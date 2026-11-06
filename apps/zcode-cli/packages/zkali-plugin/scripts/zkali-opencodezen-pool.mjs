#!/usr/bin/env node
/**
 * zkali OpenCodeZen 免费号池网关。
 *
 * 本机 OpenAI 兼容端点：多 UUID 设备身份 + 独立出口代理 + 轮询调度 + 冷却/故障转移。
 * 上游为 OpenCode Zen 免费档（https://opencode.ai/zen/v1），契约：
 *   stream:true + 非空 tools + x-opencode-session(ses_，descending 计数窗口) + UA opencode/>=1.17。
 * 参考：TiaraBasori/opencode2api（网关形态）、cheaper-inference/OmniRoute（指纹轮询/每账号代理/冷却）。
 *
 * 状态文件（本进程是唯一写者）：
 *   ~/.zcode/zkali-opencodezen-pool.json        账号/代理/开关/调度参数（admin API 修改后原子落盘）
 *   ~/.zcode/zkali-opencodezen-pool.state.json  运行态 {pid,port,adminKey,startedAt}（宿主 seed 用）
 * adminKey 仅本机回环 + Bearer 使用；不进日志、不进 renderer。
 */
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VERSION = "1.0.0";
const DEFAULT_PORT = 17331;
const UPSTREAM_BASE = "https://opencode.ai/zen/v1";
const UPSTREAM_MODELS_URL = `${UPSTREAM_BASE}/models`;
const USER_AGENT = "opencode/1.18.31";
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const STREAM_STALL_MS = 60_000;
const MAX_RETRIES = 3;

const CONFIG_DIR = join(homedir(), ".zcode");
const CONFIG_PATH = join(CONFIG_DIR, "zkali-opencodezen-pool.json");
const STATE_PATH = join(CONFIG_DIR, "zkali-opencodezen-pool.state.json");

/** 内置回退模型目录（上游 /models 不可达时使用）。 */
const FALLBACK_MODELS = [
  { id: "big-pickle", context_window: 200_000 },
  { id: "gpt-5-nano", context_window: 400_000 },
];

/**
 * 上游 /models 不返回上下文长度——按模型前缀给已知档位的估值，
 * Provider seed 侧把它写进 contextWindow；未知前缀按免费层常见 200k 兜底。
 */
const MODEL_CONTEXT_TABLE = [
  [/^gemini-/, 1_000_000],
  [/^gpt-5/, 400_000],
  [/^kimi-k/, 256_000],
  [/^minimax-m/, 200_000],
  [/^mimo-/, 256_000],
  [/^mistral-/, 256_000],
  [/^nemotron-/, 262_000],
  [/^grok-/, 256_000],
  [/^deepseek-/, 160_000],
  [/^qwen/, 262_000],
  [/^glm-/, 200_000],
  [/^claude-/, 200_000],
  [/^muse-/, 200_000],
];
const DEFAULT_CONTEXT_WINDOW = 200_000;

function estimateContextWindow(modelId) {
  for (const [re, cw] of MODEL_CONTEXT_TABLE) {
    if (re.test(modelId)) return cw;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// ---------------------------------------------------------------------------
// 配置加载/保存
// ---------------------------------------------------------------------------

function defaultConfig() {
  return {
    schemaVersion: 1,
    enabled: true,
    port: DEFAULT_PORT,
    adminKey: `zkali-pool-${randomBytes(24).toString("hex")}`,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    accounts: [],
    proxies: [],
  };
}

function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    const cfg = { ...defaultConfig(), ...raw };
    cfg.accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
    cfg.proxies = Array.isArray(raw.proxies) ? raw.proxies : [];
    if (typeof cfg.adminKey !== "string" || cfg.adminKey.length < 16) {
      cfg.adminKey = defaultConfig().adminKey;
    }
    return cfg;
  } catch {
    return defaultConfig();
  }
}

function saveConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(tmp, CONFIG_PATH);
}

function writeStateFile(cfg) {
  try {
    writeFileSync(
      STATE_PATH,
      JSON.stringify({
        pid: process.pid,
        port: cfg.port,
        adminKey: cfg.adminKey,
        version: VERSION,
        startedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
  } catch {
    /* state 文件只是 seed 提示，写失败不阻断 */
  }
}

function removeStateFile(cfg) {
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    if (state.pid === process.pid && state.adminKey === cfg.adminKey) {
      writeFileSync(STATE_PATH, JSON.stringify({ stoppedAt: new Date().toISOString() }));
    }
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 运行时健康（内存，不落盘；重启即重置是刻意的——冷却只对当前出口环境有效）
// ---------------------------------------------------------------------------

/** accountId -> {cooldownUntil, consecutiveFails, requests, failures, lastError, lastUsedAt} */
const health = new Map();
/** 轮询游标 */
let cursor = 0;

function healthOf(id) {
  let h = health.get(id);
  if (!h) {
    h = { cooldownUntil: 0, consecutiveFails: 0, requests: 0, failures: 0, lastError: null, lastUsedAt: null };
    health.set(id, h);
  }
  return h;
}

function pickAccount(cfg) {
  const now = Date.now();
  const usable = cfg.accounts;
  if (usable.length === 0) return { account: null, reason: "no-accounts" };
  const n = usable.length;
  for (let i = 0; i < n; i++) {
    const account = usable[(cursor + i) % n];
    const h = healthOf(account.id);
    if (h.cooldownUntil > now) continue;
    if (account.proxyId && !cfg.proxies.find((p) => p.id === account.proxyId)) continue;
    cursor = (cursor + i + 1) % n;
    return { account };
  }
  // 全部冷却/缺代理：挑最早解冻的账号降级派发，避免整池空转。
  let earliest = null;
  for (const account of usable) {
    const h = healthOf(account.id);
    if (account.proxyId && !cfg.proxies.find((p) => p.id === account.proxyId)) continue;
    if (!earliest || h.cooldownUntil < healthOf(earliest.id).cooldownUntil) earliest = account;
  }
  if (earliest) return { account: earliest, degraded: true };
  return { account: null, reason: "all-blocked" };
}

function markFailure(accountId, ms, error) {
  const h = healthOf(accountId);
  h.consecutiveFails += 1;
  h.failures += 1;
  h.lastError = String(error).slice(0, 300);
  h.cooldownUntil = Date.now() + ms;
}

function markSuccess(accountId) {
  const h = healthOf(accountId);
  h.consecutiveFails = 0;
  h.lastUsedAt = new Date().toISOString();
  h.lastError = null;
}

// ---------------------------------------------------------------------------
// OpenCode 契约：session id / headers / 形状记忆
// ---------------------------------------------------------------------------

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let sessionCounter = 0;

/** OpenCode `Identifier.descending()`：9hex 时间 + 低 12 位 = 0xFFF - counter(0..63)。 */
export function mintOpencodeSessionId() {
  const counter = sessionCounter++ % 64;
  const timePart = Date.now().toString(16).padStart(9, "0").slice(-9) +
    (0xfff - counter).toString(16).padStart(3, "0");
  let rand = "";
  const bytes = randomBytes(14);
  for (let i = 0; i < 14; i++) rand += BASE62[bytes[i] % 62];
  return `ses_${timePart}${rand}`;
}

/** 形状记忆：key=model|promptHash，值为 "bare"|"tools"；LRU 64。 */
const shapeMemory = new Map();
const SHAPE_PAUSE = new Map();

function promptHashOf(body) {
  let prompt = typeof body.instructions === "string" ? body.instructions : "";
  if (!prompt && Array.isArray(body.messages)) {
    const first = body.messages.find((m) => m && (m.role === "system" || m.role === "developer"));
    prompt = typeof first?.content === "string" ? first.content : JSON.stringify(first?.content ?? "");
  }
  return createHash("sha1").update(prompt || "").digest("hex");
}

function plannedShape(body) {
  const key = `${body.model}|${promptHashOf(body)}`;
  const paused = SHAPE_PAUSE.get(key);
  if (paused && paused > Date.now()) return { key, shape: shapeMemory.get(key) === "bare" ? "bare" : "tools", probe: false };
  return { key, shape: shapeMemory.get(key) || "tools", probe: true };
}

function noteShape(key, shape, accepted) {
  if (accepted) {
    shapeMemory.delete(key);
    shapeMemory.set(key, shape);
    while (shapeMemory.size > 64) shapeMemory.delete(shapeMemory.keys().next().value);
    SHAPE_PAUSE.delete(key);
  } else {
    // 两种形状都被拒过：暂停该类探测 60s，避免每请求双倍打上游。
    const alternate = shape === "tools" ? "bare" : "tools";
    if (shapeMemory.get(key) === alternate || shapeMemory.has(key)) {
      SHAPE_PAUSE.set(key, Date.now() + 60_000);
    } else {
      shapeMemory.set(key, alternate);
    }
  }
}

const PLACEHOLDER_TOOL = {
  type: "function",
  function: {
    name: "noop",
    description: "No-op placeholder required by the free tier contract.",
    parameters: { type: "object", properties: {} },
  },
};

function applyShape(body, shape, surface) {
  const next = { ...body };
  if (shape === "tools") {
    if (surface === "chat") {
      if (!Array.isArray(next.tools) || next.tools.length === 0) next.tools = [PLACEHOLDER_TOOL];
    } else if (!Array.isArray(next.tools) || next.tools.length === 0) {
      next.tools = [
        { type: "function", name: "noop", description: "No-op placeholder required by the free tier contract.", parameters: { type: "object", properties: {} } },
      ];
    }
  } else {
    delete next.tools;
    delete next.tool_choice;
  }
  next.stream = true;
  return next;
}

// ---------------------------------------------------------------------------
// 代理解析与隧道
// ---------------------------------------------------------------------------

function parseProxyUrl(raw) {
  const url = new URL(raw.trim());
  const scheme = url.protocol.replace(":", "").toLowerCase();
  if (!["http", "https", "socks5", "socks5h", "socks"].includes(scheme)) {
    throw new Error(`不支持的代理协议: ${scheme}`);
  }
  const port = Number(url.port || (scheme === "https" ? 443 : scheme.startsWith("socks") ? 1080 : 80));
  if (!url.hostname || !(port > 0 && port < 65536)) throw new Error(`代理地址无效: ${raw}`);
  return {
    scheme: scheme === "socks" ? "socks5" : scheme,
    host: url.hostname,
    port,
    user: decodeURIComponent(url.username || ""),
    pass: decodeURIComponent(url.password || ""),
  };
}

function readUntilHeadersEnd(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => cleanup(new Error("proxy handshake timeout")), timeoutMs);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx >= 0) {
        cleanup(null, buf.slice(0, idx + 4));
      } else if (buf.length > 8192) {
        cleanup(new Error("proxy response too large"));
      }
    };
    const onErr = (e) => cleanup(e);
    function cleanup(err, out) {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onErr);
      err ? reject(err) : resolve(out);
    }
    socket.on("data", onData);
    socket.on("error", onErr);
  });
}

function readExact(socket, n, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => cleanup(new Error("socks5 timeout")), timeoutMs);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= n) cleanup(null, buf);
    };
    const onErr = (e) => cleanup(e);
    function cleanup(err, out) {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onErr);
      err ? reject(err) : resolve(out);
    }
    socket.on("data", onData);
    socket.on("error", onErr);
  });
}

async function socksHandshake(socket, proxy, targetHost, targetPort, timeoutMs) {
  // greeting：无认证优先，其次 user/pass
  const methods = proxy.user ? [0x00, 0x02] : [0x00];
  socket.write(Buffer.from([0x05, methods.length, ...methods]));
  const choice = await readExact(socket, 2, timeoutMs);
  if (choice[0] !== 0x05) throw new Error("SOCKS5: bad version");
  if (choice[1] === 0x02) {
    const u = Buffer.from(proxy.user);
    const p = Buffer.from(proxy.pass || "");
    socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
    const auth = await readExact(socket, 2, timeoutMs);
    if (auth[1] !== 0x00) throw new Error("SOCKS5: auth rejected");
  } else if (choice[1] !== 0x00) {
    throw new Error("SOCKS5: no acceptable auth method");
  }
  const hostBuf = Buffer.from(targetHost);
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(targetPort);
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, portBuf]));
  const head = await readExact(socket, 4, timeoutMs);
  if (head[1] !== 0x00) throw new Error(`SOCKS5: connect failed (0x${head[1].toString(16)})`);
  const atyp = head[3];
  let addrLen;
  if (atyp === 0x01) addrLen = 4;
  else if (atyp === 0x04) addrLen = 16;
  else if (atyp === 0x03) addrLen = (await readExact(socket, 1, timeoutMs))[0];
  else throw new Error("SOCKS5: bad atyp");
  await readExact(socket, addrLen + 2, timeoutMs);
}

/**
 * 返回一个完成 TLS 的 socket（直连或经隧道），供 https.request 的 createConnection 用。
 */
async function openUpstreamSocket(proxy, timeoutMs) {
  const targetHost = "opencode.ai";
  const targetPort = 443;
  if (!proxy) {
    return tlsConnect({ host: targetHost, port: targetPort, servername: targetHost });
  }
  let raw;
  if (proxy.scheme === "http" || proxy.scheme === "https") {
    raw = proxy.scheme === "https"
      ? tlsConnect({ host: proxy.host, port: proxy.port, servername: proxy.host })
      : netConnect({ host: proxy.host, port: proxy.port });
    await new Promise((res, rej) => {
      raw.once(proxy.scheme === "https" ? "secureConnect" : "connect", res);
      raw.once("error", rej);
    });
    const auth = proxy.user ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.user}:${proxy.pass}`).toString("base64")}\r\n` : "";
    raw.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}\r\n`);
    const head = await readUntilHeadersEnd(raw, timeoutMs);
    const statusLine = head.slice(0, head.indexOf("\r\n")).toString();
    if (!/^HTTP\/\d(?:\.\d)? 2\d\d/.test(statusLine)) {
      raw.destroy();
      throw new Error(`HTTP CONNECT failed: ${statusLine}`);
    }
  } else {
    raw = netConnect({ host: proxy.host, port: proxy.port });
    await new Promise((res, rej) => {
      raw.once("connect", res);
      raw.once("error", rej);
    });
    await socksHandshake(raw, proxy, targetHost, targetPort, timeoutMs);
  }
  return tlsConnect({ socket: raw, servername: targetHost });
}

// ---------------------------------------------------------------------------
// 上游请求（https.request + createConnection 挂钩；SSE 直通/聚合）
// ---------------------------------------------------------------------------

function upstreamFetch(path, body, proxy, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        req.destroy(new Error(`upstream timeout ${timeoutMs}ms`));
      }
    }, timeoutMs);
    const req = httpsRequest(
      `${UPSTREAM_BASE}${path}`,
      {
        method: "POST",
        agent: false,
        createConnection: () => openUpstreamSocket(proxy, timeoutMs),
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          accept: "text/event-stream",
          "user-agent": USER_AGENT,
          "x-opencode-session": mintOpencodeSessionId(),
        },
      },
      (res) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve(res);
        }
      },
    );
    req.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    if (signal) {
      signal.addEventListener("abort", () => req.destroy(new Error("client aborted")), { once: true });
    }
    req.write(payload);
    req.end();
  });
}

function collectStream(res, stallMs, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setInterval(() => {
      if (Date.now() - last > stallMs) {
        clearInterval(timer);
        res.destroy(new Error(`stream stalled ${stallMs}ms`));
      }
    }, 1000);
    let last = Date.now();
    res.on("data", (c) => {
      last = Date.now();
      chunks.push(c);
    });
    res.on("end", () => {
      clearInterval(timer);
      resolve(Buffer.concat(chunks));
    });
    res.on("error", (e) => {
      clearInterval(timer);
      reject(e);
    });
    if (signal) signal.addEventListener("abort", () => res.destroy(), { once: true });
  });
}

/** SSE 字节流 → OpenAI chat.completion JSON（客户端要 stream:false 时用）。 */
function sseToChatCompletion(raw, model) {
  const text = raw.toString("utf8");
  let content = "";
  let reasoning = "";
  let finish = "stop";
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  let created = Math.floor(Date.now() / 1000);
  let modelOut = model;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const evt = JSON.parse(data);
      if (evt.id) id = evt.id;
      if (evt.created) created = evt.created;
      if (evt.model) modelOut = evt.model;
      const delta = evt.choices?.[0]?.delta ?? {};
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      if (typeof delta.reasoning === "string") reasoning += delta.reasoning;
      if (evt.choices?.[0]?.finish_reason) finish = evt.choices[0].finish_reason;
      if (evt.usage) Object.assign(usage, evt.usage);
    } catch {
      /* 忽略非 JSON 行 */
    }
  }
  const message = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  return {
    id,
    object: "chat.completion",
    created,
    model: modelOut,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage,
  };
}

function isRefusal(status, bodyText) {
  if (status === 403 || status === 429) return true;
  if (status === 426) return true;
  if (status >= 500) return true;
  if (bodyText && /FreeTierError|rate.?limit|quota/i.test(bodyText)) return true;
  return false;
}

function cooldownMsFor(status, headers) {
  if (status === 429) {
    const ra = Number(headers?.["retry-after"]);
    if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 120_000);
    return 60_000;
  }
  if (status === 403 || status === 426) return 60_000;
  if (status >= 500) return 30_000;
  return 30_000;
}

// ---------------------------------------------------------------------------
// 账号请求（含轮询/形状回退/重试）
// ---------------------------------------------------------------------------

async function dispatchChat(cfg, body, clientSignal) {
  const surface = "chat";
  const wantsStream = body.stream === true;
  let lastError = "no account available";
  const tried = new Set();
  const { key, shape: initialShape } = plannedShape(body);
  let shape = initialShape;

  for (let attempt = 0; attempt < Math.min(MAX_RETRIES, Math.max(cfg.accounts.length, 1)); attempt++) {
    const { account, reason } = pickAccount(cfg);
    if (!account || tried.has(account.id)) {
      if (!account) lastError = reason;
      break;
    }
    tried.add(account.id);
    const proxy = account.proxyId ? cfg.proxies.find((p) => p.id === account.proxyId) ?? null : null;
    const h = healthOf(account.id);
    h.requests += 1;
    const upstreamBody = applyShape(body, shape, surface);
    try {
      const res = await upstreamFetch("/chat/completions", upstreamBody, proxy?.parsed ?? null, cfg.requestTimeoutMs, clientSignal);
      if (res.statusCode === 200) {
        markSuccess(account.id);
        noteShape(key, shape, true);
        if (wantsStream) return { kind: "stream", res };
        const raw = await collectStream(res, STREAM_STALL_MS, clientSignal);
        return { kind: "json", json: sseToChatCompletion(raw, body.model) };
      }
      const errText = (await collectStream(res, 10_000).catch(() => Buffer.alloc(0))).toString("utf8").slice(0, 500);
      if (res.statusCode === 403 && /tools|FreeTier|shape/i.test(errText) && shape === "tools" && tried.size === 1) {
        // 形状探测：首个账号 403 且疑似形状拒绝 → 换 bare 形状重放同账号一次。
        shape = "bare";
        noteShape(key, "tools", false);
        tried.delete(account.id);
        continue;
      }
      if (isRefusal(res.statusCode, errText)) {
        markFailure(account.id, cooldownMsFor(res.statusCode, res.headers), `HTTP ${res.statusCode}: ${errText.slice(0, 120)}`);
        lastError = `HTTP ${res.statusCode}`;
        continue;
      }
      // 非拒绝类 4xx（参数错误等）：直接透传，不烧号池。
      return {
        kind: "json",
        passthroughStatus: res.statusCode,
        json: safeJson(errText) ?? { error: { message: errText || `upstream HTTP ${res.statusCode}`, type: "upstream_error" } },
      };
    } catch (err) {
      markFailure(account.id, 30_000, err?.message ?? err);
      lastError = err?.message ?? String(err);
      continue;
    }
  }
  return { kind: "error", status: 503, message: `OpenCodeZen pool exhausted: ${lastError}` };
}

async function dispatchResponses(cfg, body, clientSignal) {
  // responses 面同构处理：直通 SSE / 聚合后透传（responses API 的 JSON 即最后一个事件聚合复杂，
  // 直接回传 SSE 聚合的最后一个 response.completed 事件对象）。
  const wantsStream = body.stream === true;
  let lastError = "no account available";
  const tried = new Set();
  const { shape: initialShape } = plannedShape(body);
  const shape = initialShape;
  for (let attempt = 0; attempt < Math.min(MAX_RETRIES, Math.max(cfg.accounts.length, 1)); attempt++) {
    const { account, reason } = pickAccount(cfg);
    if (!account || tried.has(account.id)) {
      if (!account) lastError = reason;
      break;
    }
    tried.add(account.id);
    const proxy = account.proxyId ? cfg.proxies.find((p) => p.id === account.proxyId) ?? null : null;
    const h = healthOf(account.id);
    h.requests += 1;
    const upstreamBody = applyShape(body, shape, "responses");
    try {
      const res = await upstreamFetch("/responses", upstreamBody, proxy?.parsed ?? null, cfg.requestTimeoutMs, clientSignal);
      if (res.statusCode === 200) {
        markSuccess(account.id);
        if (wantsStream) return { kind: "stream", res };
        const raw = await collectStream(res, STREAM_STALL_MS, clientSignal);
        const completed = lastJsonEvent(raw);
        return { kind: "json", json: completed ?? { error: { message: "empty responses stream", type: "upstream_error" } } };
      }
      const errText = (await collectStream(res, 10_000).catch(() => Buffer.alloc(0))).toString("utf8").slice(0, 500);
      if (isRefusal(res.statusCode, errText)) {
        markFailure(account.id, cooldownMsFor(res.statusCode, res.headers), `HTTP ${res.statusCode}: ${errText.slice(0, 120)}`);
        lastError = `HTTP ${res.statusCode}`;
        continue;
      }
      return { kind: "json", passthroughStatus: res.statusCode, json: safeJson(errText) ?? { error: { message: errText, type: "upstream_error" } } };
    } catch (err) {
      markFailure(account.id, 30_000, err?.message ?? err);
      lastError = err?.message ?? String(err);
    }
  }
  return { kind: "error", status: 503, message: `OpenCodeZen pool exhausted: ${lastError}` };
}

function lastJsonEvent(raw) {
  const text = raw.toString("utf8");
  let last = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const evt = JSON.parse(data);
      if (evt?.type === "response.completed" && evt.response) last = evt.response;
      else if (evt && !evt.type) last = evt;
    } catch {
      /* ignore */
    }
  }
  return last;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 模型目录
// ---------------------------------------------------------------------------

let modelsCache = { at: 0, data: null };

async function fetchModels(cfg) {
  if (modelsCache.data && Date.now() - modelsCache.at < 300_000) return modelsCache.data;
  // 目录走直连（无账号也可拉）；失败回退内置目录。
  try {
    const res = await new Promise((resolve, reject) => {
      const req = httpsRequest(
        UPSTREAM_MODELS_URL,
        { method: "GET", agent: false, headers: { "user-agent": USER_AGENT, accept: "application/json" }, timeout: 15_000 },
        resolve,
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("models timeout")));
      req.end();
    });
    if (res.statusCode === 200) {
      const raw = await collectStream(res, 15_000);
      const parsed = safeJson(raw.toString("utf8"));
      const list = Array.isArray(parsed?.data) ? parsed.data : [];
      const free = list.filter((m) => m && typeof m.id === "string");
      if (free.length > 0) {
        modelsCache = {
          at: Date.now(),
          data: {
            object: "list",
            data: free.map((m) => ({
              id: m.id,
              object: "model",
              created: 0,
              owned_by: "opencode-zen",
              // 上游给了就用上游值；没给按前缀表估值（标 estimated 供调用方甄别）。
              ...(typeof m.context_window === "number"
                ? { context_window: m.context_window }
                : { context_window: estimateContextWindow(m.id), context_window_estimated: true }),
            })),
          },
        };
        return modelsCache.data;
      }
    }
    res.resume?.();
  } catch {
    /* fallthrough */
  }
  modelsCache = {
    at: Date.now(),
    data: {
      object: "list",
      data: FALLBACK_MODELS.map((m) => ({
        id: m.id,
        object: "model",
        created: 0,
        owned_by: "opencode-zen",
        context_window: m.context_window,
        context_window_estimated: true,
      })),
    },
  };
  return modelsCache.data;
}

// ---------------------------------------------------------------------------
// admin 状态投影（脱敏）
// ---------------------------------------------------------------------------

function adminState(cfg) {
  const now = Date.now();
  return {
    schemaVersion: 1,
    version: VERSION,
    enabled: cfg.enabled !== false,
    port: cfg.port,
    pid: process.pid,
    requestTimeoutMs: cfg.requestTimeoutMs,
    upstream: UPSTREAM_BASE,
    accounts: cfg.accounts.map((a) => {
      const h = healthOf(a.id);
      const proxy = a.proxyId ? cfg.proxies.find((p) => p.id === a.proxyId) : null;
      return {
        id: a.id,
        label: a.label ?? "",
        proxyId: a.proxyId ?? null,
        proxyLabel: proxy ? proxy.label || redactProxyUrl(proxy.url) : null,
        createdAt: a.createdAt ?? null,
        coolingDown: h.cooldownUntil > now,
        cooldownUntil: h.cooldownUntil > now ? h.cooldownUntil : 0,
        consecutiveFails: h.consecutiveFails,
        requests: h.requests,
        failures: h.failures,
        lastError: h.lastError,
        lastUsedAt: h.lastUsedAt,
      };
    }),
    proxies: cfg.proxies.map((p) => ({
      id: p.id,
      label: p.label ?? "",
      url: redactProxyUrl(p.url),
      scheme: p.parsed?.scheme ?? "",
      host: p.parsed?.host ?? "",
      assignedTo: cfg.accounts.filter((a) => a.proxyId === p.id).map((a) => a.id),
    })),
    stats: {
      accountCount: cfg.accounts.length,
      proxyCount: cfg.proxies.length,
      healthyAccounts: cfg.accounts.filter((a) => healthOf(a.id).cooldownUntil <= now).length,
      totalRequests: [...health.values()].reduce((s, h) => s + h.requests, 0),
      totalFailures: [...health.values()].reduce((s, h) => s + h.failures, 0),
    },
  };
}

function redactProxyUrl(url) {
  try {
    const u = new URL(url);
    if (u.username) u.username = "***";
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// admin 操作
// ---------------------------------------------------------------------------

function adminAddAccount(cfg, input) {
  const id = typeof input?.uuid === "string" && /^[0-9a-fA-F-]{32,36}$/.test(input.uuid.trim())
    ? input.uuid.trim().toLowerCase()
    : randomUUID();
  if (cfg.accounts.some((a) => a.id === id)) throw Object.assign(new Error("设备已存在"), { status: 409 });
  const account = { id, label: String(input?.label ?? "").slice(0, 80), proxyId: null, createdAt: new Date().toISOString() };
  cfg.accounts.push(account);
  saveConfig(cfg);
  return account;
}

function adminImportAccounts(cfg, input) {
  const text = typeof input?.text === "string" ? input.text : "";
  const ids = text
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[0-9a-f-]{32,36}$/.test(s));
  const added = [];
  const skipped = [];
  const existing = new Set(cfg.accounts.map((a) => a.id));
  for (const id of ids) {
    if (existing.has(id)) {
      skipped.push(id);
      continue;
    }
    existing.add(id);
    cfg.accounts.push({ id, label: "", proxyId: null, createdAt: new Date().toISOString() });
    added.push(id);
  }
  // 空导入但请求要求生成 N 个
  const generate = Number(input?.generate ?? 0);
  for (let i = 0; i < Math.min(Math.max(generate, 0), 100); i++) {
    const id = randomUUID();
    cfg.accounts.push({ id, label: "", proxyId: null, createdAt: new Date().toISOString() });
    added.push(id);
  }
  saveConfig(cfg);
  return { added, skipped, total: cfg.accounts.length };
}

function adminImportProxies(cfg, input) {
  const text = typeof input?.text === "string" ? input.text : "";
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const added = [];
  const skipped = [];
  const existing = new Set(cfg.proxies.map((p) => p.url));
  for (const line of lines) {
    let parsed;
    try {
      parsed = parseProxyUrl(line);
    } catch (e) {
      skipped.push({ line, error: e.message });
      continue;
    }
    const canonical = line;
    if (existing.has(canonical)) {
      skipped.push({ line, error: "duplicate" });
      continue;
    }
    existing.add(canonical);
    const proxy = { id: randomUUID(), url: canonical, parsed, label: "", createdAt: new Date().toISOString() };
    cfg.proxies.push(proxy);
    added.push(proxy.id);
  }
  saveConfig(cfg);
  return { added, skipped, total: cfg.proxies.length };
}

function adminAssignProxies(cfg) {
  if (cfg.proxies.length === 0) throw Object.assign(new Error("代理池为空"), { status: 400 });
  cfg.accounts.forEach((a, i) => {
    a.proxyId = cfg.proxies[i % cfg.proxies.length].id;
  });
  saveConfig(cfg);
  return { assigned: cfg.accounts.length, proxies: cfg.proxies.length };
}

async function adminTestAccount(cfg, id, clientSignal) {
  const account = cfg.accounts.find((a) => a.id === id);
  if (!account) throw Object.assign(new Error("设备不存在"), { status: 404 });
  const proxy = account.proxyId ? cfg.proxies.find((p) => p.id === account.proxyId) ?? null : null;
  const started = Date.now();
  const body = {
    model: FALLBACK_MODELS[0].id,
    stream: true,
    messages: [{ role: "user", content: "ping" }],
    tools: [PLACEHOLDER_TOOL],
    max_tokens: 1,
  };
  try {
    const res = await upstreamFetch("/chat/completions", body, proxy?.parsed ?? null, 30_000, clientSignal);
    const raw = await collectStream(res, 15_000).catch(() => Buffer.alloc(0));
    const latency = Date.now() - started;
    if (res.statusCode === 200) {
      markSuccess(id);
      return { ok: true, status: 200, latencyMs: latency };
    }
    const text = raw.toString("utf8").slice(0, 200);
    markFailure(id, cooldownMsFor(res.statusCode, res.headers), `HTTP ${res.statusCode}: ${text.slice(0, 120)}`);
    return { ok: false, status: res.statusCode, latencyMs: latency, error: text };
  } catch (e) {
    markFailure(id, 30_000, e?.message ?? e);
    return { ok: false, status: 0, latencyMs: Date.now() - started, error: e?.message ?? String(e) };
  }
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => {
      chunks.push(c);
      if (Buffer.concat(chunks).length > 8 * 1024 * 1024) req.destroy(new Error("body too large"));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function authorized(req, cfg) {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers["x-admin-key"];
  return token === cfg.adminKey;
}

const cfg = loadConfig();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
        "access-control-allow-headers": "authorization,content-type,x-admin-key",
      });
      return res.end();
    }
    if (path === "/health" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, version: VERSION, accounts: cfg.accounts.length, pid: process.pid });
    }
    if (!authorized(req, cfg)) {
      return sendJson(res, 401, { error: { message: "unauthorized", type: "auth_error" } });
    }
    if (cfg.enabled === false && path.startsWith("/v1/")) {
      return sendJson(res, 503, { error: { message: "OpenCodeZen pool disabled", type: "pool_disabled" } });
    }

    // ---- OpenAI 兼容面 ----
    if (path === "/v1/models" && req.method === "GET") {
      return sendJson(res, 200, await fetchModels(cfg));
    }
    if (path === "/v1/chat/completions" && req.method === "POST") {
      const body = safeJson((await readBody(req)).toString("utf8"));
      if (!body || !body.model) return sendJson(res, 400, { error: { message: "invalid chat completion body", type: "invalid_request" } });
      const signal = req.socket ? abortOnClose(req) : undefined;
      const out = await dispatchChat(cfg, body, signal);
      if (out.kind === "stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        out.res.pipe(res);
        return;
      }
      if (out.kind === "error") return sendJson(res, out.status, { error: { message: out.message, type: "pool_exhausted" } });
      return sendJson(res, out.passthroughStatus ?? 200, out.json);
    }
    if (path === "/v1/responses" && req.method === "POST") {
      const body = safeJson((await readBody(req)).toString("utf8"));
      if (!body || !body.model) return sendJson(res, 400, { error: { message: "invalid responses body", type: "invalid_request" } });
      const signal = req.socket ? abortOnClose(req) : undefined;
      const out = await dispatchResponses(cfg, body, signal);
      if (out.kind === "stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        out.res.pipe(res);
        return;
      }
      if (out.kind === "error") return sendJson(res, out.status, { error: { message: out.message, type: "pool_exhausted" } });
      return sendJson(res, out.passthroughStatus ?? 200, out.json);
    }

    // ---- admin 面 ----
    if (path === "/admin/state" && req.method === "GET") {
      const state = adminState(cfg);
      state.models = (await fetchModels(cfg)).data.map((m) => m.id);
      return sendJson(res, 200, state);
    }
    if (path === "/admin/enabled" && req.method === "POST") {
      const body = safeJson((await readBody(req)).toString("utf8")) ?? {};
      cfg.enabled = body.enabled !== false;
      saveConfig(cfg);
      return sendJson(res, 200, { enabled: cfg.enabled });
    }
    if (path === "/admin/accounts" && req.method === "POST") {
      return sendJson(res, 201, adminAddAccount(cfg, safeJson((await readBody(req)).toString("utf8"))));
    }
    if (path === "/admin/accounts/import" && req.method === "POST") {
      return sendJson(res, 200, adminImportAccounts(cfg, safeJson((await readBody(req)).toString("utf8"))));
    }
    if (path === "/admin/proxies/import" && req.method === "POST") {
      return sendJson(res, 200, adminImportProxies(cfg, safeJson((await readBody(req)).toString("utf8"))));
    }
    if (path === "/admin/assign" && req.method === "POST") {
      return sendJson(res, 200, adminAssignProxies(cfg));
    }
    if (path === "/admin/unassign" && req.method === "POST") {
      cfg.accounts.forEach((a) => (a.proxyId = null));
      saveConfig(cfg);
      return sendJson(res, 200, { unassigned: true });
    }
    const accountMatch = path.match(/^\/admin\/accounts\/([0-9a-f-]{36})$/);
    if (accountMatch) {
      const id = accountMatch[1];
      const idx = cfg.accounts.findIndex((a) => a.id === id);
      if (idx < 0) return sendJson(res, 404, { error: { message: "not found" } });
      if (req.method === "DELETE") {
        cfg.accounts.splice(idx, 1);
        health.delete(id);
        saveConfig(cfg);
        return sendJson(res, 200, { deleted: id });
      }
      if (req.method === "PATCH") {
        const patch = safeJson((await readBody(req)).toString("utf8")) ?? {};
        if (typeof patch.label === "string") cfg.accounts[idx].label = patch.label.slice(0, 80);
        if ("proxyId" in patch) {
          if (patch.proxyId === null) cfg.accounts[idx].proxyId = null;
          else if (cfg.proxies.some((p) => p.id === patch.proxyId)) cfg.accounts[idx].proxyId = patch.proxyId;
          else return sendJson(res, 400, { error: { message: "unknown proxyId" } });
        }
        saveConfig(cfg);
        return sendJson(res, 200, cfg.accounts[idx]);
      }
    }
    const testMatch = path.match(/^\/admin\/accounts\/([0-9a-f-]{36})\/test$/);
    if (testMatch && req.method === "POST") {
      const signal = req.socket ? abortOnClose(req) : undefined;
      return sendJson(res, 200, await adminTestAccount(cfg, testMatch[1], signal));
    }
    const proxyMatch = path.match(/^\/admin\/proxies\/([0-9a-f-]{36})$/);
    if (proxyMatch && req.method === "DELETE") {
      const id = proxyMatch[1];
      const idx = cfg.proxies.findIndex((p) => p.id === id);
      if (idx < 0) return sendJson(res, 404, { error: { message: "not found" } });
      cfg.proxies.splice(idx, 1);
      cfg.accounts.forEach((a) => {
        if (a.proxyId === id) a.proxyId = null;
      });
      saveConfig(cfg);
      return sendJson(res, 200, { deleted: id });
    }
    if (path === "/admin/config" && req.method === "PATCH") {
      const patch = safeJson((await readBody(req)).toString("utf8")) ?? {};
      if (Number.isFinite(patch.requestTimeoutMs)) {
        cfg.requestTimeoutMs = Math.min(Math.max(patch.requestTimeoutMs, 10_000), 600_000);
      }
      saveConfig(cfg);
      return sendJson(res, 200, { requestTimeoutMs: cfg.requestTimeoutMs });
    }

    return sendJson(res, 404, { error: { message: "not found", path } });
  } catch (err) {
    const status = err?.status ?? 500;
    return sendJson(res, status, { error: { message: err?.message ?? String(err) } });
  }
});

function abortOnClose(req) {
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  return controller.signal;
}

server.on("error", (err) => {
  if (err?.code === "EADDRINUSE") {
    // 已有实例在跑：探活确认后直接退出，不抢端口。
    const probe = httpRequest(
      { host: "127.0.0.1", port: cfg.port, path: "/health", timeout: 3000 },
      (r) => {
        r.resume();
        process.exit(r.statusCode === 200 ? 0 : 1);
      },
    );
    probe.on("error", () => process.exit(1));
    probe.on("timeout", () => probe.destroy());
    probe.end();
    return;
  }
  process.stderr.write(`[zkali-opencodezen-pool] listen error: ${err?.message ?? err}\n`);
  process.exit(1);
});

server.listen(cfg.port, "127.0.0.1", () => {
  saveConfig(cfg);
  writeStateFile(cfg);
  process.stdout.write(`[zkali-opencodezen-pool] v${VERSION} listening on 127.0.0.1:${cfg.port} accounts=${cfg.accounts.length} proxies=${cfg.proxies.length}\n`);
});

process.on("SIGTERM", () => {
  removeStateFile(cfg);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
process.on("SIGINT", () => {
  removeStateFile(cfg);
  process.exit(0);
});

/**
 * zkali Allin 聚合网关 · 桌面宿主管理。
 *
 * 职责边界：
 * - 唯一状态所有者是网关进程本身（zkali-plugin scripts/zkali-allin-gw.mjs），
 *   账号/代理/轮询/冷却全部在 ~/.zcode/zkali-allin.json 与网关内存中；
 *   本模块只做：脚本定位、进程拉起/退出回收、/health 探活、admin/v1 请求转发。
 * - authKey 只读 state 文件用于转发，不返回给 renderer；renderer 通过
 *   `zcode:zkali-allin-request` IPC 让主进程代理调用。
 * - CLI-only 场景由 session-init.mjs 钩子拉起同一脚本（EADDRINUSE 先到先得）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isElectronAppPackaged } from "./desktopElectronApp.js";

const GW_SCRIPT_NAME = "zkali-allin-gw.mjs";
const GW_DEFAULT_PORT = 17332;
const GW_HEALTH_TIMEOUT_MS = 1_500;
const GW_REQUEST_TIMEOUT_MS = 30_000;

interface GwLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

interface GwConfigFile {
  enabled?: boolean;
  server?: { port?: number; authKey?: string };
}

interface GwStateFile {
  pid?: number;
  port?: number;
  authKey?: string;
  stoppedAt?: string;
}

import type {
  ZkaliAllinBridgeRequest,
  ZkaliAllinBridgeResponse,
} from "@zcode/shared";

let child: ChildProcess | null = null;
let loggerRef: GwLogger | null = null;

function gwHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return join(envHome && envHome.length > 0 ? envHome : homedir(), ".zcode");
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function resolveGwScriptPath(): string | null {
  const platformKey = `${process.platform}-${process.arch}`;
  const candidates = [
    isElectronAppPackaged()
      ? join(
          process.resourcesPath,
          "glm",
          "packages",
          "zkali-plugin",
          "scripts",
          GW_SCRIPT_NAME,
        )
      : null,
    join(
      process.cwd(),
      "bundled-agents",
      platformKey,
      "glm",
      "packages",
      "zkali-plugin",
      "scripts",
      GW_SCRIPT_NAME,
    ),
    join(
      process.cwd(),
      "packages",
      "desktop",
      "bundled-agents",
      platformKey,
      "glm",
      "packages",
      "zkali-plugin",
      "scripts",
      GW_SCRIPT_NAME,
    ),
    join(
      process.cwd(),
      "apps",
      "zcode-cli",
      "packages",
      "zkali-plugin",
      "scripts",
      GW_SCRIPT_NAME,
    ),
    join(
      import.meta.dirname,
      "../../../../apps/zcode-cli/packages/zkali-plugin/scripts",
      GW_SCRIPT_NAME,
    ),
  ].filter((c): c is string => Boolean(c));
  return candidates.find((c) => existsSync(c)) ?? null;
}

async function probeHealth(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GW_HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function readGwConfig(): Promise<GwConfigFile | null> {
  return readJsonFile<GwConfigFile>(join(gwHomeDir(), "zkali-allin.json"));
}

async function readGwState(): Promise<GwStateFile | null> {
  const state = await readJsonFile<GwStateFile>(
    join(gwHomeDir(), "zkali-allin.state.json"),
  );
  if (!state || state.stoppedAt) return null;
  return state;
}

/**
 * 应用启动时调用：enabled 时确保网关在跑。
 * 已在跑（CLI/上次桌面实例）→ 直接复用；否则拉起脚本子进程。
 */
export async function ensureZkaliAllinGw(logger: GwLogger): Promise<void> {
  loggerRef = logger;
  const config = await readGwConfig();
  if (config?.enabled === false) return;
  const port = Number(config?.server?.port) > 0 ? Number(config?.server?.port) : GW_DEFAULT_PORT;
  if (await probeHealth(port)) return;

  const scriptPath = resolveGwScriptPath();
  if (!scriptPath) {
    logger.warn("Allin 网关脚本未找到", { tried: "bundled+workspace" });
    return;
  }
  if (child && child.exitCode === null && !child.killed) return;

  child = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    logger.info("allin-gw", { out: chunk.toString("utf8").trim().slice(0, 300) });
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    logger.warn("allin-gw stderr", { err: chunk.toString("utf8").trim().slice(0, 300) });
  });
  child.on("exit", (code) => {
    logger.warn("allin-gw exited", { code });
    child = null;
  });
  logger.info("Allin 网关已拉起", { pid: child.pid, scriptPath });
}

export function stopZkaliAllinGw(): void {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
  }
  child = null;
}

/**
 * Renderer → admin/v1 代理。只允许白名单路径，authKey 由主进程注入。
 * 网关未运行时返回 {status:0, running:false}，设置页据此显示"未运行"。
 */
export async function handleZkaliAllinRequest(
  payload: ZkaliAllinBridgeRequest,
): Promise<ZkaliAllinBridgeResponse> {
  const method = String(payload?.method ?? "GET").toUpperCase();
  const path = String(payload?.path ?? "");
  if (!/^\/(admin|v1|health)(\/|$)/.test(path)) {
    return { status: 400, error: "invalid-path" };
  }
  if (!["GET", "POST", "PATCH", "DELETE"].includes(method)) {
    return { status: 400, error: "invalid-method" };
  }

  // 网关未跑且是启用类操作：先尝试拉起，保证设置页开关可用。
  const config = await readGwConfig();
  const port = Number(config?.server?.port) > 0 ? Number(config?.server?.port) : GW_DEFAULT_PORT;
  if (!(await probeHealth(port))) {
    if (config?.enabled === false && !path.startsWith("/admin/enabled")) {
      return { status: 0, running: false, error: "gw-disabled" };
    }
    if (loggerRef) {
      await ensureZkaliAllinGw(loggerRef);
      // 给刚拉起的进程一点 listen 时间。
      for (let i = 0; i < 20 && !(await probeHealth(port)); i++) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    if (!(await probeHealth(port))) {
      return { status: 0, running: false, error: "gw-not-running" };
    }
  }

  const state = await readGwState();
  const authKey = state?.authKey ?? config?.server?.authKey;
  const effectivePort = state?.port ?? port;
  if (!authKey) return { status: 0, running: false, error: "gw-key-missing" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GW_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${effectivePort}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${authKey}`,
        ...(payload?.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: payload?.body !== undefined ? JSON.stringify(payload.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* 非 JSON 原样透传 */
    }
    return { status: res.status, body, running: true };
  } catch (error) {
    return { status: 0, running: true, error: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** 仅供 IPC 注册侧一次性创建配置目录（首次使用前 ~/.zcode 可能不存在）。 */
export async function ensureZkaliAllinConfigDir(): Promise<void> {
  await mkdir(gwHomeDir(), { recursive: true });
}

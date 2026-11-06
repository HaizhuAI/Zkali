/**
 * zkali OpenCodeZen 免费号池 · 桌面宿主管理。
 *
 * 职责边界：
 * - 唯一状态所有者是池进程本身（zkali-plugin scripts/zkali-opencodezen-pool.mjs），
 *   配置/轮询/冷却全部在 ~/.zcode/zkali-opencodezen-pool.json 与池内存中；
 *   本模块只做：脚本定位、进程拉起/退出回收、/health 探活、admin/v1 请求转发。
 * - adminKey 只读 state 文件用于转发，不返回给 renderer；renderer 通过
 *   `zcode:zkali-opencodezen-pool-request` IPC 让主进程代理调用。
 * - CLI-only 场景由 session-init.mjs 钩子拉起同一脚本（EADDRINUSE 先到先得）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isElectronAppPackaged } from "./desktopElectronApp.js";

const POOL_SCRIPT_NAME = "zkali-opencodezen-pool.mjs";
const POOL_DEFAULT_PORT = 17331;
const POOL_HEALTH_TIMEOUT_MS = 1_500;
const POOL_REQUEST_TIMEOUT_MS = 30_000;

interface PoolLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

interface PoolConfigFile {
  enabled?: boolean;
  port?: number;
  adminKey?: string;
}

interface PoolStateFile {
  pid?: number;
  port?: number;
  adminKey?: string;
  stoppedAt?: string;
}

import type {
  ZkaliOpencodeZenPoolBridgeRequest,
  ZkaliOpencodeZenPoolBridgeResponse,
} from "@zcode/shared";

let child: ChildProcess | null = null;
let loggerRef: PoolLogger | null = null;

function poolHomeDir(): string {
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

function resolvePoolScriptPath(): string | null {
  const platformKey = `${process.platform}-${process.arch}`;
  const candidates = [
    isElectronAppPackaged()
      ? join(
          process.resourcesPath,
          "glm",
          "packages",
          "zkali-plugin",
          "scripts",
          POOL_SCRIPT_NAME,
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
      POOL_SCRIPT_NAME,
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
      POOL_SCRIPT_NAME,
    ),
    join(
      process.cwd(),
      "apps",
      "zcode-cli",
      "packages",
      "zkali-plugin",
      "scripts",
      POOL_SCRIPT_NAME,
    ),
    join(
      import.meta.dirname,
      "../../../../apps/zcode-cli/packages/zkali-plugin/scripts",
      POOL_SCRIPT_NAME,
    ),
  ].filter((c): c is string => Boolean(c));
  return candidates.find((c) => existsSync(c)) ?? null;
}

async function probeHealth(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POOL_HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function readPoolConfig(): Promise<PoolConfigFile | null> {
  return readJsonFile<PoolConfigFile>(join(poolHomeDir(), "zkali-opencodezen-pool.json"));
}

async function readPoolState(): Promise<PoolStateFile | null> {
  const state = await readJsonFile<PoolStateFile>(
    join(poolHomeDir(), "zkali-opencodezen-pool.state.json"),
  );
  if (!state || state.stoppedAt) return null;
  return state;
}

/**
 * 应用启动时调用：enabled 时确保池在跑。
 * 已在跑（CLI/上次桌面实例）→ 直接复用；否则拉起脚本子进程。
 */
export async function ensureZkaliOpencodeZenPool(logger: PoolLogger): Promise<void> {
  loggerRef = logger;
  const config = await readPoolConfig();
  if (config?.enabled === false) return;
  const port = Number(config?.port) > 0 ? Number(config?.port) : POOL_DEFAULT_PORT;
  if (await probeHealth(port)) return;

  const scriptPath = resolvePoolScriptPath();
  if (!scriptPath) {
    logger.warn("OpenCodeZen 号池脚本未找到", { tried: "bundled+workspace" });
    return;
  }
  if (child && child.exitCode === null && !child.killed) return;

  child = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    logger.info("opencodezen-pool", { out: chunk.toString("utf8").trim().slice(0, 300) });
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    logger.warn("opencodezen-pool stderr", { err: chunk.toString("utf8").trim().slice(0, 300) });
  });
  child.on("exit", (code) => {
    logger.warn("opencodezen-pool exited", { code });
    child = null;
  });
  logger.info("OpenCodeZen 号池已拉起", { pid: child.pid, scriptPath });
}

export function stopZkaliOpencodeZenPool(): void {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
  }
  child = null;
}

/**
 * Renderer → admin/v1 代理。只允许白名单路径，adminKey 由主进程注入。
 * 池未运行时返回 {status:0, running:false}，设置页据此显示"未运行"。
 */
export async function handleZkaliOpencodeZenPoolRequest(
  payload: ZkaliOpencodeZenPoolBridgeRequest,
): Promise<ZkaliOpencodeZenPoolBridgeResponse> {
  const method = String(payload?.method ?? "GET").toUpperCase();
  const path = String(payload?.path ?? "");
  if (!/^\/(admin|v1|health)(\/|$)/.test(path)) {
    return { status: 400, error: "invalid-path" };
  }
  if (!["GET", "POST", "PATCH", "DELETE"].includes(method)) {
    return { status: 400, error: "invalid-method" };
  }

  // 池未跑且是启用类操作：先尝试拉起，保证设置页开关可用。
  const config = await readPoolConfig();
  const port = Number(config?.port) > 0 ? Number(config?.port) : POOL_DEFAULT_PORT;
  if (!(await probeHealth(port))) {
    if (config?.enabled === false && !path.startsWith("/admin/enabled")) {
      return { status: 0, running: false, error: "pool-disabled" };
    }
    if (loggerRef) {
      await ensureZkaliOpencodeZenPool(loggerRef);
      // 给刚拉起的进程一点 listen 时间。
      for (let i = 0; i < 20 && !(await probeHealth(port)); i++) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    if (!(await probeHealth(port))) {
      return { status: 0, running: false, error: "pool-not-running" };
    }
  }

  const state = await readPoolState();
  const adminKey = state?.adminKey ?? config?.adminKey;
  const effectivePort = state?.port ?? port;
  if (!adminKey) return { status: 0, running: false, error: "pool-key-missing" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POOL_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${effectivePort}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${adminKey}`,
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
export async function ensureZkaliPoolConfigDir(): Promise<void> {
  await mkdir(poolHomeDir(), { recursive: true });
}

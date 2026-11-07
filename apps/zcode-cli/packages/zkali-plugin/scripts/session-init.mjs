#!/usr/bin/env node
/**
 * SessionStart hook — 初始化 zkali 作战工作区 + 注入团队编排指令。
 * 读 stdin 的 hook 事件 JSON，创建 engagement 目录结构，
 * 探测工具矩阵，通过 additionalContext 注入会话。
 */
import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { platform, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { get as httpGet } from "node:http";

let raw = "";
for await (const c of process.stdin) raw += c;
let ev = {};
try { ev = JSON.parse(raw); } catch {}

const cwd = ev.cwd || ev.workspace?.cwd || process.cwd();
const isWin = platform() === "win32";

const DIRS = ["recon", "loot", "exploits", "findings", "notes", "screenshots", ".zkali/journal", ".zkali/output"];
const made = [];
for (const d of DIRS) {
  const p = join(cwd, d);
  if (!existsSync(p)) { mkdirSync(p, { recursive: true }); made.push(d); }
}

const QUICK = ["nmap", "nuclei", "ffuf", "sqlmap", "subfinder", "httpx", "gdb", "r2", "radare2", "jadx", "apktool", "frida", "python", "python3", "node", "git", "openssl", "hashcat", "john", "tshark", "docker", "chisel", "ssh"];
const probe = isWin ? "where" : "which";
const avail = [], missing = [];
for (const t of QUICK) {
  const r = spawnSync(probe, [t], { timeout: 5000, stdio: "pipe" });
  (r.status === 0 ? avail : missing).push(t);
}

const logDir = join(cwd, ".zkali", "journal");
const day = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// OpenCodeZen 免费号池：CLI-only 场景下由 session 钩子拉起网关进程。
// 池进程是唯一状态所有者；enabled=false 或已在跑（/health）时静默跳过。
// 桌面端由 main 进程管理同一脚本，同一 ~/.zcode 配置，先到先得（EADDRINUSE 自退）。
// ---------------------------------------------------------------------------
let poolNote = "disabled";
try {
  const poolCfgPath = join(homedir(), ".zcode", "zkali-opencodezen-pool.json");
  const poolCfg = existsSync(poolCfgPath)
    ? JSON.parse(readFileSync(poolCfgPath, "utf8"))
    : null;
  const poolEnabled = poolCfg ? poolCfg.enabled !== false : true;
  const poolPort = Number(poolCfg?.port) > 0 ? Number(poolCfg.port) : 17331;
  if (poolEnabled) {
    const poolScript = join(
      dirname(fileURLToPath(import.meta.url)),
      "zkali-opencodezen-pool.mjs",
    );
    const alive = await new Promise((resolve) => {
      const probe = httpGet(
        { host: "127.0.0.1", port: poolPort, path: "/health", timeout: 1500 },
        (r) => {
          r.resume();
          resolve(r.statusCode === 200);
        },
      );
      probe.on("error", () => resolve(false));
      probe.on("timeout", () => probe.destroy());
    });
    if (alive) {
      poolNote = `running :${poolPort}`;
    } else if (existsSync(poolScript)) {
      const child = spawn(process.execPath, [poolScript], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      poolNote = `spawned :${poolPort}`;
    } else {
      poolNote = "script-missing";
    }
  }
} catch {
  poolNote = "error";
}
appendFileSync(
  join(logDir, `${day}.md`),
  `\n## Session ${new Date().toISOString()}\n- source: ${ev.hook_event_name || "SessionStart"} / ${ev.source || "startup"}\n- dirs created: ${made.join(", ") || "none (already present)"}\n`,
);

// 团队编排指令：常驻注入，主 agent 收到安全任务时无需用户点名即自动拆给子智能体并行作业。
const ORCHESTRATION = [
  "[zkali-team] 内置网安团队已就位。你是总指挥（海鸥），按域自动派工，不等用户点名。",
  "",
  "## 多智能体协同协议（对安全任务强制执行）",
  "1. 判域：逆向/渗透/Web/CTF/审计/红队/蓝队/侦察/代理通道，可叠加。",
  "2. 派工：立即用 Agent(subagent_type=zkali-<域>) 下发子任务；互不依赖的域并行多个 Agent 同时发。",
  "3. 每个子任务 prompt 写清：目标、已有证据、期望产物路径（recon//loot//exploits//findings/）。",
  "4. 子智能体回报后主线汇总：合并 findings、消除重复假设、把缺口二次派工。",
  "5. 链路例：/recon 产出攻击面 → 自动派 zkali-web 打 Web 入口 + zkali-audit 审源码 → 拿到二进制自动派 zkali-reverse/zkali-pwn → 内网阶段自动派 zkali-red + zkali-proxy → 打完痕迹交 zkali-blue 出检测。",
  "",
  "## 队员",
  "- zkali-recon 踩点攻击面 | zkali-web Web/API 渗透 | zkali-pwn exploit 开发",
  "- zkali-reverse 二进制/协议逆向 | zkali-ctf 全题型 | zkali-audit 源码审计",
  "- zkali-red 授权红队内网 | zkali-blue 取证检测蓝队 | zkali-proxy 代理链/通道/轮换",
  "",
  "## 武器",
  `- 已挂载(${avail.length}): ${avail.join(", ") || "无"}`,
  `- 缺席(${missing.length}): ${missing.join(", ")}`,
  "- zkali-toolbox MCP: zkali_detect 全量探测 | zkali_run 白名单执行 | zkali_bootscope SpringBoot端点探测 | zkali_crypto CTF密码台 | zkali_journal 作战留痕",
  `- OpenCodeZen 免费号池: ${poolNote}（设置→OpenCodeZen 号池管理设备/代理/轮询）`,
  `- 工作区已就绪: ${DIRS.join(" / ")} —— 原始数据存原样，结论写 findings/，关键信息 zkali_journal 落盘`,
].join("\n");

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: ORCHESTRATION,
  },
}));

#!/usr/bin/env node
/**
 * PostToolUse(async) — 把执行过的 Bash 命令追加到作战日志。
 * 异步、不阻断、永不失败退出。
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let raw = "";
for await (const c of process.stdin) raw += c;
try {
  const ev = JSON.parse(raw);
  const cwd = ev.cwd || process.cwd();
  const cmd = ev.tool_input?.command || ev.toolInput?.command || "";
  if (!cmd) process.exit(0);
  const dir = join(cwd, ".zkali", "journal");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const ts = new Date().toISOString().slice(11, 19);
  const oneLine = String(cmd).replace(/\s+/g, " ").slice(0, 500);
  appendFileSync(join(dir, `${day}.md`), `- ${ts} **CMD** — \`${oneLine}\`\n`);
} catch {}
process.exit(0);

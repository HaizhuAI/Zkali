#!/usr/bin/env node
/**
 * zkali-toolbox — MCP stdio server for security work.
 * Pure Node.js, zero dependencies. Speaks MCP (JSON-RPC 2.0, newline-delimited
 * stdio transport). Diagnostics go to stderr only; stdout is protocol-only.
 *
 * Tools:
 *   zkali.detect  — probe PATH for 60+ security tools, return availability matrix
 *   zkali.run     — execute an allowlisted security binary (arg array, no shell)
 *   zkali.crypto  — CTF crypto/encoding workbench implemented in pure JS
 *   zkali.journal — append timestamped notes/findings to the engagement journal
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = { name: "zkali-toolbox", version: "1.0.0" };
const isWin = platform() === "win32";

/* ---------------- security binary allowlist ---------------- */

const ALLOWLIST = new Set([
  // recon / osint
  "nmap", "masscan", "naabu", "subfinder", "amass", "dnsx", "httpx", "katana",
  "gau", "waybackurls", "theHarvester", "whois", "dig", "nslookup", "host",
  "shodan", "asnmap", "mapcidr", "tlsx", "uncover",
  // web / fuzzing
  "ffuf", "gobuster", "dirsearch", "feroxbuster", "wfuzz", "nuclei", "nikto",
  "wpscan", "sqlmap", "dalfox", "arjun", "paramspider", "hydra", "medusa",
  // network / smb / ad
  "enum4linux", "enum4linux-ng", "smbclient", "smbmap", "rpcclient", "ldapsearch",
  "nxc", "netexec", "crackmapexec", "certipy", "certipy-ad", "bloodhound-python",
  "impacket-secretsdump", "impacket-psexec", "impacket-wmiexec", "impacket-smbexec",
  "impacket-getTGT", "impacket-getST", "impacket-GetUserSPNs", "evil-winrm",
  "kerbrute", "responder", "mitm6", "chisel", "ligolo-ng", "socat", "nc", "ncat",
  // binary analysis / reversing
  "file", "strings", "nm", "objdump", "readelf", "elfdump", "xxd", "hexdump",
  "rabin2", "r2", "radare2", "rizin", "rz-bin", "rz-asm", "rasm2", "ragg2",
  "cutter", "ghidra", "analyzeHeadless", "ida", "ida64", "idat64", "x64dbg",
  "gdb", "gdbserver", "lldb", "windbg", "cdb", "checksec", "pwn", "ropgadget",
  "ROPgadget", "ropper", "one_gadget", "seccomp-tools", "patchelf", "upx",
  "binwalk", "foremost", "bulk_extractor", "exiftool", "pngcheck", "zsteg",
  "steghide", "outguess", "openocd",
  // mobile / jvm
  "apktool", "jadx", "jadx-gui", "dex2jar", "d2j-dex2jar", "baksmali", "smali",
  "aapt", "aapt2", "adb", "fastboot", "frida", "frida-ps", "frida-trace",
  "frida-discover", "objection", "keytool", "jarsigner", "javap", "jd-cli",
  "procyon", "cfr", "ILSpyCmd", "dnspy", "de4dot",
  // runtime / memory / forensic
  "vol", "vol3", "volatility", "volatility3", "yara", "yara64", "capa",
  "floss", "pe-sieve", "hollows_hunter", "procdump", "strings64", "autoruns",
  "tcpdump", "tshark", "dumpcap", "wireshark", "mitmproxy", "mitmdump",
  "burpsuite", "zaproxy", "openssl", "certutil", "hashcat", "john", "hashid",
  "hash-identifier", "cyberchef",
  // generic utilities commonly needed mid-engagement
  "python", "python3", "py", "pip", "pip3", "node", "ruby", "perl", "php",
  "java", "javac", "go", "cargo", "gcc", "clang", "make", "cmake",
  "git", "curl", "wget", "jq", "yq", "base64", "tar", "7z", "unzip", "zip",
  "ssh", "scp", "rsync", "docker", "kubectl", "aws", "az", "gcloud",
]);

const TOOL_CATALOG = {
  recon: ["nmap", "masscan", "naabu", "subfinder", "amass", "dnsx", "httpx", "katana", "gau", "waybackurls", "theHarvester", "shodan", "asnmap", "tlsx"],
  web: ["ffuf", "gobuster", "dirsearch", "feroxbuster", "nuclei", "nikto", "wpscan", "sqlmap", "dalfox", "arjun", "hydra"],
  ad_smb: ["enum4linux", "enum4linux-ng", "smbclient", "smbmap", "rpcclient", "nxc", "netexec", "certipy", "certipy-ad", "bloodhound-python", "evil-winrm", "kerbrute", "impacket-secretsdump", "impacket-psexec"],
  binary: ["file", "strings", "nm", "objdump", "readelf", "rabin2", "r2", "radare2", "rizin", "rz-bin", "cutter", "analyzeHeadless", "gdb", "lldb", "checksec", "ropgadget", "ROPgadget", "ropper", "one_gadget", "seccomp-tools", "patchelf", "upx", "binwalk", "exiftool"],
  mobile: ["apktool", "jadx", "dex2jar", "baksmali", "aapt", "adb", "frida", "frida-ps", "frida-trace", "objection", "javap", "jd-cli", "cfr", "ILSpyCmd", "de4dot"],
  forensic: ["vol", "vol3", "volatility3", "yara", "capa", "floss", "pe-sieve", "procdump", "tshark", "tcpdump", "mitmproxy", "mitmdump", "openssl", "hashcat", "john", "hashid", "zsteg", "steghide"],
  runtime: ["python", "python3", "node", "git", "curl", "jq", "docker", "chisel", "socat", "nc", "ncat", "ssh", "7z"],
};

/* ---------------- helpers ---------------- */

function whichAll(names) {
  const probe = isWin ? "where" : "which";
  const out = {};
  for (const n of names) {
    const r = spawnSync(probe, [n], { encoding: "utf8", timeout: 8000 });
    const p = r.status === 0 ? (r.stdout || "").split(/\r?\n/)[0]?.trim() : null;
    out[n] = p && p.length ? p : null;
  }
  return out;
}

function engagementDir(cwd) {
  const base = process.env.ZKALI_ENGAGEMENT_DIR
    || (cwd ? resolve(cwd) : process.cwd());
  const dir = join(base, ".zkali");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function runProcess(cmd, args, opts = {}) {
  return new Promise((resolveP) => {
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 120000, 1000), 900000);
    const maxOut = Math.min(opts.maxOutputBytes ?? 256 * 1024, 2 * 1024 * 1024);
    const spawnOpts = {
      cwd: opts.cwd ? resolve(opts.cwd) : process.cwd(),
      env: { ...process.env, ...opts.env },
      shell: false,
      windowsHide: true,
    };
    let child;
    try {
      child = spawn(cmd, args, spawnOpts);
    } catch (e) {
      return resolveP({ ok: false, error: `spawn failed: ${e.message}` });
    }
    let out = Buffer.alloc(0), err = Buffer.alloc(0), truncated = false;
    const push = (buf, chunk) => {
      if (buf.length + chunk.length > maxOut) {
        truncated = true;
        return Buffer.concat([buf, chunk.subarray(0, Math.max(0, maxOut - buf.length))]);
      }
      return Buffer.concat([buf, chunk]);
    };
    child.stdout.on("data", (c) => (out = push(out, c)));
    child.stderr.on("data", (c) => (err = push(err, c)));
    const killer = setTimeout(() => {
      try { child.kill(isWin ? "SIGTERM" : "SIGKILL"); } catch {}
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(killer);
      resolveP({ ok: false, error: e.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      resolveP({
        ok: true, exitCode: code, signal: signal || null, truncated,
        stdout: out.toString("utf8"), stderr: err.toString("utf8"),
      });
    });
  });
}

/* ---------------- zkali.crypto (pure JS workbench) ---------------- */

function cryptoOp(op, p) {
  const input = String(p.input ?? "");
  switch (op) {
    case "encode": case "decode": {
      const enc = String(p.encoding || "base64");
      if (op === "encode") {
        const buf = Buffer.from(input, "utf8");
        if (enc === "base64") return buf.toString("base64");
        if (enc === "base64url") return buf.toString("base64url");
        if (enc === "hex") return buf.toString("hex");
        if (enc === "url") return encodeURIComponent(input);
        if (enc === "binary") return [...buf].map((b) => b.toString(2).padStart(8, "0")).join(" ");
        if (enc === "decimal") return [...buf].map((b) => b.toString(10)).join(" ");
        if (enc === "rot13") return input.replace(/[a-zA-Z]/g, (c) => {
          const b = c <= "Z" ? 65 : 97;
          return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
        });
        if (enc === "atbash") return input.replace(/[a-zA-Z]/g, (c) =>
          c <= "Z" ? String.fromCharCode(155 - c.charCodeAt(0))
                   : String.fromCharCode(219 - c.charCodeAt(0)));
        if (enc === "morse") {
          const M = { A:".-",B:"-...",C:"-.-.",D:"-..",E:".",F:"..-.",G:"--.",H:"....",I:"..",J:".---",K:"-.-",L:".-..",M:"--",N:"-.",O:"---",P:".--.",Q:"--.-",R:".-.",S:"...",T:"-",U:"..-",V:"...-",W:".--",X:"-..-",Y:"-.--",Z:"--..","0":"-----","1":".----","2":"..---","3":"...--","4":"....-","5":".....","6":"-....","7":"--...","8":"---..","9":"----."," ":"/" };
          return input.toUpperCase().split("").map((c) => M[c] ?? c).join(" ");
        }
        throw new Error(`unknown encoding: ${enc}`);
      }
      if (enc === "base64" || enc === "base64url")
        return Buffer.from(input.replace(/\s/g, ""), enc === "base64" ? "base64" : "base64url").toString("utf8");
      if (enc === "hex") return Buffer.from(input.replace(/\s|0x/g, ""), "hex").toString("utf8");
      if (enc === "url") return decodeURIComponent(input);
      if (enc === "binary") return Buffer.from(input.trim().split(/\s+/).map((b) => parseInt(b, 2))).toString("utf8");
      if (enc === "decimal") return Buffer.from(input.trim().split(/\s+/).map((b) => parseInt(b, 10))).toString("utf8");
      if (enc === "morse") {
        const M = { ".-":"A","-...":"B","-.-.":"C","-..":"D",".":"E","..-.":"F","--.":"G","....":"H","..":"I",".---":"J","-.-":"K",".-..":"L","--":"M","-.":"N","---":"O",".--.":"P","--.-":"Q",".-.":"R","...":"S","-":"T","..-":"U","...-":"V",".--":"W","-..-":"X","-.--":"Y","--..":"Z","-----":"0",".----":"1","..---":"2","...--":"3","....-":"4",".....":"5","-....":"6","--...":"7","---..":"8","----.":"9","/":" " };
        return input.trim().split(/\s+/).map((t) => M[t] ?? t).join("");
      }
      throw new Error(`unknown encoding: ${enc}`);
    }
    case "hash": {
      const algo = String(p.algorithm || "sha256").toLowerCase().replace(/-/g, "");
      const digest = (a) => createHash(a).update(input, "utf8").digest("hex");
      if (algo === "all")
        return Object.fromEntries(["md5", "sha1", "sha224", "sha256", "sha384", "sha512"].map((a) => [a, digest(a)]));
      return digest(algo);
    }
    case "xor": {
      const keyHex = String(p.key || "");
      const key = /^([0-9a-fA-F]{2})+$/.test(keyHex)
        ? Buffer.from(keyHex, "hex")
        : Buffer.from(keyHex, "utf8");
      if (!key.length) throw new Error("empty xor key");
      const data = p.input_hex
        ? Buffer.from(String(p.input_hex).replace(/\s|0x/g, ""), "hex")
        : Buffer.from(input, "utf8");
      const out = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % key.length];
      return { hex: out.toString("hex"), text: out.toString("utf8") };
    }
    case "xor_brute": {
      const data = p.input_hex
        ? Buffer.from(String(p.input_hex).replace(/\s|0x/g, ""), "hex")
        : Buffer.from(input, "utf8");
      const ETAOIN = " etaoinshrdluETAOINSHRDLU";
      const results = [];
      for (let k = 0; k < 256; k++) {
        const out = Buffer.alloc(data.length);
        for (let i = 0; i < data.length; i++) out[i] = data[i] ^ k;
        const s = out.toString("utf8");
        const printable = [...s].filter((c) => c >= " " && c <= "~").length / Math.max(1, s.length);
        if (printable > 0.85) {
          const common = [...s].filter((c) => ETAOIN.includes(c)).length / Math.max(1, s.length);
          const score = printable * 0.4 + common * 0.6;
          results.push({ key: k, key_hex: k.toString(16).padStart(2, "0"), key_ascii: k >= 32 && k < 127 ? String.fromCharCode(k) : null, score: +score.toFixed(3), text: s.slice(0, 200) });
        }
      }
      return results.sort((a, b) => b.score - a.score).slice(0, 20);
    }
    case "rot": {
      const n = ((parseInt(p.amount ?? "13", 10) % 26) + 26) % 26;
      return input.replace(/[a-zA-Z]/g, (c) => {
        const b = c <= "Z" ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - b + n) % 26) + b);
      });
    }
    case "caesar_brute": {
      const rows = [];
      for (let n = 1; n < 26; n++)
        rows.push({ shift: n, text: cryptoOp("rot", { input, amount: n }).slice(0, 120) });
      return rows;
    }
    case "freq": {
      const total = input.length || 1;
      const freq = {};
      for (const c of input.toLowerCase()) if (/[a-z]/.test(c)) freq[c] = (freq[c] || 0) + 1;
      const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1])
        .map(([c, n]) => ({ char: c, count: n, pct: +((n / total) * 100).toFixed(2) }));
      let ic = 0;
      for (const [, n] of Object.entries(freq)) ic += n * (n - 1);
      const letters = Object.values(freq).reduce((a, b) => a + b, 0);
      const indexOfCoincidence = letters > 1 ? +((ic / (letters * (letters - 1))).toFixed(4)) : 0;
      return { total_chars: total, letter_count: letters, index_of_coincidence: indexOfCoincidence, top: sorted.slice(0, 15) };
    }
    case "jwt_decode": {
      const parts = input.replace(/^Bearer\s+/i, "").split(".");
      if (parts.length < 2) throw new Error("not a JWT");
      const dec = (s) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
      return { header: dec(parts[0]), payload: dec(parts[1]), signature_hex: Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("hex") };
    }
    case "identify_hash": {
      const h = input.trim();
      const cands = [];
      if (/^[0-9a-fA-F]{32}$/.test(h)) cands.push("md5", "ntlm", "md4");
      if (/^[0-9a-fA-F]{40}$/.test(h)) cands.push("sha1", "ripemd160");
      if (/^[0-9a-fA-F]{56}$/.test(h)) cands.push("sha224", "sha3-224");
      if (/^[0-9a-fA-F]{64}$/.test(h)) cands.push("sha256", "sha3-256", "blake2s", "gost");
      if (/^[0-9a-fA-F]{96}$/.test(h)) cands.push("sha384", "sha3-384");
      if (/^[0-9a-fA-F]{128}$/.test(h)) cands.push("sha512", "sha3-512", "whirlpool");
      if (/^\$2[aby]\$/.test(h)) cands.push("bcrypt");
      if (h.startsWith("$6$")) cands.push("sha512crypt");
      if (h.startsWith("$5$")) cands.push("sha256crypt");
      if (h.startsWith("$1$")) cands.push("md5crypt");
      if (h.startsWith("$argon2")) cands.push("argon2");
      if (h.startsWith("$y$")) cands.push("yescrypt");
      if (/^[a-f0-9]{32}:[a-f0-9]+$/i.test(h)) cands.push("md5(salt.pass) family");
      return { input_len: h.length, candidates: cands.length ? cands : ["unknown — check hashid/hash-identifier"] };
    }
    case "int_convert": {
      const v = input.trim();
      let n;
      if (/^0x[0-9a-f]+$/i.test(v)) n = BigInt(v);
      else if (/^0b[01]+$/.test(v)) n = BigInt(v);
      else if (/^-?\d+$/.test(v)) n = BigInt(v);
      else throw new Error("not an integer");
      const hex = (n < 0n ? -n : n).toString(16);
      const bytes = Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
      return {
        dec: n.toString(10), hex: "0x" + hex,
        bytes_le_hex: Buffer.from(bytes).reverse().toString("hex"),
        bytes_be_hex: bytes.toString("hex"),
        u32_le: "0x" + Buffer.from(bytes.subarray(-4)).reverse().toString("hex").padStart(8, "0"),
        ascii: [...bytes].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join(""),
      };
    }
    default:
      throw new Error(`unknown crypto op: ${op}`);
  }
}

/* ---------------- tool definitions ---------------- */

const TOOLS = [
  {
    name: "zkali_detect",
    description: "扫描 PATH 中的安全工具（侦察/Web/AD/二进制/移动/取证/运行时），返回可用矩阵和绝对路径。开工第一步用它确定武器库。",
    inputSchema: {
      type: "object",
      properties: {
        categories: { type: "array", items: { type: "string", enum: Object.keys(TOOL_CATALOG) }, description: "只探测指定类别，缺省全部" },
        extra: { type: "array", items: { type: "string" }, description: "额外要探测的命令名" },
      },
    },
  },
  {
    name: "zkali_run",
    description: "执行白名单内的安全二进制（nmap/nuclei/ffuf/sqlmap/gdb/r2/jadx/frida/hashcat/openssl/python 等 150+）。参数走数组不经 shell，默认 120s 超时（上限 900s），输出超 256KB 截断并落盘。",
    inputSchema: {
      type: "object",
      required: ["tool", "args"],
      properties: {
        tool: { type: "string", description: "二进制名，必须在白名单内" },
        args: { type: "array", items: { type: "string" }, description: "参数数组，不经过 shell" },
        cwd: { type: "string", description: "工作目录（绝对路径）" },
        timeout_ms: { type: "integer", description: "超时毫秒，默认 120000，上限 900000" },
        env: { type: "object", description: "附加环境变量" },
        save_output: { type: "string", description: "把完整输出另存到 engagement 目录下该文件名" },
      },
    },
  },
  {
    name: "zkali_crypto",
    description: "纯 JS CTF 密码/编码工作台：encode/decode(base64,hex,url,binary,decimal,rot13,atbash,morse)、hash(md5~sha512/all)、xor、xor_brute(单字节爆破)、rot、caesar_brute、freq(频率+重合指数)、jwt_decode、identify_hash、int_convert(整数↔字节序)。",
    inputSchema: {
      type: "object",
      required: ["op"],
      properties: {
        op: { type: "string", enum: ["encode", "decode", "hash", "xor", "xor_brute", "rot", "caesar_brute", "freq", "jwt_decode", "identify_hash", "int_convert"] },
        input: { type: "string" },
        input_hex: { type: "string", description: "十六进制输入（xor/xor_brute 优先用它）" },
        encoding: { type: "string" },
        algorithm: { type: "string" },
        key: { type: "string", description: "xor 密钥（hex 或明文）" },
        amount: { type: "string", description: "rot 位移量" },
      },
    },
  },
  {
    name: "zkali_journal",
    description: "向 engagement 作战日志（.zkali/journal/YYYY-MM-DD.md）追加带时间戳的条目：finding/note/command/ioc/credential。用于全程留痕与报告素材。",
    inputSchema: {
      type: "object",
      required: ["kind", "text"],
      properties: {
        kind: { type: "string", enum: ["finding", "note", "command", "ioc", "credential", "todo"] },
        text: { type: "string" },
        target: { type: "string", description: "关联目标（主机/URL/二进制名）" },
        cwd: { type: "string" },
      },
    },
  },
];

/* ---------------- dispatch ---------------- */

async function callTool(name, args) {
  switch (name) {
    case "zkali_detect": {
      const cats = args?.categories?.length ? args.categories : Object.keys(TOOL_CATALOG);
      const names = new Set();
      for (const c of cats) for (const n of TOOL_CATALOG[c] || []) names.add(n);
      for (const n of args?.extra || []) names.add(String(n));
      const found = whichAll([...names]);
      const matrix = {};
      for (const c of cats) {
        matrix[c] = {};
        for (const n of TOOL_CATALOG[c] || []) matrix[c][n] = found[n];
      }
      for (const n of args?.extra || []) (matrix.extra ||= {})[n] = found[n];
      const avail = Object.values(found).filter(Boolean).length;
      return { available: avail, missing: names.size - avail, os: platform(), matrix };
    }
    case "zkali_run": {
      const tool = String(args?.tool || "");
      const base = tool.replace(/\.(exe|bat|cmd|ps1)$/i, "");
      if (!ALLOWLIST.has(tool) && !ALLOWLIST.has(base))
        throw new Error(`tool not in allowlist: ${tool}`);
      const targs = (args?.args || []).map(String);
      if (targs.some((a) => typeof a !== "string"))
        throw new Error("args must be strings");
      const res = await runProcess(tool, targs, {
        cwd: args?.cwd, timeoutMs: args?.timeout_ms, env: args?.env,
      });
      if (!res.ok) return { ok: false, error: res.error };
      if (args?.save_output) {
        const dir = join(engagementDir(args?.cwd), "output");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const f = join(dir, String(args.save_output).replace(/[/\\]/g, "_"));
        writeFileSync(f, `> ${tool} ${targs.join(" ")}\nexit=${res.exitCode}\n\n${res.stdout}\n--- stderr ---\n${res.stderr}`);
        res.saved_to = f;
      }
      res.command = `${tool} ${targs.join(" ")}`;
      return res;
    }
    case "zkali_crypto":
      return { op: args?.op, result: cryptoOp(String(args?.op), args || {}) };
    case "zkali_journal": {
      const dir = join(engagementDir(args?.cwd), "journal");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      const f = join(dir, `${day}.md`);
      const ts = new Date().toISOString().slice(11, 19);
      const tgt = args?.target ? ` [${args.target}]` : "";
      appendFileSync(f, `- ${ts} **${String(args?.kind).toUpperCase()}**${tgt} — ${String(args?.text)}\n`);
      return { logged: f, line: `${ts} ${args?.kind}${tgt}` };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/* ---------------- MCP stdio loop ---------------- */

// __zcode-plugin-host 启动形态：宿主 import 本文件后调用 main()；独立 `node` 直跑也走
// main()。started 哨兵保证宿主「import → main()」双触发时 stdin 只绑定一次。
let started = false;
export function main() {
  if (started) return;
  started = true;
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) handle(line);
    }
  });
  process.stderr.write(`[zkali-toolbox] ${SERVER.name} v${SERVER.version} ready (${platform()})\n`);
}

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // notification — ignore
  const reply = (result) => send({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
  try {
    switch (method) {
      case "initialize":
        return reply({
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: SERVER,
          instructions: "zkali-toolbox: security engagement toolbox. Start with zkali_detect to map available binaries; use zkali_run for allowlisted tools, zkali_crypto for CTF crypto, zkali_journal for findings.",
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const result = await callTool(params?.name, params?.arguments || {});
        return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      }
      case "resources/list": return reply({ resources: [] });
      case "prompts/list": return reply({ prompts: [] });
      default:
        return fail(-32601, `method not found: ${method}`);
    }
  } catch (e) {
    if (method === "tools/call")
      return reply({ content: [{ type: "text", text: `error: ${e.message}` }], isError: true });
    return fail(-32603, e.message);
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// 直跑（node / __zcode-plugin-host 都会把 argv[1] 指向本文件）时立即进入 stdio loop。
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) main();

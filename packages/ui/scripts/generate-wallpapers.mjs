// zkali 内置壁纸生成器：纯 SVG 程序化生成，原创资产零许可风险。
// 用法：node scripts/generate-wallpapers.mjs
// 产物写入 src/assets/wallpapers/，由 wallpapers.ts 以 ?url 导入打包。

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "assets", "wallpapers");
const W = 3840;
const H = 2160;

// 确定种子 PRNG：同一份源码任意机器上复现同一批壁纸。
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

function svgShell(defs, body, attrs = "") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${attrs}>
<defs>${defs}</defs>
${body}
</svg>
`;
}

// ---------------------------------------------------------------------------
// 1. neon-horizon — 合成波透视网格地平线与落日线
// ---------------------------------------------------------------------------
function neonHorizon() {
  const rnd = mulberry32(0x7a11);
  const horizon = 1340;
  const defs = `
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#050213"/><stop offset="0.55" stop-color="#12063a"/>
    <stop offset="0.78" stop-color="#2b0a52"/><stop offset="1" stop-color="#09041c"/>
  </linearGradient>
  <radialGradient id="sun" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" stop-color="#ffd76e"/><stop offset="0.55" stop-color="#ff9e4f"/>
    <stop offset="1" stop-color="#ff4fd8"/>
  </radialGradient>
  <linearGradient id="gridline" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ff4fd8" stop-opacity="0.05"/>
    <stop offset="1" stop-color="#26e6ff" stop-opacity="0.9"/>
  </linearGradient>
  <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#0a0522" stop-opacity="0"/><stop offset="1" stop-color="#05010f"/>
  </linearGradient>`;

  // 星野
  let stars = "";
  for (let i = 0; i < 420; i++) {
    const x = rnd() * W;
    const y = rnd() * horizon * 0.92;
    const r = rnd() * 2.2 + 0.4;
    const o = (rnd() * 0.75 + 0.15).toFixed(2);
    stars += `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(r)}" fill="#cdd6ff" opacity="${o}"/>`;
  }

  // 落日线切缝
  const cx = W / 2;
  const sunR = 460;
  let sun = "";
  const cuts = [0.02, 0.09, 0.17, 0.26, 0.36];
  cuts.forEach((t, i) => {
    const cy = horizon - sunR + t * sunR * 2;
    const h = 6 + i * 10;
    sun += `<rect x="${cx - sunR - 30}" y="${fmt(cy)}" width="${(sunR + 30) * 2}" height="${h}" fill="#0a0522"/>`;
  });
  sun += `<circle cx="${cx}" cy="${fmt(horizon - sunR + sunR)}" r="${sunR}" fill="url(#sun)" clip-path="url(#sunclip)"/>`;
  const sunClip = `<clipPath id="sunclip"><circle cx="${cx}" cy="${horizon - sunR + sunR}" r="${sunR}"/></clipPath>`;
  // 切缝要在圆之上，重排：先圆后切条
  sun = `<circle cx="${cx}" cy="${horizon}" r="${sunR}" fill="url(#sun)"/>`;
  cuts.forEach((t, i) => {
    const cy = horizon - sunR * 0.55 + t * sunR * 0.85;
    const h = 7 + i * 12;
    sun += `<rect x="${cx - sunR - 30}" y="${fmt(cy)}" width="${(sunR + 30) * 2}" height="${h}" fill="#12063a"/>`;
  });

  // 透视纵线：从地平线 vp 向底边散开
  const vpY = horizon;
  let lines = `<rect x="0" y="${vpY}" width="${W}" height="${H - vpY}" fill="url(#floor)"/>`;
  for (let i = -18; i <= 18; i++) {
    const xBottom = cx + i * 620;
    lines += `<line x1="${cx}" y1="${vpY}" x2="${xBottom}" y2="${H + 60}" stroke="url(#gridline)" stroke-width="${i === 0 ? 5 : 2.5}"/>`;
  }
  // 水平线：等比加密逼近地平线
  for (let i = 1; i <= 22; i++) {
    const t = i / 22;
    const y = vpY + (H - vpY) * t * t;
    lines += `<line x1="0" y1="${fmt(y)}" x2="${W}" y2="${fmt(y)}" stroke="url(#gridline)" stroke-width="${1 + t * 2.5}"/>`;
  }
  lines += `<line x1="0" y1="${vpY}" x2="${W}" y2="${vpY}" stroke="#26e6ff" stroke-width="3" opacity="0.8"/>`;

  return svgShell(defs + sunClip, `<rect width="${W}" height="${H}" fill="url(#sky)"/>${stars}${sun}${lines}`);
}

// ---------------------------------------------------------------------------
// 2. signal-rain — 磷光绿落字符矩阵
// ---------------------------------------------------------------------------
function signalRain() {
  const rnd = mulberry32(0xc0de);
  const glyphs = "0123456789ABCDEFｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎ$#%&@*+=?";
  const defs = `
  <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#39ff88" stop-opacity="0"/>
    <stop offset="0.7" stop-color="#39ff88" stop-opacity="0.55"/>
    <stop offset="1" stop-color="#b6ffd8" stop-opacity="0.95"/>
  </linearGradient>
  <linearGradient id="fadeDim" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#22cc66" stop-opacity="0"/>
    <stop offset="0.75" stop-color="#22cc66" stop-opacity="0.3"/>
    <stop offset="1" stop-color="#66ffa0" stop-opacity="0.6"/>
  </linearGradient>`;

  const colW = 46;
  let cols = "";
  for (let x = colW / 2; x < W; x += colW) {
    const bright = rnd() > 0.62;
    const len = Math.floor(8 + rnd() * 26);
    const yStart = rnd() * (H + 400) - 200;
    let txt = "";
    for (let i = 0; i < len; i++) {
      txt += glyphs[Math.floor(rnd() * glyphs.length)];
    }
    const fontSize = bright ? 30 : 24;
    cols += `<text x="${fmt(x)}" y="${fmt(yStart)}" font-family="Consolas,'Noto Sans JP',monospace" font-size="${fontSize}" fill="${bright ? "url(#fade)" : "url(#fadeDim)"}" writing-mode="tb" letter-spacing="6">${txt}</text>`;
    // 头部亮字符
    cols += `<text x="${fmt(x)}" y="${fmt(yStart + len * (fontSize + 6))}" font-family="Consolas,monospace" font-size="${fontSize + 4}" fill="${bright ? "#eafff2" : "#7dffb0"}" opacity="${bright ? 0.95 : 0.5}" text-anchor="middle">${glyphs[Math.floor(rnd() * glyphs.length)]}</text>`;
  }
  const vignette = `<radialGradient id="vig" cx="0.5" cy="0.45" r="0.75">
    <stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.7"/>
  </radialGradient>`;
  return svgShell(
    defs + vignette,
    `<rect width="${W}" height="${H}" fill="#020806"/>${cols}<rect width="${W}" height="${H}" fill="url(#vig)"/>`,
  );
}

// ---------------------------------------------------------------------------
// 3. circuit-board — 深色 PCB 走线与焊盘
// ---------------------------------------------------------------------------
function circuitBoard() {
  const rnd = mulberry32(0xb0a2);
  const grid = 96;

  let traces = "";
  const palette = ["#22d3ee", "#34d399", "#818cf8"];
  for (let i = 0; i < 90; i++) {
    const color = palette[Math.floor(rnd() * palette.length)];
    const op = (0.12 + rnd() * 0.3).toFixed(2);
    const wdt = 2 + rnd() * 4;
    let x = Math.floor(rnd() * (W / grid)) * grid;
    let y = Math.floor(rnd() * (H / grid)) * grid;
    let d = `M ${x} ${y}`;
    const segs = 3 + Math.floor(rnd() * 5);
    for (let s = 0; s < segs; s++) {
      const horizontal = s % 2 === 0;
      const len = grid * (1 + Math.floor(rnd() * 5));
      const dir = rnd() > 0.5 ? 1 : -1;
      const nx = horizontal ? x + len * dir : x;
      const ny = horizontal ? y : y + len * dir;
      // 45° 斜角过渡
      const bend = 24;
      if (horizontal) {
        const bendX = nx - bend * dir;
        d += ` L ${bendX} ${y} L ${nx} ${ny}`;
      } else {
        d += ` L ${x} ${ny - bend * dir} L ${nx} ${ny}`;
      }
      x = nx;
      y = ny;
    }
    traces += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${fmt(wdt)}" opacity="${op}" stroke-linecap="round" stroke-linejoin="round"/>`;
    // 端点焊盘
    traces += `<circle cx="${x}" cy="${y}" r="${fmt(wdt * 2.2)}" fill="none" stroke="${color}" stroke-width="${fmt(wdt * 0.8)}" opacity="${op}"/>`;
    traces += `<circle cx="${x}" cy="${y}" r="${fmt(wdt * 0.9)}" fill="${color}" opacity="${op}"/>`;
  }
  // 网格底纹 + 少量 IC 框
  let bg = `<pattern id="dots" width="${grid}" height="${grid}" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1.5" fill="#1e293b"/></pattern>`;
  let ics = "";
  for (let i = 0; i < 9; i++) {
    const iw = 200 + rnd() * 300;
    const ih = 140 + rnd() * 200;
    const ix = rnd() * (W - iw);
    const iy = rnd() * (H - ih);
    ics += `<rect x="${fmt(ix)}" y="${fmt(iy)}" width="${fmt(iw)}" height="${fmt(ih)}" rx="10" fill="#0b1220" stroke="#22d3ee" stroke-width="2" opacity="0.5"/>`;
    const pins = Math.floor(iw / 34);
    for (let p = 1; p < pins; p++) {
      const px = ix + (p * iw) / pins;
      ics += `<line x1="${fmt(px)}" y1="${fmt(iy - 14)}" x2="${fmt(px)}" y2="${fmt(iy)}" stroke="#22d3ee" stroke-width="2" opacity="0.4"/>`;
      ics += `<line x1="${fmt(px)}" y1="${fmt(iy + ih)}" x2="${fmt(px)}" y2="${fmt(iy + ih + 14)}" stroke="#22d3ee" stroke-width="2" opacity="0.4"/>`;
    }
  }
  return svgShell(
    bg,
    `<rect width="${W}" height="${H}" fill="#070c16"/><rect width="${W}" height="${H}" fill="url(#dots)"/>${ics}${traces}`,
  );
}

// ---------------------------------------------------------------------------
// 4. topo-ridge — 等高线山脊（Kali 风格低调线条）
// ---------------------------------------------------------------------------
function topoRidge() {
  const rnd = mulberry32(0x7090);
  const lines = [];
  const ridgeCount = 26;
  for (let r = 0; r < ridgeCount; r++) {
    const baseY = (r / (ridgeCount - 1)) * (H + 500) - 250;
    const amp = 40 + rnd() * 160;
    const f1 = 0.0016 + rnd() * 0.0022;
    const f2 = 0.004 + rnd() * 0.005;
    const ph1 = rnd() * Math.PI * 2;
    const ph2 = rnd() * Math.PI * 2;
    const drift = (rnd() - 0.5) * 0.4;
    let d = `M -80 ${fmt(baseY + Math.sin(-80 * f1 + ph1) * amp)}`;
    for (let x = -80; x <= W + 80; x += 16) {
      const y = baseY + Math.sin(x * f1 + ph1) * amp + Math.sin(x * f2 + ph2) * amp * 0.35 + x * drift;
      d += ` L ${fmt(x)} ${fmt(y)}`;
    }
    const accent = r === Math.floor(ridgeCount * 0.45) || r === Math.floor(ridgeCount * 0.7);
    lines.push(
      `<path d="${d}" fill="none" stroke="${accent ? "#5eead4" : "#33475f"}" stroke-width="${accent ? 3.4 : 1.6}" opacity="${accent ? 0.85 : 0.5 + (r / ridgeCount) * 0.2}"/>`,
    );
  }
  // 高程注记点
  let ticks = "";
  for (let i = 0; i < 40; i++) {
    const tx = rnd() * W;
    const ty = rnd() * H;
    ticks += `<circle cx="${fmt(tx)}" cy="${fmt(ty)}" r="2.4" fill="#5eead4" opacity="0.5"/><text x="${fmt(tx + 10)}" y="${fmt(ty - 8)}" font-family="Consolas,monospace" font-size="18" fill="#5eead4" opacity="0.4">${Math.floor(rnd() * 9000)}</text>`;
  }
  const defs = `<radialGradient id="tglow" cx="0.5" cy="0.4" r="0.8"><stop offset="0" stop-color="#0d2b33"/><stop offset="1" stop-color="#050b12"/></radialGradient>`;
  return svgShell(
    defs,
    `<rect width="${W}" height="${H}" fill="url(#tglow)"/>${lines.join("")}${ticks}`,
  );
}

// ---------------------------------------------------------------------------
// 5. hex-mesh — 蜂窝网格 + 中央徽记辉光
// ---------------------------------------------------------------------------
function hexMesh() {
  const rnd = mulberry32(0x9e4f);
  const side = 58;
  const dx = side * 1.732;
  const dy = side * 1.5;

  const hexPath = (cx, cy, s) => {
    let d = "";
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      const x = cx + s * Math.cos(a);
      const y = cy + s * Math.sin(a);
      d += `${i === 0 ? "M" : "L"} ${fmt(x)} ${fmt(y)} `;
    }
    return d + "Z";
  };

  let mesh = "";
  const litCells = [];
  for (let row = -1; row * dy < H + side * 2; row++) {
    for (let col = -1; col * dx < W + side * 2; col++) {
      const x = col * dx + (row % 2 ? dx / 2 : 0);
      const y = row * dy;
      const roll = rnd();
      if (roll > 0.965) litCells.push([x, y, roll > 0.988 ? "#a78bfa" : "#22d3ee"]);
      mesh += `<path d="${hexPath(x, y, side - 2)}" fill="none" stroke="#14202e" stroke-width="1.4"/>`;
    }
  }
  let lit = "";
  for (const [x, y, c] of litCells) {
    lit += `<path d="${hexPath(x, y, side - 2)}" fill="${c}" opacity="0.16"/><path d="${hexPath(x, y, side - 2)}" fill="none" stroke="${c}" stroke-width="2" opacity="0.7"/>`;
  }
  // 中央徽记
  const cx = W / 2;
  const cy = H / 2;
  const emblem =
    `<circle cx="${cx}" cy="${cy}" r="430" fill="none" stroke="#22d3ee" stroke-width="2" opacity="0.35"/>` +
    `<circle cx="${cx}" cy="${cy}" r="380" fill="none" stroke="#22d3ee" stroke-width="1" opacity="0.2" stroke-dasharray="8 14"/>` +
    `<path d="${hexPath(cx, cy, 300)}" fill="#0a1622" stroke="#22d3ee" stroke-width="4"/>` +
    `<path d="M ${cx - 110} ${cy - 60} L ${cx + 110} ${cy - 60} L ${cx - 30} ${cy + 70} L ${cx + 110} ${cy + 70}" fill="none" stroke="#5eead4" stroke-width="16" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<text x="${cx}" y="${cy + 190}" text-anchor="middle" font-family="Consolas,monospace" font-size="60" fill="#5eead4" letter-spacing="18">ZKALI</text>`;

  const defs = `<radialGradient id="hglow" cx="0.5" cy="0.5" r="0.55"><stop offset="0" stop-color="#0d2233"/><stop offset="0.5" stop-color="#08131d"/><stop offset="1" stop-color="#050a10"/></radialGradient>`;
  return svgShell(
    defs,
    `<rect width="${W}" height="${H}" fill="url(#hglow)"/>${mesh}${lit}${emblem}`,
  );
}

// ---------------------------------------------------------------------------
// 6. zkali-terminal — 终端磷光提示符主题
// ---------------------------------------------------------------------------
function zkaliTerminal() {
  const rnd = mulberry32(0xde57);
  const defs = `
  <linearGradient id="tbg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#04090e"/><stop offset="1" stop-color="#081521"/></linearGradient>
  <radialGradient id="pglow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#39ff88" stop-opacity="0.16"/><stop offset="1" stop-color="#39ff88" stop-opacity="0"/></radialGradient>
  <linearGradient id="scan" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#39ff88" stop-opacity="0"/><stop offset="0.5" stop-color="#39ff88" stop-opacity="0.08"/><stop offset="1" stop-color="#39ff88" stop-opacity="0"/></linearGradient>`;

  // 终端历史行（暗色残影）
  const lines = [
    "root@zkali:~# nmap -sS -sV --top-ports 1000 10.13.37.0/24",
    "Starting Zmap 7.95 ( https://zkali.local ) at 04:00 UTC",
    "Discovered open port 22/tcp on 10.13.37.101",
    "Discovered open port 443/tcp on 10.13.37.101",
    "root@zkali:~# ./exploit --target 10.13.37.101 --lhost tun0",
    "[*] Sending stage (175174 bytes) to 10.13.37.101",
    "[+] Session 1 opened (10.13.37.5:4444 -> 10.13.37.101:49152)",
    "meterpreter > getsystem",
    "...got system via technique 4 (Named Pipe Impersonation).",
    "meterpreter > hashdump",
    "root@zkali:~# ghidra -analyze ./target.bin -postScript zkali.py",
    "[*] 1337 functions analyzed | 4 crypto constants identified",
    "root@zkali:~# zkali --engagement PHANTOM-2026 --debrief",
    "[+] All findings written to /engagements/PHANTOM-2026/report.md",
  ];
  let text = "";
  lines.forEach((line, i) => {
    const y = 340 + i * 84;
    const op = i < 4 ? 0.16 + i * 0.05 : 0.32 + i * 0.015;
    const accent = line.startsWith("[+]") ? "#39ff88" : line.startsWith("[*]") ? "#22d3ee" : "#9fb3c8";
    text += `<text x="220" y="${y}" font-family="Consolas,monospace" font-size="40" fill="${accent}" opacity="${op.toFixed(2)}">${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</text>`;
  });
  // 大提示符 + 光标
  const promptY = 340 + lines.length * 84 + 40;
  const prompt =
    `<text x="220" y="${promptY}" font-family="Consolas,monospace" font-size="54" fill="#39ff88" font-weight="bold">root@zkali:~# </text>` +
    `<rect x="${220 + 560}" y="${promptY - 56}" width="34" height="64" fill="#39ff88" opacity="0.9"><animate attributeName="opacity" values="0.9;0.15;0.9" dur="1.2s" repeatCount="indefinite"/></rect>`;
  // 扫描线
  let scanlines = "";
  for (let y = 0; y < H; y += 6) {
    scanlines += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#000" stroke-width="2.6" opacity="0.28"/>`;
  }
  scanlines += `<rect x="0" y="${Math.floor(rnd() * H)}" width="${W}" height="220" fill="url(#scan)"/>`;
  const glow = `<ellipse cx="${W / 2}" cy="${H / 2}" rx="${W / 2}" ry="${H / 2}" fill="url(#pglow)"/>`;

  return svgShell(
    defs,
    `<rect width="${W}" height="${H}" fill="url(#tbg)"/>${glow}${text}${prompt}${scanlines}`,
  );
}

// ---------------------------------------------------------------------------

const GENERATORS = {
  "neon-horizon": neonHorizon,
  "signal-rain": signalRain,
  "circuit-board": circuitBoard,
  "topo-ridge": topoRidge,
  "hex-mesh": hexMesh,
  "zkali-terminal": zkaliTerminal,
};

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, gen] of Object.entries(GENERATORS)) {
  const file = join(OUT_DIR, `${name}.svg`);
  writeFileSync(file, gen(), "utf8");
  console.log(`[wallpapers] wrote ${file}`);
}

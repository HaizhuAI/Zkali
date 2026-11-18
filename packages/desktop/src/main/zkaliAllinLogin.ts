/**
 * zkali Allin 聚合网关 · webview 登录窗。
 *
 * 对齐 All In APK LoginActivity 的 WebView 提取流程：
 * - 每次登录用全新 in-memory session partition（等价 APK 先清 cookie/存储再开页）；
 * - 导航与定时轮询中执行提取：cookie 名/JWT 扫描 → localStorage/sessionStorage JWT 扫描，
 *   deepseek_web 走专用 localStorage.userToken.value 提取；
 * - 拿到凭据后主进程直接 POST /admin/accounts（authKey 不出 main，renderer 无凭据），
 *   网关侧会把该供应商进行中的 webview flow 标记 done，renderer 轮询收尾。
 *
 * device-poll / loopback 类流不走本模块——renderer 用 platform.openExternal
 * 打开系统浏览器，回环回调由网关自身 serve。
 */
import { BrowserWindow, session } from "electron";
import {
  ensureZkaliAllinGw,
  handleZkaliAllinRequest,
} from "./zkaliAllinGw.js";
import type {
  ZkaliAllinLoginRequest,
  ZkaliAllinLoginResponse,
} from "@zcode/shared";

const LOGIN_TIMEOUT_MS = 15 * 60_000;
const EXTRACT_INTERVAL_MS = 1_500;
const MIN_TOKEN_LEN = 20;

/** APK LoginActivity 的 cookie token 名白名单与值守卫。 */
const TOKEN_COOKIE_RE =
  /(?:^|;\s*)(?:xhx_token|access_token|accessToken|user_token|auth_token|token|session_token)=([^;]+)/i;
const JWT_RE = /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/;

/** 通用 JS 提取：localStorage/sessionStorage 内 JWT 扫描（APK LoginActivity 同款）。 */
const GENERIC_EXTRACT_JS = `(function(){function findJwt(str){  if(!str) return '';  let s = typeof str === 'string' ? str : JSON.stringify(str);  let m = s.match(/\\beyJ[a-zA-Z0-9_\\-]{20,}\\.[a-zA-Z0-9_\\-]{20,}\\.[a-zA-Z0-9_\\-]{20,}\\b/);  return m ? m[0] : '';}let t = '';try {  for(let i=0; i<localStorage.length; i++){    let k = localStorage.key(i);    let v = localStorage.getItem(k);    t = findJwt(v) || findJwt(k);    if(t) return t;  }} catch(e){}try {  for(let i=0; i<sessionStorage.length; i++){    let k = sessionStorage.key(i);    let v = sessionStorage.getItem(k);    t = findJwt(v) || findJwt(k);    if(t) return t;  }} catch(e){}return '';})()`;

/** deepseek_web 专用：localStorage.userToken.value → {access_token}（APK DEEPSEEK_EXTRACT_JS）。 */
const DEEPSEEK_EXTRACT_JS = `(function(){try{if(location.origin!=='https://chat.deepseek.com')return '';var raw=localStorage.getItem('userToken');if(!raw)return '';var obj=JSON.parse(raw);if(!obj||typeof obj!=='object'||Array.isArray(obj)||typeof obj.value!=='string'||!obj.value.trim())return '';return JSON.stringify({access_token:obj.value.trim()});}catch(e){return '';}})()`;

function cookieStringForHosts(
  cookies: Electron.Cookie[],
  extractHosts: string[],
): string {
  const wanted = cookies.filter((c) => {
    const domain = (c.domain || "").replace(/^\./, "");
    return extractHosts.some(
      (h) => domain === h || domain.endsWith(`.${h}`) || h.endsWith(`.${domain}`),
    );
  });
  return wanted.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** 从 cookie 串提取凭据，顺序与 APK 一致：JWT → 具名 token（带长度/GA1./distinct_id 守卫）。 */
function extractFromCookies(allCookies: string): string {
  if (!allCookies) return "";
  const jwt = allCookies.match(JWT_RE);
  if (jwt) return jwt[0];
  const named = allCookies.match(TOKEN_COOKIE_RE);
  if (named?.[1]) {
    const val = named[1].trim();
    if (val.length >= 25 && !val.includes("distinct_id") && !val.startsWith("GA1.")) {
      return val;
    }
  }
  return "";
}

/**
 * 打开一次性登录窗并完成 webview 型供应商的凭据提取与入池。
 * 返回 {ok, account} 或 {ok:false, error}（closed/timeout/gw 未运行/提取失败）。
 */
export async function handleZkaliAllinLogin(
  payload: ZkaliAllinLoginRequest,
  deps: { logger: { info: (m: string, meta?: Record<string, unknown>) => void; warn: (m: string, meta?: Record<string, unknown>) => void } },
): Promise<ZkaliAllinLoginResponse> {
  const provider = String(payload?.provider || "").trim();
  const url = String(payload?.url || "").trim();
  const extractHosts = Array.isArray(payload?.extractHosts)
    ? payload.extractHosts.filter((h): h is string => typeof h === "string" && h.length > 0)
    : [];
  const extract = payload?.extract === "deepseek" ? "deepseek" : "generic";
  if (!provider || !/^https?:\/\//.test(url) || extractHosts.length === 0) {
    return { ok: false, error: "invalid-request" };
  }

  await ensureZkaliAllinGw(deps.logger);

  return new Promise<ZkaliAllinLoginResponse>((resolve) => {
    let settled = false;
    const finish = async (res: ZkaliAllinLoginResponse) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(timeout);
      try {
        if (win && !win.isDestroyed()) win.destroy();
      } catch {}
      resolve(res);
    };

    // 全新 in-memory partition：等价 APK 登录前清 cookie/存储，避免旧会话干扰。
    const ses = session.fromPartition(`allin-login-${provider}-${Date.now()}`, {
      cache: false,
    });
    const win = new BrowserWindow({
      width: 480,
      height: 780,
      autoHideMenuBar: true,
      title: "Allin 登录",
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenuBarVisibility(false);
    void win.loadURL(url);

    const tryExtract = async () => {
      if (settled || win.isDestroyed()) return;
      const wc = win.webContents;
      if (wc.isDestroyed() || wc.isCrashed()) return;
      let token = "";
      try {
        if (extract === "deepseek") {
          const raw = await wc.executeJavaScript(DEEPSEEK_EXTRACT_JS, true);
          if (typeof raw === "string" && raw) {
            try {
              const parsed = JSON.parse(raw) as { access_token?: string };
              if (parsed.access_token && parsed.access_token.length >= MIN_TOKEN_LEN) {
                token = parsed.access_token;
              }
            } catch {}
          }
        } else {
          const cookies = await ses.cookies.get({});
          token = extractFromCookies(cookieStringForHosts(cookies, extractHosts));
          if (!token) {
            const js = await wc.executeJavaScript(GENERIC_EXTRACT_JS, true);
            if (typeof js === "string" && js.length >= MIN_TOKEN_LEN) token = js;
          }
        }
      } catch {
        return; // 页面尚未就绪/已销毁，下一轮再试
      }
      if (token.length < MIN_TOKEN_LEN) return;

      const post = await handleZkaliAllinRequest({
        method: "POST",
        path: "/admin/accounts",
        body: {
          provider,
          access: token,
          type: "token",
          label: String(payload?.label || provider),
        },
      });
      if (post.status >= 200 && post.status < 300) {
        const account = (post.body as { account?: { id?: string; label?: string } } | undefined)
          ?.account;
        await finish({ ok: true, account: { id: account?.id || "", label: account?.label || provider } });
      } else {
        await finish({
          ok: false,
          error: typeof post.body === "object" && post.body !== null && "error" in post.body
            ? String((post.body as { error: unknown }).error)
            : `account post failed (${post.status})`,
        });
      }
    };

    win.webContents.on("did-navigate", () => void tryExtract());
    win.webContents.on("did-navigate-in-page", () => void tryExtract());
    const timer = setInterval(() => void tryExtract(), EXTRACT_INTERVAL_MS);
    const timeout = setTimeout(() => void finish({ ok: false, error: "timeout" }), LOGIN_TIMEOUT_MS);
    win.on("closed", () => void finish({ ok: false, error: "closed" }));
  });
}

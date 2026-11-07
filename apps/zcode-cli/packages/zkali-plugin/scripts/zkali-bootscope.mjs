#!/usr/bin/env node
/**
 * zkali-bootscope — Spring Boot 未授权路径探测（BootScope 浏览器扩展的 Node 移植）。
 *
 * 上游项目：XiaoRoan/BootScope（浏览器扩展，手动点选）。
 * 本文件把它的核心引擎（67 条路径字典 / 绕过+URL 编码变体 / 基线校准 /
 * SPA 回退与软 404 降噪 / 指纹命中判定）移植为 agent 可调用的 CLI：
 *
 *   node zkali-bootscope.mjs <baseUrl> [options]
 *
 * 仅做只读 GET 探测、默认不带 Cookie，判断"未授权可访问"；dangerous 端点
 * （shutdown 等）仍只发 GET，405 仅证明端点存在。
 *
 * 选项：
 *   --json <file>      结构化结果（findings+summary）落盘
 *   --md <file>        Markdown 报告落盘
 *   --csv <file>       CSV 落盘（BOM，Excel 中文兼容）
 *   --proxy <url>      http/https/socks5/socks5h 出口代理（可带 user:pass）
 *   --interval <sec>   每个路径 fuzz 后的间隔秒（>0 时强制串行，默认 0）
 *   --concurrency <n>  并发数（默认 5）
 *   --timeout <ms>     单请求超时（默认 8000）
 *   --budget <n>       请求预算上限（默认 1000）
 *   --variant-limit <n> 关键路径绕过变体上限（默认 30）
 *   --encoding-limit <n> 非关键 Actuator 编码变体上限（默认 16）
 *   --no-bypass        不跑绕过/编码变体，只跑直连
 *   --show-protected   stdout 的 findings 也包含受保护项（默认仅命中+受保护摘要）
 *   --header "K: V"    附加请求头（可重复；默认不带 Cookie）
 *   --insecure         跳过 TLS 证书校验（自签证书目标）
 *   -q, --quiet        抑制 stderr 进度
 *
 * stdout：JSON {summary, findings}（findings 默认=命中+受保护，--show-protected 无差别）。
 */
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { gunzipSync, inflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const VERSION = "1.0.0";
const USER_AGENT = "zkali-bootscope/1.0 (BootScope port)";

/* ============================ 路径字典（BootScope dict.js） ============================ */
/* category: actuator|api-docs|swagger|doc|druid · severity: critical|high|medium|info
 * key=直连失败跑完整绕过变体 · dangerous=状态变更端点仅 GET 探测 */
const DICT = [];
function add(category, path, name, severity, sig, opts = {}) {
  DICT.push({ category, path, name, severity, sig, key: !!opts.key, dangerous: !!opts.dangerous, note: opts.note || "" });
}
/* Actuator 2.x / 3.x */
add("actuator", "/actuator", "Actuator 索引", "high", "actuator_index", { key: true });
add("actuator", "/actuator/health", "Health", "info", "health");
add("actuator", "/actuator/info", "Info", "info", "info");
add("actuator", "/actuator/env", "Env 环境变量/配置", "critical", "env", { key: true });
add("actuator", "/actuator/configprops", "Configprops 配置项", "critical", "configprops", { key: true });
add("actuator", "/actuator/beans", "Beans", "high", "beans");
add("actuator", "/actuator/mappings", "Mappings 全量路由", "high", "mappings", { key: true });
add("actuator", "/actuator/metrics", "Metrics", "medium", "metrics");
add("actuator", "/actuator/loggers", "Loggers 日志级别", "high", "loggers");
add("actuator", "/actuator/threaddump", "Threaddump 线程栈", "high", "threaddump");
add("actuator", "/actuator/heapdump", "Heapdump 内存快照", "critical", "heapdump", { key: true });
add("actuator", "/actuator/httptrace", "Httptrace 请求记录", "high", "httptrace");
add("actuator", "/actuator/sessions", "Sessions 会话", "high", "sessions");
add("actuator", "/actuator/auditevents", "Auditevents 审计事件", "medium", "auditevents");
add("actuator", "/actuator/caches", "Caches 缓存", "medium", "caches");
add("actuator", "/actuator/scheduledtasks", "Scheduledtasks 定时任务", "medium", "scheduledtasks");
add("actuator", "/actuator/flyway", "Flyway 迁移", "medium", "flyway");
add("actuator", "/actuator/liquibase", "Liquibase 迁移", "medium", "liquibase");
add("actuator", "/actuator/jolokia", "Jolokia MBean", "critical", "jolokia", { key: true });
add("actuator", "/actuator/gateway/routes", "Gateway 路由", "critical", "gateway_routes");
add("actuator", "/actuator/logfile", "Logfile 日志文件", "critical", "logfile");
add("actuator", "/actuator/prometheus", "Prometheus 指标", "medium", "prometheus");
add("actuator", "/actuator/startup", "Startup 启动记录", "medium", "startup");
add("actuator", "/actuator/shutdown", "Shutdown 停机（仅只读探测）", "high", "shutdown", { dangerous: true });
/* Actuator 1.x */
add("actuator", "/env", "Env 1.x", "critical", "env", { key: true });
add("actuator", "/heapdump", "Heapdump 1.x", "critical", "heapdump", { key: true });
add("actuator", "/mappings", "Mappings 1.x", "high", "mappings");
add("actuator", "/jolokia", "Jolokia 1.x", "critical", "jolokia");
add("actuator", "/trace", "Trace 1.x", "high", "httptrace");
add("actuator", "/dump", "Dump 1.x 线程栈", "high", "threaddump");
add("actuator", "/beans", "Beans 1.x", "high", "beans");
add("actuator", "/configprops", "Configprops 1.x", "critical", "configprops");
add("actuator", "/loggers", "Loggers 1.x", "high", "loggers");
add("actuator", "/metrics", "Metrics 1.x", "medium", "metrics");
add("actuator", "/health", "Health 1.x", "info", "health");
add("actuator", "/info", "Info 1.x", "info", "info");
add("actuator", "/autoconfig", "Autoconfig 1.x", "medium", "autoconfig");
/* Swagger / OpenAPI */
add("api-docs", "/v2/api-docs", "Swagger 2 文档", "high", "swagger2", { key: true });
add("api-docs", "/v3/api-docs", "OpenAPI 3 文档", "high", "openapi3", { key: true });
add("api-docs", "/v3/api-docs.yaml", "OpenAPI 3 YAML", "high", "openapi_yaml");
add("api-docs", "/v3/api-docs/swagger-config", "Swagger 配置", "medium", "swagger_config");
add("api-docs", "/api-docs", "api-docs", "high", "swagger_any");
add("api-docs", "/apidocs", "apidocs", "high", "swagger_any");
add("api-docs", "/openapi.json", "openapi.json", "high", "swagger_any");
add("api-docs", "/openapi.yaml", "openapi.yaml", "high", "openapi_yaml");
add("api-docs", "/swagger.json", "swagger.json", "high", "swagger_any");
add("api-docs", "/v2/api-docs-ext", "knife4j 扩展文档", "high", "knife4j_ext");
add("swagger", "/swagger-ui.html", "Swagger UI", "medium", "swagger_ui", { key: true });
add("swagger", "/swagger-ui/index.html", "Swagger UI (springdoc)", "medium", "swagger_ui");
add("swagger", "/swagger-resources", "Swagger Resources", "medium", "swagger_resources");
add("swagger", "/swagger-resources/configuration/ui", "Swagger UI 配置", "info", "swagger_config");
add("swagger", "/swagger-resources/configuration/security", "Swagger 安全配置", "info", "swagger_config");
add("doc", "/doc.html", "knife4j 文档页", "high", "knife4j", { key: true });
add("doc", "/doc", "doc", "info", "doc_page");
add("doc", "/docs", "docs", "info", "doc_page");
add("doc", "/docs/index.html", "docs/index.html", "info", "doc_page");
add("doc", "/knife4j", "knife4j 入口", "medium", "knife4j");
/* Druid 监控 */
add("druid", "/druid/index.html", "Druid 监控首页", "high", "druid_index", { key: true });
add("druid", "/druid/login.html", "Druid 登录页", "medium", "druid_login");
add("druid", "/druid/websession.html", "Druid 会话", "critical", "druid_websession");
add("druid", "/druid/sql.html", "Druid SQL 监控", "critical", "druid_sql");
add("druid", "/druid/api.html", "Druid API", "high", "druid_api");
add("druid", "/druid/spring.html", "Druid Spring 监控", "medium", "druid_spring");
add("druid", "/druid/sqlwall.html", "Druid SQL 防火墙", "medium", "druid_sqlwall");
add("druid", "/druid/basic.json", "Druid 基础信息 JSON", "high", "druid_json");
add("druid", "/druid/websession.json", "Druid 会话 JSON", "critical", "druid_json");
add("druid", "/druid/sql.json", "Druid SQL JSON", "critical", "druid_json");

/* ============================ 变体生成（BootScope variants.js） ============================ */
function charHex(c, upper) {
  const h = c.charCodeAt(0).toString(16);
  return "%" + (upper ? h.toUpperCase() : h.toLowerCase());
}
function encodeAll(seg, upper) {
  let out = "";
  for (const ch of seg) out += /[A-Za-z0-9]/.test(ch) ? charHex(ch, upper) : ch;
  return out;
}
function firstCharEncode(p, upper) {
  return p.replace(/^\/([A-Za-z0-9])/, (m, c) => "/" + charHex(c, upper));
}
function lastCharEncode(p, upper) {
  const i = p.lastIndexOf("/");
  if (i < 0 || i + 1 >= p.length) return null;
  const c = p.charAt(i + 1);
  if (!/[A-Za-z0-9]/.test(c)) return null;
  return p.slice(0, i + 1) + charHex(c, upper) + p.slice(i + 2);
}
function middleCharEncode(p, upper) {
  const i = p.lastIndexOf("/");
  if (i < 0) return null;
  const seg = p.slice(i + 1);
  if (!seg) return null;
  let mid = Math.floor(seg.length / 2);
  if (!/[A-Za-z0-9]/.test(seg.charAt(mid))) {
    mid = -1;
    for (let k = 0; k < seg.length; k++) {
      if (/[A-Za-z0-9]/.test(seg.charAt(k))) { mid = k; break; }
    }
    if (mid < 0) return null;
  }
  return p.slice(0, i + 1) + seg.slice(0, mid) + charHex(seg.charAt(mid), upper) + seg.slice(mid + 1);
}
function encodeFirstSegment(p, upper) {
  const parts = p.split("/");
  if (parts.length < 2 || !parts[1]) return null;
  parts[1] = encodeAll(parts[1], upper);
  return parts.join("/");
}
function encodeLastSegment(p, upper) {
  const parts = p.split("/");
  const idx = parts.length - 1;
  if (idx < 1 || !parts[idx]) return null;
  parts[idx] = encodeAll(parts[idx], upper);
  return parts.join("/");
}
function encodeWhole(p, upper, slashSep) {
  const parts = p.split("/");
  for (let i = 1; i < parts.length; i++) parts[i] = encodeAll(parts[i], upper);
  if (slashSep) return "/" + parts.slice(1).join(slashSep);
  return parts.join("/");
}
function doubleEncode(s) {
  return s ? s.replace(/%/g, "%25") : s;
}
function genEncoding(path) {
  const out = [];
  const seen = new Set();
  const push = (v, label) => {
    if (!v || v === path || seen.has(v)) return;
    seen.add(v);
    out.push({ path: v, label });
  };
  push(firstCharEncode(path, false), "URL编码：首段首字符");
  push(lastCharEncode(path, false), "URL编码：末段首字符");
  push(middleCharEncode(path, false), "URL编码：末段中间字符");
  push(firstCharEncode(path, true), "URL编码：首段首字符（大写hex）");
  push(encodeFirstSegment(path, false), "URL编码：首段全编码");
  push(encodeLastSegment(path, false), "URL编码：末段全编码");
  push(encodeWhole(path, false, null), "URL编码：全路径（保留斜杠）");
  push(encodeWhole(path, false, "%2f"), "URL编码：全路径（斜杠 %2f）");
  push(encodeWhole(path, false, "%2F"), "URL编码：全路径（斜杠 %2F）");
  push(doubleEncode(encodeFirstSegment(path, false)), "双重URL编码：首段");
  push(doubleEncode(encodeLastSegment(path, false)), "双重URL编码：末段");
  push(doubleEncode(encodeWhole(path, false, null)), "双重URL编码：全路径");
  push(doubleEncode(encodeWhole(path, false, "%2f")), "双重URL编码：全路径+%2f");
  push("/%2e%2e%2f" + path, "URL编码：../ 前缀");
  push("/%252e%252e%252f" + path, "双重编码：../ 前缀");
  push("/..%2f" + path, "URL编码：..%2f 前缀");
  push("/..%252f" + path, "双重编码：..%252f 前缀");
  return out;
}
function genVariants(path) {
  const out = [];
  const seen = new Set();
  const push = (v, label) => {
    if (!v || v === path || seen.has(v)) return;
    seen.add(v);
    out.push({ path: v, label });
  };
  push(path + ";.js", "后缀 ;.js");
  push(path + ";", "后缀 ;");
  push(path + "/", "后缀 /");
  push(path + ";.css", "后缀 ;.css");
  push("/" + path, "前缀 //");
  push("/..;" + path, "前缀 ..;/");
  push("/;" + path, "前缀 /;/");
  push("/xxx/..;" + path, "前缀 xxx/..;/");
  push("/xxx/%2e%2e" + path, "前缀 xxx/%2e%2e");
  push("/%2e" + path, "前缀 /%2e");
  const i = path.indexOf("/", 1);
  if (i > 0) push(path.slice(0, i) + "/;" + path.slice(i), "段间 ;/");
  push(path + "%3b", "后缀 %3b");
  push(path + "%00", "后缀 %00");
  push(path + ".", "后缀 .");
  for (const v of genEncoding(path)) push(v.path, v.label);
  return out;
}

/* ============================ 指纹识别（BootScope detect.js） ============================ */
function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}
const has = (o, k) => !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const hasStr = (t, s) => typeof t === "string" && t.indexOf(s) !== -1;
const isHtml = (ct) => /text\/html|application\/xhtml/i.test(ct || "");
const isText = (ct) => /text\/plain|application\/octet-stream|application\/yaml|text\/yaml/i.test(ct || "");
function bytesStart(bytes, s) {
  if (!bytes || !bytes.length) return false;
  const n = Math.min(bytes.length, s.length);
  for (let i = 0; i < n; i++) if (bytes[i] !== s.charCodeAt(i)) return false;
  return n > 0;
}
function bytesPreview(bytes) {
  if (!bytes) return "";
  let out = "";
  for (let i = 0; i < Math.min(bytes.length, 16); i++) out += ("0" + bytes[i].toString(16)).slice(-2) + " ";
  return out.trim();
}
function textHash(s) {
  let h = 0x811c9dc5;
  s = s || "";
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}
function looksLikeBootError(text, status) {
  if (!text || status < 400) return false;
  return /"timestamp"\s*:/.test(text) && /"status"\s*:/.test(text) && /"path"\s*:/.test(text);
}
const preview = (t) => (t || "").replace(/\s+/g, " ").trim().slice(0, 180);
function pathOf(url) {
  try { return new URL(url).pathname; } catch { return ""; }
}
/* 软 404：基线与候选把各自路径替换为占位符后模板一致 → 丢弃。 */
function isSoft404(text, baselineText, res, baseline) {
  if (!text || !baselineText || !baseline) return false;
  const bp = baseline.path || "";
  if (!bp || baselineText.indexOf(bp) === -1) return false;
  const cp = pathOf((res && res.finalUrl) || "");
  if (!cp || cp === bp) return false;
  return baselineText.split(bp).join(" ") === text.split(cp).join(" ");
}
const SIG = {
  actuator_index: (r, t) => has(parseJson(t), "_links"),
  health: (r, t) => has(parseJson(t), "status") && !looksLikeBootError(t, r.status),
  info: (r, t) => {
    if (r.status !== 200) return false;
    const j = parseJson(t);
    if (!j || typeof j !== "object" || Array.isArray(j)) return false;
    return Object.keys(j).length === 0 ||
      has(j, "git") || has(j, "build") || has(j, "app") || has(j, "artifact") || has(j, "version");
  },
  env: (r, t) => hasStr(t, '"propertySources"') || (hasStr(t, '"profiles"') && hasStr(t, '"systemProperties"')),
  configprops: (r, t) => (hasStr(t, '"contexts"') && (hasStr(t, '"properties"') || hasStr(t, '"prefix"'))) || /"spring\.[a-z]/.test(t),
  beans: (r, t) => hasStr(t, '"beans"') && (hasStr(t, '"type"') || hasStr(t, '"scope"')),
  mappings: (r, t) =>
    (hasStr(t, '"contexts"') && (hasStr(t, '"mappings"') || hasStr(t, '"dispatcherServlets"'))) ||
    (hasStr(t, '"bean"') && hasStr(t, '"method"') && hasStr(t, '"patterns"')),
  metrics: (r, t) => {
    const j = parseJson(t);
    return (has(j, "names") && Array.isArray(j.names)) ||
      hasStr(t, '"counter.') || hasStr(t, '"gauge.') ||
      (hasStr(t, '"measurements"') && hasStr(t, '"name"'));
  },
  loggers: (r, t) => hasStr(t, '"loggers"') && hasStr(t, '"levels"'),
  threaddump: (r, t) => hasStr(t, '"threadName"') && (hasStr(t, '"threadState"') || hasStr(t, '"stackTrace"')),
  heapdump: (r, t) => bytesStart(r.bytes, "JAVA PROFILE") || hasStr(t, "JAVA PROFILE"),
  httptrace: (r, t) => {
    const j = parseJson(t);
    return hasStr(t, '"traces"') || (Array.isArray(j) && hasStr(t, '"timestamp"') && hasStr(t, '"path"'));
  },
  sessions: (r, t) => hasStr(t, '"sessions"'),
  auditevents: (r, t) => hasStr(t, '"events"') || hasStr(t, '"principal"'),
  caches: (r, t) => hasStr(t, '"cacheManagers"') || hasStr(t, '"caches"'),
  scheduledtasks: (r, t) => hasStr(t, '"cron"') || hasStr(t, '"fixedDelay"') || hasStr(t, '"fixedRate"'),
  flyway: (r, t) => hasStr(t, '"flywayBeans"') || (hasStr(t, '"contexts"') && hasStr(t, '"flyway"')),
  liquibase: (r, t) => hasStr(t, '"liquibaseBeans"') || (hasStr(t, '"contexts"') && hasStr(t, '"liquibase"')),
  jolokia: (r, t) => {
    const j = parseJson(t);
    return has(j, "agent") || has(j, "protocol") || has(j, "value");
  },
  gateway_routes: (r, t) => {
    const j = parseJson(t);
    if (has(j, "routes")) return true;
    return Array.isArray(j) && j.length > 0 && (has(j[0], "route_id") || has(j[0], "uri"));
  },
  logfile: (r, t) => r.status === 200 && isText(r.ct) && !isHtml(r.ct) && t.length > 0,
  prometheus: (r, t) => /# (HELP|TYPE) /.test(t) && (hasStr(t, "jvm_") || hasStr(t, "process_")),
  startup: (r, t) => hasStr(t, '"timeline"') || hasStr(t, '"springBootVersion"'),
  shutdown: (r) => r.status === 405,
  autoconfig: (r, t) => hasStr(t, '"positiveMatches"') || hasStr(t, '"negativeMatches"'),
  swagger2: (r, t) => hasStr(t, '"swagger"') && hasStr(t, '"paths"'),
  openapi3: (r, t) => hasStr(t, '"openapi"') && hasStr(t, '"paths"'),
  openapi_yaml: (r, t) => /(^|\n)\s*openapi\s*:/.test(t),
  swagger_config: (r, t) => hasStr(t, '"configUrl"') || hasStr(t, '"swagger-config"') || hasStr(t, '"validatorUrl"'),
  swagger_any: (r, t) => hasStr(t, '"swagger"') || hasStr(t, '"openapi"'),
  knife4j_ext: (r, t) => hasStr(t, '"swagger"') || hasStr(t, '"openapi"'),
  swagger_ui: (r, t) => isHtml(r.ct) && /swagger-ui-bundle|swagger-ui\.css|SwaggerUIBundle|Swagger UI/i.test(t),
  swagger_resources: (r, t) => hasStr(t, '"swaggerVersion"') || (hasStr(t, '"name"') && hasStr(t, '"url"')),
  knife4j: (r, t) => isHtml(r.ct) && /knife4j/i.test(t),
  doc_page: (r, t) =>
    isHtml(r.ct) && r.status === 200 &&
    (hasStr(t, "swagger") || hasStr(t, "openapi") || hasStr(t, "api-docs") || /<title>[^<]*(文档|API|Doc)/i.test(t)),
  druid_index: (r, t) => isHtml(r.ct) && /Druid Stat Index|StatViewServlet|Druid 监控/i.test(t),
  druid_login: (r, t) => isHtml(r.ct) && /druid/i.test(t) && /login|password|用户名|密码/i.test(t),
  druid_websession: (r, t) => isHtml(r.ct) && /druid/i.test(t) && /websession|Web Session|会话/i.test(t),
  druid_sql: (r, t) => isHtml(r.ct) && /druid/i.test(t) && /sql/i.test(t),
  druid_api: (r, t) => isHtml(r.ct) && /druid/i.test(t) && /api/i.test(t),
  druid_spring: (r, t) => isHtml(r.ct) && /druid/i.test(t) && /spring/i.test(t),
  druid_sqlwall: (r, t) => isHtml(r.ct) && /druid/i.test(t) && /wall/i.test(t),
  druid_json: (r, t) => hasStr(t, '"ResultCode"'),
};

function analyze(entry, res, baseline) {
  if (!res || !res.ok) {
    return { hit: false, kind: "error", evidence: res?.error ? res.error : "请求失败" };
  }
  const text = res.text || "";
  const status = res.status;
  if (baseline?.hash && status === baseline.status && textHash(text) === baseline.hash) {
    return { hit: false, kind: "baseline", evidence: "与不存在路径的响应一致（疑似 SPA 回退或全站统一拦截）" };
  }
  if (baseline && status === baseline.status && isSoft404(text, baseline.text, res, baseline)) {
    return { hit: false, kind: "soft-404", evidence: "与基线模板一致（疑似软 404）" };
  }
  if (res.redirected) {
    const u = String(res.finalUrl || "").toLowerCase();
    if (/(login|signin|sign_in|sso|cas|auth)/.test(u)) {
      return { hit: false, exists: true, protected: true, kind: "redirect-login", evidence: "跳转到登录页：" + res.finalUrl };
    }
  }
  if (status === 401 || status === 403) {
    return { hit: false, exists: true, protected: true, kind: "http-" + status, evidence: `HTTP ${status}（接口存在但受保护）` };
  }
  if (entry.sig === "shutdown" && status === 405) {
    return { hit: false, exists: true, protected: true, kind: "method-not-allowed", evidence: "HTTP 405（端点存在，仅支持 POST，已跳过）" };
  }
  const bootError = looksLikeBootError(text, status) || hasStr(text, "Whitelabel Error Page");
  if (status >= 400) {
    if (bootError) return { hit: false, kind: "boot-fingerprint", fingerprint: true, evidence: "Spring Boot 错误页特征" };
    return { hit: false, kind: "http-" + status, evidence: preview(text) };
  }
  if (status !== 200 && status !== 206) {
    return { hit: false, kind: "http-" + status, evidence: preview(text) };
  }
  const fn = SIG[entry.sig];
  let matched = false;
  if (fn) {
    try { matched = !!fn(res, text); } catch { matched = false; }
  }
  if (matched) {
    let ev = preview(text);
    if (!ev && res.bytes?.length) ev = "二进制响应，前 16 字节：" + bytesPreview(res.bytes);
    return { hit: true, kind: entry.sig, evidence: ev };
  }
  return { hit: false, kind: "no-match", evidence: preview(text) };
}

/* ============================ 代理隧道（与号池同款 CONNECT/SOCKS5） ============================ */
function parseProxyUrl(raw) {
  const u = new URL(raw);
  const scheme = u.protocol.replace(":", "").toLowerCase();
  if (!["http", "https", "socks5", "socks5h", "socks"].includes(scheme)) {
    throw new Error(`unsupported proxy scheme: ${scheme}`);
  }
  return {
    scheme: scheme === "socks" ? "socks5" : scheme,
    host: u.hostname,
    port: Number(u.port) || (scheme === "http" ? 80 : scheme === "https" ? 443 : 1080),
    user: decodeURIComponent(u.username || ""),
    pass: decodeURIComponent(u.password || ""),
  };
}
function readUntilHeadersEnd(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("proxy timeout")); }, timeoutMs);
    const onData = (c) => {
      chunks.push(c);
      const buf = Buffer.concat(chunks);
      if (buf.length > 65536) { clearTimeout(timer); socket.destroy(); reject(new Error("proxy response too large")); return; }
      if (buf.includes("\r\n\r\n")) { clearTimeout(timer); socket.off("data", onData); resolve(buf); }
    };
    socket.on("data", onData);
    socket.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
function socksHandshake(socket, proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("socks5 timeout")); }, timeoutMs);
    const done = (e) => { clearTimeout(timer); e ? reject(e) : resolve(); };
    socket.once("error", done);
    const greet = proxy.user ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
    socket.write(greet);
    socket.once("data", (resp) => {
      if (resp[0] !== 0x05) return done(new Error("socks5 bad greeting"));
      if (resp[1] === 0x02) {
        const u = Buffer.from(proxy.user), p = Buffer.from(proxy.pass);
        socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        socket.once("data", (ar) => {
          if (ar[1] !== 0x00) return done(new Error("socks5 auth failed"));
          sendConnect();
        });
      } else if (resp[1] === 0x00) sendConnect();
      else return done(new Error(`socks5 method rejected: ${resp[1]}`));
    });
    function sendConnect() {
      const hostBuf = Buffer.from(host);
      socket.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf,
        Buffer.from([port >> 8, port & 0xff]),
      ]));
      socket.once("data", (resp) => {
        if (resp[0] !== 0x05 || resp[1] !== 0x00) return done(new Error(`socks5 connect failed: ${resp[1]}`));
        socket.removeAllListeners("data");
        done();
      });
    }
  });
}
/** 直连返回明文 socket / TLS socket；代理则建隧道（HTTPS 目标再套 TLS）。 */
async function openTargetSocket(url, proxy, timeoutMs, insecure) {
  const host = url.hostname;
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  const isTls = url.protocol === "https:";
  let raw;
  if (!proxy) {
    raw = netConnect({ host, port });
  } else if (proxy.scheme === "http" || proxy.scheme === "https") {
    raw = proxy.scheme === "https"
      ? tlsConnect({ host: proxy.host, port: proxy.port, servername: proxy.host, rejectUnauthorized: !insecure })
      : netConnect({ host: proxy.host, port: proxy.port });
    await new Promise((res, rej) => {
      raw.once(proxy.scheme === "https" ? "secureConnect" : "connect", res);
      raw.once("error", rej);
    });
    const auth = proxy.user ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.user}:${proxy.pass}`).toString("base64")}\r\n` : "";
    raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    const head = await readUntilHeadersEnd(raw, timeoutMs);
    const statusLine = head.slice(0, head.indexOf("\r\n")).toString();
    if (!/^HTTP\/\d(?:\.\d)? 2\d\d/.test(statusLine)) {
      raw.destroy();
      throw new Error(`HTTP CONNECT failed: ${statusLine}`);
    }
  } else {
    raw = netConnect({ host: proxy.host, port: proxy.port });
    await new Promise((res, rej) => { raw.once("connect", res); raw.once("error", rej); });
    await socksHandshake(raw, proxy, host, port, timeoutMs);
  }
  if (!isTls) return raw;
  return tlsConnect({ socket: raw, servername: host, rejectUnauthorized: !insecure });
}

/* ============================ HTTP 探测（重定向跟踪 + 截断读取） ============================ */
function probeOnce(url, opts) {
  const { proxy, timeoutMs, insecure, headers } = opts;
  const isTls = url.protocol === "https:";
  const reqFn = isTls ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    const req = reqFn(
      {
        host: url.hostname,
        port: Number(url.port) || (isTls ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        agent: false,
        timeout: timeoutMs,
        rejectUnauthorized: !insecure,
        createConnection: () => openTargetSocket(url, proxy, timeoutMs, insecure),
        headers: {
          accept: "*/*",
          "accept-encoding": "identity",
          "user-agent": USER_AGENT,
          connection: "close",
          ...headers,
        },
      },
      (res) => resolve(res),
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ __error: e }));
    req.end();
  });
}
const MAX_REDIRECTS = 8;
function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
/** GET + 重定向跟随 + 正文截断读取（gzip/deflate 解压）。 */
async function fetchProbe(urlStr, maxBytes, opts, requestBudget) {
  if (requestBudget.count >= requestBudget.limit) {
    return { ok: false, status: 0, skipped: true, error: "已达请求上限" };
  }
  let current = urlStr;
  let hops = 0;
  let res = null;
  for (;;) {
    requestBudget.count++;
    const u = new URL(current);
    res = await probeOnce(u, opts);
    if (res.__error) return { ok: false, status: 0, error: res.__error.message };
    if (isRedirect(res.statusCode) && res.headers.location && hops < MAX_REDIRECTS) {
      hops++;
      res.resume?.();
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    break;
  }
  const status = res.statusCode ?? 0;
  const ct = res.headers["content-type"] || "";
  const chunks = [];
  let total = 0;
  try {
    for await (const c of res) {
      total += c.length;
      if (total <= maxBytes) chunks.push(c);
      else { res.destroy(); break; }
    }
  } catch { /* 连接中断按已收数据处理 */ }
  let bytes = Buffer.concat(chunks);
  const enc = String(res.headers["content-encoding"] || "").toLowerCase();
  if (enc === "gzip" || enc === "deflate") {
    try { bytes = enc === "gzip" ? gunzipSync(bytes) : inflateSync(bytes); } catch { /* 保留原始字节 */ }
  }
  return {
    ok: true,
    status,
    ct,
    text: bytes.toString("utf8"),
    bytes,
    finalUrl: res.url || current,
    redirected: hops > 0,
    xAppContext: res.headers["x-application-context"] || "",
    server: res.headers["server"] || "",
  };
}

/* ============================ 扫描编排 ============================ */
const DEFAULTS = {
  concurrency: 5,
  timeoutMs: 8000,
  budget: 1000,
  variantLimit: 30,
  encodingLimit: 16,
  intervalMs: 0,
  useBypass: true,
};
const maxBytesFor = (entry) =>
  entry.sig === "heapdump" ? 64 : entry.sig === "logfile" ? 8192 : 131072;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runPool(items, worker, concurrency) {
  let idx = 0;
  const workers = [];
  for (let i = 0; i < Math.max(1, concurrency); i++) {
    workers.push((async function loop() {
      for (;;) {
        const cur = idx++;
        if (cur >= items.length) return;
        await worker(items[cur], cur);
      }
    })());
  }
  await Promise.all(workers);
}

function makeFinding(entry, url, res, a, bypass, variant) {
  return {
    hit: !!a.hit,
    protected: !!a.protected,
    severity: a.hit ? entry.severity : "info",
    category: entry.category,
    name: entry.name,
    sig: entry.sig,
    path: entry.path,
    variant: variant || "",
    bypass: !!bypass,
    url,
    status: res?.status || 0,
    contentType: res?.ct || "",
    evidence: a.evidence || "",
    dangerous: !!entry.dangerous,
    note: entry.dangerous ? "状态变更端点，仅做只读探测" : "",
  };
}

async function scan(cfg, onProgress) {
  const budget = { count: 0, limit: cfg.budget };
  const findings = [];
  const fingerprints = new Set();
  let protectedCount = 0;
  let errorCount = 0;
  let done = 0;
  let total = DICT.length;
  const base = cfg.baseUrl;

  let hitCount = 0;
  const emit = (f) => {
    findings.push(f);
    if (f.hit) hitCount++;
    else if (f.protected) protectedCount++;
    onProgress?.({ done, total, hits: hitCount, requests: budget.count });
  };

  /* 基线：随机不存在路径，识别 SPA 回退 / 软 404 / 全站统一拦截 */
  const rand = Math.random().toString(36).slice(2, 10);
  const baselinePath = `/__zkbs_${rand}__`;
  const baselineRes = await fetchProbe(base + baselinePath, 65536, cfg, budget);
  if (!baselineRes.ok && baselineRes.status === 0) {
    throw new Error(`目标不可达：${baselineRes.error || "请求失败"}`);
  }
  const baseline = {
    status: baselineRes.status,
    ct: baselineRes.ct,
    hash: baselineRes.ok ? textHash(baselineRes.text) : "",
    path: baselinePath,
    text: (baselineRes.text || "").slice(0, 65536),
  };
  if (baselineRes.ok) {
    if (baselineRes.xAppContext) fingerprints.add("X-Application-Context: " + baselineRes.xAppContext);
    if (looksLikeBootError(baselineRes.text, baselineRes.status)) fingerprints.add("Spring Boot 错误 JSON");
    if ((baselineRes.text || "").includes("Whitelabel Error Page")) fingerprints.add("Whitelabel Error Page");
  }

  await runPool(DICT, async (entry) => {
    const url = base + entry.path;
    const res = await fetchProbe(url, maxBytesFor(entry), cfg, budget);
    done++;
    if (res.ok && res.xAppContext) fingerprints.add("X-Application-Context: " + res.xAppContext);
    if (res.skipped) { onProgress?.({ done, total }); return; }

    const a = analyze(entry, res, baseline);
    if (a.fingerprint) fingerprints.add("Spring Boot 错误页");
    if (a.hit || a.protected) emit(makeFinding(entry, url, res, a, false, ""));
    else if (!res.ok) errorCount++;

    /* 直连失败跑变体：key 路径全量绕过+编码；其余 actuator 仅编码子集 */
    let variants = [];
    if (cfg.useBypass && !a.hit &&
        (a.protected || !res.ok || res.status === 404 || res.status === 400 || res.status === 500)) {
      if (entry.key) variants = genVariants(entry.path).slice(0, cfg.variantLimit);
      else if (entry.category === "actuator") variants = genEncoding(entry.path).slice(0, cfg.encodingLimit);
      total += variants.length;
    }
    for (const v of variants) {
      const vUrl = base + v.path;
      const res2 = await fetchProbe(vUrl, maxBytesFor(entry), cfg, budget);
      done++;
      if (res2.skipped) { onProgress?.({ done, total }); continue; }
      const a2 = analyze(entry, res2, baseline);
      if (a2.hit) emit(makeFinding(entry, vUrl, res2, a2, true, v.label));
      else if (a2.fingerprint) fingerprints.add("Spring Boot 错误页");
      else if (!res2.ok) errorCount++;
      onProgress?.({ done, total });
    }
    if (cfg.intervalMs > 0) await sleep(cfg.intervalMs);
  }, cfg.concurrency);

  return {
    findings,
    summary: {
      base,
      requests: budget.count,
      hits: findings.filter((f) => f.hit).length,
      protected: protectedCount,
      errors: errorCount,
      fingerprints: [...fingerprints],
    },
  };
}

/* ============================ 报告（BootScope report.js 等价物） ============================ */
const sevLabel = (s) => (s === "critical" ? "严重" : s === "high" ? "高危" : s === "medium" ? "中危" : "信息");
const resultLabel = (f) => (f.hit ? "命中" : f.protected ? "受保护" : "信息");
const csvCell = (v) => `"${String(v ?? "").replace(/\r?\n/g, " ").replace(/"/g, '""')}"`;
const mdCell = (v) => String(v ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

function toCsv(results) {
  const head = ["severity", "result", "category", "name", "method", "status", "path", "variant", "bypass", "url", "content_type", "evidence", "note"];
  const lines = [head.map(csvCell).join(",")];
  for (const f of results) {
    lines.push([
      f.severity, resultLabel(f), f.category, f.name, "GET", f.status,
      f.path, f.variant, f.bypass ? "yes" : "", f.url, f.contentType, f.evidence, f.note,
    ].map(csvCell).join(","));
  }
  return "﻿" + lines.join("\r\n");
}
function toMarkdown(summary, results) {
  const md = ["# Spring Boot 未授权自检报告", "", `- 生成时间: ${new Date().toLocaleString()}`];
  if (summary) {
    md.push(`- BaseURL: \`${summary.base}\``);
    md.push(`- 请求数: ${summary.requests}`);
    md.push(`- 命中: ${summary.hits}，受保护: ${summary.protected}`);
    if (summary.fingerprints?.length) md.push(`- 指纹: ${summary.fingerprints.join(" / ")}`);
  }
  md.push("", "| 级别 | 结果 | 类别 | 方法 | 状态 | 路径 | 证据 |", "|---|---|---|---|---|---|---|");
  for (const f of results) {
    md.push(`| ${sevLabel(f.severity)} | ${resultLabel(f)} | ${mdCell(f.category)} | GET | ${f.status || ""} | \`${mdCell(f.variant || f.path)}\` | ${mdCell((f.evidence || "").slice(0, 180))} |`);
  }
  md.push("", "> 仅用于授权测试。401/403/405 不等于未授权；业务接口的 200 响应需人工确认是否为公开接口。");
  return md.join("\n");
}

/* ============================ CLI ============================ */
function normBase(input) {
  let s = String(input || "").trim();
  if (!s) throw new Error("缺少 BaseURL（如 https://host:port 或 https://host/app）");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
  const u = new URL(s);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("仅支持 http/https");
  let path = u.pathname || "";
  if (path === "/") path = "";
  path = path.replace(/\/+$/, "");
  return u.origin + path;
}

function parseArgs(argv) {
  const opts = { headers: {} };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--json": opts.jsonOut = next(); break;
      case "--md": opts.mdOut = next(); break;
      case "--csv": opts.csvOut = next(); break;
      case "--proxy": opts.proxy = parseProxyUrl(next()); break;
      case "--interval": opts.intervalMs = Math.max(0, Number(next()) * 1000); break;
      case "--concurrency": opts.concurrency = Math.max(1, Number(next()) || 5); break;
      case "--timeout": opts.timeoutMs = Math.max(1000, Number(next()) || 8000); break;
      case "--budget": opts.budget = Math.max(1, Number(next()) || 1000); break;
      case "--variant-limit": opts.variantLimit = Math.max(1, Number(next()) || 30); break;
      case "--encoding-limit": opts.encodingLimit = Math.max(1, Number(next()) || 16); break;
      case "--no-bypass": opts.useBypass = false; break;
      case "--show-protected": opts.showProtected = true; break;
      case "--insecure": opts.insecure = true; break;
      case "-q": case "--quiet": opts.quiet = true; break;
      case "--header": {
        const h = next();
        const idx = h.indexOf(":");
        if (idx < 1) throw new Error(`bad --header: ${h}`);
        opts.headers[h.slice(0, idx).trim().toLowerCase()] = h.slice(idx + 1).trim();
        break;
      }
      case "-h": case "--help": opts.help = true; break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        positional.push(a);
    }
  }
  opts.baseUrl = positional[0];
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(2);
  }
  if (opts.help || !opts.baseUrl) {
    process.stdout.write(`zkali-bootscope v${VERSION} — Spring Boot 未授权路径探测\n\n` +
      `usage: node zkali-bootscope.mjs <baseUrl> [--json f] [--md f] [--csv f] [--proxy url]\n` +
      `       [--interval s] [--concurrency n] [--timeout ms] [--budget n] [--no-bypass]\n` +
      `       [--show-protected] [--header "K: V"] [--insecure] [-q]\n`);
    process.exit(opts.help ? 0 : 2);
  }
  const cfg = { ...DEFAULTS, ...opts, baseUrl: normBase(opts.baseUrl) };
  if (cfg.intervalMs > 0) cfg.concurrency = 1;
  const log = opts.quiet ? () => {} : (s) => process.stderr.write(s);
  log(`[bootscope] target=${cfg.baseUrl} dict=${DICT.length} proxy=${cfg.proxy ? cfg.proxy.host : "none"}\n`);

  let result;
  try {
    result = await scan(cfg, (p) => {
      if (!opts.quiet && p.done % 10 === 0) {
        process.stderr.write(`\r[bootscope] ${p.done}/${p.total} hits=${p.hits ?? ""} req=${p.requests ?? ""}   `);
      }
    });
  } catch (e) {
    process.stderr.write(`\n[bootscope] scan failed: ${e.message}\n`);
    process.exit(1);
  }
  log(`\n[bootscope] done: ${result.summary.requests} req, ${result.summary.hits} hits, ${result.summary.protected} protected\n`);

  const allFindings = result.findings;
  const visible = opts.showProtected ? allFindings : allFindings.filter((f) => f.hit || f.protected);
  const payload = { summary: { ...result.summary, version: VERSION }, findings: visible };

  if (opts.jsonOut) {
    mkdirSync(dirname(resolve(opts.jsonOut)), { recursive: true });
    writeFileSync(opts.jsonOut, JSON.stringify({ summary: payload.summary, findings: allFindings }, null, 2));
  }
  if (opts.mdOut) {
    mkdirSync(dirname(resolve(opts.mdOut)), { recursive: true });
    writeFileSync(opts.mdOut, toMarkdown(result.summary, allFindings));
  }
  if (opts.csvOut) {
    mkdirSync(dirname(resolve(opts.csvOut)), { recursive: true });
    writeFileSync(opts.csvOut, toCsv(allFindings));
  }
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath.endsWith("zkali-bootscope.mjs")) {
  main().catch((e) => {
    process.stderr.write(`fatal: ${e.message}\n`);
    process.exit(1);
  });
}

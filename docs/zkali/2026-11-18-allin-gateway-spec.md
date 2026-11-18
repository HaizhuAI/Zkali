# zkali Allin 聚合网关 · 产品与技术规格

日期：2026-11-18 · 状态：已实现（2026-11-18 合入）

## 1. 目标

把 `All In 1.2.23` APK（`com.gaeul.allin`）内置的聚合网关整体移植进 zkali：
21+ 家供应商账号在设置页统一登录/授权/管理，网关在本机回环暴露
OpenAI/Anthropic 兼容端点，并自动注册为「Allin 聚合网关」模型供应商。
协议逆向产物位于 `D:\apk_work\sources\com\gaeul\allin\`（JADX 反编译）。

## 2. 组件与状态归属

```
settings UI (allinGw 设置页, 仅桌面)
   │  platform.zkaliAllinRequest  (IPC: zcode:zkali-allin-request)
   ▼
desktop main zkaliAllinGw.ts
   │  spawn/health-check + /admin 代理转发（authKey 不出主进程）
   ▼
zkali-allin-gw.mjs  ── 唯一状态所有者 ──► ~/.zcode/zkali-allin.json
   (zkali-plugin scripts, 零依赖 ESM, ~2240 行)   ~/.zcode/zkali-allin.state.json
   │                                             (port/authKey/pid，main+services 只读)
   ├─ /v1/models /v1/chat/completions /v1/messages (Anthropic 入站)
   ├─ /admin/* 供应商/账号/代理/分组/鉴权流（bearer=authKey）
   └─ 车道分发：LANES[lane](pid, account, model, body, wantStream, proxy)
         ▲
services zkaliAllinSeed.ts ── host bootstrap 时读取 state 文件，
                              把网关幂等 seed 成 personal Provider
                              「Allin 聚合网关」(openai-chat-completions)
```

- 单实例：state 文件 + `/health` 探测 + EADDRINUSE 自退；桌面 fork、
  CLI session-init 钩子都可启动，先到先得。
- authKey 只落在 `~/.zcode` 文件（0600）与主进程内存，不进 renderer/日志。
- seed 幂等锚点：providerName → authKey → 精确 baseUrl（不做任意 loopback
  匹配——OpenCodeZen 初版误收事故的根因教训）。

## 3. 供应商与车道

26 个供应商目录（`PROVIDERS`），7 类车道：

| 车道 | 供应商 | 协议要点（自 APK 逆向） |
|---|---|---|
| openai | zcode/agentmore/wenxin/meoo/runable/dangbei/tabbit/deepseek/siliconflow/openai/openrouter/tencent | OpenAI 兼容透传 + authScheme/quirks 头 |
| anthropic | anthropic | openai→/v1/messages 入站桥 + 回译 |
| codex | codex | →/responses（originator codex_cli_rs + chatgpt-account-id + session_id） |
| catpaw | catpaw(妙手) | 3 步 POST round/event/turn + m-spanid + Cookie X-Passport-Token |
| qoder | qoder_cn | COSY 签名：AES-128-CBC userBlob + RSA-PKCS1 wrap + Bearer COSY.{b64}.{md5chain} + ~15 cosy-* 头 |
| deepseek-web | deepseek_web | DeepSeekHashV1 PoW（Keccak 变体，23 轮，salt_expiry_answer==32B challenge）+ JSON-Patch 流帧 |
| antigravity | antigravity | loadCodeAssist→onboardUser→project→streamGenerateContent?alt=sse |
| workbuddy/workbuddy-ai | workbuddy, workbuddy-ai | Anthropic 风格 /v1/messages + x-api-key/x-user-id |
| trae | trae-cn | Cloud-IDE-JWT 头组 + trae-api-cn.mchost.guru |
| loomy | loomy | HmacSHA1 签名登录（canonical POST 串）+ GM3LOOMY appid |
| raccoon | raccoon | authorization_code → /login_with_authorization_code |
| copilot | github-copilot | device code → copilot_internal/v2/token + editor 头组 |
| cline | cline | WorkOS device flow → api.cline.bot |
| minimax | minimax-code | device code + PKCE → agent.minimax.cn/mavis |

## 4. 鉴权流引擎

`/admin/auth/start|poll|code` 三类：

- **device-poll**：start 返回 {flowId, authorizeUrl, userCode}；poll 间隔轮询至
  done/failed（copilot/cline/minimax/qoder/zcode/catpaw）。
- **code-paste**：start 返回 {flowId, authorizeUrl, instructions}；用户回贴
  code/回调 URL → code() 换 token（codex/antigravity/raccoon/trae/workbuddy/loomy）。
- **手动**：`/admin/accounts` 直贴凭据（任意供应商）；`/admin/keys` 批量 key 池
  （keyProvider 供应商）。

凭据统一入 `registerAccount(pid,{label,type,access,fields,proxy})`，敏感字段
经 `maskSensitive`/`redactSecret`/`redactProxyUrl` 后才出 admin API。

## 5. 账号池、代理与路由

- 每账号：UUID、label、type、access、fields（供应商私有）、proxy、enabled。
- 冷却：429→60s、401/403→120s、5xx→30s、网络错误→30s；round-robin 游标跳过冷却。
- 代理池：http CONNECT + socks5（账密）隧道；`/admin/proxies/assign` 一键轮询
  分配全部账号；`/admin/proxies/:id/test` 隧道自检（api.github.com:443）。
- 路由：`pid/model` 精确 → `groups[gid].targets` 按序回退 → bare model 全目录
  匹配 → auto 组兜底；`/admin/groups` PUT 整组覆写。
- 守卫：maxBodyBytes、requestTimeoutSeconds/connectTimeoutSeconds（cfg.guard）。
- 隐私：maskApiKeys/maskEmails/maskPhones/maskPasswords 脱敏（cfg.privacy）。

## 6. DeepSeekHashV1 PoW 移植要点

`D:\apk_work\...` 中 `DeepSeekHashV1`：Keccak-1600 海绵，rate 136B，pad 0x06，
**23 轮**置换（标准 keccak-f 为 24 轮），challenge = `salt_expiry_answer` 的
32 字节摘要须逐字节相等。JS 移植的关键坑：`BigInt64Array` 元素为有符号，
`x >> (64-n)` 算术右移带符号扩展、`x << n` 不掩码 —— `rotl64` 须先把
lane 归一化为无符号 64 位（`U64(x)`），否则高位置 lane 旋转结果全错。
修复后经 sha3-256 标准向量（空串/abc）验证通过。

## 7. 入站面

- `POST /v1/chat/completions`（stream / 非流式，聚合还原）
- `POST /v1/messages`（Anthropic 入站：body 回译 openai → 调度 → 回译 anthropic SSE/JSON）
- `GET /v1/models`：`pid/model` 组合 + groups 分组 id，共 136 项
- `GET /health`：探活
- `/admin/*`：state/models/providers/accounts/keys/auth/groups/quirks/proxies/config/enabled

## 8. 验收记录（2026-11-18）

- 网关独立冒烟：/health 200、/admin/state（enabled/providers:26/models:136）、
  /admin/keys 批量导入、/admin/accounts 建号、/admin/proxies 导入（坏行 skip）、
  /admin/enabled 开关（state stoppedAt 写回）全部通过。
- sha3-256 标准向量 PASS；solvePow 自洽 roundtrip PASS。
- typecheck 全绿、lint 0 errors、architecture:check 0 violations。
- 上游真实凭证未注入（无用户账号），各车道凭据注入点与头组按 APK 契约实现。

## 9. 限制

- 各车道上游调用未经真实凭证端到端验证（需用户自行登录账号）；协议字段均按
  APK 反编译逐字节复刻，运行时差异以实测为准。
- placeholder 供应商（agentmore/wenxin_web/meoo/runable/dangbei 等）baseUrl
  为 APK 占位推断，启用前需校验实际上游地址。

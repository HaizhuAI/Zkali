# zkali OpenCodeZen 免费号池 · 产品与技术规格

日期：2026-11-08 · 状态：已实现（2026-11-06 合入）

## 1. 目标

在 zkali 内集成 OpenCode Zen 免费模型号池：多 UUID 设备身份 + 独立出口代理 + 轮询调度，
对本机暴露 OpenAI 兼容端点，并自动注册为模型供应商，默认参与智能体。参考实现：
`TiaraBasori/opencode2api`（OpenAI 兼容网关）与 `cheaper-inference/OmniRoute`
（open-sse/executors/opencode*：指纹轮询、per-account 代理、冷却/健康）。

## 2. 上游契约（实测自 OmniRoute 源码注释）

- 端点：`https://opencode.ai/zen/v1`（chat/completions、responses、models）。
- 免费模型请求四要素，缺一返 403 FreeTierError：
  1. `stream: true`；
  2. 非空 `tools` 数组（"禁止使用工具"类提示词可 bare，网关做形状回退重试）；
  3. `x-opencode-session: ses_<12hex><14base62>`，12hex 时间部须满足
     `^[0-9a-f]{9}f[c-f][0-9a-f]$`（OpenCode CLI `Identifier.descending()` 计数窗口 0xFC0–0xFFF）；
  4. `User-Agent: opencode/<version>`，version ≥ 1.17（用 `opencode/1.18.31`）。
- "账号"= 设备指纹（uuid）。指纹独立 + 独立出口代理 → 配额相互独立。
- 非流式请求方：网关强制上游 stream，聚合 SSE 还原 JSON 响应。

## 3. 组件与状态归属

```
settings UI (opencodezenPool 设置页, 仅桌面)
   │  platform.zkaliOpencodeZenPoolRequest  (IPC: zcode:zkali-opencodezen-pool-request)
   ▼
desktop main zkaliOpencodeZenPool.ts
   │  spawn/health-check + /admin 代理转发（adminKey 不出主进程）
   ▼
zkali-opencodezen-pool.mjs  ── 唯一状态所有者 ──► ~/.zcode/zkali-opencodezen-pool.json
   (zkali-plugin scripts, 零依赖 ESM)              ~/.zcode/zkali-opencodezen-pool.state.json
   │                                              (port/adminKey/pid，main+services 只读)
   ├─ /v1/models /v1/chat/completions /v1/responses  (bearer=adminKey)
   └─ /admin/* 配置 CRUD（bearer=adminKey）
         ▲
services zkaliOpencodeZenSeed.ts  ── host bootstrap 时读取 state 文件，
                                     把网关幂等 seed 成 personal provider
                                     「OpenCodeZen 免费号池」(openai-chat-completions)
```

- 配置唯一所有者：池进程。UI/CLI/桌面只通过 admin API 写；`enabled` 持久化在池配置里。
- 单实例：state 文件 + `/health` 探测；桌面 fork、CLI session-init 都可启动，先到先得。
- adminKey 只落在 `~/.zcode` 文件（0600）与主进程内存，不进 renderer/日志。
- 种子 provider 幂等键：`api.baseUrl` 以 `http://127.0.0.1:` 开头且 providerName 匹配。

## 4. 轮询与冗余

- 轮询游标（内存）；账号 `cooldownUntil`/`consecutiveFails`；429 取 Retry-After（≤120s），
  网络错误 30s，403/FreeTier 60s；全部冷却时按最早解冻账号降级派发，无账号则 503。
- 失败重试：同请求在剩余健康账号间重放（上限=账号数，最多 3 次）；请求幂等（无状态上游）。
- 代理：`http/https` 走 CONNECT 隧道；`socks5/socks5h` 走 SOCKS5 CONNECT（支持 user:pass），
  隧道上再 TLS。代理解析失败 → 该账号本轮跳过（proxyUnavailable），不误伤其它账号。
- 超时：上游总超时 180s（可配 `requestTimeoutMs`），SSE 停顿看门狗 60s。
- 请求形状记忆：按 `model|promptHash` 记住 bare/tools 哪种被上游接受（LRU 64），
  403 时换形状重放一次。

## 5. 设置页（opencodezenPool，仅桌面可见）

- 启用开关、运行状态（端口/账号数/健康数/启动时间）。
- 设备表：uuid、备注、指派代理、健康/冷却、最近错误、请求/失败计数；添加（自动生成 uuid）、
  批量导入（每行一个 uuid）、删除、单设备连通性测试、代理指派下拉。
- 代理表：scheme://[user:pass@]host:port 导入（http/https/socks5/socks5h）、删除、
  「一键分配」把代理轮询指派给全部设备；解除指派。
- 模型目录展示（网关 /v1/models 返回，含上游同步 catalog + 内置回退）。
- zh-CN/en-US 双 locale。

## 6. 验收

- `pnpm typecheck`、`pnpm lint`（0 errors）、`pnpm architecture:check --changed` 通过。
- 池脚本单测级自检：uuid 生成、代理 URL 解析、session id 形状、轮询跳过冷却账号。
- 桌面端：设置页可增删设备/导入代理/一键分配；pool.state.json 生成；
  provider 列表出现「OpenCodeZen 免费号池」且 baseUrl/apiKey 正确。
- CLI：session-init 钩子可在无桌面时拉起池（同一份配置）。

## 7. 验收记录（2026-11-06）

- `pnpm typecheck` 全绿（root + desktop remote-main + zcode-cua）；`pnpm --dir apps/zcode-cli typecheck` 34/34 包通过。
- `pnpm lint` 0 errors（85 存量 warning）；`pnpm --dir apps/zcode-cli lint` 0 errors。
  唯一新增例外：`adapters/src/plugins/index.ts` 上游存量超 800 行登记 `.oxlintrc.json` warn 档。
- `pnpm architecture:check --changed` 0 violations（新文件经 `zkali-opencodezen-pool-module` 例外登记）。
- 网关端到端冒烟（临时 HOME + 独立端口）：`/health` OK；`/admin/*` 无 Bearer 401；
  账号创建返回独立 uuid；代理导入跳过 `badline` 并报 `Invalid URL`；`/admin/assign`
  一键为 2 账号指派 2 代理；`/admin/state` 中 `socks5://u:p@` 脱敏为 `***:***`。
- `/v1/models` 实拉上游返回 80 个模型，全部带 `context_window`（上游无值时按前缀表估值并标
  `context_window_estimated`，Provider seed 据此写 `contextWindow` 元数据）。
- 会话头生成器输出匹配 `ses_` + 递减计数窗口正则；UA 固定 `opencode/1.18.31`。

## 8. 上游契约修正（2026-11-08，v1.1.0）

实测 OpenCode 上游行为修正初版假设，网关按真实契约重写：

- **车道迁移**：免费档已从 `/zen/v1` 迁至 `https://opencode.ai/inference/openai/v1`
  （OmniRoute `opencodeFreeTierContract.ts` 同源结论）。zen 车道对免费请求一律
  `FreeUsageLimitError`——用户报告的"全部 429"主因之一（另一因见下）。
- **匿名凭证**：inference 车道要求 `Authorization: Bearer public`（官方客户端
  匿名车道凭证，opencode2api 同款字面量）；初版网关未发 Authorization 属契约缺陷。
- **目录分流**：`/inference/v1/models` 返回 per-model `cost`/`limit`/`api.*.base_url`
  真值。`cost.text.*.price===0` 即免费档（实测 10 个：big-pickle、beam-free、
  flint-40b-free、mimo-v2.6-flash-free、nemotron-3.5-{super-vl,lightning}-free、
  deepseek-v4.1-flash-free、glm-5.3-flash-free、{pulse,crouton}-alpha-free）；
  `limit.context` 取代前缀估值成为 context_window 真值。
- **配额维度实测**：配额校验先于会话校验——垃圾 ses_/无 ses_/合法 ses_ 同出口
  一律 429，证明配额按**出口 IP** 计。设备指纹保身份稳定性，出口代理保配额独立性。
- **会话标识**：`x-opencode-session` 改为 canonical `ses_`（与 opencode2api v1.3.8
  `CanonicalSessionID` 逐字节一致：sha256 种子 → 36bit ts → `~(ts<<12|1)` →
  12hex+14base62），按"设备uuid+客户端会话亲和"定种子，同会话稳定（prompt-cache
  亲和）；附 `x-opencode-client/project/request` 全套头。
- **付费档**：非免费模型未配 `zenApiKey` 时直接 402 拒付不烧号池；`PATCH /admin/config`
  可写入 zenApiKey（adminState 只回显 `zenApiKeySet`）。
- **FreeUsageLimitError 提示**：未分配代理的设备吃到配额错误时，lastError 追加
  "出口 IP 配额耗尽"指引；新增 `POST /admin/proxies/:id/test` 隧道自检区分
  "代理死了"与"配额耗尽"（实测用户的 socks5 出口即为 handshake timeout）。
- **Provider seed 修复（真实事故根因）**：旧版 `isSeedProvider` 用
  `^http://127\.0\.0\.1:\d+/v1` 匹配任意回环 Provider，把用户自有「千问夸克版」
  (127.0.0.1:18788, sk-quark) 覆写成号池绑定。新锚点=名称精确/adminKey 指纹/
  网关精确地址；池绑定 rule 改名归一 + 凭据刷新；成员名单收敛为免费目录
  （缺补/失效删）；`pool-not-running` 重试 8×15s + fs.watch 监听启停重 seed。
- 手工修复记录：千问夸克版已按 provider_config.json.bak.20261017 恢复原始
  baseUrl/key/models；`OpenCodeZen 免费号池` Provider（id: opencodezen-pool）
  已带 10 个免费模型 + 真实 contextWindow 写入配置。

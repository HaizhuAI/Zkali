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

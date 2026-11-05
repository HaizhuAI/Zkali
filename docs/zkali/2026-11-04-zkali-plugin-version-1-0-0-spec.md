# zkali 内置安全团队插件 version 1.0.0

## 目标与边界

zkali 是面向授权安全工程场景的内置官方插件：逆向分析、CTF 解题、授权渗透
（红队视角）、蓝队防御/取证/检测、源码审计、安全实验室工作流。它把"团队式
多智能体协同"作为默认工作方式内置到发行版，不要求用户逐个启用插件或点名
调用。

边界：插件本身不携带漏洞武器库、不内置第三方逆向套件；它提供的是编排、
方法论技能、受控工具执行与作战日志。真实工具（ghidra/jadx/nmap 等）由目标
机环境提供，`zkali_detect` 只做存在性探测，`zkali_run` 只执行白名单二进制。

## 构成

```text
apps/zcode-cli/packages/zkali-plugin/
├── .zcode-plugin/plugin.json   # skills/commands/agents/mcpServers 声明；hooks 走约定路径
├── agents/                     # 9 个子智能体：recon/reverse/pwn/web/ctf/audit/red/blue/proxy
├── skills/                     # 10 个技能：kernel 总纲 + 8 域手册 + lab 工作区规范
├── commands/                   # /recon /reverse /pwn /ctf /audit /redops /engagement
├── hooks/hooks.json            # SessionStart → session-init.mjs（约定路径自动发现）
└── scripts/
    ├── session-init.mjs        # 编排协议注入 + 作战目录初始化 + 武器矩阵探测
    ├── cmd-journal.mjs         # PostToolUse 异步命令日志
    └── zkali-toolbox.mjs       # 零依赖 MCP：detect / run(白名单) / crypto / journal
```

## 注册与启用

- `OFFICIAL_PLUGIN_DEFINITIONS`（bootstrap）新增 `zkali` 条目，
  `defaultEnabled: true`，`requiredSeedPaths` 钉住 manifest/hooks/scripts 关键文件，
  `rootCandidates` 覆盖开发树与 SEA 资源目录。
- `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`（shared）同步加入
  `zkali@zcode-plugins-official`，两处定义保持机械对照（单测强制）。
- 用户可在设置中禁用该插件；禁用后所有 agent/skill/command/hook/MCP 一并卸载，
  系统提示词中的团队调度段不含任何插件文件路径假设，不产生悬挂引用。

## 自动协同的注入链路（三层冗余，按优先级）

```text
系统提示词层  identity.ts SECURITY_NOTICE 追加团队调度段
              → provider-visible 稳定段，每请求常驻，无文件依赖
Hook 层       SessionStart → session-init.mjs
              → 建作战目录（recon/loot/exploits/findings/notes/.zkali）
              → 输出编排协议 + 实时武器矩阵到 additionalContext
发现层        agents/*.md description 写清 whenToUse
              → Agent 工具按域自然路由
```

任务下发时主 agent 判域 → `Agent(subagent_type=zkali-*)` 并行下发 → 子智能体
回报 → 主线汇总到 findings。三层任一失效（如用户关 hook）其余两层仍成立。

## MCP 安全契约

- `zkali_run` 只执行内置白名单二进制，参数以数组透传、无 shell 拼接；
  超时默认 120s 上限 900s；stdout/stderr 截断 256KB，可选落盘 `.zkali/output/`。
- `zkali_detect` 只读探测 PATH 上工具存在性，按域分类返回。
- `zkali_crypto` 为纯本地 CTF 编码/散列/XOR/爆破/频分工具，无网络。
- `zkali_journal` 追加写 `.zkali/journal/`，路径限定在工作区内。
- MCP 启动命令为 `node`，args 经 `${CLAUDE_PLUGIN_ROOT}` 模板解析。
  桌面版由 Electron node-fallback shim 兜底；无系统 node 的 SEA/远程目标机
  需要 node 可用或按 mcp-node-fallback 规则处理（如实文档，不宣称全平台免 node）。

## 验收

| 场景 | 必须断言 | 证据 |
|---|---|---|
| 插件发现 | `zcode plugins list` 含 zkali@zcode-plugins-official 且 enabled | CLI 集成验证 |
| 组件加载 | skills 10 / commands 7 / agents 9 全部出现且无 schema 警告 | plugins validate |
| 编排注入 | 新会话 additionalContext 含子智能体清单与作战目录 | hook 输出 |
| MCP 握手 | initialize + tools/list 返回 4 个工具；crypto 工具实测 | 协议冒烟 |
| 白名单 | `zkali_run` 拒绝非白名单命令；白名单命令正常执行 | MCP 冒烟 |
| 降级 | 禁用插件后无 agent/skill/command 残留引用 | plugins list |
| SEA | SEA 产物资源内含 zkali-plugin 文件且插件正常加载 | 打包后运行 |

## 验证记录（2026-11-04）

- plugin.json / hooks.json / marketplace.json JSON 解析通过。
- session-init.mjs / cmd-journal.mjs / zkali-toolbox.mjs `node --check` 通过。
- toolbox MCP 协议冒烟（直接 node 起）：initialize→tools/list→crypto hash 实测通过。
- `zcode plugins list` 端到端：待构建产物后执行（本节如实记录，未跑不宣称）。

---

# zkali 发行版定制（2026-11-05 追加）

## 更名：ZCode → zkali（保留 zcode 账号登录体系）

- 展示层产品名改为 `zkali` / `zkali Preview`：桌面 `productName`、appId
  （`dev.zkali.app` / `dev.zkali.app.preview`）、Linux executable/package 名、
  NSIS 产物名、SEA 产物文件名（`outputBinaryName` → `zkali-<platform>-<arch>`）、
  桌面主进程与 i18n 面向用户的品牌文案（`ZCode Protocol` 协议名与
  `X-ZCode-*` 请求头属服务端契约，保留不改）。
  npm `bin` 名维持 `zcode`：私有包不经 npm 分发，bin 名不构成用户面。
- **不改的管道面**：`zcode://` deep link scheme（OAuth 回调依赖，改名即断登录）、
  `zcode.z.ai` 端点、`ZCODE_*` 环境变量、`~/.zcode` 数据目录、JWT 凭据键、
  `@zcode/*` 包名、`__zcode-plugin-host`、marketplace ID `zcode-plugins-official`。
- 结果：登录 z.ai/BigModel 账号体系原样工作，安装包/窗口/可执行名是 zkali。

## 免费额度自动领取

- 官方链路：marketing-touch 轮询拿到含 `claim_zcode_plan` 动作的投放
  （左下角 banner 或 popup），用户点击后 execute → 安全校验 →
  `POST /api/v1/zcode-plan/billing/claim`。
- 本发行在 `MarketingTouchProvider` 轮询收口处自动执行该动作：已登录态下
  banner/popup 出现 claim 动作即复用同一 controller 状态机
  （verifying→submitting→成功结果弹窗→权益刷新）完成领取，
  不再等用户点击。controller 新增 `bannerAction(action)` 按动作精确执行
  （`clickBanner` 的「第一个非 close 按钮」语义不能保证命中 claim）。
  未登录不触发（避免反复弹登录）；claim 终态失败码
  （1001-1005）由 controller 原逻辑清掉 banner，瞬时失败下轮重试。
- 单一事实源不变：仍是服务端 deliveries；没有第二条 claim 链路。
- 开源版 request-security-edition 为空实现（校验头 {}），claim 仅需 JWT+plan_id。

## 作业内核预置（universal-kernel-v31）

- 内核正文（277,189 B）以生成模块 `packages/shared/src/zkali/universalKernel.ts`
  嵌入（JSON 字符串字面量，不依赖 fs/Buffer，renderer/CLI 双端可用）。
  源头文件 `D:\Devin\haizhu\prompts\builtin\universal-kernel-v31.md`，
  重生成命令记录在 BUILD.md。
- **个性化指令层**：`~/.zcode/AGENTS.md` 缺失或为空时，
  CLI `resolveUserInstructions` 注入内核作为 user-scope 指令源；
  桌面 `getUserInstructions` 同样兜底返回内核（编辑器显示预置正文，
  用户编辑保存后其文件内容生效）。用户文件非空即用户优先。
- **系统提示词层**：context builder 在 identity 段后追加
  `Universal Kernel` 段（`injectionTarget: "system"`、`cacheHint: "stable"`），
  内核全文常驻系统提示词。仅默认身份路径注入：`customSystemPrompt`
  与 `workflowActor` 路径不叠加（前者用户全控，后者是脚本执行体）。
- **容量**：`USER_INSTRUCTIONS_MAX_BYTES` 与 CLI `DEFAULT_MAX_BYTES`
  由 100KB 同步上调至 512KB（内核 271KB + 工作区 AGENTS.md 头部余量）。
  代价如实记录：内核全文约 8-10 万 token/请求，出现在系统提示词与用户
  指令两处；关闭方式 = 在 `~/.zcode/AGENTS.md` 写入任意非空内容
  （个性化层停用），系统提示词层为发行固定行为。

## 自动领取防重复修复 + 设置开关（本轮）

- **Bug 根因**：此前轮询里见到 claim 动作即触发 `bannerAction`；结果为
  uncertain（提交后无法确认）时 controller 清 banner，但下轮 refresh 服务端
  重投同一 campaign → banner 重建 → 再次提交 → 再弹「无法确认操作结果」，
  无限循环。
- **修复语义**：只在投放「出现」时自动提交一次。
  `autoClaimStateRef` 记录 `lastActiveKey`（position:campaign_id）与
  `exhausted` 集合；同一投放停留期间不重复触发；结果/错误弹窗在屏
  （pending、error）不追加提交；success / uncertain / terminal
  结果的 campaign 记入 exhausted，本 session 永不再自动提交；
  投放消失后再次出现视为新出现，可再触发一次（瞬时 failure 的重试通道）。
  ref 挂在 Provider 组件层，controller 随依赖重建时记录不丢失。
- **设置开关**：store 新增 `zkaliAutoClaim`（默认开，`zkali-auto-claim`
  localStorage，broadcast 跨窗口同步）；通用设置页新增
  `ZkaliFeatureSection`（zkali 功能区），内含自动领取开关。

## 沉浸式主题（Dream Skin 适配）

- 参考 Codex-Dream-Skin「一张图一种心情」：主题 = 配色氛围 + 配对壁纸 +
  半透明玻璃面板。`Theme` 新增 `zkali-dream`（梦境极光·紫）、
  `zkali-cyber`（赛博终端·绿）、`zkali-nightops`（暗夜行动·蓝），
  均 resolve 为 dark。
- `applyTheme` 改为遍历应用类名表（`theme-zkali-*` 与 zai 类同级互斥）；
  桌面/Web 启动 boot 块同步识别 `zkali-*` 存储值；
  `WebRemoteControlThemeSeed` 联合类型同步扩展（远控/Web 链路不丢主题）。
- styles.css：每个主题一套不透明基座变量（无壁纸也完整可读）；
  `html.zkali-wallpaper.theme-zkali-*` 覆盖层把侧栏/头部/面板/卡片/标签
  换成半透明色，并对 `.bg-sidebar|.bg-header|.bg-panel|.bg-card` 加
  backdrop blur——壁纸从面板后透出，浮层（popover/menu/tooltip）
  保持不透明保证可读性。
- 主题↔壁纸联动：`THEME_WALLPAPER_PAIRS`（dream→neon-horizon、
  cyber→signal-rain、nightops→hex-mesh），外观页选主题即整套生效，
  用户仍可在壁纸区另行调整。主题选择器由 3 项扩为 6 项（i18n 双语）。

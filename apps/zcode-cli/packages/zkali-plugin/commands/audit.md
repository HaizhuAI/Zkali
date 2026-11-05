---
description: 源码审计：入口枚举→source→sink 数据流→分语言危险模式→依赖与密钥面→带行号漏洞报告
argument-hint: "<代码目录|仓库路径> [语言]"
---
对目标执行代码审计作战（参考 zkali-audit 技能）：$ARGUMENTS

流程：
1. 结构轮：技术栈+信任边界+输入面清单。
2. 数据流轮：source→sink 逐条跟踪，跨层才成立。
3. 模式轮：分语言危险信号 grep 扫面回验；依赖版本比对 CVE；密钥/历史泄露面。
4. 产出 `findings/audit-<repo>.md`：文件:行号+数据流+触发条件+PoC+严重度；可疑未确认单列。

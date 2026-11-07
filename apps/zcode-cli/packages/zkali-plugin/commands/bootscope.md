---
description: Spring Boot 未授权端点测绘：Actuator/Swagger/knife4j/Druid 探测+绕过变体+基线降噪，产出分级命中清单与报告
argument-hint: "<目标URL> [--proxy 代理] [--fast 仅直连] [--save 存报告]"
---
对目标执行 Spring Boot 端点测绘（参考 zkali-bootscope 技能）：$ARGUMENTS

流程：
1. 解析参数：目标 URL 必填；`--fast`→`no_bypass`；`--proxy <url>`→代理出口；`--save`→`save_report`。
2. 调 `zkali_bootscope` 扫描；Java/Spring 指纹不明时先 `zkali_run` httpx 验栈可选。
3. 解读结果：critical 端点逐条给利用链建议（env 读密钥、heapdump 拉取离线挖、jolokia MBean、druid 会话、mappings/api-docs 接口矩阵）。
4. 每条命中 `zkali_journal` 记录；`--save` 时报告落 `.zkali/output/bootscope-*/`。
5. 收尾：把 mappings/api-docs 发现的接口面派给 zkali-web 继续测。

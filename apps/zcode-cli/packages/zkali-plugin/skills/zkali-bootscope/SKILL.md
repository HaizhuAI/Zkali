---
name: zkali-bootscope
description: Spring Boot 未授权路径探测——Actuator 2.x/1.x、Swagger/OpenAPI、knife4j、Druid 端点测绘，含绕过变体与基线降噪，输出分级命中清单与报告。
---

# BootScope 端点测绘手册

内置工具 `zkali_bootscope`（MCP）= BootScope 引擎 Node 移植。对 **Java/Spring 目标**或指纹不明的 Web 目标，拿端点面先用它跑一轮，比 ffuf 盲跑快且自带误报降噪。

## 何时用

- httpx/指纹显示 Spring Boot、Tomcat、Jetty、Java、Whitelabel Error → 直接跑。
- 未知栈的 Web 目标做初步端点测绘 → 也值得跑（67 条字典很小，30 秒出结果）。
- `/env`、`/heapdump`、`jolokia`、`druid`、`api-docs`、`doc.html` 这类高价值端点是重点。

## 调用

```
zkali_bootscope target="https://app.example.com"          # 标准测绘（约 650 请求）
zkali_bootscope target="https://app.example.com/api"      # 带 context-path
zkali_bootscope target="..." no_bypass=true               # 快速直连（68 请求）
zkali_bootscope target="..." proxy="socks5://h:1080"      # 走代理出口
zkali_bootscope target="..." interval_s=0.3               # 限速（防 WAF 触发）
zkali_bootscope target="..." save_report=true cwd="<工作区>"  # 报告落 .zkali/output/
zkali_bootscope target="..." headers=["Cookie: session=x"]   # 认证态探测
```

## 结果解读

- `hit=true`：指纹确认的未授权可访问端点，按 severity 处理：
  - **critical** `env`/`configprops`：读 propertySources 拿密钥/数据源 → 交给凭证利用链。
  - **critical** `heapdump`：让 agent `zkali_run` curl 拉全量 dump，离线 `strings`/`JDumpSpider` 挖密码。
  - **critical** `jolokia`：MBean 列 `jolokia/list`，查 `logback`/`createJNDIRealm` 类 RCE 链。
  - **critical** `gateway_routes`：可读路由表，进一步测 route 注入（POST 才可写，需授权确认）。
  - **critical** `druid_websession/sql`：会话劫持 → 伪造 session 进 Druid → SQL 监控看语句。
  - **high** `mappings`：全量路由表 = 隐藏接口清单，喂给下一步参数/IDOR 探测。
  - **high** `swagger2`/`openapi3`/`knife4j`：下载 API 文档解析全接口，生成测试矩阵。
- `protected=true`（401/403/跳登录/405）：端点存在但设防——记录，绕过变体已自动跑过；仍有价值（标记防护边界）。
- `fingerprints`：即使零命中，`Spring Boot 错误 JSON`/`Whitelabel`/`X-Application-Context` 也证明栈是 Spring Boot，换打法（如 Actuator 不在根路径——试常见前缀 `/api/actuator`、`/manage/actuator` 重跑 target 带 context-path）。

## 联动

- 命中 env/configprops → `zkali_journal` 记为 credential 类发现，提取的 key 走 `zkali_crypto` 解码。
- 命中 heapdump → 拉取后交 `zkali-reverse`/`zkali-pwn` 做凭证提取。
- `mappings`/`api-docs` 产出接口清单 → 派 `zkali-web` 逐接口测注入/越权。
- 全部发现必须 `zkali_journal` 落盘；`save_report=true` 的 md/csv 直接进 SRC 报告。

## 边界

- 只发只读 GET，默认不带 Cookie；`shutdown` 等状态变更端点只探存在性（405 证明存在），绝不发 POST。
- 预算默认 1000 请求上限；对 WAF 敏感目标开 `interval_s` 限速 + `proxy` 出口。

---
name: zkali-web
description: Web/API 渗透方法论——攻击面枚举、漏洞验证矩阵、提权链、PoC 规范。授权 Web 渗透与 CTF Web 使用。
---

# Web 渗透作战手册

## 攻击面四步

1. **指纹**：server header、技术栈 cookie（PHPSESSID/JSESSIONID/.AspNet）、前端框架、WAF 存在性（恶意字符探针看响应码跳变）。
2. **端点**：JS 文件提取 API 路径、`robots.txt`/`sitemap.xml`、wayback 历史、fuzz 目录（ffuf `-w raft-medium -fc 404`）。
3. **参数**：URL 参数+POST body+cookie+header（X-Forwarded-For、Referer、User-Agent 全是输入面）+隐藏参数（arjun）。
4. **认证面**：登录/注册/找回/SSO/JWT/Session 固定/验证码逻辑。

## 验证矩阵（每输入点逐行过）

| 类别 | 判别依据 | 首选 payload |
|---|---|---|
| SQLi | 报错回显/布尔差/时间差 | `'` `"` `')` `or 1=1--` `and sleep(5)` |
| SSTI | 算术回显 | `{{7*7}}` `${7*7}` `<%=7*7%>` `*{7*7}` |
| XSS | 上下文回显 | `"><svg onload=alert(1)>` 按上下文闭合 |
| 命令注入 | 时间差/OOB | `;sleep 5` `|sleep 5` `$(sleep 5)` `` `sleep 5` `` |
| SSRF | 出网回连/内网响应差 | `http://127.0.0.1` `file:///etc/passwd` 云元数据 `169.254.169.254` |
| LFI/路径 | 文件内容回显 | `../`×8 `php://filter/convert.base64-encode/resource=` |
| XXE | 实体回显/OOBE | `<!ENTITY x SYSTEM "file:///etc/passwd">` |
| 反序列化 | 特征格式 | `O:4:"`/`rO0`(java b64)/`__reduce__`(pickle) |
| IDOR | 改 ID 越权 | 换 uid/order_id/doc_id 看归属 |
| 文件上传 | 双扩展/MIME/路径 | `.php.jpg`/`phar`/`.htaccess`/二次渲染绕过 |

## 提权链思路

单点低危 → 链式高危：JS 泄露密钥→API 未授权→IDOR 拉数据→找回逻辑缺陷→账号接管→垂直越权→注入→RCE。每步落 `findings/`。

## 工具速查

`zkali_run`：ffuf（目录/参数/vhost，`recursion` `rate`）、nuclei（`-tags cve,exposure`）、sqlmap（`-u` `--data` `--technique B,T` `--level` `--risk`，确认后 `--os-shell`/`--dump`）、dalfox、arjun、hydra（表单爆破 `-l/-P` `http-post-form`）、nikto、wpscan。抓包：mitmdump 脚本或 `curl -x http://proxy` + `-v` 手工重放。

## PoC 规范

每个漏洞：请求原文、预期响应、判别依据、复现脚本（curl/python）、严重度+一行修复。不许只交"疑似存在"。

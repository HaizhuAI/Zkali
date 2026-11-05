---
name: zkali-recon
description: 侦察与攻击面测绘——被动 OSINT、子域/端口/指纹/目录枚举、AD 信息收割、云暴露面，输出假设矩阵。
---

# 侦察作战手册

## 被动层（不触目标）

- 证书透明度：crt.sh `%%.domain` → 子域。
- 聚合 DNS：subfinder/amass passive、`gau`/`waybackurls` 历史 URL。
- 搜索引擎语法：site:/inurl:/intitle: + GitHub 代码搜索（org 名 + `password`/`key`/`token`）。
- 泄露面：公开存储桶、Pastebin 类、员工邮箱格式（theHarvester）。

## 主动层

- 子域：subfinder + 纯爆破（dnsx + 字典）→ 合并去重。
- 探活：httpx（标题/状态码/技术栈/TLS 信息，`-tech-detect -title -status-code`）。
- 端口：naabu/masscan 快速面 → nmap `-sV -sC` 精准服务识别。
- 路径：ffuf `-w raft-medium-words.txt -fc 404`；参数 arjun；爬取 katana。

## AD/内网层

- `nxc smb <cidr>` 存活+签名；`enum4linux-ng`/`rpcclient` 用户枚举；`ldapsearch`/`bloodhound-python` 收关系。
- kerberos 用户枚举（kerbrute userenum）；GetUserSPNs（kerberoast 面）。

## 云/容器面

- 子域接管（CNAME 悬空检测）、bucket 枚举（公司名±env/dev/backup）、K8s API 暴露（6443/10250）、元数据 SSRF 面。

## 输出规范

`recon/attack-surface.md`：

| 资产 | 指纹 | 假设弱点 | 验证命令 | 交接 |
|---|---|---|---|---|
| app.x.com | nginx+PHP | LFI/反序列化 | `ffuf/phpinfo` | zkali-web |

- 每条资产必须落到"交给谁打"：Web→zkali-web、服务→zkali-red、二进制→zkali-reverse、源码→zkali-audit。
- 扫描结果原文存 `recon/` 原始文件，不许只存结论。

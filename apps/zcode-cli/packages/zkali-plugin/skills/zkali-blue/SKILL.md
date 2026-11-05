---
name: zkali-blue
description: 蓝队防御分析——取证链、时间线重建、IOC 提取、YARA/Sigma/Suricata 检测规则、ATT&CK 映射与加固。
---

# 蓝队作战手册

## 取证链

- **内存**（volatility3）：`windows.info` → `pslist`/`pstree`（异常父子关系）→ `malfind`（注入）→ `netscan`（连接）→ `cmdline`/`dlllist` → `dumpfiles`/`memmap` 提取样本 → `hashdump`/`lsadump`。
- **磁盘**：MFT/USRnJrnl（时间线）、注册表 hive（Run/Services/UserAssist/ShimCache/AmCache）、Prefetch、事件日志（evtx：`Security 4624/4625/4688`、`Sysmon 1/3/7/10/11/22`）、浏览器史、计划任务、服务。
- **PCAP**：`tshark -r x.pcap -q -z conv,tcp` 会话概览 → 协议分流 → `--export-objects http,smb` 提取载荷 → DNS 异常（长子域/TXT 回包）→ JA3 指纹。

## 时间线模板

| 时间 | 事件 | 证据源 | MITRE | 置信度 |
|---|---|---|---|---|
| T0 | 钓鱼邮件落地 | MFT+邮件头 | T1566 | 高 |
| T1 | 宏执行 spawn | Sysmon 1 | T1204 | 高 |

按 initial access→execution→persistence→privilege→credential→discovery→lateral→collection→exfil→impact 归位。

## 检测规则

- **YARA**：选静态稳定特征（字符串/导入表组合/pe 结构），`condition` 里做 3 条以上特征 AND，写 meta 说明捕捉的行为，评估误报面（常见 DLL/签名二进制的特征排除）。
- **Sigma**：`logsource`（product/category/service）→ `detection`（selection+condition）→ 转后端（splunk/elk 说明）。优先行为型（`Image=*/rundll32* AND CommandLine contains http`）而非易变 IOC。
- **Suricata**：`alert tcp $HOME_NET any -> $EXTERNAL_NET any (msg:...; content:"..."; sid:xxx)`，特征取载荷稳定段。

## IOC 处理

IOC 表分三档：易变（IP/域名/hash —— 快查快封）、半稳定（UA/URI 路径/证书/Mutex —— 检测主力）、行为（TTP —— 规则与 hunt）。IOC 即 `zkali_journal ioc` 落盘。

## 溯源与加固

C2 画像：基础设施（ASN/注册商/历史解析/被动 DNS）、样本同源（imphash/ssdeep/TLSH/代码复用）、TTP 映射 ATT&CK → 归因到组织（置信度分级写明）。
加固输出：每条攻击路径 → 阻断点（补丁/配置/检测/分段），给可执行命令级建议。

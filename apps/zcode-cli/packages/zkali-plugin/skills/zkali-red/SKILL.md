---
name: zkali-red
description: 授权红队作战方法论——杀伤链各阶段技术选项、凭据收割、代理链与通道、AD 攻击面、红蓝闭环交付。
---

# 红队作战手册

> 适用：授权攻防演练、内网渗透评估、靶场（HTB/OffSec/Vulnhub）。范围外资产一律记入"理论可达"不动手。

## 杀伤链技术选项

### 1. 初始立足
Web 入口（zkali-web）/凭据喷射（spray：一个密码打多个账号，注意锁定阈值）/服务漏洞/文档载荷。立足后第一件事：**通道稳定性**（计划任务/服务/启动项选其一轻量持久化；评估期不要多写）。

### 2. 本地提权
- Windows：`whoami /priv`（SeImpersonate→Potato 族）、服务弱 ACL、unquoted path、AlwaysInstallElevated、补丁缺失（winPEAS/winexploit 思路）、存储凭据（cmdkey/unattend.xml）。
- Linux：`sudo -l`（GTFOBins）、suid（`find / -perm -4000`）、cron 可写、NFS no_root_squash、内核 CVE（按发行版精确选）、容器（docker.sock/lxc 组/特权→逃逸）。

### 3. 凭据收割
lsass 思路（procdump→离线解析）、SAM/SECURITY hive、`mimikatz` 族、浏览器凭据、配置文件 grep（`password`/`pwd`/`secret`）、ssh key、`~/.aws`。收割即 `zkali_journal credential` 落盘。

### 4. 内网测绘与横向
- 探测：`nxc smb <cidr>`、存活（ICMP/ARP/445/22）、`bloodhound-python`/`SharpHound` 收 AD 关系 → 最短路径到 DA。
- 横向：凭据/哈希复用（PtH：`impacket-psexec -hashes`/`nxc --sam`）、票据（kerberoast→GetUserSPNs→hashcat；AS-REP roast）、winrm/ssh 跳转、计划任务远程。
- AD 攻击面：ACL 滥用（GenericAll/WriteDacl→ShadowCredentials/targeted kerberoast）、ADCS（ESC1-ESC8→certipy）、委派（unconstrained/constrained/RBCD）、组策略密码（cpassword）。

### 5. 通道与代理
多级代理思路：chisel（`server --reverse`+`client socks`）、ligolo-ng（TUN 接口全网段）、ProxyCat 思路（多级 socks/http 轮换）。出网受限：DNS/ICMP 封装、CDN/域前置思路。Web 通道：webshell→reGeorg/Neo 思路做内网穿透。

## 蓝队对抗意识

每步自问：这个动作在 EDR/日志里长什么样？高噪操作（扫描/爆破/dump）少做、慢做、换通道做。文件落地前先想能不能内存执行（rundll32 思路/反射加载概念）。所有 IOC 自己先记账，交给蓝队复盘。

## 交付闭环

`findings/redops-<date>.md`：攻击路径图（资产→手法→证据）+ 每步可复现命令 + 被检测点自评 + 未验证分支 + IOC 清单（给 zkali-blue 出检测规则）。

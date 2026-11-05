---
name: zkali-ctf
description: CTF 全题型解题手册——分类判据、各域武器链、常见套路索引、writeup 规范。拿到题目先按本文定类。
---

# CTF 解题手册

## 30 秒定类

看附件和描述：有 URL→web；有二进制+nc→pwn；有代码+参数→crypto；有二进制无 nc→reverse；图片/压缩包/流量→misc/forensics；有"签到"→按要求提交。

## Web

指纹→JS 端点→参数面。常见考点：SSTI（`{{7*7}}`/`<%=7*7%>`）、文件包含（`php://filter` 读源码）、反序列化（PHP `O:`/`java`/`pickle` 特征）、SQLi（报错/布尔/时间）、模板逻辑（JWT none/弱密钥、ID 越权）、SSRF（`file://`/内网/元数据）、任意文件读（`../`、绝对路径、备份后缀）。nuclei 先扫已知 CVE 模板。

## Pwn

`checksec` → 保护全开表 → 逆向找洞。套路索引：ret2text/ret2libc（leak+system）、ret2csu、栈迁移、格式化串（%n 写/%s 泄）、堆（tcache dup/unsorted leak/house of 系列）、IO_FILE（vtable/fsop）、seccomp 限制下的 orw（open-read-write）。libc 版本用泄露地址查 libc.rip / libc-database。

## Crypto

- **RSA**：小 e/共模/相关明文/维纳攻击（d 小）/coppersmith/p+q 泄露/多素数/同模不同指数。`zkali_crypto int_convert` 转参数。
- **对称/分组**：ECB 逐字节、CBC 翻转/padding oracle、CTR 重放 keystream。
- **编码套娃**：`zkali_crypto` decode 循环（base64→hex→rot→atbash→morse 常见组合）；`freq` 看重合指数判断单表/多表替换（IC≈0.066 单表，≈0.038 多表→维吉尼亚 kasiski）。
- **自造轮**：逆运算逐位回推；z3 约束求解（`solver.add` 建约束）。
- **格/曲线**：LLL 思路（fpylll）、ECC 小阶/无效曲线/Smart 攻击。

## Reverse

flag 校验函数优先：找 `correct`/`wrong`/`flag` 字符串 → xref → 精读校验逻辑 → 还原算法 → z3 或穷举出输入。动态偷懒法：gdb 断比较点直接看期望值；Frida hook strcmp。

## Misc / Forensics

- 隐写：`exiftool` 元数据 → `binwalk -e` 提取 → `zsteg`（png）/`steghide`（jpg）→ 音频（频谱/SSTV）→ 文件头修复。
- 压缩包：伪加密（标志位 09→00）、弱口令（john/zip2john）、明文攻击（bkcrack）。
- PCAP：`tshark -Y` 过滤 → 导出对象（`--export-objects`）→ 协议字段重组 flag（DNS 子域/ICMP data/USB 键盘）。
- 内存：`vol3 -f mem windows.info` → pslist/netscan/malfind/dumpfiles/hashdump。
- 取证文件系统：已删文件（photorec/extundelete 思路）、MFT、浏览器 SQLite。

## 解题纪律

1. 每题一目录 `loot/<题号>/`：附件、脚本、flag、推理笔记。
2. 假设驱动：写"我赌 X 因为 Y"，3 次失败换轨。
3. flag 到手 `zkali_journal`：`finding [题号] flag{...} + 关键一步`。
4. writeup：定性→洞察→解题链→脚本→flag，队友能复现。

---
description: CTF 解题模式：自动定类（web/pwn/crypto/reverse/misc/forensics）→ 对应作战链 → writeup
argument-hint: "<题目描述|附件路径|URL> [题号]"
---
进入 CTF 解题作战（参考 zkali-ctf 技能）：$ARGUMENTS

流程：
1. 30 秒定类：看附件/描述/URL → 选解题链（web→注入矩阵、pwn→checksec、crypto→结构识别、reverse→校验函数、misc→编码/隐写/流量、forensics→vol3/tshark）。
2. `zkali_detect` 确认武器库；每题建 `loot/<题号>/`。
3. 假设驱动推进，3 次失败换轨；`zkali_crypto` 处理编码/哈希/xor/频率分析。
4. flag 到手 → `zkali_journal` 记录 → `findings/writeup-<题号>.md`。

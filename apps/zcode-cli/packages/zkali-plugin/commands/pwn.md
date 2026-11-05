---
description: 二进制漏洞利用开发：checksec→漏洞→原语→利用链→pwntools 脚本，本地打通再打远程
argument-hint: "<二进制路径> [远程 host:port]"
---
对目标做 exploit 开发（参考 zkali-pwn 技能）：$ARGUMENTS

流程：
1. `checksec`+`file` 列保护表；逆向输入面定漏洞类型。
2. 定读/写原语 → 泄露基址 → 构造利用链（ROP/堆风水/格式化串/IO_FILE）。
3. 写 `exploits/solve_<name>.py`（pwntools，每步注释栈布局）。
4. 本地打通→远程打通→取 flag/执行证明。
5. `zkali_journal` 记哈希/libc 版本/偏移/思路；产出 `findings/pwn-<bin>.md`。

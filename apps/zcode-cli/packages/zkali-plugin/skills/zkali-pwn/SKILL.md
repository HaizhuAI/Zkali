---
name: zkali-pwn
description: 二进制漏洞利用——保护机制判读、漏洞原语、栈/堆/格式化串/IO_FILE 利用链、pwntools 工程规范。
---

# Pwn 作战手册

## 保护机制判读

`checksec --file=bin`：Canary（栈溢出需泄露）、PIE（需泄露基址）、NX（需 ROP）、RELRO（Full→不能改 GOT；Partial→可改）、FORTIFY（部分危险函数有长度检查）、Seccomp（`seccomp-tools dump` 看允许的 syscall → orw 套路）。

## 漏洞原语速查

| 洞 | 读原语 | 写原语 |
|---|---|---|
| 栈溢出 | 溢出读栈上残留/格式化串 | 覆盖 retaddr → ROP |
| 格式化串 | `%p`/`%s` 读任意 | `%n`/`%hn`/`%hhn` 写任意 |
| UAF | 释放后读残留指针 | 释放后写函数指针/内容 |
| 堆溢出 | 越界读 chunk 数据 | 改 size/fd/bk → 任意分配 |
| 整数溢出 | — | 长度计算错误 → 堆/栈溢出 |
| 类型混淆 | 错误解读成员 | 控制虚表/函数指针 |

## 利用链套路

- **无 PIE 无 Canary**：溢出 → ret2text/backdoor；ret2syscall（int 0x80/syscall gadget）。
- **有 PIE**：先泄露（格式化串/puts@plt→libc/elf base），计算基址再 ROP。
- **ret2libc**：`puts(puts@got)` → 回 main → libc base → `system("/bin/sh")` 或 one_gadget（满足约束寄存器）。
- **栈迁移**：空间不够 → `leave; ret` 迁移到可控 buffer（bss/heap）。
- **堆**：tcache poisoning（改 fd→任意地址分配）、unsorted bin leak（libc/heap 地址）、fastbin dup、house of 系列（按 glibc 版本剪枝：2.31 加对齐检查，2.32 加 fd 加密，2.34 tcache 计数）。
- **格式化串**：先 `%p.%p` 数偏移找可控参数位置 → `%n` 改写 GOT/返回地址；栈上有指针链可做任意写。
- **IO_FILE**：篡改 `_IO_2_1_stdout_` 泄露 libc；FSOP 打 `_IO_list_all`/vtable 劫持（新版 glibc 有 vtable 校验 → FILE_complete/exit_handlers/内存钩）。
- **内核**：先泄 cred/commit_creds 地址 → 栈溢出/modprobe_path/core_pattern 套路；kaslr 泄露靠 /proc/kallsyms 或侧信道。

## pwntools 工程规范

```python
from pwn import *
context.binary = e = ELF("./chall"); context.log_level = "debug"
libc = ELF("./libc.so.6")
p = process("./chall")          # remote("host", port) 一键切换
rop = ROP(e)
# 每个 payload 注释：这一步在干什么、预期栈布局
p.sendlineafter(b"> ", flat(b"A"*off, rop.chain()))
p.interactive()
```

- `exploits/solve_<name>.py` 落盘；本地通→远程通→整理。
- debug 技巧：`gdb.attach(p)` 断关键地址；`context.terminal` 配置终端；`core = p.corefile` 分析崩溃。

## 交付

脚本 + 注释栈布局图 + `findings/pwn-<bin>.md`（保护表→洞→原语→链→flag）。远程打不通交本地 PoC + 差异假设。

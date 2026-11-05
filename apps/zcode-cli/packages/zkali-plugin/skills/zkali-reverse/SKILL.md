---
name: zkali-reverse
description: 逆向工程方法论——原生二进制、APK/Java、.NET、IL2CPP、固件、协议、混淆还原。搭配 rea 插件的 Ghidra/JADX/Cutter 桥与 zkali-toolbox 白名单执行。
---

# 逆向工程作战手册

## 第一步：定性质（30 秒定性，决定整条路线）

| 目标 | 判定命令 | 路线 |
|---|---|---|
| PE | `file` / `diec` / `strings` | IDA/x64dbg/Ghidra；.NET 先 `strings` 找元数据特征 |
| ELF | `file` `readelf -h` `checksec` | Ghidra/r2 + gdb |
| APK | `apktool d` / `jadx -d out` | jadx 看 Java，lib/*.so 走原生路线 |
| IL2CPP | `Il2CppDumper` + global-metadata | 还原符号后当普通 so 逆 |
| 固件 | `binwalk -Me` | 提取→文件系统→二进制/web 界面/服务 |
| 协议 | 抓包 + `tshark -V` / 客户端 hook | 分帧→字段推断→状态机→parser |
| 脚本/字节码 | `.pyc`→uncompyle6/decompyle3；`.class`→cfr/jd | 反编译后当源码审 |

## 静态三板斧

1. **字符串驱动**：`strings -a` + xref → 关键功能入口（错误信息/flag 文本/URL/密钥常量）。
2. **导入表驱动**：加密找 AES/RSA 常量表，网络找 send/recv/SSL_write，反调找 IsDebuggerPresent/ptrace。
3. **伪码精读**：Ghidra `analyzeHeadless -postScript` 批量导出或 rea 插件桥；重点函数画调用链。magic number 必须追到常量来源。

## 动态三板斧

1. **Frida**：hook 函数打印入参/出参/返回；内存搜特征；`frida-trace` 批量打桩。
   模板：`frida -l hook.js -f <target>` / `frida -p <pid>`。hook.js 骨架写在 `exploits/`。
2. **调试器**：gdb `b *func`、`x/32xb` 看内存；验证静态结论（"这个参数到底是不是 key"）。
3. **流量对照**：协议题把客户端发出去的包和 hook 到的加密前 buffer 对照，定位加密封装点。

## 还原与验证

- 算法还原 = 独立实现 + 测试向量。实现放 `exploits/`（CTF）或 `recon/`（实战），用原文输出对拍。
- 结构还原 = C 结构体/JSON schema/协议格式文档 + 生成-解析回环。
- 交付底线：函数地图（地址→作用）+ 关键偏移表 + 可运行还原代码 + 复现命令。

## 卡壳处理

| 障碍 | 对策 |
|---|---|
| 加壳（UPX/商业壳） | 先 `upx -d` 试；dump 运行内存（frida-scrIp/ESI 插件/手动 dump）；r2 或 pe-sieve 重建 |
| 混淆/控制流平坦化 | 动态路径覆盖 + 输入输出对表；不硬啃反混淆，先求功能等价 |
| 反调试 | 换注入点（early→late）、内核级绕过思路、静态补动态 |
| 虚拟化保护 | 只还语义不还结构：handler 输入输出表 + 黑盒模拟器 |
| 缺工具 | `zkali_detect` 看有什么；没有 Ghidra 用 r2 `aaa`+`pdf`，没有 jadx 用 apktool+smali 阅读 |

## 工具对照速查

`zkali_run` 白名单已含：file/strings/nm/objdump/readelf/rabin2/r2/radare2/rizin/cutter/analyzeHeadless/gdb/checksec/binwalk/exiftool/upx/apktool/jadx/dex2jar/baksmali/aapt/adb/frida/frida-ps/frida-trace/objection/javap/jd-cli/cfr/ILSpyCmd/de4dot/yara/capa/floss/pe-sieve/openssl/python 等。

装了 rea 插件时：rea 的 MCP 桥接工具（Ghidra/JADX/Cutter 深度操作）优先于手工命令；其 `reverse-engineer-anything` skill 含各平台细化手册，逆向开始前值得载入。

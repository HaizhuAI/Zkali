---
description: 逆向分析目标：定性质→静态→动态→算法/协议还原，产出可运行实现+函数地图
argument-hint: "<二进制|APK|协议|样本路径>"
---
对目标执行逆向工程作战（参考 zkali-reverse 技能，装了 rea 插件优先用其桥接工具）：$ARGUMENTS

流程：
1. `file`/`rabin2`/apktool 定性质，选路线。
2. 静态：字符串/xref/导入表→关键函数伪码，画函数地图。
3. 动态：Frida hook / gdb 断点 / 抓包对照，验证静态结论。
4. 还原：算法→独立实现+测试向量；协议→parser+回环验证。
5. 交付：`findings/re-<目标>.md`（函数地图+关键偏移+还原说明），实现代码落 `exploits/`。

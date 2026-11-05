---
name: zkali-lab
description: 作战工作区规范——目录结构、证据管理、复现 harness、日志纪律、报告输出。所有项目开工与收尾都按本文执行。
---

# 作战工作区规范（zkali-lab）

## 目录契约（SessionStart hook 自动创建）

```
<engagement>/
├── recon/         # 侦察原始数据：扫描输出、资产清单、假设矩阵
├── loot/          # 战利品：凭据、flag、提取的文件、样本（按目标/题号分目录）
├── exploits/      # 武器：exploit 脚本、payload、hook 脚本、还原实现
├── findings/      # 结论文档：漏洞报告、分析笔记、writeup
├── notes/         # 过程草稿：推理链、试错记录
├── screenshots/   # 证据截图
└── .zkali/
    ├── journal/   # 作战日志（hook+工具自动追加）
    └── output/    # zkali_run save_output 落盘
```

## 证据纪律

- 原样原则：扫描/抓包/导出的原始数据先存 `recon/` 或 `loot/` 原文，再分析。结论可错，证据不能丢。
- 样本哈希：拿到二进制第一件事 `sha256sum`（或 `zkali_crypto hash`）记 journal。
- 每条关键命令自动进日志（PostToolUse hook）；手动补记用 `zkali_journal`（finding/ioc/credential/note/todo）。

## 复现 harness

- 每个 exploit/PoC 头部注释：目标、版本、依赖、用法、预期输出。
- 远程脚本必须带参数化和超时重连；本地复现环境优先（docker compose / 本地二进制）。
- 还原实现必须配测试向量：原始输入输出对 ≥3 组。

## 报告输出

- 渗透：`findings/report-<target>-<date>.md` —— 摘要→范围→方法→漏洞表（严重度+证据+修复）→攻击路径→附录（日志/命令）。
- CTF：`findings/writeup-<题号>.md` —— 定性→洞察→链→脚本→flag。
- 逆向：`findings/re-<样本>.md` —— 函数地图→关键偏移→算法还原→复现脚本→IOC。
- 红蓝对抗：红队出 `redops-<date>.md`（路径+IOC），蓝队出 `ir-<date>.md`（时间线+规则+盲区）。

## 交接清单（收尾检查）

- [ ] 所有发现都进了 `findings/` 且有证据
- [ ] 凭据/flag/IOC 都 `zkali_journal` 落盘
- [ ] exploit 脚本可直接运行（路径/依赖写明）
- [ ] 日志完整可还原操作序列

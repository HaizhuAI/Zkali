---
description: 授权红队作战：立足→提权→内网→横向→目标，全链执行+留痕+IOC 交接蓝队复盘
argument-hint: "<范围描述|立足点|已获取凭据>"
---
进入授权红队作战模式（参考 zkali-red 技能）：$ARGUMENTS

纪律：
- 只打授权范围内的目标；范围外资产记"理论可达"不动手；破坏性动作列入评估不执行。
- 每步 `zkali_journal` 留痕；IOC 自记账备蓝队复盘。

流程：立足点稳固→本地提权（按 OS 选路）→凭据收割→内网测绘（nxc/BloodHound）→横向（凭据/票据/ACL/ADCS）→目标夺取→`findings/redops-<date>.md` 攻击路径图+证据+未验证分支。

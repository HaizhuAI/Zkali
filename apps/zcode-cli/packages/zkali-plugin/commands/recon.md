---
description: 对目标做攻击面测绘：子域→探活→端口→指纹→路径→假设矩阵，产出 recon/attack-surface.md
argument-hint: "<域名|IP|网段|组织名>"
---
对目标执行完整侦察作战（参考 zkali-recon 技能）：$ARGUMENTS

流程：
1. `zkali_detect`（recon+web）确认武器库。
2. 被动层（证书透明度/wayback/GitHub 泄露）→ 主动层（子域爆破→httpx 探活→端口→指纹→ffuf 目录）。
3. 原始结果全部落 `recon/`。
4. 产出 `recon/attack-surface.md`：资产表 × 假设弱点 × 验证命令 × 交接队友。
5. 每条发现 `zkali_journal` 记录。

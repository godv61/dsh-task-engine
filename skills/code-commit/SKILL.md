---
name: code-commit
description: 提交节点：校验阶段、文件范围与消息格式，执行范围受控的本地提交。仅在提交检查点（交付阶段）时使用。
---

# 提交

1. `dev_task`（operation=commit, files=[...], message=...) 校验阶段、范围与消息格式。
2. 拿到 approved 后逐文件 `git add <files>`（禁止 `git add .` / `git add -A`），再 `git commit -m "<message>"`。
3. 用 `dev_task`（operation=commit, hash=<hash>）回写 commit hash。
4. 只提交任务 files 范围内文件；发现范围外文件、密钥或环境配置时停止并报告。

不 push、不合并、不建 PR、不执行数据库、部署或发布。
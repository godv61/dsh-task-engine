---
name: code-verify
description: 交付验证节点：执行目标测试、编译与契约检查，记录验证结果与证据。仅在任务处于「交付」阶段时使用（以 dev_task status 的 stage 为准）。
---

# 验证

1. `dev_task`（operation=status）读风险等级与验收条件。
2. 执行聚焦验证：目标测试、受影响模块编译、契约检查与必要人工步骤，不默认叠加 clean/package 全家桶。
3. 结果用 `dev_task`（operation=verify, passed=..., evidence=[...]) 记录；high_risk 必须附证据。
4. 环境受阻时如实记"未编译/未联调"；high_risk 核心行为无法验证时不得通过。

验证失败不得 advance。
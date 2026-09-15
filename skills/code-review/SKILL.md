---
name: code-review
description: 代码审核节点：评审变更，产出结论与问题清单并落评审记录。仅在 dev_task status 的当前阶段绑定本技能时使用，阶段名称可以自定义。
---

# 代码审核

1. `dev_task`（operation=status）读当前变更与验证结果。
2. 评审：契约是否兼容、边界条件、错误处理、变更范围是否越界。
3. 结论与问题用 `dev_task`（operation=record, artifact=review, fields={conclusion, issues}）落库。
4. 结论用 `dev_task`（operation=review, outcome=pass|blocked）记录；blocked 写清阻塞原因。

complex、用户要求或验证发现阻塞风险时才进入本节点；其余验证通过可直接完成。

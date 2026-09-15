---
name: solution-design
description: 设计节点：产出最小方案、改动点与技术选择，落设计文档并等确认。仅在 dev_task status 的当前阶段绑定本技能时使用，阶段名称可以自定义。
---

# 方案设计

进入本节点后，按任务快照中的当前阶段要求工作：

1. `dev_task`（operation=status）读当前节点与待办。
2. 产出最小方案：技术基线、修改位置与做法、明确保持不变的部分。
3. 不做投机性抽象：单一调用方不为"以后可能复用"新增抽象层或包装层，优先复用相邻实现；语言特定的分层与命名约定由项目挂载的 rule 约束，不在这里预设。
4. 用 `dev_task`（operation=record, artifact=design, fields={approach, risks, impact}）落设计文档。
5. 完成后用 `dev_task`（operation=advance）流转；系统会向人发起「方案确认」审批，批准才放行。

方案未获人批准不得进入实现。

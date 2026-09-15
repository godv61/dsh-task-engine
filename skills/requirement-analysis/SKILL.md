---
name: requirement-analysis
description: 需求评审节点：把一条需求拆成目标、验收、非目标和待确认项，落需求说明并等确认。仅在 dev_task status 的当前阶段绑定本技能时使用，阶段名称可以自定义。
---

# 需求分析

进入本节点时任务需求尚未确认。按顺序：

1. `dev_task`（operation=status）读当前节点与任务事实。
2. 把需求拆成三块：目标（要达成什么）、验收（怎么算完成）、非目标（明确不做）。
3. 列出疑问、矛盾、假设；存在影响范围或验收的问题时不得进入下一步，也不从沉默推断同意。
4. 用 `dev_task`（operation=record, artifact=requirement, fields={scope, acceptance_criteria}）落需求说明。
5. 完成后用 `dev_task`（operation=advance）流转；系统会向人发起「需求确认」审批，批准才放行。

需求未获人批准不得 advance 到下一节点。

---
name: requirement-analysis
description: 需求评审节点：把一条需求拆成目标、验收、非目标和待确认项，落需求说明并等确认。仅在任务处于「需求评审」阶段时使用（以 dev_task status 的 stage 为准）。
---

# 需求分析

进入本节点时任务需求尚未确认。按顺序：

1. `dev_task`（operation=status）读当前节点、任务事实及 `artifact_requirements` 的允许字段和缺项，以任务冻结流程为准。
2. 把需求拆成三块：目标（要达成什么）、验收（怎么算完成）、非目标（明确不做）。
3. 列出疑问、矛盾、假设；存在影响范围或验收的问题时不得进入下一步，也不从沉默推断同意。
4. 按 `artifact_requirements` 用 `dev_task`（operation=record, artifact=requirement）落需求说明。标准流程使用 `fields={scope, acceptance_criteria}`；敏捷流程只有 `scope`，将验收写在其正文中。目标、非目标、疑问、假设和待确认取舍写入允许字段的正文，不新增“待确认取舍”等字段。字段被拒绝时读取允许字段并修正本次输入，不改流程配置或任务 JSON 来绕过校验。
5. 完成后用 `dev_task`（operation=advance）流转；系统会向人发起「需求确认」审批，批准才放行。

需求未获人批准不得 advance 到下一节点。

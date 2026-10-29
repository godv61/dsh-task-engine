---
name: eng-delivery
description: 使用 dev_task 读取任务状态、执行流程门禁与完成条件；具体技能、规则、产物和提交文本以用户配置为准。
whenToUse: 在启用工程化交付会话预设后，开始或继续开发任务时先读取状态；阶段流转与完成必须通过 dev_task。
---

# 工程任务编排

先判断交付目标。普通问答直接回答；“查原因、给方案、分析影响”创建 `intent=analysis`（同时写明 `intent_reason`）的调查任务，直接搜索和读取相关源码并及时报告中心发现。用 `submit_analysis` 一次提交 `conclusion`、`proposal`、`limitations`（可为空）及含 `file/start_line/end_line` 的源码位置（行号从 1 开始，由宿主采集原文；若提供 `quote` 则必须精确匹配）；引擎核对当前内容后保存交付，不制造实施项、测试文件或 Sonar 扫描。需要执行命令或修改代码时说明当前分析未覆盖的验证，由用户后续授权的实施任务承接。

分析可以使用项目已有 Skill 和代码索引辅助定位，相关业务结论必须核对源码。只读委派使用 `delegate`，提供具体问题、已知路径、依赖、`delegation_benefit` 和说明事实的 `execution_reason`；默认主会话连续调查。不要把相邻调用链机械拆给多个代理，也不要因复杂度高就委派。引擎返回 `returned` 只表示报告已回，主会话仍核对推理和关键证据，不能把运行完成当作任务通过。遇到模型授权错误保留已有成果，恢复时使用 `recover_analysis`，不重跑已返回的问题。

以下实施规则适用于用户已要求修改/实现的工作；新任务创建时传 `intent=implementation` 和 `intent_reason`。不带 intent 的旧任务继续遵守其原有快照。

项目初始化是可选扩展；六个内置元技能无需项目 Skill 或 Rule 就能执行。若生成 `<项目名>-project-map`，它必须概述整个仓库的模块职责、依赖与通用代码入口，可被后续不同需求复用。当前需求的具体页面、接口调用链和验收条件写入任务产物；若确需长期保存领域地图，另建明确命名的领域 Skill，不把它们塞进项目总地图。`inspect` 只提供目录和清单证据，`propose/apply` 的正文由模型拟定，应用前逐项检查范围。

新需求先按改动范围、实现依赖和架构影响选择 `low`、`medium`、`high` 或 `ultra`，调用 `dev_task assess` 查看相应阶段与有效技能来源。创建时提供 `complexity` 和具体的 `complexity_reason`。低档为局部明确修改；中档先形成需求与验收；高档增加按实现先后顺序的任务编排；超高档适用于完整新模块或大范围重构，增加架构设计。风险等级独立选择。没有 `complexity` 的旧调用继续使用 `.dsh/eng.json`。

自适应任务的当前元技能及附加技能都以 `status.bindings` 为准，用 `dev_task load_skill` 和准确的 `source:name` 加载；项目同名 Skill 覆盖用户与内置 Skill，Rule 由生效 Skill 自身的 `profile.json` 持有。当前任务的流程在创建时冻结，其他会话的任务可选择不同档次。

项目配置优先通过 `dev_task assess/status` 读取实际生效结果。自适应任务的 `.dsh/eng.json` 是可选兼容配置，缺失不代表初始化失败；确需直接读取可选文件时先检查存在性，不用忽略错误参数代替存在性检查。

`dev_task` 是任务状态、阶段流转与门禁的唯一事实来源。流程预设决定阶段图与守卫；项目配置决定阶段使用哪些技能、每个技能遵守哪些规则，以及产物字段和提交文本。没有绑定时仅执行状态机，不自行补充技能或规则。

1. 每次收到需求先调用 `dev_task`（operation=status）查看任务归属。已归档任务只读；交付后的缺陷、优化或新需求即使在同一会话、同一分支也用新 `task_id` 调用 `create`，可用 `related_task_id` 和 `relation_kind` 关联原任务。仅当原任务仍进行中且本次要求属于同一轮验收时继续；归属不清时询问使用者是继续当前任务还是新建。没有任务时评估复杂度，调用 `assess` 后 `create`。
2. 读取 `status.bindings`、`skill_obligations`、`artifact_requirements`、`legal_next` 和 `commit`。只加载当前及即将进入的终态实际绑定的技能，遵守本次交互读取的最新规则正文；没有绑定时不自行补上技能或规则。
3. 技能要求的证据以其配置和 `status.skill_obligations` 为准：仅对 `command_receipts_required` 列出的技能通过带真实命令的 `skill_result` 记录；`manual` 通过人工审批记录；`artifact`、`review` 与 `none` 按对应阶段操作或无需额外回执处理。不要把所有技能都当成命令型技能。技能加载成功不等于要求的证据已经完成。
4. 需要记录产物时，只使用 `artifact_requirements` 给出的 id 与字段。按当前流程要求完成确认、实施项、验证和审核，再调用 `advance`；被拒绝时按返回的阻塞原因修正，不改任务文件绕过门禁。
   新自适应任务必须为每项记录边界、范围、验收、依赖和选择理由，可用 `plan` 原子登记全部计划，或逐项 `plan_execution`。高/超高档在任务编排时做，低/中档在代码开发开始时做。新交付契约的 auto 只有明确 `delegation_benefit` 才委派，独立文件本身不是收益。主会话直接实施可在真实 verify 后用 `accept_item` 原子审核并标 done；需要独立审核时先执行 `review_dispatch`。旧契约继续按计划 `dispatch`、`review_item`、标 done。不要调用原生 subagent 工具制造无法关联台账的委派。
   每项包含实现和必要测试；通过 plan_verification 声明全部必要测试组的 command、files 和 item_ids。verify 按 verification_group 执行，分别保存回执。只有全部组有效，任务整体才验证通过。返工范围明确时用 revise(defect) 的 affected_items；影响未知时完整返工。技能读取记录按当前会话与内容版本复用，执行证据按实际输入重新核对。
   `items` 默认按 ID 增量合并；只有明确重排或删除尚未实施的项目时才传 `items_mode=replace` 和完整目标列表。审核前对照 Git 变更补齐任务文件范围；插件会拒绝漏登的新增审核文件。
   删除/重命名在实施前通过 plan_execution.changes 声明，旧路径与目标保留在 files，审核读取引擎保存的变更前文本快照。需要提高风险时调用 set_risk 并按新状态重新审核被打开项；不手改任务 JSON，也不重复实现未变化的工作。
5. 只在 `status.commit` 允许的检查点申请提交，并按任务创建时的流程配置校验文件范围与消息。提交后按工具要求回写真实 Git HEAD。到达终态并满足完成条件后立即调用 `complete` 归档，不等待部署；归档后所有写操作均被拒绝。仅未归档的同一轮需求返工使用 `revise`。

不同流程的阶段数与守卫不同，不把某一预设的阶段顺序或提交格式当作所有项目的默认工作方法。用户修改流程配置只影响之后创建的任务；进行中的任务继续遵守创建时的阶段与门禁，但在下次交互读取所引用技能和规则的最新正文。

## Skill 加载方式

当前阶段核心 Skill 和强制挂载项需要真实读取记录；同一任务、同一会话已加载的内容跨阶段复用。按需挂载项由名称、描述和使用时机判断，只读取相关项，不要求跳过说明或 Skill 完成凭证。选中某 Skill 时一并读取其全部 Rule。阶段产物、测试、审核及人工确认要求仍单独执行，不能用此前的读取记录代替。独立子代理须获得自己的必要上下文。

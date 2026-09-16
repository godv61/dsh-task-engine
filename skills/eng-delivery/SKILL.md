---
name: eng-delivery
description: 使用 dev_task 工具编排工程化交付流程；按当前分支任务、配置的状态机与提交门禁推进需求评审、设计、开发、交付、代码审核。
whenToUse: 开始任何开发、改 bug、加功能、代码评审或提交任务前；dev_task 是工程化交付状态机的唯一闸门，阶段流转与提交必须经它，禁止绕过。
---

# 工程化交付

`dev_task` 工具是流程的唯一事实来源与硬约束。阶段顺序、流转门槛、提交格式来自所选流程预设（standard / agile / minimal）；项目根 `.dsh/eng.json` 只声明 `flow`（选哪套预设）和 `stage_bindings`（每个节点挂哪些 skill / rule）。

## 项目认知（可选前置）

接手一个还不熟悉（尤其二开 / 遗留）的项目、且项目根没有 `AGENTS.md` 时，先 `dev_task`（operation=init）走 inspect → propose → apply 三阶段生成项目根的 `AGENTS.md` 描述文件——DSH 会把它自动注入到每个会话，之后每个任务开工自带项目认知。扫项目后先 propose 草稿（只预览、硬校验 200 行上限，只写「项目是什么 → 怎么跑 → 结构 → 约定 → 坑」，超限即精简），再 apply 落盘；已有 `AGENTS.md` 时默认只读，覆盖需 overwrite + 人工批准，绝不裸覆盖项目已有治理文件。

## 入口

1. 先 `dev_task`（operation=status, branch=当前分支）发现任务，再带 task_id 查询所选任务的详细状态；有多个候选时不要猜测：
   - 没有任务 → `dev_task`（operation=create，task_id=短 ID 如 GREET-001，title=任务标题，branch=当前 git 分支，files=本任务涉及的文件列表）建立任务并停在**起始阶段**（由配置 `start_stage` 决定，默认「需求评审」），从起始阶段开始。
   - 已有任务 → **从 `status` 返回的 `stage` 继续，绝不重走已过的阶段**。每个阶段对应一个节点技能：需求评审→`requirement-analysis`、设计→`solution-design`、开发→`code-implement`、交付→`code-verify`、代码审核→`code-review` + `code-commit`、完成→收尾。只做当前 stage 那一个节点的事：完成该阶段产物、满足 guard，才 `advance` 到下一阶段。
   - 文件范围一时不清就先 `operation=create` 建任务，摸清后用 `operation=scope, files=...` 补齐。
2. 每阶段先通过 `skill` 工具加载所有绑定技能，再执行其指引；仅看到技能名称不算执行。完成本阶段产物后：
   - 内置七项（eng-delivery、requirement-analysis、solution-design、code-implement、code-verify、code-review、code-commit）使用现有 record/verify/review/commit 门禁，**不需要 skill_result**，即使项目配置显式列出了这些名称。仅对 status.skill_obligations.command_receipts_required 列出的附加技能记录 skill_result；不要为内置节点重复写“检查字段非空”的验证命令。
   - 新任务的附加技能还需 `operation=skill_result, skill_name=技能名, target_stage=所属阶段, evidence=[实际场景与结果], command=真实验收命令`。命令由引擎执行，失败不能流转；非测试技能可用检查其交付文件内容的命令，不能用 echo/恒成功命令代替验收。
   - `status.skill_obligations` 包含紧邻的终态绑定：例如挂在“完成”的 software-testing，需要在代码审核阶段提前加载、执行、记录，再提交和进入完成。不要等宣告完成后才测试。
   - 标准流程在代码审核阶段完成评审后提交；其他流程以 `status.commit` 返回的检查点为准。审核修复允许留在当前阶段处理，但改动后须重新验证，更新评审结论。
   - 若本阶段配置了必交产物（`dev_task` operation=status 会列出 still missing 的字段），先用 `dev_task`（operation=record, artifact=..., fields=...）逐字段记录；字段不填全，流转会被 `artifacts_present` guard 拒绝。
   - 再用 `dev_task`（operation=advance）流转到目标阶段；被拒绝说明 guard 未满足（需求/方案未获人批准 / 产物字段没填全 / 实施项没完 / 高风险没验证 / 评审没过），先补齐再重试，不得绕过。
3. 提交前用 `dev_task`（operation=commit, files=<要提交的文件列表>, message=...）校验阶段、文件范围与消息格式；拿到 approved 后再逐文件 git add 和 git commit，并把 commit hash 通过 `dev_task`（operation=commit, files=同一列表, message=同一消息, hash=真实HEAD）回写。引擎核对 Git HEAD、消息和实际文件。没有回写成功，不得离开提交检查点。落在任务 files 之外的文件先明确与当前需求的关系，必要时更新 scope；无关工作另开任务。

## 硬规则

- 需求、Bug、继续开发、验证、评审、提交请求一律经 `dev_task` 状态机推进，不自行绕过。
- 阶段是硬状态：`status` 的 `stage` 决定你现在做哪个节点；只做该节点绑定的技能与产物，不得在错误阶段做其他阶段的事，绝不倒带重走已过的阶段。
- 需求、方案的「确认」只能由人在审批中批准（`advance` 撞上确认门槛时系统会自动发起审批，人在页面点批准才放行）；模型不能自己确认，也不能绕过这扇门。
- 阶段必交产物（如需求说明、设计文档、评审记录）必须用 `dev_task` operation=record 落库，字段不能留空、不能装样子。
- 先声明文件范围：任务 `files` 只放本任务真正要改的文件；提交的文件必须全在 `files` 内，范围外的文件（哪怕是"顺手改一下"）也必须另开任务。
- 只做任务范围内的本地提交；绝不 push、合并、创建 PR、执行数据库、操作 Jenkins、部署或发布。
- `dev_task` 的拒绝是硬事实：修正前置条件，而不是换一种方式绕过。

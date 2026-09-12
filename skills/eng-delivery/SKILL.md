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

1. 先 `dev_task`（operation=status）读当前分支任务与阶段：
   - 没有任务 → `dev_task`（operation=create，task_id=短 ID 如 GREET-001，title=任务标题，branch=当前 git 分支，files=本任务涉及的文件列表）建立任务并停在**起始阶段**（由配置 `start_stage` 决定，默认「需求评审」），从起始阶段开始。
   - 已有任务 → **从 `status` 返回的 `stage` 继续，绝不重走已过的阶段**。每个阶段对应一个节点技能：需求评审→`requirement-analysis`、设计→`solution-design`、开发→`code-implement`、交付→`code-verify`（提交用 `code-commit`）、代码审核→`code-review`、完成→收尾。只做当前 stage 那一个节点的事：完成该阶段产物、满足 guard，才 `advance` 到下一阶段。
   - 文件范围一时不清就先 `operation=create` 建任务，摸清后用 `operation=scope, files=...` 补齐。
2. 每阶段：完成本阶段产物后：
   - 若本阶段配置了必交产物（`dev_task` operation=status 会列出 still missing 的字段），先用 `dev_task`（operation=record, artifact=..., fields=...）逐字段记录；字段不填全，流转会被 `artifacts_present` guard 拒绝。
   - 再用 `dev_task`（operation=advance）流转到目标阶段；被拒绝说明 guard 未满足（需求/方案未获人批准 / 产物字段没填全 / 实施项没完 / 高风险没验证 / 评审没过），先补齐再重试，不得绕过。
3. 提交前用 `dev_task`（operation=commit, files=<要提交的文件列表>, message=...）校验阶段、文件范围与消息格式；拿到 approved 后再 `git add <同一批文件>; git commit -m "<approved>"`，并把 commit hash 通过 `dev_task`（operation=commit, hash=...）回写。落在任务 `files` 之外的文件一律不能提交。

## 硬规则

- 需求、Bug、继续开发、验证、评审、提交请求一律经 `dev_task` 状态机推进，不自行绕过。
- 阶段是硬状态：`status` 的 `stage` 决定你现在做哪个节点；只做该节点绑定的技能与产物，不得在错误阶段做其他阶段的事，绝不倒带重走已过的阶段。
- 需求、方案的「确认」只能由人在审批中批准（`advance` 撞上确认门槛时系统会自动发起审批，人在页面点批准才放行）；模型不能自己确认，也不能绕过这扇门。
- 阶段必交产物（如需求说明、设计文档、评审记录）必须用 `dev_task` operation=record 落库，字段不能留空、不能装样子。
- 先声明文件范围：任务 `files` 只放本任务真正要改的文件；提交的文件必须全在 `files` 内，范围外的文件（哪怕是"顺手改一下"）也必须另开任务。
- 只做任务范围内的本地提交；绝不 push、合并、创建 PR、执行数据库、操作 Jenkins、部署或发布。
- `dev_task` 的拒绝是硬事实：修正前置条件，而不是换一种方式绕过。
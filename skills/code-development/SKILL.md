---
name: code-development
description: 按验收条件和有序任务清单实现代码，并遵守绑定的项目规则。
whenToUse: 自适应任务进入代码开发元技能时。
---

# 代码开发元技能

仅用户已要求实施时使用。先读取当前阶段绑定的 Skill 和 Rule，保留已有工作区修改，按验收条件和实现依赖推进。流程操作以当前任务的交付契约和工具返回为准；项目 Skill 补充代码约束，旧版流程示例不能覆盖当前契约。

## 新交付契约（intent=implementation）

用 `plan` 原子登记完整实施项，或逐项 `plan_execution`：记录 `item_id`、`task_boundary`、交付 `files`、`acceptance`、`depends_on`、`execution_reason`。local 表示局部改动，independent 表示边界清晰，coupled 表示需要共同处理；边界独立本身不是委派理由。默认主会话执行，只有明确 `delegation_benefit`（并行、上下文隔离、独立核对）才委派。用户指定全程主会话时使用 `execution_policy=main_only`。

主会话直接实施：实现与必要测试 → `verify` → `accept_item`（`spec_outcome`、`quality_outcome`、具体 `notes`），一次接受审核并标 done。**直接实施不需要额外 `dispatch`，也不需要再串联 `review_item` 和 `items`。**

确需子代理：先记录计划与收益，再 `dispatch`，不得绕过引擎调用原生子代理工具。主会话核对真实交付并运行 `verify`；计划要求独立审核时先 `review_dispatch`，再通过 `accept_item` 接受同一结论。子代理自报完成、文本自报测试通过都不构成验收。

## 旧契约任务

只有没有新交付契约的旧任务使用 `dispatch` → 实现与验证 → `review_item` → `items done`。`review_item` 不自动完成旧任务的实施项。暂停时设回 todo，保留已有记录；不要把这一套额外叠加到新契约的直接实施项。

## 验证与交付范围

实施项应包含实现及其必要测试，不把本项必须的单测拆成依赖“本项 done”的下游项。用 `plan_verification` 登记测试组的稳定 `verification_group`、真实测试 `command`、全部输入 `files` 和 `item_ids`。只读构建配置放在测试输入，只有实际修改的文件才登记为交付；任务级集成检查可使用空 `item_ids`。

`verify verification_group=...` 返回 `group_result` 与任务整体 `task_verified`。本组 passed、其它组待运行时可先验收本项，不重跑已通过且输入不变的组。编译成功不能冒充测试通过；测试失败、全跳过或输入改变必须重新验证。默认回执只有摘要，完整日志使用 `status detail=true`，不要为查看日志重复执行测试。

测试应覆盖实际业务入口、主要条件分支、外部副作用和失败恢复。不能用只有常量、序列化或 mock 参数透传的用例，代替对核心编排流程的验证。审核 notes 说明哪些验收场景被测试覆盖、哪些只经源码核对、哪些尚未验证；测试数和哈希不证明测试充分。

## 返工与恢复

需要修改已审核交付时，先 `revise revision_kind=defect target_stage=代码开发 affected_items=[...]`，再修改和验收；已经处于开发阶段时可原地登记缺陷返工。共享交付、变化的共同输入及下游依赖会扩大影响范围。需求/方案变化使用对应 revision_kind；影响不明时省略 affected_items，完整返工。

工具会报告仍有效的测试组与未受影响项。当前输入和计划均未变化的通过回执可复用，不为刷新审核重跑测试；已失败、过期、计划变化或规则变化的证据不能复用。遇到错误先执行返回的 recovery，或查看 status；不要在审核阶段反复尝试只允许开发阶段调用的操作。

删除/重命名前在 plan_execution.changes 声明 `{path,kind:"delete"}` 或 `{path,kind:"rename",to}`；保留旧路径、目标及引擎保存的基线供审核。重审须核对所需文件全文，截断、缺页、读取失败不能报 pass。不要手改父任务 JSON、快照或子代理状态解锁。

SonarQube 启用时在代码审核阶段运行；先使用问题消息、位置和报告，不能为猜规则扫描 DSH 安装包、app.asar 或整个用户运行目录。有可用索引时按需定位符号，过期或不可用时直接搜索源码。

长任务在重要发现、阻塞、返工和验证完成时主动给简短进度说明，正常工作中避免超过约一分钟没有说明。跟踪自己启动的后台作业，结束前收齐仍相关作业的终态，不再需要的作业使用宿主取消工具停止。

---
name: code-implement
description: 开发节点：按方案拆解实施项，独立交付可派子 agent，小修正可由主 agent 实施；经「规格符合 → 代码质量」两阶段审查通过才记完成。仅在任务处于「开发」阶段时使用（以 dev_task status 的 stage 为准）。
---

# 代码实现

进入本节点时需求与方案均已确认。按顺序，一项一项做：

1. `dev_task`（operation=status）读当前阶段、风险、实施项明细与验证基线。实施项按能独立审查的交付内容拆分，不为达到任意时间粒度重复拆同一调用链；用 `dev_task`（operation=items, items=[...]) 记录清单，后续可通过 status 读取明细和审核记录。
2. 按改动选择执行方式：独立功能或需要隔离上下文的重做，可先 `dev_task`（operation=dispatch, item_id=<本项 id>, description=<目标与范围>）登记派发计划，工具会把该项设为唯一 doing，再派一个 fresh 子 agent。主 agent 可直接完成范围清楚的小修正（如测试文件移位），先用 items 标 doing，完成后仍须真实验证和两阶段审核，不补造 dispatch。
   - 用 `subagent` 工具，前台调用（默认等结果，不设 run_in_background）。
   - prompt 必须自包含（子 agent 看不到本对话），写清：任务目标（引用需求/方案要点）、本项要做什么、只改本项和必要调用方（不顺带重构）、可改的文件范围、完成标准，并要求返回「改动文件清单 + 验证结果/命令」。
   - 明令子 agent：只实现这一项、跑本地验证，不要调 dev_task 流转、不要 items、不要 commit、不要 push。
   - 权限或沙箱拒绝时保留失败，核对路径和调用配置后使用 Harness 正式审批机制；没有可用审批时报告阻塞并返回主 agent。不得反复换删除命令、切 shell、改 ACL 或削弱验证来规避同一拒绝。子任务 prompt 必须包含此约束。
   - 不要等子代理返回才登记派发，否则任务台账会在实际开发时一直显示 todo。dispatch 只是计划记录，实际执行由子代理工具调用和结果证明；重派会使该项旧审核失效。
3. 本项实现完成后（主 agent 实施或子 agent 返回），主 agent 做两阶段审查（顺序不可反）：
   - 规格符合：对照需求/方案，查「做对了没、有没有超范围、漏没漏边界」。
   - 代码质量：按当前任务为本技能配置的规则（若有）及实际代码契约查「做得好不好」——契约兼容、边界与错误处理、命名与结构；不自行补用未绑定的内置规则。
4. 审查完用 `dev_task`（operation=review_item, item_id=<本项 id>, spec_outcome=pass|fail, quality_outcome=pass|fail, notes=[结论或问题清单]) 落两阶段结论留痕。
5. 任一阶段不过：按第 2 步选择主 agent 小修正或 fresh 子 agent 重做，明确上次的问题；重做后再审查，并再次 `review_item` 覆盖前次结论。只改测试路径或文案时，运行受影响的定向检查，不重复无关的全量编译。
6. **两阶段都 pass 后**才用 `dev_task`（operation=items, items=[...]) 全量回写，把本项标 done（其余项原样保留）；已有项可只传 id/status，省略 title 以保留原文与审核。追加修复项时不要重写已完成项标题；确需改标题应显式重开并重新审核。spec 或 quality 任一 fail 都不许标 done，回到第 5 步重做。
7. 重复 2-6 直到全部 done。随后跑一次聚焦验证（目标测试、受影响模块编译、契约检查；high_risk 覆盖核心失败路径）确认整体可交付。
8. 全部 done 才 `dev_task`（operation=advance）；`todos_done` 门会硬校验：每个 done 的项都必须带两阶段审查留痕且都 pass，缺 `review_item` 留痕会被拒绝。失败保持 doing、只记最新结果与阻塞；需求或方案变化时回退确认并停止编码。

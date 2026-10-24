# 开发与发布

[返回项目首页](../README.md) · [使用手册](manual.html)

插件分为 host 控制器、agent 工具和浏览器工作台。源码在 `src/`，构建结果在 `lib/`，npm 包包含预构建入口、内置 Skill、预设和提交钩子。

当前发行线要求 DSH `^0.2.0-rc.2`，使用声明式 `@deepseek-ai/dsh-agent-preset` 和宿主子代理服务。不再声明旧 `0.1.x` 宿主兼容；旧版文件预设派生测试在缺少旧宿主包时跳过，不能充当当前声明式预设的验收。当前预设、`spawn` 与 `fork` 需在实际 0.2 宿主单独验证。

新自适应任务保存 `delegation_version=1`：实施前必须 `plan_execution`；高/超高档离开任务编排前检查每项策略，低/中档在代码开发检查。模型提供边界事实、文件、验收与依赖，引擎按真实 `getProvider` 能力决定执行和审核方式，`dispatch` 读取计划而非默认静默 direct。子代理实现或高复杂度/高风险项优先独立审核，缺能力的回退原因保存到计划。`execution_policy=main_only` 用于用户明确要求全程主会话。旧记录不追溯增加门禁。

`review_dispatch` 使用新的 spawn 上下文和宿主 `toolFilter.allow=['read']`；解析成功 read 的模型可见行内容，与当前全部计划文件逐行比较，可合并多个窗口。缺行、行截断或旧内容不接受为全文覆盖；空文件必须收到明确的空文件结果。记录 `read_coverage` 的文件与行数，旧的 `read_files` 路径记录不等于全文核对，升级后的逐项接受须重新审核。单行超过宿主读取上限时须调整宿主配置，不能将截断结果算作全文。宿主声明 `outputSchema` 时使用原生 `structured_output` 捕获及 `result.structured`；捕获缺失或非法时拒绝，不从文本补填。未声明该能力时沿用严格 JSON 文本解析。审核工作工具只保留 read；原生结果提交工具由 DSH 在子作用域注册，不提供写文件或命令能力。

回执绑定计划、实施轮次、适用规则/产物上下文和文件 SHA-256 指纹，主代理不能覆盖失败结论。同一代码和审核上下文最多三次有效完成结论；启动失败、取消、读取不全及传输错误只记历史，不消耗该额度。重审将实施项退回 doing 并清除旧父接受，成功后须重新 review_item 与 done；不会保留 done 却无当前接受的状态。审核清理失败保持锁定，通过 `recover_dispatch dispatch_role=review` 在确认宿主及后代不活动后恢复。独立审核不是命令验证，也不自动将实施项设为 done。

新自适应任务的交付文件及测试必须全部归属到实施项计划；派发、编排交接和实施项阶段门禁检查归属并集。主会话和子代理执行项的 done 都要求当前真实非零测试回执及逐项审核；逐项审核绑定对应文件指纹，重跑测试不能让旧审核自动变新。当前进程的全部 agent 注册共享任务变更锁，状态查询保持可用；跨进程竞争继续由宿主文件版本 CAS 保护，不另建锁文件或接管宿主运行生命周期。

派发实现和审核均请求绝对深度上限，因此能力检测要求 provider 声明 `depthLimit`，并在实际派发时重新核对。能力在计划后被移除时拒绝启动，保留原实施项状态并提示重新规划。`fork` 只继承已完成轮次，当前轮次的验收和说明始终随派发提示传递。当前只使用 one-shot，不把台账恢复描述为 DSH continuable 子会话续跑。

## 代码位置

新增自适应任务保存 `verification_version=1`，在派发前声明全部 `plan_verification` 分组（稳定 ID、command、files、item_ids）。`verification_runs` 追加实际命令回执，按组读取最新一轮；组计划身份、源码/测试/配置及依赖输入指纹均需匹配。覆盖由计划声明并审核，测试数和文件指纹不证明覆盖充分。`verification` 是当前聚合投影，`receipt` 仍代表最后一次真实命令，不伪装成多组一次执行。提交钩子独立重算每组输入。

旧任务缺少 verification_version 时沿用原门禁；显式 plan_verification 后才启用新契约，旧全局回执不会追认成分组通过。所有归档记录只读。`revise(defect)` 的 affected_items 传播到共享交付文件和下游依赖；真实输入变化也会扩大范围，Skill/Rule 已变化时保守完整失效。未知影响、需求或方案改变继续任务级失效。相同会话、相同指令内容的读取记录可以复用，命令/产物证据仍按输入核对。

缺陷可在当前开发阶段原地返工，需求/方案修订仍回到更早阶段；活动子代理未结束时不可修订。执行计划 files 是允许修改和交付的范围，测试计划 files 包括只读输入；共享交付范围保守联动重新验收，共同只读输入在指纹变化时才使相关测试失效。verify 的 group_result 为本组状态，task_verified 和兼容 ok 仍为任务整体状态；diagnostics 的 code 是稳定的故障类别，group_id 定位具体组。

| 路径 | 主要职责 |
| --- | --- |
| `src/adaptive.ts`、`src/workflows.ts`、`src/engine.ts` | 四档流程、兼容流程与任务状态机。 |
| `src/dev-task.ts` | `dev_task` 操作、阶段门禁和任务留痕。 |
| `src/sonarlint-local.ts`、`src/sonar.ts`、`src/sonar-report.ts` | 本地规则分析、服务端结果与 Markdown 报告。 |
| `src/verification-tests.ts`、`src/gradle-reports.ts` | 多语言测试摘要与本次 Gradle JUnit XML 门禁。 |
| `src/verification-state.ts` | 测试组、回执历史、失败诊断及影响传播。 |
| `src/project-init.ts` | 项目扫描与初始化覆盖检查。 |
| `src/controller.ts`、`src/client/` | 工作台读写接口与界面。 |
| `skills/`、`preset/` | 会话编排与元技能正文。 |

## 本地验证

在插件源码根目录执行：

```sh
npm install
npm run typecheck
npm run build
npm test
npm run verify:package
```

`verify:package` 将当前 tarball 安装到隔离临时目录，检查可发布入口、客户端注册、包内测试和 CLI 语法。CI 在 Windows 与 Ubuntu 的 Node 22、24 上运行；DSH 契约作业还检查固定版本，最新主线为提示性信号。提交前检查 `git status`，确认没有本机凭据、临时审核文件或生成包进入版本控制。

## 当前质量约束

- 本地 Sonar 审核必须先对照参考分支的 Git 差异、项目 `include_paths` 与任务 `files`；漏登文件不得产生“完整审核通过”。
- `ide-local` 的逐项误报处置只能在当前审核、当前代码指纹上由宿主人工批准；原始告警和结果保留。CI 或上传式服务端 Gate 不接受本地处置。
- 验证命令必须产生非零测试证据：Maven Surefire/Failsafe、Node TAP/Jest/Vitest、pytest、Go test、Cargo test 的可识别摘要，或本次 Gradle `test` 新生成的 JUnit XML。未知命令和缺少证据的成功退出也不能让测试门禁通过。
- `items` 默认按 ID 合并；显式 `items_mode=replace` 才允许移除未实施的项目。已完成或有审查记录的项仍保留。
- 文档只维护项目首页、本 HTML 使用手册和本开发指南，三处描述均以当前功能为准。

## 发布与部署检查

待发布工作区的证据与恢复契约：

- `commit hash=...` 补登记与 `complete` 都核对目标 HEAD、任务交付路径、提交 blob 和文件模式；无关文件改动不阻塞。原有 Git 提交钩子的暂存区校验继续保留。
- `review pass` 只允许在流程审核阶段，绑定当前文件指纹与验证回执。旧活动任务缺少审核内容回执时须重新审核，归档记录保持只读。
- CI/上传式 Sonar 审核要求精确 analysis ID 的 SCM revision 与登记提交相符，并检查读取问题期间分析未变化。接口无权访问、缺少 revision 或无法证明 PR 分析身份时明确拒绝，不使用台账 hash 冒充服务端证据。本地审核记录同步配置与启用规则清单指纹，拒绝当前项目未启用规则的发现。
- 工作台的历史分析语言筛选仅控制显示。实际本地范围是 Git 比较差异与项目 `include_paths` 的交集，并要求登记全部范围内变更。`HEAD` 表示当前提交，只覆盖未提交差异；完整任务可选任务开始前的固定提交。范围策略在任务创建时保存，修改项目配置不自动重写旧任务。
- 初始化逐项生成使用 `projectInitJob`，草稿作业 ID 和结果保存于 `.dsh/init-jobs/`。浏览器断开不取消服务器作业；完成结果可以恢复。生成进程重启后，未完成租约最长等待 330 秒再允许重试该步骤，不承诺恢复模型生成到一半的输出。写入相同资源可续办，已有不同内容始终拒绝覆盖。
- `dispatch execution=spawn|fork` 复用 DSH 的单次前台子代理服务，记录真实运行 ID、状态和交付结果，并释放运行资源。完成委派后主代理仍须验证和逐项审核；子代理不自动获得任务完成证据。执行期间禁止改写父任务台账，释放失败保持锁定。中断使用原父会话的 `recover_dispatch`，通过宿主 `listDescendants` 确认对应子代理及其后代均已停止；查询不支持、运行 ID 缺失或状态不可读时拒绝恢复。当前仍保持单实施项进行中，不并发改写交付文件。
- 台账区别当前有效、过期、失败和交付历史，台账及审核 Markdown 时间固定使用 UTC+08:00，不随浏览器时区变化；JSON 原始 ISO 时间保留。坏记录单独报错，每页最多 100 条，可加载更多。子代理重试保留最近 20 次委派摘要。Sonar 历史最多 20 条，每条内联阻断样本最多 50 个，完整明细保留在报告旁 JSON，`learn_rule` 按需读取。

1. 更新 `package.json` 版本，运行上述验证，再检查 `npm pack --dry-run --json` 的文件清单只有当前文档。
2. 推送提交后发布 npm 包；需要 npm 登录或 WebAuthn 时，保持发布命令等待，由账号持有人完成验证。
3. 在实际 DSH Web profile 安装刚发布的精确版本并重启，确认侧边栏入口、会话预设和 `dev_task` 能加载。项目 Token 保存在本机凭据中，升级不应把它写进仓库。
# 2026-10-23 联机回归补充

新建的 ide-local Sonar 任务保存 `sonar_baseline`：参考版本解析出的提交和创建前已修改代码文件的 SHA-256（不保存正文）。任务范围外、内容仍与该基线一致的既有改动不纳入本次任务审核，排除路径写入报告；开始后新增或再次修改的代码仍需登记。参考提交变化、旧任务没有基线或创建时无法读取 Git 时保留严格范围检查，不补造历史基线。分析结束前会再核对参考提交与范围，避免运行中漏入新代码。

验证支持标准 Maven 生命周期以及 Surefire/Failsafe 的短目标和完整坐标目标；仍要求真实非零测试摘要，失败或全部跳过的测试不通过。

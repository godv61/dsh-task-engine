# DSH 0.2.1-rc.3 对插件 0.34.1 的兼容性评估

日期：2026-10-26（UTC+08:00）。结论：**需要实际适配，不能只扩大 peerDependencies 范围。**

插件基线：正式 0.34.1，提交 `71275137a46c8afd401e6abc76963e66c69125af`。已验证宿主基线为 DSH 0.2.0-rc.2（`639ed015397290b3745d163aafe02ffee4aa3f84`）。目标为官方标签 `dsh-v0.2.1-rc.3`（`1f81c047fc48fa190a683e469daa699857e9afe8`），官方发布时间 2026-10-23 23:26:39（UTC+08:00）。

## 已确认影响

| 项目 | 实证 | 对当前插件的影响 |
| --- | --- | --- |
| 工程会话提示词 | `cordis.patch.yml` 仍在 persona suffix 引用 `{{cwd}}`；官方已移除该内置变量。用官方 rc.3 SystemPrompt 对出货首行进行实际 assemble/render，注册 model 而不注册已移除的 cwd，得到 `unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"`。 | 在通常新版组合下，工程预设的模型请求会因提示词变量未解析而失败。应删除旧变量，并使用宿主工作目录上下文。 |
| 子代理启动 API | 官方 rc.3 npm `SubagentRuntime.prototype.start` 为 undefined，`startActivation` 为 function；当前插件调用 `runtime.start()`。以真实导出 API 原型输入当前生产能力检测，结果 spawn/fork/reviewer 全为 false。 | 自动计划会误降级为主会话；指定子代理和旧独立审核计划会被拒绝。应迁移调用接口，不能继续把 start 的存在作为新版能力前提。该探针是 API 形状检查，不是完整活动运行时。 |
| 只读审核权限边界 | 官方从 SubagentStartRequest / capabilities 移除了 toolFilter、persona，改为 spawn 的 agentPreset；fork 不能独立更换组合。当前审核要求 capabilities.toolFilter 并传 toolFilter.allow=['read']。 | 即使只替换 start，也无法恢复原只读保证。须建立专用审核 preset，并校验实际可见及可执行工具，覆盖 Host 全局原生委派工具，不给审核者写文件、命令、dev_task 或进一步委派能力。 |
| 审核读取证据 | 新 SubagentActivation 返回 childId、result、dispose，不提供旧 run.localAgent。当前直接从 localAgent.session.snapshotEvents() 验证全文读取。 | 接口迁移后仍会拿不到旧读取证明。应通过子会话 ID 和官方 sessionQuery.observeSession 的受管理观察读取真实事件，正确释放观察租约；继续拒绝漏行、截断及旧文本。不能删掉全文读取门禁。 |
| 取消与清理 | 官方 activation 的启动 signal 只拥有发布前取消，发布后须通过该次 activation.dispose() 取消；result 在清理结束后结算，dispose 另报清理失败。 | 新适配层须处理父工具中断到子执行的取消传递、结果与清理错误，并保留现有未清理成功时的锁定和恢复检查。不能仅改函数名。 |
| 旧委派配置 | 当前 bundle 的 spawn/fork 等行仍含 backgroundMode，官方已移除该配置及相关前台/Job 模式。 | 清理旧配置，按 activation 语义处理调用方结果。此处依据官方配置迁移说明和源码核对，未额外宣称已复现整份 preset 的挂载错误。 |
| 版本声明 | 三个 DSH peer 包仍为 ^0.2.0-rc.2，不包含 0.2.1-rc.3 预发行版本。官方标签的 protocol 快照与既有 master CI 均只在 peer 范围检查失败。 | 安装/兼容检测会报不支持；必须在实际适配和验证后才增加 rc.3 的明确范围。 |

## 暂未发现直接破坏的部分

- 在隔离源码副本安装官方 rc.3 包后，build 与 host/client typecheck 均通过；dev_task 使用真正 rc.3 defineTool 的 schema 注册成功。
- 现有 40 个 Remote 对应、79 个严格 codec 的 create factory 静态检查通过。该结论不等同于新版 BFF 的权限和页面往返验收；新增访问控制仍应纳入实际加载测试。
- Fs/shell 目前使用的类型表面未观察到直接签名冲突。原始 Session.header.cwd 仍存在，但不再代表当前执行目录；适配要明确固定任务根目录、当前执行目录和权限根目录的区别，并为子代理显式传入任务目录。
- read 的路径信封、编号行和 EOF 输出格式仍保留；主要读取证据问题在获取子会话事件的入口变化。
- listDescendants 和 getProvider 仍存在，后代条目的 id/parentId/depth/kind/activity 仍支持当前恢复判据；清理与恢复仍需新接口实际测试。

## 建议适配顺序与验收

1. 新增宿主适配层：区分旧 start 与新版 startActivation，统一派发、身份、结果、取消和清理；新版采用 delivery='caller'，避免父级重复完成通知。台账保留旧字段可读，明确子会话身份和实施轮次，不重写历史记录。
2. 清理工程 preset 的 cwd 变量和旧委派配置；明确任务根目录与新版 workingDirectory 服务的使用边界。
3. 新增真正只读的审核 preset，通过 agentPreset 启动 spawn；用 sessionQuery 采集当前审核子会话事件，保留完整读取、当前测试、规格/质量接受及提交门禁。
4. 扩展兼容性检查：现有脚本主要查 RPC codec 与 peer 范围，编译/旧 mock 回归也捕获不到动态的 ctx.get('subagents') API 破坏。增加真实 rc.3 启动接口、提示词渲染、实际工具权限和子会话事件契约检查；CI 同时固定旧宿主与 rc.3，而非仅把 master 当作提示信号。
5. 完成新宿主真实控制测试：工程会话首个模型请求、主会话实现、spawn/fork、只读审核、structured_output、全文读取、超时/父取消/清理失败恢复、旧任务继续、台账及初始化 RPC。之后再扩大 peer 范围并发布新的适配版本。

成本与质量多轮对照仍为单独待办，不因宿主接口更新而视为完成。

## 证据与边界

隔离副本位于本地 `dsh-rc3-audit/`，仅该副本将开发依赖固定为 rc.3，并移除自身 peer 声明以单独观察源码能否编译；正式插件的 manifest、源码、依赖与已发布版本均未修改。已确认旧 peer 范围本身不支持 rc.3，隔离实验不能作为绕过宿主版本检查的方案。

证据：`dsh-rc3-build.log`、`dsh-rc3-typecheck.log`、`dsh-rc3-runtime-probe.json`、`dsh-rc3-runtime-probe.log`、`dsh-rc3-contract.log`、`dsh-master-ci-failures.log`。此次未启动新版 DSH 完整应用、未执行真实模型或子代理任务、未进行新版页面端到端验收。原 DSH checkout 仍为 0.2.0-rc.2，既有 profile 未升级到 rc.3，QMS 未修改。

官方依据：

- [0.2.1-rc.3 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.3)
- [迁移子代理 activation](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/docs/upgrade-guide/v0.2.1-alpha.1/subagent-activations/guide.zh.md)
- [通过 preset 配置子代理](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/docs/upgrade-guide/v0.2.1-alpha.1/subagent-preset-composition/guide.zh.md)
- [工作目录迁移](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/docs/upgrade-guide/v0.2.1-alpha.1/working-directory/guide.zh.md)
- [原生子代理全局工具变化](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/docs/upgrade-guide/v0.2.1-alpha.1/native-subagent-bundle-tools/guide.zh.md)

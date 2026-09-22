# 更新日志

[← 文档导航](README.md)

按版本查阅功能变化。当前使用方式以[项目首页](../README.md)和使用指南为准；历史条目中的实现方式、限制与测试数量可能已被后续版本替代。

## 0.23.7

- **修复 persona 字段在旧版 DSH 上不兼容**。`@deepseek-ai/dsh-persona` 在提交 `40792330c0`（2026-09-06，首次随 `dsh-v0.1.3-alpha.2` 发布）把配置字段从 `text` 改名为 `prefix`/`suffix`，两个 schema 互斥：写 `prefix` 的预设会被旧版 persona 插件以 `$.text missing required value` 整份拒绝，反之亦然。0.23.6 的派生逻辑**硬编码了 `prefix`**，因此在 `dsh-v0.1.3-alpha.1` 及更早的 harness 上，`eng` 预设挂载失败、新会话无法创建。现在改为**读取源预设自己使用的字段**再照写——`standard` 就是运行中 harness 的格式权威。已用两个版本的真实 `standard` 验证：`v0.1.3-alpha.1` 产出 `text: |-`，`v0.1.6-alpha.2` 产出 `suffix` + `prefix: |-`，两者 YAML 均解析通过。
- 顺带修复派生时的缩进：`suffix:` 此前被写到错误的层级，使新格式的 persona 段落 YAML 结构改变。新格式下同时保留源预设的 `suffix`（它声明工作目录），旧格式则不引入该字段。
- peer 范围补上 `|| ^0.1.7-alpha.1`。DSH `0.1.7-alpha.1` 修复了 0.1.6 中导致所有工具调用失败的问题（`ctx.tools[TOOL_RUNTIME_SCHEDULER]` 为 `undefined`，社区在讨论 #7035 / #7194 报告，官方确认修复）；peer 范围需要跟着覆盖该版本。
- `.preset-test.mjs` 增至 9 项：新增两组 persona fixture，分别断言 `text` 与 `prefix` 两种 schema 下的字段选择、`suffix` 保留与缩进正确性。已反向验证：把字段选择改回硬编码 `prefix`，两项断言立即失败。

## 0.23.6

- **修复「工程化开发引擎」预设加载失败**。`seed-preset.ts` 用 `@deepseek-ai/dsh-agent-presets` 导出的 `SHIPPED_PRESET_ROOT` 常量定位源预设，而该常量是 `fileURLToPath(new URL('../presets/', import.meta.url))`——它锁在**插件自己依赖树**里的那份包上，可能和**正在运行的** DSH 不同版本。于是派生出的预设携带运行中 harness 早已替换掉的行：DSH 2026-09-13 把 `workflow-worker-thread` 换成了 `workflow-ptc`，而该包同时退出了 `apps/cli` 的依赖，预设因此报 `row "workflow-worker-thread" names a plugin that cannot be resolved`，整个预设显示「加载失败」，任何新会话都无法启用任务流程。现在改为在**调用时**用 `createRequire` 从插件自身位置解析，跟随宿主的安装图。
- **预设改为每次启动重新派生**，而非"存在即跳过"。此前一次性复制把预设冻结成首次运行时的快照，DSH 每次修改 `standard` 都会让它失配；persona 格式也经历过 `text:` → `prefix`/`suffix` 的迁移，旧副本因此被 persona 插件的 schema 拒绝。现在检测到是本插件生成的预设才更新，**手工编辑过的预设绝不被覆盖**。
- persona 行改为**整块重写 `config:`**，不再匹配某一种历史措辞，因此对 schema 的后续演进免疫。同时**不再设置 `complete: true`**——那会让这段 prefix 成为整个系统提示词并抑制其余所有 section。
- 新增 `.preset-test.mjs`（7 项），断言 persona 已替换、使用当前 `prefix` 形式、不含 `complete`、agent 行只出现一次、`standard` 的所有顶层行都被继承、以及重复派生结果稳定。已反向验证：把 `complete: true` 加回去该测试即失败。`npm test` 从 43 项增至 50 项。

## 0.23.5

- **修复 `scripts/` 未随包发布，导致两条已声明的 npm script 在安装后无法执行**。`package.json` 声明了 `verify:package` 与 `verify:dsh`，但 `files` 白名单不含 `scripts/**`，用户装包后运行它们会直接 `MODULE_NOT_FOUND`。该问题早于 0.23.3 存在（`verify:package` 一直如此），0.23.4 新增的 `verify:dsh` 只是沿用了同一模式。现在把 `scripts/**` 纳入白名单，并在 `verify:package` 中加断言：包内必须能找到每一条 `package.json` 里声明的 `node <file>` script 目标。

## 0.23.4

- **关闭两处 Remote 路径边界漏洞**。`checkedPath` 此前用**原始字符串**比对禁止前缀，`D:/proj/../../Windows` 不匹配任何前缀，却被后续 `join()` 解析到 `C:/Windows`；实测 8 个越界样本中旧实现放过 7 个。现在先 `resolve()` 归一化再判断，禁止列表不再绑定盘符（`D:/Windows`、`E:/Program Files` 同样拒绝），并拒绝裸盘符根（`D:/`、`C:/`）。
- `writeInit` 不再写到工作区之外。`locateInitRoot` 的祖先回溯可能定位到工作区上一级：**读取**该文件是有意的（那才是真正拥有 `AGENTS.md` 的项目），但**写入**不是本工作区的事。现在越界写入直接拒绝并提示改选工作区，与 `dev_task init apply` 的 `assertInsideRoot` 一致；祖先回溯同时加上 8 层上限。新增 `isInside` 按**路径段**而非字符串前缀比较，`D:/a/bc` 不会被误判为在 `D:/a/b` 内。
- **新增 DSH 契约兼容性检查**（`scripts/verify-dsh-compat.mjs`，`npm run verify:dsh`）。它读取真实 DSH 检出里 typert 协议的类型声明，判断当前契约是 `schema` 还是 `create()`，再断言产物满足它、且 peer 范围确实覆盖该版本。这正是 0.23.3 修复的那类问题——单元测试看不到，因为测试从不通过真实注册表加载 descriptor。CI 新增 `dsh-contract` 作业：对固定基线 `dsh-v0.1.6-alpha.2` 失败即红，对 `master` 仅告警（`continue-on-error`），因此破坏性变更会在发布前暴露。已反向验证：把 peer 范围改回旧值，该检查会失败。
- **新增提交钩子端到端测试**（`.hook-test.mjs`，6 项）。此前的 P0 断言只检查钩子**源码**的字符串（关闭路径转义、NUL 分隔、捆绑冻结快照），能防手抄回潮，但**无法证明门禁真的拦住了提交**——一个全部拒绝或全部放行的钩子都能通过。新测试在临时 git 仓库里真实执行 `git commit`，双向断言：合法提交放行，消息格式错误、范围外文件、未到检查点、快照被篡改、敏感路径无高风险回执五类均被拒绝且给出对应理由。
- P0 断言从 126 增至 146；`npm test` 现包含钩子端到端用例（37 → 43 项）。

## 0.23.3

- **适配 DSH 0.1.6-alpha.2 的 typert strict codec 契约变更**。该版本把 codec 从直接携带 `schema` 改为惰性工厂 `create: () => TypertSchema`，并在注册时硬校验 `typeof codec.create === 'function'`；旧写法会在插件加载阶段抛 `strict codec has no create() factory`，整份 Remote 贡献被拒绝。`src/client/remote.ts` 的 36 个 strict codec 现在**同时携带 `create` 与 `schema`**，因此同一份产物在 0.1.2-rc.1（桌面版）与 0.1.6-alpha.2（源码版）上都能加载。两处内联的 `z.object({...})` 提为具名常量，与文件既有风格一致。
- peer 范围补上 `|| ^0.1.6-alpha.2`。此前声明未覆盖该版本，pnpm 只在安装时警告、运行时不拦，导致问题在启动时才暴露。
- 注意：npm 的 semver 不匹配未被范围显式点名的预发布版本，因此后续每个新的 DSH alpha 都需要在此处追加，否则会重新出现同类加载失败。

## 0.23.2

- 修复 verify / skill_result 先执行命令后审批、批准权限未传入 shell 的问题；拒绝、取消或审批不可用时不执行命令。
- 审批显示实际验证命令；批准模式只用于本次命令和回执写入，不改变会话策略，也不重复申请保存回执的审批。
- 修正提交规则与手册中的模块名示例，第一段使用当前任务 id，第二段使用 status 的 commit.label；自定义格式以任务冻结流程为准。
- dshtest 首轮在 0.23.1 复现权限问题；修复后连续两轮完整开发、验证、审核、本地提交及归档回退通过。专项覆盖审批拒绝、原命令批准执行、证据过期和单次权限恢复，详见[发布说明](release-0.23.2.md)与[测试报告](testing/0.23.2/测试报告.md)。

## 0.23.1

- 汇总本轮候选版的资源来源、Windows 技能加载、实施审核保留、派工状态、真实技能/验证/提交回执及状态一致性修复。
- 新增 status.artifact_requirements，提前披露当前阶段的记录字段和缺项；未知字段拒绝时给出恢复指引，整次写入保持不变。
- 需求技能按预设实际字段记录，修正敏捷流程误用标准字段的问题；小修正、权限恢复、契约核对和测试证据说明同步更新。
- 旧任务保留冻结流程，新任务使用标准 v2 和执行证据门禁。实际能力及未覆盖边界见[发布说明](release-0.23.1.md)与[测试说明](testing/0.23.1/测试报告.md)。

以下 rc 条目为本轮迭代历史，已汇总至 0.23.1；“尚未发布”描述的是当时状态。

## 0.23.1-rc.5（本地回归候选，尚未发布）

- 修复状态查询显示允许提交、实际却因技能未执行或回执过期而拒绝的不一致。status 新增 evidence_blockers，commit.allowed 纳入同一技能与文件摘要检查；不改写历史验证回执。
- 回归覆盖缺失技能、两种回执同时过期、只刷新验证、全部刷新后恢复，以及只读状态查询不修改台账。
- 测试说明区分已执行但失败、依赖阻塞未执行和模拟验证，要求测试对象与证据对应；不以报告行数证明质量。

## 0.23.1-rc.4（本地回归候选，尚未发布）

- 小修正允许主代理实施，保留两阶段审核与必要验证，不强制重新派子代理和无关编译。
- 子任务指引要求沙箱拒绝后走正式审批或报告阻塞，禁止反复换等价命令、改 ACL 规避。
- 这些是执行指引改进，不替代 Harness 沙箱或子代理控制能力；实际回归仍在进行。

## 0.23.1-rc.3（本地回归候选，尚未发布）

- 状态明确列出需要命令回执的附加技能；内置技能不重复要求 skill_result，可选的内置回执过期不会额外阻塞流程。
- 派工前登记 dispatch，自动标记实施项进行中；重派清除旧审核，禁止同时派发另一进行中项。登记表示派工意图，实际执行以工具日志为准。
- 已有实施项更新可省略标题，保留原文和审核；已审核项改标题且仍标完成时立即拒绝，避免追加修复项造成审核静默丢失。
- 方案要求核对真实接口字段及组件行为；审批驳回后先获取反馈、修订方案，再重新申请。
- 验证和审核指引补充异步时序、组件交互及上游异常响应检查；编译和源码匹配不能代替行为测试。
- 已安装并在原 EAMDEV-R2 任务实机验证：省略标题保留审核、派工先设进行中、重派撤销旧审核。完整终态闭环仍在验证。

## 0.23.1-rc.2（本地回归候选，尚未发布）

- 修复同名项目/个人资源覆盖导致来源误标。
- 第二轮实机发现并修复 Windows CRLF / BOM 导致内置技能注册、技能列表与正文读取失败；安装包检查覆盖七个内置技能注册。
- status 支持不带 task_id 发现工作区任务；更新实施项状态保留已有审核记录。
- 验证命令继承调用会话的沙箱策略及取消信号，返回真实失败与沙箱信息。
- 标准流程 v2 将提交放在审核之后；新任务完成前检查真实提交回执。
- 新任务检查技能加载记录，附加技能要求执行证据；终态技能提前执行。
- 验证回执关联声明文件内容，文件或范围变化后须重验。旧任务不强制迁移。

真实 EAM 项目重跑尚未完成，不能据自动化测试宣告实机闭环通过。

## 0.23.0

- 技能选择系统文件夹，规则选择 Markdown 文件，预览后确认安装。
- 统一资源卡片、搜索筛选、加载反馈、删除确认和窄屏布局。
- 增加任务台账搜索、风险/阶段筛选与验证审核摘要。
- 加强导入校验与失败清理，修复任务并发写入的版本读取次序。
- 优先使用 Harness 已注册的工作区，补充发布包行为测试和 Node 22/24 CI。

[完整发布说明](release-0.23.0.md) · [测试报告](testing/0.23.0/测试报告.md)

## 早期版本

以下保留原项目的版本记录，供追溯变化；历史验证描述不代表对当前版本的额外测试承诺。

### 0.22.7

**skill 目录选择器 + 包形态（0.22.7）**：① 安装表单新增「浏览…」——host 端 `listDirs` 逐级列举目录（Windows 盘符快捷 + 路径输入回车跳转 + ↑ 上级 + **可点击面包屑**标明当前位置），含 `SKILL.md` 的子目录标「含 SKILL.md ✓」，当前目录能否直接安装实时提示，点「选此目录」回填路径，彻底不用手输；② 安装上限放宽到 1000 文件 / 100 MB（单文件 20 MB 上限），skill 作为<b>完整包</b>安装（references / scripts / 模板 / 资源等全部保留，仍自动排除 node_modules / `.git` / `__pycache__` 缓存）；③ 实机验证<b>项目级</b>（工作区 `.dsh/skills`）与<b>用户级</b>（`$DSH_HOME/skills`）两条安装路径均完整落盘，逐级进入与面包屑经浏览器实测确认。

### 0.22.6

**文案与安装体验（0.22.6）**：「安装 skill」输入框 placeholder 去掉示例绝对路径，改为通用提示「本机 skill 目录，需含 SKILL.md」；`installSkill` 支持<b>容器目录自动定位</b>——填的目录自身没有 SKILL.md 但直接子目录里恰好有一个含 SKILL.md 的 skill 根时自动装入该子目录（多个候选则提示直接填 skill 根）。

### 0.22.5

**目录型 skill 安装（0.22.5）**：工作台「技能」页新增「安装 skill」——把本机已有的目录型 skill（`SKILL.md` + references / scripts / agents 等文件）一键装到<b>项目级</b>（工作区 `.dsh/skills`，团队共享）或<b>用户级</b>（`$DSH_HOME/skills`，个人所有项目可用）；安装校验 SKILL.md frontmatter、拒绝覆盖内置同名、拒绝覆盖已装同名、自动排除 node_modules / .git / `__pycache__` 等缓存目录并限制 200 文件 / 20 MB；实机验证 `software-testing` 目录型 skill 从 UI 安装完整落盘（含 references + scripts）。

### 0.22.3

**可信边界加固（0.22.3，采纳 GPT 评审）**：① 验证命令统一在任务记录的项目根运行（monorepo 子目录不再跑错目录），receipt.root 与任务根强校验；② 旧任务（无 frozen 快照）禁止升 `high_risk`——迁移或重建后才可；③ `init apply` 强制 `expected_hash`，新增 `existing_hash` 防审批期间文件被换（TOCTOU）；④ 任务记录新增 `revision`，每次写入 compare-and-swap，并发覆盖直接报错（`changed concurrently`）；⑤ 工作台 Remote 增加 host workspace registry（`registerWorkspace` 供 harness 集成，注册后未授权路径一律拒绝）；⑥ sandbox 升级审批展示 workspace；⑦ 文档明确 hook（本地反馈）/ host（工具流约束）/ CI（最终可信门禁）三层职责边界。

### 0.22.2

**质量修补（0.22.2，采纳 codex 评审五项）**：① client typecheck 修复——`project.ts` 不再依赖 `node:path`，浏览器面可完整类型检查；② sandbox 升级补审批——`sandbox_permissions` 必须与 `justification` 成对出现，`danger-full-access` 需人工一次批准，无审批服务即拒绝；③ Remote 任意路径设防——工作台 Remote 拒绝非绝对路径与系统级根目录；④ `set_risk` 升到 `high_risk` 时受流程能力门约束（`minimal`/`agile` 拒绝，不再绕过 `create` 的检查）；⑤ `loadTask` 补齐旧记录缺失字段（items / verification / review / commits），损坏记录 fail-closed 而非引擎裸崩。

### 0.22.1

**沙箱写入修复（0.22.1）**：`dev_task` 的文件写入此前没有携带按调用传递的沙箱策略（`writeText` 的 `sandboxPolicy` 参数），在 DSH 文件沙箱下会把 workspace 内的任务记录写入误判为越界而拒绝（`file access denied under workspace-write mode`，且会话策略变化无法影响它）；现在每次写入显式携带 `{ mode, workspaceRoot: 会话目录 }`，并新增 `sandbox_permissions` 参数（`workspace-write` / `danger-full-access`）作为被拒后的一次性升级路径。

### 0.22.0

**审计和发布质量（0.22.0）**：① 流程快照 hash——任务创建时固化 `config` 的 SHA-256，工具与提交钩子读任务记录时校验，被手改的快照一律拒绝继续；② 提交钩子完整性检测——新增 `dev_task verify_hook`，比对 `.git/hooks/commit-msg` 与内置门禁的 hash，被替换/篡改立即报错；③ 风险降级审批——新增 `set_risk`，`high_risk → standard` 必须人工批准并落 `risk_downgrades` 审计记录；④ 验证回执绑定项目根——receipt 记录 `root`，与任务 workspace 绑定；⑤ 内置规则指纹锁定——创建时固化内置规则内容指纹，包升级后 `status` 报 `bindings_drift` 而非静默换规则；⑥ 多项目 / 多语言 / 多任务测试矩阵补强。

### 0.21.0

**通用项目适配（0.21.0）**：① 新增项目适配层 `src/project.ts`——按特征文件识别 Node / Java / Python / Go / Rust 类型，从 workspace 向上发现项目根（`.git` / `.dsh` / 语言特征文件）；② 各语言默认验证命令（`npm test` / `mvn -q test` / `python -m pytest` / `go test ./...` / `cargo test`），`verify` 不带 `command` 时按 `.dsh/eng.json` 的 `verify_command` → 语言默认链自动跑真实命令；③ 治理文件识别扩展至 `AGENTS.md`、`CLAUDE.md`、`.cursorrules`，`init inspect` 一并报告治理文件、项目根、语言栈与项目级 skill/rule 目录（约定 `.dsh/rules/*.md`、`.dsh/skills/<name>/SKILL.md`）；④ 提交钩子加风险策略——触及敏感路径（`.git` / `.env` / credentials / secrets；`.dsh` 的任务记录与流程配置由快照 hash 与豁免保护）要求任务为 `high_risk` 且验证有真实命令回执，否则拒绝；⑤ 初始化写入越界保护——`init` / `create` 的写入目标必须落在项目根内；任务记录新增 `root` / `project_type` 字段。

### 0.20.0

**安全闭环（0.20.0）**：① 验证改真实命令回执——`dev_task verify` 新增 `command` 入参，引擎通过宿主 shell 服务真实运行该命令并落 `VerificationReceipt`（命令 / 退出码 / 超时 / 中止 / 起止时间 / stdout / stderr）；`high_risk` 任务的 `verified` 门改为要求回执 `exit_code === 0` 且非超时 / 中止，纯文本 `passed` 声明不再放行（常规风险仍可用 `passed` + `evidence` 文本）；② 文件范围检查补 `T` + 改用 `--name-status`——`--diff-filter=ACMRDT` 纳入类型变换，提交状态随范围拒绝一并报出，删除 / 类型变换 / 重命名的旧·新路径都受范围检查；③ 提交钩子改为从 `engine.ts` / `workflows.ts` 单一源打包生成（`build-hook.mjs`），彻底消除手写镜像漂移，未知流程在钩子侧同样 fail-closed（不再静默回退 `standard`）。

### 0.19.2

**审计修复（0.19.2）**：补齐七项——① 提交钩子 `stagedFiles` 用 `core.quotePath=false` + `-z` 按 NUL 拆分（中文文件名不再被八进制转义误拒）并补 `D`（删除范围外文件也被拦）；② 提交消息第一段改为 task id、钩子按 id 精确定位任务（不再按分支/mtime 猜，同分支多任务不再锁错）；③ artifact id 全流程唯一 + `record` 校验产物属于当前阶段（堵越阶段复用）；④ 高风险验证证据 `trim()` 后须非空（`evidence:[""]` 不再通过）；⑤ README/手册加「诚实边界」，明说验证/评审/实施项是模型自报、需人工或 CI 兜底；⑥ 文档修正优先级（内置 &gt; 用户 &gt; 项目、内置不可覆盖）与 enable 措辞，`.dsh/task-*.json`/`eng.json` 豁免文件范围门；⑦ 提交钩子改用任务快照的 frozen 配置校验（对抗任务执行中改流程导致的配置漂移）；⑧ 工作台 `writeInit` 对齐 `init` 保护（已有 `AGENTS.md` 时需显式 overwrite + 前端确认才覆盖）；⑨ `.p0-test.mjs` 纳入发布包，装包后 `npm test` 可用。新增回归测试。

### 0.19.1

**使用手册跟进（0.19.1）**：随包发布的 `docs/manual.html` 补上工作台「项目初始化」（默认置顶标签页、项目根自动发现、AI 生成 150 秒超时 + 覆盖需人工确认），第 7 节标签页从「三个」改为「五个」；安装章节补全 dsh CLI（非源码）安装方式与 pnpm 前置、`dsh plugin add` 的挂载机制；删除顶层已废弃的 `USER_GUIDE.html`（v0.9.1、无引用、不随包发布），README 目录结构描述同步为五标签页。

### 0.19.0

**工作台项目初始化（0.19.0）**：工作台新增置顶的「项目初始化」标签页——加载展示项目根 `AGENTS.md`、一键让 AI 扫描项目生成草稿（预览后再确认写回）、支持手动编辑与覆盖；Host 控制器新增 `readInit`/`writeInit`/`generateInit` 三个 Remote，`generateInit` 通过 `ctx.llm` + 默认模型在 Host 端直接生成，复用 `dev_task init` 的 200 行硬约束。

### 0.18.1

**会话工作目录修复（0.18.1）**：`dev_task` 的所有文件操作此前用 `fs.resolve(相对路径)` 不带 cwd，落到了 fs 后端默认目录（DSH 进程目录）而非会话工作区——在 web 会话里会把台账、配置、`AGENTS.md`、git 钩子写到/读到错误位置。改为从 `exec.agent.session.header.cwd` 取会话工作区并传给每个解析，补 4 项回归测试。

### 0.18.0

**工程可靠性加固（0.18.0）**：① 高风险任务与流程能力绑定——`high_risk` 任务只能在具备「验证门 + 文件范围 + 评审门」能力的流程创建，选 `agile`/`minimal` 直接拒绝；② 任务创建时固化流程快照（预设 id + version + 完整配置），后续 `status`/`advance`/`verify`/`review`/`commit` 一律用快照，中途改 `.dsh/eng.json` 不再漂移在途任务的门禁；③ 未知流程失败关闭——`.dsh/eng.json` 缺 `flow` 或 `flow` 不在预设里一律报错（`UNKNOWN_FLOW` / 缺字段），不再静默回退 `standard`；④ 核心 skill/rule 不可取消、不可被同名覆盖——项目阶段绑定只能追加不能移除预设自带绑定，同名规则/技能读内置版、新建同名被拒；⑤ `init` 升级 `inspect → propose → apply` 三阶段，覆盖已有 `AGENTS.md` 需人工批准。

### 0.17.0

**项目初始化 + 语言无关内置规则（0.17.0）**：`dev_task` 新增 `init` 操作，生成项目根 `AGENTS.md`（DSH 每会话自动注入），落盘前做 200 行硬校验、已存在需 `overwrite` 才覆盖；内置 `solution-design` / `coding-conventions` / `security-redlines` 去掉 Java 专属概念（Impl / DTO / VO、Controller / Mapper），改成语言中立骨架，语言特定规范交给项目自建 rule。

### 0.16.0

**流程预设收敛（0.16.0）**：把「自由编辑阶段图/守卫/产物/提交规则/验证开关」收敛为「选一套内置流程预设 + 给节点挂 skill/rule」。新增 `src/workflows.ts` 内置 `standard` / `agile` / `minimal` 三套流程（阶段图、守卫、产物字段、提交规则、验证证据开关全部固化）；`.dsh/eng.json` 从完整配置精简为 `{ flow, stage_bindings }`；工作台删掉流转/产物/提交规则/验证开关编辑 UI，只剩「流程预设 + 流程节点（只读）+ 阶段技能/规则」；git 提交钩子同步按 `flow` 选预设。

### 0.15.0

**弹窗 + markdown 查看（0.15.0）**：skill/rule 的查看与编辑从内联卡片改为居中宽弹窗；查看时正文用 DSH 自带的 `MarkdownText` 渲染成 markdown 富文本（不引入任何新依赖），编辑时正文保持纯文本。

### 0.14.0

**skill / rule 查看 + 删除（0.14.0）**：内置 skill/rule 从「只读不可见」改为「可查看正文」；自建（项目/用户）skill/rule 新增删除（两步确认）。删改在类型层即把 `bundled` 排除，内置资源永不误删。

### 0.13.0

**两阶段评审硬门（0.13.0）**：`todos_done` 进一步收紧——每个 done 的 item 必须带 spec + quality 都 pass 的评审记录，缺评审或任一阶段 fail 都会挡住「开发 → 交付」，并以具体 item 报出阻塞原因（`todosBlockers`）。派工审计保持软约束。

### 0.12.0

**台账硬门 + 软约束修复（0.12.0）**：`todos_done` 守卫改为「实施项非空且全部 done」；`code-implement` 技能里写清「两阶段都 pass 才标 done」。

### 0.11.0

**派工 / 审核审计（0.11.0）**：`TaskItem` 新增 `dispatch`（子代理派工留痕）与 `review`（spec / quality 两阶段评审）字段；`dev_task` 新增 `dispatch`、`review_item` 操作；工作台新增「任务台账」视图展示逐项审计。派工留痕是软约束——模型可自己实现小项而不强制派子代理。

### 0.10.0

**需求/方案人工确认门（0.10.0）**：`requirement_confirmation` / `solution_confirmation` 两个守卫从「模型自己标记」升级为「人来批准」。走 `advance` 撞上确认门时，`dev_task` 用 `@deepseek-ai/dsh-user-approval` 发起审批；人在页面点「允许」才放行，模型不能自己确认、也不能绕过。headless e2e 验证真模型全流程时两个确认都会触发。

### 0.9.1

**工作台可用性（0.9.1）**：修复「新建 skill / 新建 rule」按钮点击不弹出表单（`formOpen` 只认编辑态，新建态缺少显式标志）；给六个守卫补 hover 说明、把「产物齐全」改名「产物字段已填全」并讲清「产物 = 阶段要写清楚的记录、字段 = 这份记录里必填的空」，「节点挂载」改名「阶段技能 / 规则」。

### 0.9.0

**点选即用（0.9.0）**：host 入口新增 `src/seed-preset.ts`——首次启动自动把当前 `standard` 复制成 `eng` 预设（换工程人设 + 追加 agent 行，幂等、不覆盖手改）。装 bundle 重启后预设列表直接出现「工程化开发引擎」，点选即激活、切走即不激活，零复制/零编辑/零脚本。实机 boot 验证：boot 后 `.agent-presets/eng` 自动生成（agent 行 + 工程人设齐全）、roster 列出 `eng`（user）、`eng` 会话有 `dev_task` 且 persona 含「铁律」、`standard` 会话无 `dev_task`。

### 0.8.1

**一键激活（0.8.1）**：新增 `preset/enable.mjs`（bin: `dsh-task-engine-enable`），一条命令自动复制 `standard` → `eng`、把 persona 换成工程人设、追加 agent 行、写 `preset.yml`。persona 从「必须换」降级为「可选」——`eng-delivery` 技能自带 `whenToUse`，即使不加人设，模型遇到开发请求也自己加载技能走 `dev_task`；最简激活只剩「复制预设 + 追加一行 agent 行」。实机验证：脚本生成的 `eng` 预设挂载后 `dev_task` 可见、persona 以工程人设（含「铁律」）渲染、`standard` 仍无 `dev_task`。

### 0.8.0

**按预设激活（0.8.0）**：`dev_task` 工具与内置技能从 host 全局层拆到 agent 层。host 入口只挂 `task-engine` Remote 控制器 + 工作台 UI（`src/index.ts`）；新增 `src/agent.ts`（`./agent` 出品）、`src/dev-task.ts`、`src/shipped-skills.ts`，由预设的 `agent.cordis.yml` 命名后，在**该预设的 scope** 里注册工具与技能。实机 boot 验证：`standard` 会话工具目录不含 `dev_task`（26 个工具），加了 `@godv61/dsh-task-engine/agent` 行的 `eng` 会话含 `dev_task`（27 个工具）且描述正确，换回 `standard` 再次不含——切换预设即切换流程激活状态。

### 0.7.0

**全屏工作台 + 在线编辑（0.7.0）**：配置页从设置弹窗迁出，改为侧边栏 `sidebar.footer.action`「工程流程」按钮，点开 `shell.overlay` 全屏工作台（触发按钮与覆盖层共享一个 store 控制开关）。工作台分「流程配置 / 技能 skill / 规则 rule」三个标签页；技能和规则列表支持在线编辑——`readSkill`/`readRule` 读回正文、改 description/whenToUse/正文、`writeSkill`/`writeRule` 写回；内置项只读，项目/用户项可原地编辑，新建同时支持项目级/用户级。旧的 `settings.section` 入口移除，统一走侧边栏按钮。浏览器 e2e 全绿。

### 0.6.1

**配置页精简 + 自建 skill 可观测（0.6.1）**：设置页的流转/产物/提交规则/新建默认折叠，「节点挂载」从六阶段全平铺改成「选一个阶段再看它挂了什么」；新建成功提示带回显路径（`.dsh/skills/<name>/SKILL.md` 或 `$DSH_HOME/…`），挂载清单给非内置的 skill/rule 标「（项目）/（用户）」来源。修复 `listSkills` 依赖 host skill registry 导致项目 `.dsh/skills` 自建技能不显示的问题——改为与 `listRules` 一致，直接扫「内置 + 项目 + 用户」三层目录。浏览器 e2e 全绿。

### 0.6.0

**skill/rule 挂载与渐进披露（0.6.0）**：`WorkflowConfig` 新增 `stage_bindings`（每阶段挂 skills/rules，可选字段），`dev_task` 的 `status`/`advance` 按当前阶段披露挂载的 skill 名 + rule 正文；内置 6 技能 + 3 规则库；Host 控制器新增 `listSkills`/`listRules`/`writeSkill`/`writeRule`；设置页新增「节点挂载」和「新建 skill / rule」两块，同时补上 `dev_task` 缺失的 `items` 操作（更新实施项状态）。引擎层 `stage_bindings` 校验（未知阶段/空名）与合并已单测通过。

### 0.5.0

**网页图形化配置界面（0.5.0）**：新增 `src/client/` 设置页「工程流程配置」+ Host 端 `task-engine` Remote 控制器；`@godv61/dsh-task-engine` 升级为双端包（`dsh.client` manifest + `./client` 出品，`exports` 暴露）。已实机验证：`dsh web` 起服务后 boot 数据里 `@godv61/dsh-task-engine` 以 `inject:["@deepseek-ai/dsh-api-gateway"]` 进入 application batch、`/plugins/…/client.js` 正常服务；headless 冒烟确认 boot + `dev_task` 未被新控制器破坏。浏览器点击级 e2e 留到发布后用真浏览器收尾。

### 0.4.1

**真实模型端到端（0.4.1）**：headless + NewAPI DeepSeek 下让真模型走 `dev_task` 全流程，抓到并修掉一个真实 bug——`readText`/`writeText` 调 `fs.resolve()` 漏了 `await`，把 `Promise<FsTarget>` 当 `target` 传给了读写方法，导致 create/record/advance/commit 全部写不了任务文件、读永远返回 undefined。0.4.1 修复（`await fs.resolve(relPath)`），并把 `task_id` 在 create 也必填的说明补进工具 schema 与技能。修复后走真实 `ctx.fs` 路径冒烟全绿。

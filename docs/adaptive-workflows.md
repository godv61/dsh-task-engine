# 自适应工程任务

本页描述任务级流程。可选 SonarQube 审核支持 CI 结果、上传式本机扫描，以及在未提交工作区运行的本地规则审核。

旧 `.dsh/eng.json` 与已创建任务的快照继续可读，工作台不再提供旧版流程配置页。新需求在工程化会话中先评估复杂度，调用 `dev_task assess` 预览，再用 `create` 的 `complexity` 与 `complexity_reason` 创建任务。复杂度由需求范围和实现依赖决定，`risk_level` 单独判断。

| 复杂度 | 适用情形 | 元技能顺序 |
| :--- | :--- | :--- |
| 低 `low` | 边界明确的局部修改 | 代码开发 → 测试 → 代码审核 → 完成 |
| 中 `medium` | 常规功能或缺陷修复 | 需求分析 → 代码开发 → 测试 → 代码审核 → 完成 |
| 高 `high` | 跨模块或存在实现依赖 | 需求分析 → 任务编排 → 代码开发 → 测试 → 代码审核 → 完成 |
| 超高 `ultra` | 完整新模块或大范围重构 | 需求分析 → 架构设计 → 任务编排 → 代码开发 → 测试 → 代码审核 → 完成 |

高档的任务编排按实现先后拆解，记录每步依赖、完成判据和交接产物；它不按人员或分支分发。`task-plan.steps` 中每项应单独起行并以稳定 ID 开头（例如 `- I1 数据模型`），`dev_task items` 必须登记相同的全部 ID；缺项不能进入代码开发。超高档的架构设计记录模块边界、接口和取舍，不默认要求迁移或回退演练。每档的测试要有实际命令回执，审核要有通过结论；低档每项一次审核，其余档对需求符合性和质量分别记录。CI 与上传式本机扫描在测试后提交；本地规则审核先检查未提交代码，再于代码审核通过后提交。

任务台账中的“已开始”是实施项进入执行的记录，可由当前会话直接完成，不表示一定派给子代理。“待审查”指该实施项缺少规格/质量审查，和最后的整项代码审核阶段不同。实施项列表重排时，已完成或有开始/审查记录的项仍保留在台账。

## 元技能交接契约

| 元技能 | 输入 | 交接产物 |
| :--- | :--- | :--- |
| 需求分析 | 用户诉求、代码库现状 | 目标、范围、可验证的验收条件 |
| 架构设计 | 已明确的需求与现有结构 | 模块边界、接口变化、主要取舍 |
| 任务编排 | 需求、必要的架构决定 | 按先后顺序的实施项、依赖、每步完成判据与交接 |
| 代码开发 | 上述产物、项目 Skill/Rule | 变更文件、实现结果、已知限制 |
| 测试 | 验收条件和变更 | 真实命令回执、覆盖场景、失败及修复结果 |
| 代码审核 | 变更和测试结果 | 审核结论；启用 SonarQube 时包含该次 CI 或本机扫描的结果 |

每个节点始终加载同名核心 Skill。`.dsh/meta.json` 的 `meta_bindings` 只增加项目需要的 Skill 名称，不决定整个项目所有会话的流程。相同名称按 `.dsh/skills` → `.agents/skills` → `$DSH_HOME/skills` → 插件内置解析。生效 Skill 的 `profile.json` 持有 Rule 引用；项目同名覆盖用户级时采用项目 Skill 自身的 Rule，不暗中合并。

工作台中点击“配置核心 Skill 的 Rule”即可编辑。若核心 Skill 当前来自内置、用户级或 `.agents/skills`，保存时会先复制为同名 `.dsh/skills` 项目 Skill，再写入该项目 Skill 的 Rule 档案；打开编辑器不会写入文件。

```json
{
  "meta_bindings": {
    "requirements-analysis": ["qms-project-map"],
    "code-development": ["qms-project-map", "qms-code-backend"]
  }
}
```

任务创建时冻结实际的流程、Skill 来源和 Rule 引用。运行时仍读取相同来源的最新正文并报告漂移，因此团队修改规范后，进行中的任务应重新核查已有结论。

## 初始化项目知识

工作台“项目初始化”页将项目 Skill/Rule 与 `AGENTS.md` 分为两个区域。“自适应流程”页顶部也有“初始化项目 Skill / Rule”入口。点击“复制初始化请求”后，在项目根工作区的新“工程化开发引擎”会话中粘贴发送；页面本身不会启动模型或写入 Skill/Rule。

在项目根目录运行 `dev_task init_project phase=inspect`。扫描读取一级目录与常见构建清单，返回结构、可证实的技术栈版本及建议的多个项目 Skill 名称，例如 `eam-project-map`、`eam-tech-stack`、`eam-code-backend`。模型结合实际源码、测试和现有治理文件拟定 Skill/Rule 内容；`phase=propose` 预览文件与挂载关系；用相同内容及哈希调用 `phase=apply` 才写入 `.dsh/skills`、`.dsh/rules` 和 `.dsh/meta.json`。已有同名资源不会被 init 覆盖。扫描结果只提供证据，旧代码中的偶发写法不能自动成为团队规则。`*-project-map` 要总结整个仓库的模块职责、依赖和通用导航，供不同需求复用；当前需求的专属调用链放在任务产物或单独命名的领域 Skill。插件会拒绝遗漏扫描发现的主要模块或构建清单的地图草稿，并在仓库结构变化后要求重新预览；这不能代替人检查正文事实。应用结果中的团队配置文件应纳入 Git，供其他分支和成员使用。

## 可选 SonarQube 审核

不需要 SonarQube 的项目保持工作台「自适应流程」里的开关关闭，或不在 `.dsh/meta.json` 写 `sonar`。不需要配置 Token，代码审核仍按审核元技能和项目 Rule 执行。

需要使用的项目，在工作台打开 SonarQube 开关，填写服务地址、项目 Key、扫描来源及分析对象，并保存。Token 可直接在同页输入并单独保存；插件调用 DSH 本机凭据存储，按项目工作区隔离，页面只显示是否已配置，不回显 Token。也可以手工写入 `.dsh/meta.json` 的非敏感配置。只有显式启用时，之后创建的新任务才冻结 SonarQube 审核策略；已创建任务不会因开关变化而自动切换：

```json
{
  "sonar": {
    "enabled": true,
    "host_url": "https://sonarqube.example.com",
    "project_key": "my-project",
    "mode": "branch",
    "source": "ide-local",
    "reference_branch": "main",
    "include_paths": ["backend", "pom.xml"],
    "token_env": "SONAR_TOKEN"
  }
}
```

Token 首选从本机 DSH 凭据存储按项目读取；没有保存时兼容 `token_env` 指定的服务进程环境变量。它不写入项目配置或任务台账，切换项目不会串用。DSH 的本地凭据提供方使用仅当前操作系统用户可读的本机文件持久化，重启后仍可用；它不向同一用户运行的其他程序提供隔离。功能测试通过后，到“代码审核”调用 `dev_task sonar_check`。`source=ide-local` 同步项目 Quality Profile，用独立的 SonarLint 后台检查当前任务登记文件中、相对本机 Git 参考分支新增或修改的 Java、JS/TS、Vue、CSS、HTML 和 XML 代码行；`include_paths` 可限定项目相对目录或文件，留空则使用任务登记的全部代码。它不需要提交、推送、CE task ID，也不上传分析。本地中高级问题会阻止审核通过；对本地分析器不支持的语言，只有该项目服务端 Quality Profile 存在生效规则时才标为未覆盖并阻止通过。此结果不代表服务端 Quality Gate。审核通过后，在“代码审核”检查点提交。`source=ci` 先在“测试”检查点提交并推送，传入 CI 的 `ceTaskId`；`source=local` 也先提交，但由本机 SonarScanner 上传并等待 Compute Engine。后两种方式只依据新代码问题和 `new_*` Gate 条件阻断，旧代码导致的整体 Gate 状态单独展示。代码变化后须重新测试和审核。

Quality Profile 决定规则，CI 构建与扫描参数决定分析哪些目录，两者不是同一项配置。QMS 当前服务端分析索引只有 Java 与 XML 的后端文件，即使服务端还存在 JavaScript Quality Profile，本地审核也应通过 `include_paths` 对齐后端模块。使用者可在当前项目工作台的「任务台账」展开任务的“最近一次 SonarQube 审核”，查看通过状态、阻断数量、每条规则及文件行号。每次 `sonar_check` 在项目 `.dsh/reviews/<任务 ID>/` 生成一份 Markdown 文件，任务台账显示文件路径；完整结构化结果仍在 `.dsh/task-<任务 ID>.json` 的 `sonar_audit` 字段。两处均不写 Token。报告目录可加入项目 `.gitignore`。代码或 Skill/Rule 改动后，需要重新测试并再次运行 `dev_task sonar_check`。

本地规则审核需预先提供 SonarLint 后台组件及其所需 Java 运行时路径。设置 DSH 服务进程环境变量 `DSH_SONARLINT_JAVA`（Java 可执行文件）、`DSH_SONARLINT_LIB`（包含后台 JAR 的目录）和 `DSH_SONARLINT_PLUGINS`（内置分析器 JAR 路径；Windows 多个路径以分号分隔），然后重启 DSH。此路径可以指向独立安装的组件；无需启动 IDEA，也不要求把项目的 JDK 8 升级为分析器使用的 Java 版本。JavaScript、TypeScript、Vue 与 CSS 分析还需本机 Node.js。当前实现未覆盖 SQL 等其他代码扩展名；它会查询该项目的服务端 Quality Profile，只有相应语言存在生效规则时才把此类文件列为未覆盖。QMS 项目目前没有 SQL 语言的 Quality Profile，因此 SQL 迁移文件不构成 Sonar 阻断，但仍需单独完成数据库验证。部分服务端规则本来就不能在 SonarLint 本地执行；本地检查也没有服务端 Quality Gate、跨文件语义和完整构建依赖的同等保证。需要与服务端完全一致的结论时，使用 CI 扫描。

本机扫描只支持分支模式，要求 SonarQube Server Developer Edition 或更高版本；Community Build 只能保存主分支分析，插件会在上传前拒绝。`reference_branch` 必须已在该 Sonar 项目中分析过，且不能等于当前任务分支。参考分支决定 Sonar 对“新代码”的定义；它不是“本次任务涉及的文件”过滤器。任务分支的 HEAD 必须与记录的提交一致，工作区除 `.dsh` 任务记录外不能有未提交文件。本机需要安装 Maven 或 SonarScanner 并能访问 Sonar 服务。默认有根 `pom.xml` 时运行固定版本 Maven Sonar 插件，否则运行 `sonar-scanner`。复杂项目可在页面配置 `scan_command`（例如 Maven 命令及项目所需的 `-DskipTests` 等参数）；只允许单条 Maven 或 SonarScanner 命令，不接受 Shell 运算符和 Token 参数。插件追加项目 Key、分支、参考分支和结果文件参数，通过子进程环境传入 Token，不会执行 `git push`。本机扫描会更新 Sonar 服务端同名分支的分析结果；团队共用分支应优先使用个人本地分支进行试验。

CI 模式建议保存扫描产生的 `report-task.txt` 为制品，方便取得 `ceTaskId`。如果 CI 已配置 `sonar.qualitygate.wait=true`，它可以继续作为 CI 门禁；插件读取分析结果，不重复运行扫描。Sonar 只需针对所选任务实际扫描的分支或合并请求配置 `mode`，具体 CI 触发条件由项目自行决定。分支/MR 最新问题列表与指定 `analysisId` 的门禁分别来自 SonarQube API；如果同一分支同时运行多次扫描，应按最新扫描重新审核，避免把旧结果当成当前代码。

失败案例可以用 `dev_task learn_rule phase=propose` 生成项目 Rule 预览，注明 Sonar issue key、可复用原因和正确写法；审阅后用 `phase=apply` 写入项目 Rule 并挂到对应项目代码 Skill。它只影响未来任务，不能把一次误报或整个 Quality Profile 自动复制成规则。
`sonar_check` 与 `status` 会按 Sonar 规则列出尚未沉淀的阻断案例；这只是候选清单。先核实是否为真实问题，再把有普遍价值的修复提炼成 Rule，并把生成的 `.dsh/rules/`、`.dsh/skills/` 和 `.dsh/meta.json` 作为团队配置纳入 Git。每次初始化时，项目地图至少要涵盖扫描发现的主要模块与构建清单；插件会拒绝遗漏模块的草稿，仍需人工核对职责、依赖和事实。

### 分支、提交与当前限制

SonarQube 服务端把上传式分析结果放在项目的某个分支或合并请求下，插件以它定位要查询的问题。`ide-local` 的参考分支只用于本机 Git 差异，不在 Sonar 服务端创建新分支分析；因此它可在首次提交之前审核未提交文件，也适用于 Community Build。

`ide-local` 采用与 SonarQube for IDE 相同的本地分析后台，对未提交代码应用服务端 Quality Profile 中受支持的规则。`local` 是另外一条上传式扫描路径，要求 SonarQube 支持分支分析、参考分支已有分析，以及本机扫描器和构建环境可用。任一前提缺失时审核会报错。CI 模式继续承担推送后的完整验证。

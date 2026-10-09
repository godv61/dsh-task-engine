<p align="center">
  <img src="https://raw.githubusercontent.com/godv61/dsh-task-engine/main/.github/assets/readme-hero.svg" alt="DSH Task Engine：从项目知识到可验证交付" width="100%" />
</p>

<h1 align="center">DSH Task Engine</h1>

<p align="center">
  为 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 提供按需求运行的工程化开发引擎。<br />
  让项目知识、团队规范、测试证据和代码审核在每次开发中真正生效。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@godv61/dsh-task-engine"><img src="https://img.shields.io/npm/v/%40godv61%2Fdsh-task-engine?style=flat-square&amp;color=0d9488" alt="npm 版本" /></a>
  <a href="https://github.com/godv61/dsh-task-engine/actions/workflows/verify.yml"><img src="https://github.com/godv61/dsh-task-engine/actions/workflows/verify.yml/badge.svg" alt="自动验证状态" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-334155?style=flat-square" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="#安装与检查">安装</a> ·
  <a href="#首次初始化项目">项目初始化</a> ·
  <a href="#执行一个开发任务">任务操作</a> ·
  <a href="#按项目配置-sonarqube">SonarQube</a> ·
  <a href="docs/manual.html">HTML 使用手册</a>
</p>

---

## 它解决什么问题

一个项目会有许多需求、分支和会话。团队需要复用编码约定，但不同需求不该被迫走完全相同的步骤。

| 常见问题 | Task Engine 的做法 |
| --- | --- |
| 大模型反复询问项目结构、版本和编码习惯 | 初始化项目地图、技术栈与开发 Skill；Rule 保存团队约束。 |
| 小改动流程太重，大改动又缺少分析与拆解 | 按**每项需求**评估复杂度，选择低、中、高、超高四档路径。 |
| 会话说“测试通过”，实际没有执行测试 | `dev_task` 保存命令和回执；常见测试运行器必须证明至少执行一个测试。 |
| 审核问题散落在聊天记录里 | 任务台账展示阶段、实施项、测试与审核；可选 Sonar 报告落到项目目录。 |

> **项目配置是团队知识，流程选择属于当前需求。** 同一项目的普通会话不会自动进入工程流程；不同工程任务也可以选择不同档次。

```text
项目初始化                        每个新需求                            交付
结构地图 · 技术栈 · Skill/Rule  →  复杂度评估 → 阶段执行 → 测试 → 代码审核 → 完成
              │                       │                     │
              └── 项目级知识复用 ──────┘                     └── 台账与证据
```

## 安装与检查

插件必须安装到**实际启动的 DSH profile**。以下以 Web profile `web` 为例：

```sh
dsh plugin --profile web add @godv61/dsh-task-engine
```

如果从 DSH 源码运行，在 DSH 根目录执行：

```sh
pnpm dsh plugin --profile web add @godv61/dsh-task-engine
pnpm dsh web --no-open
```

安装后关闭旧的 DSH Web 进程，再以同一个 profile 启动。打开页面，检查侧边栏是否出现**工程任务**，以及新会话的模式菜单是否能选择**工程化开发引擎**。只在普通项目目录执行 `npm install` 不会把插件挂进 DSH profile；若没有入口，先核对安装和启动使用的是不是同一个 profile，再看 Web 启动日志。

## 首次初始化项目

1. 在**工程任务**顶部选择代码库根目录作为工作区，并确认当前 Git 分支。
2. 打开**项目初始化 → 项目 Skill / Rule 初始化**，点击**扫描并生成提案**。工作台会读取项目清单与部分源码，用已配置的默认模型生成 Skill / Rule 草稿；无需复制请求到会话。生成过程可能需要一两分钟。
3. 逐项检查草稿正文、简介、元技能挂载及 Rule 关联。可直接修改或移除不合适的建议；修改后点击**检查修改**。
4. 检查通过后点击**确认写入项目**。工作台再次核对项目地图覆盖、同名文件和配置版本，只写入刚审阅的提案。若项目配置或文件已变化，重新生成或检查。不要把某一条需求的实现方案当成整个项目的结构地图。

| 阶段 | 会发生什么 | 重点检查 |
| --- | --- | --- |
| 扫描并生成提案 | 只读扫描目录、构建清单、代表性源码，用默认模型生成草稿 | 后端、前端和脚本等主要模块是否都被发现。 |
| 检查修改 | 校验项目地图、Skill、Rule、挂载关系和同名冲突 | 内容是否覆盖整个仓库；版本和规则是否有代码证据。 |
| 确认写入项目 | 按同一提案哈希写入文件 | 已有同名资源不会被静默覆盖。 |

通常会生成 `.dsh/skills/<项目名>-project-map/SKILL.md`、技术栈与后端/前端编码 Skill，以及 `.dsh/rules/` 下的项目规则。**项目地图应描述整个仓库**的模块职责、依赖和通用入口；当前需求的页面、接口、验收条件应放进任务产物。页面中的 **AGENTS.md 初始化**是另一项操作。

初始化还会建议一个可选的 `<项目名>-business-capabilities` Skill：仅当仓库提供页面、路由、接口、测试或业务文档等证据时，才生成可复用的业务能力说明。每项能力应列出代码路径，并区分已确认事实、代码推导和待业务确认；不能凭类名猜功能。它可挂载到需求分析和架构设计元技能。没有足够证据时从提案中删除即可。

团队共享前，审阅 `.dsh/skills/`、`.dsh/rules/` 和 `.dsh/meta.json`，再提交到 Git。Token 与本地审核报告不应提交。

## 元技能、Skill 和 Rule

内置元技能覆盖**需求分析、架构设计、任务编排、代码开发、测试、代码审核**。元技能约定本阶段做什么、交给下一阶段什么；项目 Skill 说明如何在当前仓库做；Rule 描述更具体的约束、触发条件与适用范围。

安装包只内置这些通用核心 Skill，**不内置 Java 或某团队的业务 Rule**。项目 Rule 由初始化提案或使用者审阅后建立，避免把别的项目的规范强加到当前仓库。

项目 Skill 可以放在 `.dsh/skills/`，工作台也能发现 `.agents/skills/` 中的 Codex 项目技能。用户级 Skill 可跨项目复用；**同名 Skill 的优先级是项目级 > 用户级 > 内置**。项目同名版本使用自己的 Rule 列表，不会自动混入被覆盖版本的 Rule。

在**工程任务 → 自适应流程**给元技能挂载 Skill，在对应 Skill 的 `profile.json` 中配置 Rule；项目挂载保存在 `.dsh/meta.json`。Rule 跟随 Skill 生效，不会因为挂在某一阶段就随意叠加给其他 Skill。已创建任务冻结阶段图和资源引用；被引用的 Skill/Rule 正文下次读取会更新，删除正在引用的资源会阻止流转。

配置时先在左侧选择元技能；右侧显示核心 Skill 与已挂载 Skill。用搜索框查找要挂载的 Skill，点该 Skill 旁的**配置 Rule**会立即打开右侧抽屉，可按名称、来源或“已选”筛选规则。配置项目挂载后，使用页面底部始终可见的**保存自适应配置**；Rule 抽屉则单独保存对应 Skill 的规则档案。

## 四档流程与交接

| 档次 | 典型需求 | 默认阶段顺序 |
| --- | --- | --- |
| **低 · low** | 边界明确的局部修改 | 代码开发 → 测试 → 代码审核 → 完成 |
| **中 · medium** | 常规功能或缺陷修复 | 需求分析 → 代码开发 → 测试 → 代码审核 → 完成 |
| **高 · high** | 跨模块且有实现先后依赖 | 需求分析 → 任务编排 → 代码开发 → 测试 → 代码审核 → 完成 |
| **超高 · ultra** | 完整新模块或大范围重构 | 需求分析 → 架构设计 → 任务编排 → 代码开发 → 测试 → 代码审核 → 完成 |

需求分析交付目标、范围、非目标和可验证的验收条件；架构设计交付边界、影响与取舍；任务编排交付按实现先后排列的实施项 ID、依赖和交接产物；开发交付文件与逐项审查；测试交付真实命令；代码审核交付结论和可选 Sonar 报告。**实施项体现推进顺序，不是按人数分派工作。** 风险等级由模型另外判断，不等同复杂度。

项目已有 **CodeGraph** 时，需求和架构阶段可用其索引核对调用链与影响范围；索引不可用时继续读源码。项目已有 **OpenSpec** Change 时，可把已确认的规格编号关联到任务计划。两者均由使用者按项目选择；`dev_task` 仍保存本次需求的阶段、实施项、测试及审核，不会自动安装工具或维护两份进度台账。

## 执行一个开发任务

在项目工作区新建**工程化开发引擎**会话，可以直接这样提出需求：

```text
请在当前项目实现“设备授权范围”需求。先读取已有项目 Skill/Rule，
评估需求复杂度并明确验收条件。需要任务编排时，按实现先后列出
实施项、依赖和交接产物；开发、真实测试和代码审核按任务台账推进。
只在当前分支工作，不要推送。
```

随后按台账和 `dev_task` 的门禁推进：

1. **确认任务归属。** 先用 `status` 查看工作区和分支是否已有任务；新需求用 `assess` 预览档次和技能，再用 `create` 创建。发现已有任务时核对任务 ID，避免把需求写进别的任务。
   新任务 ID 限 1–64 位 ASCII 字母、数字、连字符或下划线，首位为字母或数字，以避免不同 ID 写到同一个文件。
2. **记录阶段产物。** 每阶段查看 `status` 给出的 Skill、Rule、必填产物及阻塞原因；用 `record` 写入当前阶段允许的内容，用 `advance` 进入下一阶段。不要手工改任务 JSON 跳过门禁。
3. **按顺序实施。** 高、超高任务先在计划中列稳定实施项 ID，再用 `items` 登记。`items` 默认按 ID 增量合并；例如只补 I5 不会删掉 I1–I4。确需重排或移除未开始的项目，显式使用 `items_mode=replace` 并提供完整列表；实施中、已完成或已有审查记录的项仍受保护。
4. **记录实现与逐项审查。** 用 `dispatch` 和 `review_item` 留痕。开发者可以在当前会话直接实施，不要求把任务派给其他人。把所有变更文件登记到任务 `files` 范围；代码变动会使旧测试和审核回执失效。
5. **验证与审核。** `verify` 执行真实命令；进入代码审核后，若启用 Sonar，调用 `sonar_check` 并处理结果，再记录 `review`。门禁通过后按 `status.commit` 提示提交并完成任务。

**测试回执的要求：** 退出码为 0 只是必要条件。Maven Surefire/Failsafe、Node TAP/Jest/Vitest、pytest、Go test、Cargo test 的常见输出，以及本次 Gradle `test` 执行新生成的 JUnit XML，必须证明至少执行一个实际通过的测试；全部跳过、没有可识别证据，或仅运行 `true`、编译命令时不能算通过。验证命令不能通过串联、管道、重定向或命令替换掩盖失败。项目使用其他运行器时，先用能输出受支持摘要的测试命令；记录未覆盖项，不能用文字自报通过。Maven 项目的建议命令为 `mvn -B test`，Gradle 项目默认使用 wrapper 的 `test --rerun-tasks`。升级前保存的验证回执若缺少当前要求的测试证据或文件指纹，需重新运行 `verify`。

如需对 `git commit` 启用同一任务门禁，在工程会话调用 `dev_task install_hook`，再调用 `verify_hook`。安装器会登记当前工作区（包括 Git 仓库的子目录）；已有其他团队的 `commit-msg` 或设置了 `core.hooksPath` 时会停止并提示人工组合，更新已有 DSH 钩子前会备份。钩子配置保存在该 Git 工作树的 `.git/hooks/`，不随 Git 提交。提交时钩子要求当前分支能唯一对应一项未完成任务，并核对真实验证回执、任务文件范围与暂存区内容。测试后改过文件、暂存了不同版本，或旧任务只有手写的 `passed=true` 而没有回执时，需要重新运行 `verify`。任务状态仍是工作区内可编辑的 JSON，门禁用来防止误操作和遗漏，**不提供对恶意修改任务文件的防篡改保证**。

删除文件、变更文件类型或触及敏感路径时，提交门禁要求任务为 `high_risk` 且有有效验证回执。多会话并行时，建议每个任务使用独立分支或工作区，避免其他任务的未提交文件混入本次范围和审核。

## 按项目配置 SonarQube

**不需要 Sonar：** 保持“自适应流程”中的 Sonar 开关关闭，不必填地址、Key 或 Token；代码审核元技能和项目 Rule 仍会运行。

**需要 Sonar：** 在工作台顶部选对项目，进入**自适应流程 → SonarQube 审核**，依次填写：

| 字段 | 填写方式 |
| --- | --- |
| 服务地址 | SonarQube 根地址，如 `https://sonar.example.com`，不带项目页面路径。 |
| 项目 Key | 当前代码库在 SonarQube 中的项目标识，不同项目可以不同。 |
| Git 参考版本 | 高级设置，默认 `HEAD`，审核当前尚未提交的变更；也可填本机已有的分支或提交。 |
| 审核路径 | 高级设置，留空审核本次任务全部代码；项目只需审核后端时填写对应的相对目录。 |
| Token | 先保存服务地址与项目 Key，再在同一页面单独保存到本机 DSH 凭据存储；绑定当前工作区、地址和 Key，只显示“已配置”。 |

Sonar 的非秘密配置保存在项目 `.dsh/meta.json`；Token **不会写入该文件、任务或报告**。换项目，或更改当前项目的服务地址/项目 Key 后，需要为新的连接重新保存 Token。旧版只按工作区保存的 Token 不会自动迁移，升级后需在页面重新输入一次。若使用环境变量，须同时设置 `DSH_SONAR_TRUSTED_HOST` 和 `DSH_SONAR_TRUSTED_PROJECT_KEY` 与当前连接完全一致；不要把通用 Token 交给仓库配置中的任意地址。内部 HTTP Sonar 服务仍可填写，但网络传输没有 TLS 保护，建议由管理员确认网络边界。项目的 Quality Profile 和规则本身仍由 SonarQube 服务器管理。

保存配置和 Token 后，管理员可点击**安装或检查本地分析器**。此操作按项目 Key 连接 SonarQube，检查本地组件并读取项目生效的 Quality Profile；页面优先显示该项目最近一次服务端分析涉及的语言，例如 QMS 的 Java、XML。若项目还没有分析记录，则显示所有已配置语言。它不会审核或上传项目代码；后续任务在代码审核阶段也会自动准备组件。

服务器修改了当前项目的 Quality Profile 或规则参数后，点击**更新当前项目规则**。插件为这个项目建立新的本地绑定，重新同步服务器配置；只有本地同步成功，后续审核才切换到新绑定。页面显示上次手动更新时间；更新失败时继续使用上一次成功的绑定。这个操作不扫描或上传代码，也不计算服务端 Quality Gate。每个项目分别更新。

点击**查看当前项目规则**可按语言查看对应 Quality Profile 的名称、启用规则总数、规则编号与名称，搜索规则并跳转到 SonarQube 规则详情。默认只显示项目最近一次分析涉及的语言，需要时可展开其它语言配置。此列表来自服务器当前配置；数量核对只证明规则清单读取完整，不能证明每条规则都可在本地执行。**Quality Profile** 决定启用哪些规则；**Quality Gate** 是服务端分析结果的通过条件，提交前本地检查不计算完整 Quality Gate。

### 提交前审核如何运行

测试通过并进入代码审核阶段后，代码审核元技能会调用 `dev_task sonar_check`。默认以 `HEAD` 为基线，读取当前任务尚未提交的 Git 变更，并按 SonarQube 项目的 Quality Profile 分析变更行；**无需提交或推送，也无需在页面手动发起**。首次运行会下载并校验官方 SonarLint 后台组件，缓存在 `DSH_HOME/sonarlint-runtime/`（未设置 `DSH_HOME` 时为 `~/.dsh/sonarlint-runtime/`）；后台从 SonarQube 同步当前项目的语言分析器与规则。安装与同步要求这台机器能访问 Maven Central 和 SonarQube；网络或权限失败时审核会明确报错，不会静默通过。通常无需安装 IDEA、Maven、SonarScanner 或单独配置 JDK。JS/TS/Vue/CSS 分析仍可能需要可用的 Node.js。

首次下载约 93 MiB，网络较慢时会等待较久。如果运行 DSH 的机器访问 Maven Central 必须走代理，在启动 DSH 前设置 `DSH_SONARLINT_PROXY=http://127.0.0.1:7897`（替换为实际代理地址），或使用标准 `HTTPS_PROXY` 环境变量；重启 DSH 后生效。这是安装组件的网络设置，不会写入项目配置。若已手工准备后台组件，仍可用 `DSH_SONARLINT_JAVA` 与 `DSH_SONARLINT_LIB` 指向现有安装。

项目仅审核后端时，可在高级设置的“审核路径”填写实际后端目录，例如 Maven 模块。审核前会核对这些目录的 Git 变更是否全部登记在任务 `files`；漏登会报出文件名。范围外的前端或 SQL 不会被称为已通过本次后端审核。报告会列出项目生效规则数量、分析器状态和未覆盖文件；未覆盖的相关语言会阻断审核。

本地审核只能运行 SonarLint 支持的服务端规则，**通过不等于 SonarQube 服务端 Quality Gate 通过**。涉及全项目数据流、跨文件上下文或仅在服务端实现的规则，仍以团队的 CI 扫描结果为准。旧任务原有的 CI/上传式扫描配置仍可读取，但新项目页面只提供提交前审核。

已有上传式扫描配置若使用 `.dsh/meta.json` 的 `sonar.scan_command`，当前只接受单独的 `sonar-scanner`，或固定 Maven Sonar 目标 `org.sonarsource.scanner.maven:sonar-maven-plugin:5.5.0.6356:sonar`（可附 `-DskipTests`、`-Dmaven.test.skip=true`）。不再接受 shell 串联、自定义 Maven 目标或把 Token 写进命令；升级后配置不通过校验时请改为上述形式，Token 仍通过项目凭据传入。

### 查看审核、处理误报、沉淀 Rule

代码审核元技能自动调用 `dev_task sonar_check`。在**任务台账**展开最近一次审核，可查看原始结果、规则、严重程度、文件位置、分析器状态、人工复核状态和未解决数量。每次扫描在项目 `.dsh/reviews/<任务 ID>/` 生成 Markdown 报告；结构化结果写入 `.dsh/task-<任务 ID>.json`。

- **真实问题：** 修复代码，重新测试并复扫。真实、已修复且可复用的案例，可以通过 `learn_rule phase=propose → apply` 预览并沉淀为项目 Rule，供之后创建的任务使用。
- **疑似本地规则误报：** 用 `sonar_disposition` 指定本次报告的 `issue_key`，提供具体理由与源码证据，由人逐条批准。原始告警仍保留；未批准、证据不足、代码变化或重新扫描后都不能沿用处置。已确认误报不会自动转成 Rule。
- **自定义规则不准确：** 将问题、代码语义和证据反馈给 SonarQube 规则维护者；不要为消除告警而破坏业务实现。

## 任务台账与项目文件

“待开始”表示实施项还未执行；“实施中”表示已记录开始；“待审查”表示缺少该项的规格或质量审查；“代码审核”则是整个任务的后续阶段。它们不是团队成员分派状态。

| 位置 | 内容 | 团队共享建议 |
| --- | --- | --- |
| `.dsh/meta.json` | 项目元技能挂载及 Sonar 非秘密配置 | 审阅后提交 |
| `.dsh/skills/`、`.dsh/rules/` | 项目 Skill、Rule 与 Skill 的 `profile.json` | 审阅后提交 |
| `.dsh/task-<id>.json` | 任务阶段、实施项、测试和审核回执 | 按团队留痕策略决定 |
| `.dsh/reviews/` | 逐次 Sonar 报告与误报处置 | 可加入 `.gitignore` 留在本机 |
| 本机 DSH 凭据存储 | 按工作区隔离的 Sonar Token | 不提交、不分享 |

## 常见问题

<details>
<summary>安装后看不到“工程任务”或“工程化开发引擎”？</summary>

核对插件是否装在正在运行的 Web profile，关闭旧 Web 进程后重启，查看启动日志。普通预设与工程化预设加载的工具不同。

</details>

<details>
<summary>项目初始化在哪里操作？</summary>

在工程任务的“项目初始化”页直接点击“扫描并生成提案”，审阅后确认写入。页面使用默认模型；若提示模型未配置，先到“模型”页选择默认模型。工程化会话仍可按需使用 `dev_task init_project` 的 `inspect → propose → apply` 调用。项目根目录的 AGENTS.md 生成功能是独立操作。

</details>

<details>
<summary>为什么 Maven 构建成功，任务仍不能前进？</summary>

插件要求验证命令输出证明至少运行一个测试。检查测试运行器是否实际发现用例、是否跳过测试，以及输出中是否有可识别摘要；重新运行有测试结果的命令。

</details>

<details>
<summary>为什么 Sonar 报了业务上必须创建的对象？</summary>

自定义规则可能过宽。保留告警并核对代码语义；本地规则分析可以逐条提交理由和证据由人批准，服务端规则应由维护者修正。不要复用本该独立的实体或挪动代码来隐藏告警。

</details>

<details>
<summary>为什么审核提示补文件范围？已有任务会随配置改变吗？</summary>

本次扫描路径内的 Git 变更若未登记到任务 `files`，需补入当前任务范围，或把其他任务移到独立分支/工作区。已有任务的阶段图和资源引用在创建时冻结；Skill/Rule 正文下次读取会更新，代码、范围或规则变化后应重新检查证据。

</details>

## 文档与参与

- [HTML 使用手册](docs/manual.html)：适合下载后分享给团队使用者，覆盖安装、初始化、任务、Sonar 与排障。
- [开发指南](docs/development.md)：插件架构、构建、测试和发布前检查。
- [反馈问题](https://github.com/godv61/dsh-task-engine/issues) · [MIT License](LICENSE)

<p align="center"><sub>DSH Task Engine · 让项目知识进入开发，让每次交付留下证据。</sub></p>

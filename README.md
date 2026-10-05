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
| 会话说“测试通过”，实际没有执行测试 | `dev_task` 保存命令和回执；Maven 测试必须证明至少执行一个测试。 |
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
2. 打开**项目初始化 → 项目 Skill / Rule 初始化**。当前版本会显示初始化请求；复制后发送到以该项目为工作区的**工程化开发引擎**会话。页面负责提供入口，扫描与生成由会话中的 `dev_task init_project` 完成。
3. 先检查扫描证据，再审阅生成提案，确认后才允许写入项目。不要把某一条需求的实现方案当成整个项目的结构地图。

| 阶段 | 会发生什么 | 重点检查 |
| --- | --- | --- |
| `inspect` | 只读扫描目录、构建清单、代表性源码与可证明的版本 | 后端、前端和脚本等主要模块是否都被发现。 |
| `propose` | 预览项目地图、技术栈、Skill、Rule 与元技能挂载关系 | 内容是否覆盖整个仓库；版本和规则是否有代码证据。 |
| `apply` | 按同一提案哈希写入文件 | 先审阅，再应用；已有同名资源不会被静默覆盖。 |

通常会生成 `.dsh/skills/<项目名>-project-map/SKILL.md`、技术栈与后端/前端编码 Skill，以及 `.dsh/rules/` 下的项目规则。**项目地图应描述整个仓库**的模块职责、依赖和通用入口；当前需求的页面、接口、验收条件应放进任务产物。页面中的 **AGENTS.md 初始化**是另一项操作。

团队共享前，审阅 `.dsh/skills/`、`.dsh/rules/` 和 `.dsh/meta.json`，再提交到 Git。Token 与本地审核报告不应提交。

## 元技能、Skill 和 Rule

内置元技能覆盖**需求分析、架构设计、任务编排、代码开发、测试、代码审核**。元技能约定本阶段做什么、交给下一阶段什么；项目 Skill 说明如何在当前仓库做；Rule 描述更具体的约束、触发条件与适用范围。

项目 Skill 可以放在 `.dsh/skills/`，工作台也能发现 `.agents/skills/` 中的 Codex 项目技能。用户级 Skill 可跨项目复用；**同名 Skill 的优先级是项目级 > 用户级 > 内置**。项目同名版本使用自己的 Rule 列表，不会自动混入被覆盖版本的 Rule。

在**工程任务 → 自适应流程**给元技能挂载 Skill，在对应 Skill 的 `profile.json` 中配置 Rule；项目挂载保存在 `.dsh/meta.json`。Rule 跟随 Skill 生效，不会因为挂在某一阶段就随意叠加给其他 Skill。已创建任务冻结阶段图和资源引用；被引用的 Skill/Rule 正文下次读取会更新，删除正在引用的资源会阻止流转。

## 四档流程与交接

| 档次 | 典型需求 | 默认阶段顺序 |
| --- | --- | --- |
| **低 · low** | 边界明确的局部修改 | 代码开发 → 测试 → 代码审核 → 完成 |
| **中 · medium** | 常规功能或缺陷修复 | 需求分析 → 代码开发 → 测试 → 代码审核 → 完成 |
| **高 · high** | 跨模块且有实现先后依赖 | 需求分析 → 任务编排 → 代码开发 → 测试 → 代码审核 → 完成 |
| **超高 · ultra** | 完整新模块或大范围重构 | 需求分析 → 架构设计 → 任务编排 → 代码开发 → 测试 → 代码审核 → 完成 |

需求分析交付目标、范围、非目标和可验证的验收条件；架构设计交付边界、影响与取舍；任务编排交付按实现先后排列的实施项 ID、依赖和交接产物；开发交付文件与逐项审查；测试交付真实命令；代码审核交付结论和可选 Sonar 报告。**实施项体现推进顺序，不是按人数分派工作。** 风险等级由模型另外判断，不等同复杂度。

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
2. **记录阶段产物。** 每阶段查看 `status` 给出的 Skill、Rule、必填产物及阻塞原因；用 `record` 写入当前阶段允许的内容，用 `advance` 进入下一阶段。不要手工改任务 JSON 跳过门禁。
3. **按顺序实施。** 高、超高任务先在计划中列稳定实施项 ID，再用 `items` 登记。`items` 默认按 ID 增量合并；例如只补 I5 不会删掉 I1–I4。确需重排或移除未开始的项目，显式使用 `items_mode=replace` 并提供完整列表；已完成或已有审查记录的项仍受保护。
4. **记录实现与逐项审查。** 用 `dispatch` 和 `review_item` 留痕。开发者可以在当前会话直接实施，不要求把任务派给其他人。把所有变更文件登记到任务 `files` 范围；代码变动会使旧测试和审核回执失效。
5. **验证与审核。** `verify` 执行真实命令；进入代码审核后，若启用 Sonar，调用 `sonar_check` 并处理结果，再记录 `review`。门禁通过后按 `status.commit` 提示提交并完成任务。

**测试回执的要求：** 退出码为 0 只是必要条件。对于 Maven 的 `test`、`verify`、`package`、`install`，输出必须有 Surefire/Failsafe 摘要且至少执行一个测试；显示 0 个测试或没有摘要时不能算通过。编译、静态检查、单元测试、接口测试和业务验收覆盖的风险不同，缺少环境或测试账号时应明确记录未覆盖项。

多会话并行时，建议每个任务使用独立分支或工作区，避免其他任务的未提交文件混入本次范围和审核。

## 按项目配置 SonarQube

**不需要 Sonar：** 保持“自适应流程”中的 Sonar 开关关闭，不必填地址、Key 或 Token；代码审核元技能和项目 Rule 仍会运行。

**需要 Sonar：** 在工作台顶部选对项目，进入**自适应流程 → SonarQube 审核**，依次填写：

| 字段 | 填写方式 |
| --- | --- |
| 服务地址 | SonarQube 根地址，如 `https://sonar.example.com`，不带项目页面路径。 |
| 项目 Key | 当前代码库在 SonarQube 中的项目标识，不同项目可以不同。 |
| 扫描来源 | 提交前本地规则选 `ide-local`；已有 CI 分析选 `ci`；本机上传扫描选 `local`。 |
| 分析对象 | 分支或合并请求，与实际扫描目标一致；`ide-local` 使用分支模式。 |
| 参考分支、审核路径 | 本地规则审核的新代码 Git 基线，以及实际扫描的项目相对路径。 |
| Token | 在同一页面单独保存到本机 DSH 凭据存储，按工作区隔离；保存后只显示“已配置”。 |

Sonar 的非秘密配置保存在项目 `.dsh/meta.json`；Token **不会写入该文件、任务或报告**。换项目时分别配置。项目的 Quality Profile 和规则本身仍由 SonarQube 服务器管理。

### 三种审核来源

| 来源 | 何时使用 | 提交/推送 | 结果边界 |
| --- | --- | --- | --- |
| `ide-local` 本地规则 | 提交前检查新代码，本机具备 SonarLint 后台组件 | **无需提交、无需推送** | 同步 Quality Profile 中可本地运行的规则；不产生 CE task，不等同完整服务端 Quality Gate。 |
| `ci` CI 分析 | CI 已扫描并能取得本次 CE task ID | 按 CI 触发条件提交并推送 | 读取该次服务端分析的新代码问题与 Quality Gate。 |
| `local` 本机上传 | 本机有扫描器且服务端支持任务分支分析 | 先提交，无需推送 | 将扫描结果上传 Sonar；Community Build 的分支分析会预先拒绝。 |

`ide-local` 需要选 Git 参考分支或提交作为新代码基线，并用 `include_paths` 限定实际审核范围，例如只扫描后端 Maven 模块。审核前会核对这些目录的 Git 变更是否全部登记在任务 `files`；漏登会报出文件名。扫描范围外的前端或 SQL 不会被称为通过了后端审核。

本地规则审核还需要 DSH 服务进程提供 `DSH_SONARLINT_JAVA`、`DSH_SONARLINT_LIB`、`DSH_SONARLINT_PLUGINS`，分别指向 Java、SonarLint 后台 JAR 目录和分析器 JAR；Windows 多个插件路径用分号分隔。JS/TS/Vue/CSS 分析还需要 Node.js。无法分析的语言会列为“未覆盖”并阻断。需要完整服务端结论时使用 CI 扫描。

### 查看审核、处理误报、沉淀 Rule

测试通过并进入**代码审核**后运行 `dev_task sonar_check`。在**任务台账**展开最近一次审核，可查看来源、原始结果、规则、严重程度、文件位置、人工复核状态和未解决数量。每次扫描在项目 `.dsh/reviews/<任务 ID>/` 生成 Markdown 报告；结构化结果写入 `.dsh/task-<任务 ID>.json`。

- **真实问题：** 修复代码，重新测试并复扫。真实、已修复且可复用的案例，可以通过 `learn_rule phase=propose → apply` 预览并沉淀为项目 Rule，供之后创建的任务使用。
- **疑似本地规则误报：** 用 `sonar_disposition` 指定本次报告的 `issue_key`，提供具体理由与源码证据，由人逐条批准。原始告警仍保留；未批准、证据不足、代码变化或重新扫描后都不能沿用处置。已确认误报不会自动转成 Rule。
- **CI 或上传式服务端结果：** 插件不能通过本地误报处置绕过服务端 Quality Gate；应按组织流程在 SonarQube 中处理。若自定义规则本身过宽，应反馈给规则维护者，不要为消除告警而破坏业务实现。

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
<summary>为什么项目初始化需要把页面请求发送给会话？</summary>

当前页面只提供入口；完整的项目 Skill/Rule 草稿由该项目的工程化会话结合源码生成。会话会先执行 `inspect`，再通过 `propose` 让你审阅，确认后才 `apply`。这一步目前需要复制请求；项目根目录的 AGENTS.md 生成功能是独立操作。

</details>

<details>
<summary>为什么 Maven 构建成功，任务仍不能前进？</summary>

如果验证命令是 Maven 测试目标，插件还要求输出证明至少运行一个测试。检查 Surefire/Failsafe、JUnit 引擎和是否跳过测试；重新运行能看到测试摘要的命令。

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

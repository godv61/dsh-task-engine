# dsh-task-engine

一个**可安装、项目无关、硬约束**的工程化交付引擎，把「需求评审 → 设计 → 开发 → 交付 → 代码审核」这套流程做成 DeepSeek Harness 的一个 bundle。**按预设激活**：装 bundle 后在目标预设的 `agent.cordis.yml` 加一行，该预设的会话才挂上 `dev_task` 工具、内置技能和人设；换到别的预设（不加那行）就完全不激活——不需要每个项目手写 `.agents` / `.claude` / `.harness`。

核心是一个 `dev_task` 工具 + 内置技能。工具的硬约束在代码里执行，不是"提醒模型"：

- **阶段流转**：只能沿所选流程预设的阶段图走（`standard` / `agile` / `minimal`）；非法流转直接报错拒绝。
- **确认/验证门**：需求/方案未确认 → 进不了设计/开发；实施项没完 → 不能交付；高风险没验证证据 → 不能过评审。
- **产物门**：每个阶段要交的产物 + 必填字段（需求说明 / 设计文档 / 评审记录…已固化在预设里），字段没填全 → 不让流转。
- **提交门禁**：到检查点才能提交，消息必须匹配预设的提交格式，`manual` 策略永不自动提交。
- **文件范围**：任务声明 `files`（本任务该改的文件），提交碰了范围外的文件 → 工具和 git 钩子都拒绝。
- **skill / rule 挂载**：流程预设里每个阶段默认挂了「这个阶段用什么 skill」+「守哪条 rule」；项目可在节点上**追加**自己的 skill/rule（内置绑定保留、不可移除，同名会被拒、只读内置版），模型走到该阶段时，`dev_task` 只**渐进披露**这阶段挂载的内容，不一次性全给。内置一套通用库，也能在网页里新建自己的 skill/rule。
- **边界（诚实说明）**：「需求确认」「方案确认」两扇门由**人工批准**点亮；但「实施项完成」「验证通过」「评审通过」是模型通过工具上报的状态，代码只校验这些状态在流程里自洽、格式/范围/绑定对齐，**不验证上报内容本身是否属实**——要硬保证请叠加外部 CI 或人工评审，不要把它当事实仲裁。

## 目录

```
cordis.patch.yml        bundle 声明 + host 组合 patch（一行，只挂 host 半：Remote 控制器 + 工作台 UI）
defaults/eng.json       标准预设的默认声明示例（flow + stage_bindings）
hooks/commit-msg        git 提交门禁钩子（install_hook 装进 .git/hooks/）
src/engine.ts           纯函数状态机 + 配置校验（无 harness 依赖，双端复用）
src/workflows.ts        内置 3 套流程预设（阶段图/守卫/产物/提交规则/默认绑定全部固化）
src/index.ts            host 入口：挂 task-engine Remote 控制器 + 首次启动自动 seed「工程化开发引擎」预设
src/seed-preset.ts      对齐当前 standard 复制出 eng 预设（换人设 + 加 agent 行，幂等）
src/agent.ts            agent 入口（./agent 出品）：在调用它的预设 scope 里注册 dev_task + 内置技能
src/dev-task.ts         dev_task 工具定义 + 全部文件系统辅助（模型门禁，随 agent 入口激活）
src/shipped-skills.ts   内置技能扫描 + 注册（随 agent 入口激活）
src/controller.ts       Host 端 Remote 控制器：网页读写 .dsh/eng.json + skill/rule + 项目初始化（AGENTS.md）
src/client/             浏览器半：全屏工作台（项目初始化 / 流程配置 / 任务 / 技能 skill / 规则 rule 五个标签页）
skills/                 内置技能库（需求分析/方案设计/实现/验证/审核/提交/交付编排）
rules/                  内置规则库（编码规范/提交规范/安全红线）
preset/agent.cordis.yml 预设接入片段（persona 行 + agent 行，供自定义预设照抄）
preset/enable.mjs       手动重建 eng 预设的命令行兜底（bin: dsh-task-engine-enable）
preset/preset.yml       预设元数据
preset/persona.md       预设 persona 文案
```

## 构建

> 依赖走**公共 npm**：`@deepseek-ai/*` 已发到 `0.1.2-rc.1`（tag `next`）/ `0.1.2-alpha.5`，`cordis` 是 `4.0.2`。本包依赖对齐到 `^0.1.2-rc.1` + `^4.0.2`，已实测 `npm install`（公网）+ `tsc` 构建/typecheck + 运行时冒烟全部通过。

```powershell
npm install           # 从公共 npm 解析 @deepseek-ai/* 依赖
npm run typecheck     # 严格模式零错误（host tsconfig + client tsconfig）
npm run build         # tsc 产出 host lib（index/controller/engine）+ esbuild 产出双端 lib/client.js
```

## 安装（别人集成）

```powershell
# 从公共 npm（发布后）
dsh plugin --profile <name> add @godv61/dsh-task-engine
# 从你的 git 仓库
dsh plugin --profile <name> add github:<你的org>/dsh-task-engine
# 或本地 checkout
dsh plugin --profile <name> add .
```

### host 集成 API（0.22.4，供 harness 层接入）

`./agent`（工具面）无需额外集成；工作台 Remote 的 workspace 边界可由宿主收紧：

```ts
import { registerWorkspace, enableStrictWorkspaces } from '@godv61/dsh-task-engine'
// 每个会话工作区挂载时注册（未注册的路径被 Remote 拒绝）：
registerWorkspace('/absolute/workspace/path')
// 生产模式：空 registry 不再回退放行（不调用则保持兼容的防误用校验）：
enableStrictWorkspaces()
```

根治性的 Typert 调用上下文（Remote 携带 session/workspace）与任务状态的 host 侧 HMAC 签名仍在 harness 层，本包已预留接入点并在「门禁边界」说明三层分工。

## 启用（点选即用）

装完 bundle、重启 web，预设列表里会**自动多出一个「工程化开发引擎」**——host 半在首次启动时把它对齐当前 `standard` 生成（换好工程人设 + 加好 agent 行），落在 `~/.dsh/.agent-presets/eng/`。

- **用**：新建会话（或设置 → agent 预设）选「工程化开发引擎」，这个会话就挂上 `dev_task` + 内置技能 + 工程人设，按流程走。
- **不用**：选 `standard` / `minimal` / 其它预设，就没有 `dev_task`、没有内置技能、没有工程人设，流程完全不介入。
- 侧边栏「工程流程」工作台不受影响，随时供人选流程预设、给节点挂 skill / rule、在线编辑 skill / rule 正文。

这一层对称由 DSH 的工具/技能 scope 机制保证：host 半从不把 `dev_task` 注册进全局工具层，agent 半（`@godv61/dsh-task-engine/agent` 行）只在命名它的预设里注册——所以切换预设本身就是开关。

### 兜底 / 自定义

自动生成只在 `eng` 不存在时发生，绝不覆盖你手改过的预设；删掉 `eng` 后下次启动会重新生成。想**手动**造一个（不同名字、或改人设）才需要：复制 `standard` → 在 `agent.cordis.yml` 末尾加一行：

```yaml
- id: task-engine-agent
  name: '@godv61/dsh-task-engine/agent'
```

`dsh-task-engine-enable` 同样**只在 `eng` 不存在时创建**（已存在则直接退出、绝不覆盖）；要重建请先删掉 `eng` 再重跑。

## 项目配置（选流程 + 挂 skill/rule）

在项目根放 `.dsh/eng.json`（没有就用 `standard` 预设）。收敛后只需写两件事：

```json
{
  "flow": "standard",
  "stage_bindings": {
    "需求评审": { "skills": ["requirement-analysis"], "rules": ["security-redlines"] },
    "开发":     { "skills": ["code-implement"], "rules": ["coding-conventions"] }
  }
}
```

- `flow`：选一套内置流程预设 —— `standard`（需求评审→设计→开发→交付→代码审核，含产物门+确认门）/ `agile`（需求→开发→交付→审查，四阶段少产物）/ `minimal`（开发→交付，只留提交门禁）。
- `stage_bindings`：每个节点挂哪些 skill / rule（可整体省略，省略即用该预设自带的默认绑定）。

**阶段图、流转守卫、产物字段、提交规则、验证证据开关全部固化在预设里，不再手工配置**。团队要改「提交消息格式」「交付要自测」这些约定，就新建一个项目级的新 skill/rule（用**新名字**，再挂到对应节点）——内置 skill/rule 的正文不可被同名覆盖（同名新建会被拒、解析同名只读内置版），新增的会与内置的一起挂在该节点上。

`dev_task`（operation=config）随时查看当前生效配置；配置写错（未知 flow / 绑定到不存在的阶段 / 空名）会报错，不悄悄退回默认。

## 网页配置界面

不用手写 `.dsh/eng.json`。装在带 Web 的 profile 里后，打开 Web GUI → 侧边栏「工程流程」工作台 →「流程配置」标签页：

- 顶部选工作区，页面读出该工作区的 `.dsh/eng.json`（没有就用 `standard` 预设）。
- 只有两件事可配：**选流程预设**（standard / agile / minimal）+ **给每个节点挂 skill / rule**。阶段流转、守卫、产物、提交规则、验证证据开关都是预设固化的，页面只读展示「流程节点」，不再开放编辑。
- 编辑时实时跑 `validateWorkflow`：有问题红字列出、保存按钮置灰；主机保存前再校验一遍，有问题的配置永不落盘。
- 保存写入所选工作区的 `.dsh/eng.json`，和 `dev_task` 用的是**同一套**校验（单一事实来源）。

> 纯 headless 装机不受影响（只是没有这个页）；Web profile 需要包含 `@deepseek-ai/dsh-web-app`。

## skill / rule 挂载（0.6.0）

流程不止"走到哪个阶段"，还有"这个阶段该用哪本手册"。每个阶段可以在 `stage_bindings` 里挂 skill 和 rule：

```json
{
  "flow": "standard",
  "stage_bindings": {
    "需求评审": { "skills": ["requirement-analysis"], "rules": ["security-redlines"] },
    "开发":     { "skills": ["code-implement"], "rules": ["coding-conventions"] }
  }
}
```

- **渐进披露**：模型走到某阶段时，`dev_task`（`status` / `advance`）只返回**这个阶段**挂载的 skill 名 + rule 内容；skill 用 DSH 的 `skill` 工具按名加载，rule 直接把正文给出。阶段推进到哪，才给哪。
- **三层来源**：技能和规则都来自「内置 + 项目 + 用户」三层——内置（本包 `skills/`、`rules/`）、项目（`.dsh/skills/`、`.dsh/rules/`）、用户（`$DSH_HOME/skills/`、`$DSH_HOME/rules/`）。**同名时内置优先**：内置 skill/rule 不可被项目/用户同名覆盖（新建同名会被拒，解析同名只读内置版）。
- **网页新建 / 查看 / 编辑 / 删除**：工作台「技能 / 规则」标签页里可新建、查看、编辑、删除项目级/用户级 skill 和 rule（内置只能查看、不可删改）。查看时正文以 markdown **富文本**渲染在宽弹窗里；编辑时正文保持纯文本。项目级写进 `.dsh/skills|rules/`（团队共享），用户级写进 `$DSH_HOME/skills|rules/`（个人全局），写好后自动出现在挂载清单里。
- **内置库**：6 个节点技能（`requirement-analysis` / `solution-design` / `code-implement` / `code-verify` / `code-review` / `code-commit`）+ 3 条规则（`coding-conventions` / `commit-conventions` / `security-redlines`），开箱即用；想加项目专属的，用 DSH 原生技能机制或网页新建即可。

## git 提交门禁（防止绕过）

默认提交是「工具校验 + 模型执行 git」，模型理论上能绕过 `dev_task` 直接 `git commit`。装个机械钩子彻底封死：

1. 用 `dev_task`（operation=install_hook）装进 `.git/hooks/commit-msg`（每个克隆本机装一次）。
2. 之后任何 `git commit`，钩子都用和引擎**同一套规则**检查：没有 dev_task 任务、阶段没到提交检查点、消息不匹配预设的提交格式、提交文件不在任务 `files` 内——一律拒绝并打印原因。

> 钩子读 `.dsh/eng.json` + `.dsh/task-*.json`，跨仓库零依赖、自包含。

### 门禁边界：hook / host / CI 各自负责什么（0.22.3 起明确）

- **git hook = 本地即时反馈**：拦常规 `git commit`（校验任务存在、阶段、范围、消息、快照 hash、敏感路径）。它挡不住 `git commit --no-verify`、`core.hooksPath` 替换或手改 task 记录——这是定位，不是漏洞。
- **host 工具流 = 正常路径的强约束**：`dev_task` 的阶段/范围/回执/审批门禁在工具调用时生效；Remote 路径校验 + workspace registry（host 集成 `registerWorkspace` 后生效）挡住越界访问；文件沙箱是最终文件边界。
- **CI = 最终可信门禁**：CI 里重新验证 task id、快照 hash、staged 范围、提交消息、真实验证退出码、高风险回执、hook 是否被绕过——这是唯一不依赖"模型配合"的可信验证点。

## 项目初始化（init）

二开 / 遗留项目常常没有文档，AI 接手前需要先「认识」这个项目。`dev_task`（operation=init）走 **inspect → propose → apply** 三阶段管理项目根的 `AGENTS.md`，绝不直接覆盖已有治理文件：

1. `inspect`——读取现有 `AGENTS.md`（若有）返回给模型；没有则提示扫描项目。
2. `propose`——模型扫描（目录结构、技术栈、构建/运行命令、约定、红线）后给出全文草稿，此步**只预览不落盘**，并返回草稿内容 hash（已有文件时另附现有文件 hash）。
3. `apply`——落盘。**必须传回 propose 返回的 `expected_hash`**（防预览与落盘之间内容被换）；覆盖已有 `AGENTS.md` 必须 `overwrite: true` 且**经人工批准**，传回 `existing_hash` 可防审批期间文件被他人改动（TOCTOU），否则拒绝。

- **为什么是 `AGENTS.md`**：DSH 平台会把项目根的 `AGENTS.md` **自动注入到每个会话**——生成一次，之后每个任务开工 AI 都自带这份项目认知，引擎无需额外的注入逻辑。
- **行数上限**：`AGENTS.md` 每次都进上下文，200 行（约 4–6K token）是硬约束，逼着只写「项目是什么 → 怎么跑 → 结构 → 约定 → 坑」，而不是塞长篇文档。
- **治理文件保护**：`AGENTS.md` 默认受保护——已有文件时 `apply` 不裸覆盖，需显式 `overwrite` + 人工批准。
- **工作台可视化入口（0.19.0）**：以上三阶段也能在网页工作台点按钮完成。工作台第一个标签页「项目初始化」会**加载展示**当前 `AGENTS.md`（无则显示「未初始化」）；点「让 AI 初始化 / 重新初始化」由工作台调用默认模型扫描项目生成草稿（预览，不落盘），点「保存并覆盖」才写回；也可「手动编辑」后保存。页面入口与 `dev_task init` 读写的是同一份 `AGENTS.md`，两处共用 200 行硬约束。

## 状态与待办

- **当前验证基线（0.22.4）**：`npm test` 123 项验收全过（引擎状态机 / 守卫 / 快照 hash / 回执门 / 并发 CAS / Remote 路径 / 沙箱策略断言）；`npm run typecheck` host + client 双面零错误；`npm run verify:package` 发布包黑盒 16 项（pack → 白名单 → 真实安装 → 主入口 import → client 注册 → 包内测试 → CLI）；真实 git 临时仓库 e2e（合法放行 / 阶段·范围·快照篡改·敏感路径拦截）；headless Chrome 实测侧栏入口与设置按钮逐像素对齐。发布前必跑 `npm test` + `npm run verify:package`。
- **真实模型端到端（0.4.1）**：headless + NewAPI DeepSeek 下让真模型走 `dev_task` 全流程，抓到并修掉一个真实 bug——`readText`/`writeText` 调 `fs.resolve()` 漏了 `await`，把 `Promise<FsTarget>` 当 `target` 传给了读写方法，导致 create/record/advance/commit 全部写不了任务文件、读永远返回 undefined。0.4.1 修复（`await fs.resolve(relPath)`），并把 `task_id` 在 create 也必填的说明补进工具 schema 与技能。修复后走真实 `ctx.fs` 路径冒烟全绿。
- **网页图形化配置界面（0.5.0）**：新增 `src/client/` 设置页「工程流程配置」+ Host 端 `task-engine` Remote 控制器；`@godv61/dsh-task-engine` 升级为双端包（`dsh.client` manifest + `./client` 出品，`exports` 暴露）。已实机验证：`dsh web` 起服务后 boot 数据里 `@godv61/dsh-task-engine` 以 `inject:["@deepseek-ai/dsh-api-gateway"]` 进入 application batch、`/plugins/…/client.js` 正常服务；headless 冒烟确认 boot + `dev_task` 未被新控制器破坏。浏览器点击级 e2e 留到发布后用真浏览器收尾。
- **skill/rule 挂载与渐进披露（0.6.0）**：`WorkflowConfig` 新增 `stage_bindings`（每阶段挂 skills/rules，可选字段），`dev_task` 的 `status`/`advance` 按当前阶段披露挂载的 skill 名 + rule 正文；内置 6 技能 + 3 规则库；Host 控制器新增 `listSkills`/`listRules`/`writeSkill`/`writeRule`；设置页新增「节点挂载」和「新建 skill / rule」两块，同时补上 `dev_task` 缺失的 `items` 操作（更新实施项状态）。引擎层 `stage_bindings` 校验（未知阶段/空名）与合并已单测通过。
- **配置页精简 + 自建 skill 可观测（0.6.1）**：设置页的流转/产物/提交规则/新建默认折叠，「节点挂载」从六阶段全平铺改成「选一个阶段再看它挂了什么」；新建成功提示带回显路径（`.dsh/skills/<name>/SKILL.md` 或 `$DSH_HOME/…`），挂载清单给非内置的 skill/rule 标「（项目）/（用户）」来源。修复 `listSkills` 依赖 host skill registry 导致项目 `.dsh/skills` 自建技能不显示的问题——改为与 `listRules` 一致，直接扫「内置 + 项目 + 用户」三层目录。浏览器 e2e 全绿。
- **全屏工作台 + 在线编辑（0.7.0）**：配置页从设置弹窗迁出，改为侧边栏 `sidebar.footer.action`「工程流程」按钮，点开 `shell.overlay` 全屏工作台（触发按钮与覆盖层共享一个 store 控制开关）。工作台分「流程配置 / 技能 skill / 规则 rule」三个标签页；技能和规则列表支持在线编辑——`readSkill`/`readRule` 读回正文、改 description/whenToUse/正文、`writeSkill`/`writeRule` 写回；内置项只读，项目/用户项可原地编辑，新建同时支持项目级/用户级。旧的 `settings.section` 入口移除，统一走侧边栏按钮。浏览器 e2e 全绿。
- **按预设激活（0.8.0）**：`dev_task` 工具与内置技能从 host 全局层拆到 agent 层。host 入口只挂 `task-engine` Remote 控制器 + 工作台 UI（`src/index.ts`）；新增 `src/agent.ts`（`./agent` 出品）、`src/dev-task.ts`、`src/shipped-skills.ts`，由预设的 `agent.cordis.yml` 命名后，在**该预设的 scope** 里注册工具与技能。实机 boot 验证：`standard` 会话工具目录不含 `dev_task`（26 个工具），加了 `@godv61/dsh-task-engine/agent` 行的 `eng` 会话含 `dev_task`（27 个工具）且描述正确，换回 `standard` 再次不含——切换预设即切换流程激活状态。
- **一键激活（0.8.1）**：新增 `preset/enable.mjs`（bin: `dsh-task-engine-enable`），一条命令自动复制 `standard` → `eng`、把 persona 换成工程人设、追加 agent 行、写 `preset.yml`。persona 从「必须换」降级为「可选」——`eng-delivery` 技能自带 `whenToUse`，即使不加人设，模型遇到开发请求也自己加载技能走 `dev_task`；最简激活只剩「复制预设 + 追加一行 agent 行」。实机验证：脚本生成的 `eng` 预设挂载后 `dev_task` 可见、persona 以工程人设（含「铁律」）渲染、`standard` 仍无 `dev_task`。
- **点选即用（0.9.0）**：host 入口新增 `src/seed-preset.ts`——首次启动自动把当前 `standard` 复制成 `eng` 预设（换工程人设 + 追加 agent 行，幂等、不覆盖手改）。装 bundle 重启后预设列表直接出现「工程化开发引擎」，点选即激活、切走即不激活，零复制/零编辑/零脚本。实机 boot 验证：boot 后 `.agent-presets/eng` 自动生成（agent 行 + 工程人设齐全）、roster 列出 `eng`（user）、`eng` 会话有 `dev_task` 且 persona 含「铁律」、`standard` 会话无 `dev_task`。
- **工作台可用性（0.9.1）**：修复「新建 skill / 新建 rule」按钮点击不弹出表单（`formOpen` 只认编辑态，新建态缺少显式标志）；给六个守卫补 hover 说明、把「产物齐全」改名「产物字段已填全」并讲清「产物 = 阶段要写清楚的记录、字段 = 这份记录里必填的空」，「节点挂载」改名「阶段技能 / 规则」。
- **需求/方案人工确认门（0.10.0）**：`requirement_confirmation` / `solution_confirmation` 两个守卫从「模型自己标记」升级为「人来批准」。走 `advance` 撞上确认门时，`dev_task` 用 `@deepseek-ai/dsh-user-approval` 发起审批；人在页面点「允许」才放行，模型不能自己确认、也不能绕过。headless e2e 验证真模型全流程时两个确认都会触发。
- **派工 / 审核审计（0.11.0）**：`TaskItem` 新增 `dispatch`（子代理派工留痕）与 `review`（spec / quality 两阶段评审）字段；`dev_task` 新增 `dispatch`、`review_item` 操作；工作台新增「任务台账」视图展示逐项审计。派工留痕是软约束——模型可自己实现小项而不强制派子代理。
- **台账硬门 + 软约束修复（0.12.0）**：`todos_done` 守卫改为「实施项非空且全部 done」；`code-implement` 技能里写清「两阶段都 pass 才标 done」。
- **两阶段评审硬门（0.13.0）**：`todos_done` 进一步收紧——每个 done 的 item 必须带 spec + quality 都 pass 的评审记录，缺评审或任一阶段 fail 都会挡住「开发 → 交付」，并以具体 item 报出阻塞原因（`todosBlockers`）。派工审计保持软约束。
- **skill / rule 查看 + 删除（0.14.0）**：内置 skill/rule 从「只读不可见」改为「可查看正文」；自建（项目/用户）skill/rule 新增删除（两步确认）。删改在类型层即把 `bundled` 排除，内置资源永不误删。
- **弹窗 + markdown 查看（0.15.0）**：skill/rule 的查看与编辑从内联卡片改为居中宽弹窗；查看时正文用 DSH 自带的 `MarkdownText` 渲染成 markdown 富文本（不引入任何新依赖），编辑时正文保持纯文本。
- **流程预设收敛（0.16.0）**：把「自由编辑阶段图/守卫/产物/提交规则/验证开关」收敛为「选一套内置流程预设 + 给节点挂 skill/rule」。新增 `src/workflows.ts` 内置 `standard` / `agile` / `minimal` 三套流程（阶段图、守卫、产物字段、提交规则、验证证据开关全部固化）；`.dsh/eng.json` 从完整配置精简为 `{ flow, stage_bindings }`；工作台删掉流转/产物/提交规则/验证开关编辑 UI，只剩「流程预设 + 流程节点（只读）+ 阶段技能/规则」；git 提交钩子同步按 `flow` 选预设。
- **项目初始化 + 语言无关内置规则（0.17.0）**：`dev_task` 新增 `init` 操作，生成项目根 `AGENTS.md`（DSH 每会话自动注入），落盘前做 200 行硬校验、已存在需 `overwrite` 才覆盖；内置 `solution-design` / `coding-conventions` / `security-redlines` 去掉 Java 专属概念（Impl / DTO / VO、Controller / Mapper），改成语言中立骨架，语言特定规范交给项目自建 rule。
- **工程可靠性加固（0.18.0）**：① 高风险任务与流程能力绑定——`high_risk` 任务只能在具备「验证门 + 文件范围 + 评审门」能力的流程创建，选 `agile`/`minimal` 直接拒绝；② 任务创建时固化流程快照（预设 id + version + 完整配置），后续 `status`/`advance`/`verify`/`review`/`commit` 一律用快照，中途改 `.dsh/eng.json` 不再漂移在途任务的门禁；③ 未知流程失败关闭——`.dsh/eng.json` 缺 `flow` 或 `flow` 不在预设里一律报错（`UNKNOWN_FLOW` / 缺字段），不再静默回退 `standard`；④ 核心 skill/rule 不可取消、不可被同名覆盖——项目阶段绑定只能追加不能移除预设自带绑定，同名规则/技能读内置版、新建同名被拒；⑤ `init` 升级 `inspect → propose → apply` 三阶段，覆盖已有 `AGENTS.md` 需人工批准。
- **会话工作目录修复（0.18.1）**：`dev_task` 的所有文件操作此前用 `fs.resolve(相对路径)` 不带 cwd，落到了 fs 后端默认目录（DSH 进程目录）而非会话工作区——在 web 会话里会把台账、配置、`AGENTS.md`、git 钩子写到/读到错误位置。改为从 `exec.agent.session.header.cwd` 取会话工作区并传给每个解析，补 4 项回归测试。
- **工作台项目初始化（0.19.0）**：工作台新增置顶的「项目初始化」标签页——加载展示项目根 `AGENTS.md`、一键让 AI 扫描项目生成草稿（预览后再确认写回）、支持手动编辑与覆盖；Host 控制器新增 `readInit`/`writeInit`/`generateInit` 三个 Remote，`generateInit` 通过 `ctx.llm` + 默认模型在 Host 端直接生成，复用 `dev_task init` 的 200 行硬约束。
- **使用手册跟进（0.19.1）**：随包发布的 `docs/manual.html` 补上工作台「项目初始化」（默认置顶标签页、项目根自动发现、AI 生成 150 秒超时 + 覆盖需人工确认），第 7 节标签页从「三个」改为「五个」；安装章节补全 dsh CLI（非源码）安装方式与 pnpm 前置、`dsh plugin add` 的挂载机制；删除顶层已废弃的 `USER_GUIDE.html`（v0.9.1、无引用、不随包发布），README 目录结构描述同步为五标签页。
- **审计修复（0.19.2）**：补齐七项——① 提交钩子 `stagedFiles` 用 `core.quotePath=false` + `-z` 按 NUL 拆分（中文文件名不再被八进制转义误拒）并补 `D`（删除范围外文件也被拦）；② 提交消息第一段改为 task id、钩子按 id 精确定位任务（不再按分支/mtime 猜，同分支多任务不再锁错）；③ artifact id 全流程唯一 + `record` 校验产物属于当前阶段（堵越阶段复用）；④ 高风险验证证据 `trim()` 后须非空（`evidence:[""]` 不再通过）；⑤ README/手册加「诚实边界」，明说验证/评审/实施项是模型自报、需人工或 CI 兜底；⑥ 文档修正优先级（内置 &gt; 用户 &gt; 项目、内置不可覆盖）与 enable 措辞，`.dsh/task-*.json`/`eng.json` 豁免文件范围门；⑦ 提交钩子改用任务快照的 frozen 配置校验（对抗任务执行中改流程导致的配置漂移）；⑧ 工作台 `writeInit` 对齐 `init` 保护（已有 `AGENTS.md` 时需显式 overwrite + 前端确认才覆盖）；⑨ `.p0-test.mjs` 纳入发布包，装包后 `npm test` 可用。新增回归测试。
- **安全闭环（0.20.0）**：① 验证改真实命令回执——`dev_task verify` 新增 `command` 入参，引擎通过宿主 shell 服务真实运行该命令并落 `VerificationReceipt`（命令 / 退出码 / 超时 / 中止 / 起止时间 / stdout / stderr）；`high_risk` 任务的 `verified` 门改为要求回执 `exit_code === 0` 且非超时 / 中止，纯文本 `passed` 声明不再放行（常规风险仍可用 `passed` + `evidence` 文本）；② 文件范围检查补 `T` + 改用 `--name-status`——`--diff-filter=ACMRDT` 纳入类型变换，提交状态随范围拒绝一并报出，删除 / 类型变换 / 重命名的旧·新路径都受范围检查；③ 提交钩子改为从 `engine.ts` / `workflows.ts` 单一源打包生成（`build-hook.mjs`），彻底消除手写镜像漂移，未知流程在钩子侧同样 fail-closed（不再静默回退 `standard`）。
- **通用项目适配（0.21.0）**：① 新增项目适配层 `src/project.ts`——按特征文件识别 Node / Java / Python / Go / Rust 类型，从 workspace 向上发现项目根（`.git` / `.dsh` / 语言特征文件）；② 各语言默认验证命令（`npm test` / `mvn -q test` / `python -m pytest` / `go test ./...` / `cargo test`），`verify` 不带 `command` 时按 `.dsh/eng.json` 的 `verify_command` → 语言默认链自动跑真实命令；③ 治理文件识别扩展至 `AGENTS.md`、`CLAUDE.md`、`.cursorrules`，`init inspect` 一并报告治理文件、项目根、语言栈与项目级 skill/rule 目录（约定 `.dsh/rules/*.md`、`.dsh/skills/<name>/SKILL.md`）；④ 提交钩子加风险策略——触及敏感路径（`.git` / `.env` / credentials / secrets；`.dsh` 的任务记录与流程配置由快照 hash 与豁免保护）要求任务为 `high_risk` 且验证有真实命令回执，否则拒绝；⑤ 初始化写入越界保护——`init` / `create` 的写入目标必须落在项目根内；任务记录新增 `root` / `project_type` 字段。
- **审计和发布质量（0.22.0）**：① 流程快照 hash——任务创建时固化 `config` 的 SHA-256，工具与提交钩子读任务记录时校验，被手改的快照一律拒绝继续；② 提交钩子完整性检测——新增 `dev_task verify_hook`，比对 `.git/hooks/commit-msg` 与内置门禁的 hash，被替换/篡改立即报错；③ 风险降级审批——新增 `set_risk`，`high_risk → standard` 必须人工批准并落 `risk_downgrades` 审计记录；④ 验证回执绑定项目根——receipt 记录 `root`，与任务 workspace 绑定；⑤ 内置规则指纹锁定——创建时固化内置规则内容指纹，包升级后 `status` 报 `bindings_drift` 而非静默换规则；⑥ 多项目 / 多语言 / 多任务测试矩阵补强。
- **沙箱写入修复（0.22.1）**：`dev_task` 的文件写入此前没有携带按调用传递的沙箱策略（`writeText` 的 `sandboxPolicy` 参数），在 DSH 文件沙箱下会把 workspace 内的任务记录写入误判为越界而拒绝（`file access denied under workspace-write mode`，且会话策略变化无法影响它）；现在每次写入显式携带 `{ mode, workspaceRoot: 会话目录 }`，并新增 `sandbox_permissions` 参数（`workspace-write` / `danger-full-access`）作为被拒后的一次性升级路径。
- **质量修补（0.22.2，采纳 codex 评审五项）**：① client typecheck 修复——`project.ts` 不再依赖 `node:path`，浏览器面可完整类型检查；② sandbox 升级补审批——`sandbox_permissions` 必须与 `justification` 成对出现，`danger-full-access` 需人工一次批准，无审批服务即拒绝；③ Remote 任意路径设防——工作台 Remote 拒绝非绝对路径与系统级根目录；④ `set_risk` 升到 `high_risk` 时受流程能力门约束（`minimal`/`agile` 拒绝，不再绕过 `create` 的检查）；⑤ `loadTask` 补齐旧记录缺失字段（items / verification / review / commits），损坏记录 fail-closed 而非引擎裸崩。
- **可信边界加固（0.22.3，采纳 GPT 评审）**：① 验证命令统一在任务记录的项目根运行（monorepo 子目录不再跑错目录），receipt.root 与任务根强校验；② 旧任务（无 frozen 快照）禁止升 `high_risk`——迁移或重建后才可；③ `init apply` 强制 `expected_hash`，新增 `existing_hash` 防审批期间文件被换（TOCTOU）；④ 任务记录新增 `revision`，每次写入 compare-and-swap，并发覆盖直接报错（`changed concurrently`）；⑤ 工作台 Remote 增加 host workspace registry（`registerWorkspace` 供 harness 集成，注册后未授权路径一律拒绝）；⑥ sandbox 升级审批展示 workspace；⑦ 文档明确 hook（本地反馈）/ host（工具流约束）/ CI（最终可信门禁）三层职责边界。
- **并发与发布闭环（0.22.4，采纳 REVIEW-0.22.3）**：① `init apply` 在目标文件存在时**强制** `existing_hash`（不再可选），propose→apply 之间文件被篡改直接 fail-closed；② 任务写入升级为真正的原子 CAS——逻辑 `revision` 检查 + dsh-fs 的 `lstat` 版本号 `replaceIfVersion` write intent，并发写入报 `FS_STALE_VERSION` 而非静默覆盖；③ workspace registry 增加 `enableStrictWorkspaces()` 生产模式（空 registry 不再回退放行）；④ `exports["./client"]` 补 `types` 条件（`lib/client.d.ts` 随构建生成）；⑤ 新增 `npm run verify:package` 发布包黑盒验证（pack → 白名单一致性 → 真实安装 → 主入口 import → client 注册 → 包内 123 checks → CLI 语法）；⑥ 工作台 UI 优化——侧栏「工程流程」入口与设置按钮逐像素对齐（实测对齐 36 圆形 rail / 42 高 12 圆角展开行）、流程预设改卡片式选择器、工作台 header 品牌化、初始化预览容器化。REVIEW 指出的 Typert invocation context、host 可信状态签名、CI 最终门禁仍属 harness 层，集成点已在文档标注。
- **目录型 skill 安装（0.22.5）**：工作台「技能」页新增「安装 skill」——把本机已有的目录型 skill（`SKILL.md` + references / scripts / agents 等文件）一键装到<b>项目级</b>（工作区 `.dsh/skills`，团队共享）或<b>用户级</b>（`$DSH_HOME/skills`，个人所有项目可用）；安装校验 SKILL.md frontmatter、拒绝覆盖内置同名、拒绝覆盖已装同名、自动排除 node_modules / .git / `__pycache__` 等缓存目录并限制 200 文件 / 20 MB；实机验证 `software-testing` 目录型 skill 从 UI 安装完整落盘（含 references + scripts）。
- **文案与安装体验（0.22.6）**：「安装 skill」输入框 placeholder 去掉示例绝对路径，改为通用提示「本机 skill 目录，需含 SKILL.md」；`installSkill` 支持<b>容器目录自动定位</b>——填的目录自身没有 SKILL.md 但直接子目录里恰好有一个含 SKILL.md 的 skill 根时自动装入该子目录（多个候选则提示直接填 skill 根）。
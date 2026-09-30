# 自适应工程任务

本页描述 `0.29.0` 的任务级流程。可选 SonarQube 接入复用 CI 扫描，要求先提交并推送才能审核；它还不能对未提交代码执行 Sonar 检查。

此文描述待发布的任务级流程。旧 `.dsh/eng.json`、三个旧流程与已创建任务的快照继续可读；新需求在工程化会话中先评估复杂度，调用 `dev_task assess` 预览，再用 `create` 的 `complexity` 与 `complexity_reason` 创建任务。复杂度由需求范围和实现依赖决定，`risk_level` 单独判断。

| 复杂度 | 适用情形 | 元技能顺序 |
| :--- | :--- | :--- |
| 低 `low` | 边界明确的局部修改 | 代码开发 → 测试 → 代码审核 → 完成 |
| 中 `medium` | 常规功能或缺陷修复 | 需求分析 → 代码开发 → 测试 → 代码审核 → 完成 |
| 高 `high` | 跨模块或存在实现依赖 | 需求分析 → 任务编排 → 代码开发 → 测试 → 代码审核 → 完成 |
| 超高 `ultra` | 完整新模块或大范围重构 | 需求分析 → 架构设计 → 任务编排 → 代码开发 → 测试 → 代码审核 → 完成 |

高档的任务编排按实现先后拆解，记录每步依赖、完成判据和交接产物；它不按人员或分支分发。超高档的架构设计记录模块边界、接口和取舍，不默认要求迁移或回退演练。每档的测试要有实际命令回执，审核要有通过结论；低档每项一次审核，其余档对需求符合性和质量分别记录。提交检查点在“测试”：验证通过后提交并推送分支，CI 才能产生供“代码审核”读取的 Sonar 分析。

## 元技能交接契约

| 元技能 | 输入 | 交接产物 |
| :--- | :--- | :--- |
| 需求分析 | 用户诉求、代码库现状 | 目标、范围、可验证的验收条件 |
| 架构设计 | 已明确的需求与现有结构 | 模块边界、接口变化、主要取舍 |
| 任务编排 | 需求、必要的架构决定 | 按先后顺序的实施项、依赖、每步完成判据与交接 |
| 代码开发 | 上述产物、项目 Skill/Rule | 变更文件、实现结果、已知限制 |
| 测试 | 验收条件和变更 | 真实命令回执、覆盖场景、失败及修复结果 |
| 代码审核 | 变更和测试结果 | 审核结论；启用 SonarQube 时包含该次 CI 扫描的结果 |

每个节点始终加载同名核心 Skill。`.dsh/meta.json` 的 `meta_bindings` 只增加项目需要的 Skill 名称，不决定整个项目所有会话的流程。相同名称按 `.dsh/skills` → `.agents/skills` → `$DSH_HOME/skills` → 插件内置解析。生效 Skill 的 `profile.json` 持有 Rule 引用；项目同名覆盖用户级时采用项目 Skill 自身的 Rule，不暗中合并。

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

在项目根目录运行 `dev_task init_project phase=inspect`。扫描读取一级目录与常见构建清单，返回结构、可证实的技术栈版本及建议的多个项目 Skill 名称，例如 `eam-project-map`、`eam-tech-stack`、`eam-code-backend`。模型结合实际源码、测试和现有治理文件拟定 Skill/Rule 内容；`phase=propose` 预览文件与挂载关系；用相同内容及哈希调用 `phase=apply` 才写入 `.dsh/skills`、`.dsh/rules` 和 `.dsh/meta.json`。已有同名资源不会被 init 覆盖。扫描结果只提供证据，旧代码中的偶发写法不能自动成为团队规则。

## 可选 SonarQube 审核

不需要 SonarQube 的项目保持工作台「自适应流程」里的开关关闭，或不在 `.dsh/meta.json` 写 `sonar`。不需要配置 Token，代码审核仍按审核元技能和项目 Rule 执行。

需要使用当前 CI 接入的项目，在工作台打开 SonarQube 开关，填写服务地址、项目 Key、分析对象（分支或合并请求）及 Token 环境变量名，并保存。也可以手工写入 `.dsh/meta.json`。只有显式启用时，之后创建的新任务才冻结 SonarQube 审核策略；已创建任务不会因开关变化而自动切换：

```json
{
  "sonar": {
    "enabled": true,
    "host_url": "https://sonarqube.example.com",
    "project_key": "my-project",
    "mode": "branch",
    "token_env": "SONAR_TOKEN"
  }
}
```

Token 只放在运行插件的服务进程环境变量，不能写入配置或任务台账。功能测试通过后，**当前实现**在“测试”检查点提交并推送分支，等待现有 CI 完成扫描。到达“代码审核”后，从 CI 的 `report-task.txt` 取 `ceTaskId`，调用 `dev_task sonar_check`；合并请求模式还要提供请求编号。该操作查询这次 Compute Engine 任务的 `analysisId` 和 Quality Gate，并在配置的分支或合并请求上读取新代码问题。Quality Gate 不是 `OK`、有中高等级问题或代码在审核后变化，都会阻止审核通过与任务完成。修复后重新测试、重新扫描、重新检查。

建议在 CI 的 Sonar job 中保存 `target/sonar/report-task.txt` 为制品，方便取得 `ceTaskId`。如果 CI 已配置 `sonar.qualitygate.wait=true`，它可以继续作为 CI 门禁；插件读取分析结果，不重复运行扫描。Sonar 只需针对所选任务实际扫描的分支或合并请求配置 `mode`，具体 CI 触发条件由项目自行决定。分支/MR 最新问题列表与指定 `analysisId` 的门禁分别来自 SonarQube API；如果同一分支同时运行多次扫描，应按 CI 的最新扫描重新审核，避免把旧结果当成当前代码。

失败案例可以用 `dev_task learn_rule phase=propose` 生成项目 Rule 预览，注明 Sonar issue key、可复用原因和正确写法；审阅后用 `phase=apply` 写入项目 Rule 并挂到对应项目代码 Skill。它只影响未来任务，不能把一次误报或整个 Quality Profile 自动复制成规则。

### 分支、提交与当前限制

SonarQube 服务端把分析结果放在项目的某个分支或合并请求下，插件以它定位要查询的问题。分支是结果的命名空间，**不是审核前必须提交的技术要求**。本版要求先提交，是因为它选择复用 CI：CI 扫描已推送的代码，插件随后读取结果。这与“功能通过后先审核未提交代码，修复通过再提交”的目标不一致。

SonarQube for IDE 的 Connected Mode 可以对本地未提交代码应用服务端 Quality Profile 中受支持的规则；本地分析不能代表完整的服务端 Quality Gate，部分复杂规则只在服务端分析时运行。本插件当前没有接入 IDE 的本地分析，也没有提供未提交代码的 Sonar 审核。因此需要提交前 Sonar 审核的团队，暂时不能把本版 `sonar_check` 当作该门禁。未来应把提交前本地检查和提交后 CI Quality Gate 分开设计，并明确两者覆盖范围。

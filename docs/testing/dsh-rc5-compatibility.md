# DSH 0.2.1-rc.5 适配与验收

发布归属：本记录中的适配纳入 0.40.0。以下版本号与“尚未发布”等表述保留为测试当时的候选状态，不代表当前发行状态。

核对日期：2026-11-02。对比官方标签 `dsh-v0.2.1-rc.3`（`1f81c047fc48fa190a683e469daa699857e9afe8`）与 `dsh-v0.2.1-rc.5`（`b830ec950faba0a46dda564be3e2d854afed94f1`）。源码放在独立工作树，未覆盖原有源码或项目数据。

## 官方变更与插件影响

| 变更 | 官方依据 | 对任务引擎的影响 |
| --- | --- | --- |
| rc.4：账号模型目录日志由 stdout 改到 stderr | [官方提交](https://github.com/deepseek-ai/deepseek-harness/commit/41736cdec5) | 避免 ACP 的 JSON-RPC 输出被普通日志污染；插件不解析这类日志，无须修改业务代码。 |
| rc.4：无 resources 能力的 MCP 服务直接返回空资源列表 | [官方提交](https://github.com/deepseek-ai/deepseek-harness/commit/cc4446eecc) | 避免底层 SDK 的调试输出污染 ACP；不改变插件的 CodeGraph CLI 和 Sonar 调用。 |
| rc.4：会话视图标签只在可能溢出时显示提示，更多视图按钮提示固定 | [官方提交](https://github.com/deepseek-ai/deepseek-harness/commit/199ffe37ba) | 属于宿主会话页展示，插件没有覆盖这些标签。 |
| rc.5：思考内容增加显示处理，Body Slot 新增 rawText，text 改为显示文本 | [官方升级指南](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/docs/upgrade-guide/v0.2.1-rc.4/reasoning-body-props/guide.zh.md) | 插件未注册 `conversation.chat.reasoning.body`，没有使用该属性，无须迁移思考渲染器。 |
| DSH 工作区包版本统一更新 | [官方标签对比](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.1-rc.3...dsh-v0.2.1-rc.5) | 原插件精确 peer 仅允许 rc.3，rc.5 的安装器实际拒绝安装，必须适配版本声明。 |

对比中，插件使用的 core、subagent、fs、typert、user-questions、LLM 核心接口没有源码变化，只有各包版本更新。任务存储、需求确认、Skill/Rule 加载、派发与审核策略、测试回执和 Sonar 算法不因本次适配而更改。未知后续预览版仍需单独验证。

## 本次适配

- DSH 构建依赖统一固定为 `0.2.1-rc.5`，更新 npm 锁文件。非 DSH 依赖版本未变化。
- 五项 DSH peer 均明确列举 `0.2.1-rc.3 || 0.2.1-rc.4 || 0.2.1-rc.5`。不设置兼容豁免，不用宽泛范围放行未知版本。
- `verify:dsh` 检查全部五项 peer；继续检查浏览器 Remote 描述、严格 codec 和托管 activation 接口。
- `verify:preset` 默认跟随构建宿主版本，支持 `TASK_ENGINE_DSH_VERSION` 选择已声明支持的版本，复用依赖时要求宿主包版本一致。
- CI 为 rc.3、rc.4、rc.5 分别保留真实预设验证与源码契约检查，master 检查继续作为非阻断预警。未修改远端分支保护规则。

当前 npm 版本号仍为 `0.39.0`；这次适配尚未发布。验收使用本地代码打包的 tarball，不使用 npm 上同版本旧包。打包时从已提交代码建立暂存目录，仅叠加本次适配文件，未夹带工作区原有未提交的架构 Skill 修改。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| 官方 rc.5 完整源码构建 | 9 项构建检查通过，含 Host、Client、Web 和聚合类型检查。 |
| 插件类型检查及构建 | 通过。 |
| 插件回归 | 415 项：408 通过、0 失败、7 项原有历史宿主测试跳过。 |
| 安装包冷安装黑盒 | 通过，含主入口导入、ModuleLoader 注册、包内测试、143 项 P0 和真实 Git hook。 |
| rc.3 真实 npm 宿主预设 | 通过，零模型调用。 |
| rc.4 真实 npm 宿主预设 | 通过，零模型调用。 |
| rc.5 真实 npm 宿主预设 | 通过，零模型调用。 |
| rc.5 正常插件安装 | 原包因版本不符被拒绝；适配包正常安装，无豁免。 |
| 未声明的 rc.6 | 在安装前拒绝，不会借用旧版宿主的验证结果。 |

三版宿主探针实际验证工程预设和只读预设、读写权限、需求确认请求、受控材料、绑定模板渲染、材料变化使批准失效，以及旧记录只读。探针提供确定性的测试答复，不代表真实用户需求批准，也不是模型开发质量或真实子代理性能基准。

## 本地源码页面验证

完整宿主通过源码 CLI 的 `web` profile 启动，按上游指引启用浏览器内目录选择器。独立 `DSH_HOME` 和测试 Git 仓库，不复制其他 profile 的凭据，不改 QMS。

已检查工程入口和预设、工作区切换、新目录任务读取、需求与方案、真实测试回执、宿主 Markdown 渲染以及实际 Markdown 下载。页面所读的 `SOURCE-HOST-1` 是前一轮真实模型生成的隔离任务，不是手工构造的任务 JSON；其中测试由 rc.3 会话执行，不能当作 rc.5 新会话的测试结果。

rc.5 独立真实模型任务 `RC5-LIVE-2` 已完成并归档，会话为 `session-acaa4176-9e61-42c0-bd20-a3289879fffd`。模型为用户在隔离页面配置的 DeepSeek-V4.1-Flash / Max。需求总结 v2 由用户明确批准后通过 DSH 页面确认；`product/checklist.md` 经受控入口保存在任务材料目录；模型完成 multiply 函数、两条新增回归用例、测试、审核、本地提交和归档。真实测试共 4 条通过，退出码 0，只执行了一次。提交 `760275c9e005f11774beb7eb65724a72b0050bde` 只包含两个业务与测试文件，隔离仓库没有远程地址。

独立验收脚本读取真实任务和完整压缩会话日志，核对需求文件、材料哈希、当前验证输入哈希、审核范围哈希、提交内容与工具调用。没有通过原生 write/edit 工具直接修改任务 JSON。完整 rc.5 页面核对归档状态、有效回执、审核结论和实际导出的 Markdown 文档。

### 本轮限制和恢复事项

1. Windows `workspace-write` 沙箱在给测试目录授权时返回 `SetNamedSecurityInfoW failed (Win32 5)`，当时项目命令尚未执行。拒绝了模型提出的目录权限修复脚本，未修改 ACL，也未生成权限恢复目录。页面访问模式随后显示为完全权限，最终测试回执记录 `danger-full-access`。因此本轮证明该条件下插件交付链可完成，不能宣称 Windows 沙箱模式已经通过；这项环境问题没有在本次版本适配中修复。
2. 模型服务出现一次 `MALFORMED_RESPONSE`（工具参数不是合法 JSON），导致轮次中断。通过继续消息从已有台账恢复，保留需求批准、材料和测试回执，未重建任务。这项服务响应问题没有因插件适配而消失。
3. 低复杂度任务由主会话实施，SonarQube 未启用；本轮不是 Sonar 扫描或真实 spawn/fork 子代理的验收。三版宿主探针验证的是预设与只读限制，不能代替真实委派的成本和质量评测。

结论：rc.3、rc.4、rc.5 的声明、构建、包安装和预设兼容检查通过，rc.5 在记录的实际权限与模型条件下完成了页面交付流程。沙箱环境和模型流式响应恢复仍需分别跟踪。

本地详细日志位于 `docs/assessment-20261102/source-host/`，含宿主版本、构建、安装、回归、三版预设探针与页面截图；该目录不随 npm 包发布。

## 后续高复杂度实测

同一 rc.5 源码环境还完成了 `HIGH-PRODUCT-1`：挂载原有产品澄清 Skill、两轮模拟产品答复、正式需求批准、前后端实现、16 项后端与 2 项前端测试、6 个真实只读审核子会话、返工、本地提交和归档。多轮材料、错版答复拒绝、审核发现的真实缺陷以及流程重复失效、Windows 沙箱恢复和成本限制，分别记录在[高复杂度与多轮产品确认评测](product-clarification-multiround.md)。这轮同样不是无人工干预的沙箱验收，也不包含 SonarQube 或 CodeGraph。

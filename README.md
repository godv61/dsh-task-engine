# DSH Task Engine

在 DeepSeek Harness 中按**每个需求**组织开发：模型评估低、中、高、超高四档复杂度，任务按相应元技能推进；项目 Skill 与 Rule 保存团队约定。可选的 SonarQube 审核只在代码审核阶段运行。

## 安装

把插件安装到实际使用的 Web profile（下面以 `web` 为例），重启 DSH Web：

```sh
dsh plugin --profile web add @godv61/dsh-task-engine
```

使用 DSH 源码启动时，在 DSH 根目录执行 `pnpm dsh plugin --profile web add @godv61/dsh-task-engine`，再运行 `pnpm dsh web --no-open`。重启后，侧边栏应出现“工程任务”，新会话应能选择“工程化开发引擎”。普通会话不会因为某个项目配置了流程而自动进入该流程。

## 从一个项目开始

1. 在“工程任务”选择工作区，进入“项目初始化”，复制初始化请求到该项目的“工程化开发引擎”会话。`init_project` 依次扫描、预览、应用项目地图、技术栈及开发 Skill/Rule。项目地图概述**整个仓库**，需求细节写进具体任务。
2. 检查生成的 `.dsh/skills/`、`.dsh/rules/` 和 `.dsh/meta.json`，按需在“自适应流程”把项目 Skill 挂到元技能。同名项目 Skill 优先于用户级和内置 Skill。
3. 在会话中描述需求。模型用 `dev_task assess` 评估复杂度，再创建独立任务。高、超高任务按实现先后顺序编排实施项，不按人员分包。
4. 在“任务台账”查看阶段、实施项、测试和审核。`items` 默认按 ID 增量更新；要有意重排或移除未开始的项目时，显式使用 `items_mode=replace`。
5. 开发完成后运行真实验证。Maven 测试命令须在输出中证明至少运行一个测试；零测试不能作为通过。审核通过后，按任务门禁完成提交。

## 可选 SonarQube

在当前项目的“自适应流程”页单独填写服务地址、项目 Key、扫描方式和 Token。Token 保存在本机 DSH 项目凭据中，不写入仓库；不需要 Sonar 的项目保持开关关闭。

- **本地规则审核 `ide-local`**：使用项目 Quality Profile 中可本地执行的规则检查相对 Git 参考分支新增的代码；无需先提交或推送。审核会拒绝任务范围漏登的新增文件。对疑似误报，可逐条附理由和证据，请求人工批准；原始告警保留，代码变化后需重新审核。
- **CI 结果 `ci`**：读取本次 CI 分析的 CE task ID，按服务端新代码规则和 Quality Gate 判断。
- **上传式本机扫描 `local`**：本机扫描并上传分析；需要支持分支分析的 SonarQube 版本。

每次审核都在项目 `.dsh/reviews/<任务 ID>/` 留下 Markdown 报告，任务台账可查看问题与处理状态。`ide-local` 的结果不能代替服务端完整 Quality Gate。真实且可复用的修复案例可以经预览后生成项目 Rule；误报不会自动变成 Rule。

## 文档

详细安装、首次初始化、四档流程、Skill/Rule、任务命令、Sonar 配置与排障见唯一的[使用手册](docs/manual.html)。插件开发与发版检查见[开发指南](docs/development.md)。仓库历史版本可通过 Git 记录查看；当前文档只描述现行功能。

[MIT License](LICENSE) · [问题反馈](https://github.com/godv61/dsh-task-engine/issues)

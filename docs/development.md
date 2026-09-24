# 开发指南

[← 文档导航](README.md)

插件包含 host 控制器、agent 工具和浏览器工作台。代码为 TypeScript，发布到 npm 的包包含预构建入口与资源文件。

## 本地验证

在插件源码目录执行：

```sh
npm install
npm run build
npm run typecheck
npm test
npm run verify:package
```

`build` 生成 host、浏览器客户端与提交钩子；`typecheck` 检查 host 和 client 两个编译面。`verify:package` 将 tarball 安装到干净临时项目，检查包入口、客户端注册、包内测试和 CLI 语法。

CI 在 Windows 的 Node 22/24 上运行。每次功能修改选择相关验证；文档排版调整只需要文档、链接和渲染检查。测试数量随版本变化，当前值以本地 `npm test` 与 `npm run verify:package` 的输出为准，不在此处固定。

## 代码导航

| 位置 | 职责 |
| :--- | :--- |
| [src/engine.ts](../src/engine.ts) | 状态机、阶段条件和提交规则检查。 |
| [src/workflows.ts](../src/workflows.ts) | 三套流程骨架及可选的推荐配置。 |
| [src/dev-task.ts](../src/dev-task.ts) | 模型使用的 dev_task 工具与任务文件操作。 |
| [src/controller.ts](../src/controller.ts) | 工作台读取配置、任务和资源的 Remote 控制器。 |
| [src/resource-import.ts](../src/resource-import.ts) | 导入校验、安装预览、独占写入与失败清理。 |
| [src/client](../src/client/) | 工作台界面与客户端 Remote 定义。 |
| [src/hook.ts](../src/hook.ts) | 提交钩子的源码，构建后输出到 hooks/commit-msg。 |
| [cordis.patch.yml](../cordis.patch.yml) | Bundle 的 host 挂载声明。 |

## 启用方式

Host 入口挂载工作台控制器，并在 eng 预设不存在时生成“工程化开发引擎”。Agent 入口只在引用它的会话预设中注册工具和技能。

需要将插件接入自己的会话预设时，在该预设的 agent.cordis.yml 加入：

```yaml
- id: task-engine-agent
  name: '@godv61/dsh-task-engine/agent'
```

eng 预设由插件在每次启动时**从当前 Harness 的 `standard` 预设重新派生**，因此 Harness 升级后预设会跟着更新。判断依据是文件里是否带有本插件写入的 agent 行：**插件自己生成的会被更新，手工编辑过的原样保留**。配套的 `enable` 脚本行为更保守——目标已存在时直接拒绝，不覆盖。

## 可选 host 接入

Host 入口优先使用 Harness 的 `workspaceRegistry.resolveByPath` 获取已登记工作区。旧 host 可以通过插件导出的 `registerWorkspace` 和 `enableStrictWorkspaces` 配置注册目录及严格模式，接口定义见 [src/controller.ts](../src/controller.ts)。注册范围不等于会话身份鉴权；个人本机使用不要求为此改造 Harness。

发布前保持 README、使用手册和实际代码一致；不要将规划中的功能描述为已经可用。

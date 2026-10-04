# 开发与发布

[返回项目首页](../README.md) · [使用手册](manual.html)

插件分为 host 控制器、agent 工具和浏览器工作台。源码在 `src/`，构建结果在 `lib/`，npm 包包含预构建入口、内置 Skill、预设和提交钩子。

## 代码位置

| 路径 | 主要职责 |
| --- | --- |
| `src/adaptive.ts`、`src/workflows.ts`、`src/engine.ts` | 四档流程、兼容流程与任务状态机。 |
| `src/dev-task.ts` | `dev_task` 操作、阶段门禁和任务留痕。 |
| `src/sonarlint-local.ts`、`src/sonar.ts`、`src/sonar-report.ts` | 本地规则分析、服务端结果与 Markdown 报告。 |
| `src/verification-tests.ts` | Maven 测试摘要门禁。 |
| `src/project-init.ts` | 项目扫描与初始化覆盖检查。 |
| `src/controller.ts`、`src/client/` | 工作台读写接口与界面。 |
| `skills/`、`preset/` | 会话编排与元技能正文。 |

## 本地验证

在插件源码根目录执行：

```sh
npm install
npm run typecheck
npm run build
npm test
npm run verify:package
```

`verify:package` 将当前 tarball 安装到隔离临时目录，检查可发布入口、客户端注册、包内测试和 CLI 语法。CI 在 Windows 的 Node 22、24 上运行。提交前检查 `git status`，确认没有本机凭据、临时审核文件或生成包进入版本控制。

## 当前质量约束

- 本地 Sonar 审核必须先对照参考分支的 Git 差异、项目 `include_paths` 与任务 `files`；漏登文件不得产生“完整审核通过”。
- `ide-local` 的逐项误报处置只能在当前审核、当前代码指纹上由宿主人工批准；原始告警和结果保留。CI 或上传式服务端 Gate 不接受本地处置。
- Maven 测试目标在进程成功之外，还需解析到非零 Surefire/Failsafe 测试数。未输出摘要时失败关闭，其他命令按自身回执判断。
- `items` 默认按 ID 合并；显式 `items_mode=replace` 才允许移除未实施的项目。已完成或有审查记录的项仍保留。
- 文档只维护项目首页、本 HTML 使用手册和本开发指南，三处描述均以当前功能为准。

## 发布与部署检查

1. 更新 `package.json` 版本，运行上述验证，再检查 `npm pack --dry-run --json` 的文件清单只有当前文档。
2. 推送提交后发布 npm 包；需要 npm 登录或 WebAuthn 时，保持发布命令等待，由账号持有人完成验证。
3. 在实际 DSH Web profile 安装刚发布的精确版本并重启，确认侧边栏入口、会话预设和 `dev_task` 能加载。项目 Token 保存在本机凭据中，升级不应把它写进仓库。

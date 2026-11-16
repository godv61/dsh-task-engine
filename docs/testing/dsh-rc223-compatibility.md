# DSH 0.2.2-rc.3 适配验收

日期：2026-11-16。基线为已发布插件 0.41.0（c115252），目标为官方 `dsh-v0.2.2-rc.3`（38a6a5c965aa99ab525161efb7cc5cf1fe62fced）。本记录对应 0.41.1 源码与打包验收，不能用于断言桌面已安装新版插件。

## 问题与修改

已发布 0.41.0 的 peer 范围不包含 rc.3，宿主会禁用插件贡献。仅修改兼容声明仍不足：rc.2 起 `startActivation` 将 `request` 内参数移到顶层，原只读委派实测在启动时出现读取 `undefined.id` 的错误。

三个生产入口统一调用 `startTaskActivation`：只读分析委派、实施 spawn/fork、独立审核。适配层根据宿主公开 `namesOf` 方法判断参数形状；该方法与顶层 activation API 同时在 rc.2 引入。启动前只选择一次，失败后不换形状重试。旧宿主仍使用 `request` 包装，新宿主传顶层参数。包装句柄保留新 `name`，任务身份继续使用稳定 `childId`。

开发依赖固定为 rc.3，peer 显式增加 rc.3。CI 增加精确 rc.3 源码契约校验和 Windows 当前 SDK 验证，并保留 rc.1 与三版 0.2.1 的兼容矩阵。未将未验收的 0.2.2-rc.2 或任意未来预览版放入兼容声明。

没有调整复杂度、任务阶段、需求确认、Skill/Rule 挂载、审核策略或项目数据。适配在 `codex/harness-0.2.2-rc.3` 隔离工作树完成，原工作区和 QMS/QDM 未修改。

## 本机结果

| 检查 | 结果 |
| --- | --- |
| 构建与双端类型检查 | 通过 |
| 三个派发入口及取消、清理、只读权限针对性回归 | 55 项通过 |
| Node 24 完整回归 | 456 项：449 通过、7 跳过、0 失败；P0 143 项通过 |
| npm tarball 黑盒验收 | 安装、公开入口、浏览器模块注册、包内行为及 CLI 通过 |
| 精确 rc.3 官方源码契约 | 通过 |
| rc.3 公共 SDK / Node 24.9.0 | 双端类型检查、预设、需求门禁及真实托管子代理通过 |
| rc.1 公共 SDK / Node 24.9.0 | 同上；旧参数形状通过 |
| 最低支持的 0.2.1-rc.3 / Node 22.22.3 | 精确类型检查、预设切换、需求门禁和只读审核通过 |

两个 0.2.2 宿主均加载本地新打包的 tarball，创建全新项目、profile 和 session；使用本地脚本适配器产生 7 次响应，不访问外部模型 API。实际调用 `dev_task delegate`，由宿主创建只读子代理，验证拒绝写入、读取文件、结构化回传和稳定会话 ID。子代理结束不等于父任务验收，父任务随后单独提交源码证据。继续通过适配层启动真实 spawn/fork，取消挂起子代理后再次派发，核对所有子会话处于 inactive。

实施及独立审核的参数路由由 `.execution-policy-test.mjs` 分别在新旧协议下验证；真实 SDK 的实施传输用 spawn/fork 验证，未把它描述成完整业务需求交付验收。本轮未安装用户日常桌面 profile、未手测页面、未调用真实模型、未提交业务代码。

7 项跳过是原有缺少旧文件式预设宿主资源的可选检查，不作为当前兼容性通过证据。首次受限沙箱运行有 8 项因创建临时目录链接而触发 EPERM；普通本机权限下复验全部通过。SDK 夹具调试中修正了本地模型路由，并按宿主契约同时接受取消回执与取消异常；没有放宽生产门禁。

发布 CI 前两轮的 Windows 当前 SDK 作业均在夹具内 npm 依赖准备时达到 600 秒超时，尚未进入运行验证；拆分宿主与插件安装未消除该环境问题。Windows CI 改为沿用旧宿主已通过的独立 PowerShell 依赖准备步骤，输出实时安装进度，随后向全新 SDK 夹具复制已安装的公开依赖。插件始终解包本次 tarball，继续执行宿主 peer 校验、类型检查及全部 SDK 断言。实际 npm 安装插件的检查仍由 `verify:package` 保留。

原始日志位于工作树上一层评测目录：`adaptation-build.log`、`adaptation-typecheck.log`、`adaptation-targeted.log`、`adaptation-full-test-node24.log`、`adaptation-package.log`、`adaptation-contract-rc3.log`、`adaptation-preset-rc3-final.log`、`adaptation-preset-rc1.log`、`adaptation-preset-legacy-rc3.log`。这些日志和测试 profile 不随 npm 包发布。上述为本机结果；远程 CI 与发布状态以关联 PR 和 GitHub Release 为准。

# DSH rc.3 适配与本地源码验收

日期：2026-10-26，时间使用 UTC+08:00。本报告记录 **0.35.0 本地候选的验收，尚未推送或发布**。

## 采用的方案

按用户选择的方案 2：0.35 仅面向 DSH `0.2.1-rc.3`，不维护旧 `start()` 分支。旧 DSH `0.2.0-rc.2` 继续固定使用已发布插件 `0.34.1`。兼容脚本已实测接受 rc.3，并拒绝 rc.2 的接口和版本，不能只扩大 peer 范围。

新版官方源码单独位于 `D:\dsharness\deepseek-harness-rc3`，标签 `dsh-v0.2.1-rc.3`，提交 `1f81c047fc48fa190a683e469daa699857e9afe8`。依赖按 frozen lockfile 安装，七项 build:artifacts 全部完成；官方源码工作区保持干净。原 `D:\dsharness\deepseek-harness` 仍停留 rc.2，旧 profile 和会话保留。

## 主要修复

- 子代理调用改为官方 `startActivation`，使用 `childId`、`result`、`dispose` 和 `delivery=caller`。父工具在发布后取消时显式释放该次 activation；清理失败继续保留锁定。
- 使用独立 `task-engine-review` 预设实施只读审核，移除旧 `toolFilter`/persona 启动参数和 backgroundMode 配置。审核者只见 read 与 structured_output；守卫也拦截其它工具的实际执行。
- 宿主记录审核工具清单，接受审核前核对具体 child 身份、结构化结果和完整读取证据。通过 `sessionQuery.observeSession` 读取真实子日志并释放观察租约。
- 移除已失效的 `{{cwd}}`。任务台账和交付以原始项目根为锚点，父会话改变当前目录不会搬迁台账；派发和验证显式使用 task.root。
- 台账显示只读策略回执状态；缺少或无效的回执不显示“已验证”。旧活动任务缺少新回执时需要重新审核，历史归档不重写。
- 开发依赖、peer 声明、CI 固定宿主和兼容检查切换到 rc.3。

## 联机中发现并修正的问题

1. D 盘测试目录的用户权限只有 Modify。rc.3 原生 Windows 沙箱还需要 WRITE_OWNER 来设置 Low label，因此在命令执行前出现 `SetNamedSecurityInfoW ... grantWrite ... Win32 5`。改用用户临时目录中原本就继承 FullControl 的全新隔离项目后，普通 workspace-write 命令正常执行。没有批准 ACL 修复脚本，没有修改 D 盘或原项目权限，没有关闭沙箱。普通用户进程重启本身未解决这个目录权限前提。
2. 独立审核曾两次启动失败：`reviewer policy requires a preset scope`。修复为依靠宿主的 scope 事件路由，为各 Agent 安装限制，避免插件自行读取另一个模块实例的私有 scope 标记。修复后复用既有实现和测试回执重新审核成功；父会话及其它会话的工具不受影响已有实际框架测试。
3. 第一轮模型在审核失败后越过测试目录搜索用户配置和插件，已被操作员停止。这一负面过程保留在会话和报告中，不能将整轮描述为完全无人干预；后续轮次明确要求失败即报告，没有再次跨工作区搜索。

## 真实验收结果

宿主通过 `pnpm dsh web` 从上述官方源码启动，独立 home 为 `%TEMP%\task-engine-rc3-local-20261026`，只安装本地 tarball。测试入口为 `http://127.0.0.1:54578/`；访问令牌仅保留在本机服务日志，不放入报告。

真实项目：`%TEMP%\dsh-rc3-acceptance-20261026`，任务 `RC3-ACCEPT-20261026`。使用 DeepSeek 模型、真实子会话和原生 workspace-write 命令，并非只运行 mock。

| 项目 | 实现子会话 | 审核子会话 | 真实验证 |
| --- | --- | --- | --- |
| ADD / spawn | e7eda3ff-4921-48f0-a10c-f55b90ac35a5 | 5f5116e4-3ccf-4597-ae56-b46004d827d5 | 17/17，exit 0 |
| MULT / fork | c02c8567-cddf-4a2c-8acd-7b44a64de6f4 | 88ac3b38-98d8-4bff-87cd-2b0fd96e3dea | 18/18，exit 0 |

日志核对确认：spawn 不继承会话种子，fork 继承 218 条记录；两次审核都是全新上下文的 task-engine-review 子会话。每次实际模型请求的工具清单均严格为 read 和 structured_output，实际调用也仅这两种工具；四份交付文件的全文内容已从真实 read 事件重新计算覆盖并核对。两个实施项均 done，规格/质量通过，全部当前测试指纹有效。MULT 完成后 ADD 的实施/审核记录与测试回执保持原样，父会话没有重复运行 add 测试。

页面验收：工程预设可以发送模型请求；任务台账成功读取一条实际任务，显示 2/2、两组测试、两类子代理和独立审核；时间显示 `2026-10-26 15:02:03.125（UTC+08:00）`。初始化页也完成扫描和候选步骤加载。没有执行本次项目 Skill 生成、CodeGraph 安装或 SonarQube 扫描。

任务按验收指令停在代码开发，任务级审核仍 pending，没有进入完成、提交、推送或归档。这是刻意的验收边界，不代表完整发布流程已运行。

## 本地自动检查

- typecheck、build：通过。
- 完整回归：303 项，296 通过，7 跳过，0 失败。7 项是缺少旧文件预设包的旧派生测试，不能当作 rc.3 预设验收。
- 包黑盒检查：通过，包含干净临时安装、入口导入、客户端注册、151 项 P0 断言和包内行为测试。
- 官方 rc.3 源码契约：通过；旧 rc.2：按预期拒绝。
- controlled runtime 测试覆盖：父取消、清理失败、精确 child 查询、观察释放、只读工具实际执行拦截、父/其它会话不受限。取消和清理故障未再进行真实模型中断试验。
- 原 QMS：25 份治理文件与 5 份业务文件的既有哈希均保持不变；没有回退或重跑 QMS。

证据为同目录 `rc3-live-result.json`、`rc3-live-after-add.json`、`rc3-live-assertions.log`、`rc3-final-tests.log`、`rc3-final-package.log`、`rc3-final-contract.log`、`rc3-old-host-rejected.log`、`rc3-preservation.log`、`rc3-live-ledger.png` 和 `rc3-readonly-review.png`。`collect-rc3-live.mjs` 只读核对实际台账及持久化子日志，不修改运行中的任务。

## 成本与发布边界

结果 JSON 保存父会话和四个子会话的真实 usage，fork 扣除继承前缀后单独汇总。这里包含启动失败、操作员干预和明确指定 spawn/fork 的测试提示，因此不能用于证明自动委派优于 direct，也不能把不同任务的两项 token 直接当成公平对照。小修改、跨模块和缺陷返工的重复同任务对照仍待做。

本次没有推送新 CI，也没有 npm 发布。未来发版前需运行 Windows/Ubuntu、Node 22/24 的远端检查；GitHub 保护规则目前仍使用旧固定宿主的检查名称，切换 rc.3 的对应必需检查需一并处理，不能绕过。原始兼容评估 `DSH-0.2.1-rc.3-COMPATIBILITY.md` 是修改前基线记录，以本文为适配后结果。

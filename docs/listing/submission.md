# 插件收录申请

**已收录：** [PR #5681](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/5681)
于 2026-09-22 15:45:57 UTC 被维护者 `fkysly` 合并，**无修改要求**（0 条评审评论）。
条目已在列表的 `main` 上，中英两个 README 均已生成对应行。

提交时 `check`（7m40s）与 `Submission gate` 两项 CI 全部通过。PR 只新增
`data/plugins/godv61__dsh-task-engine.yml`（+6 行），未触碰生成出来的 README。

条目页：[awesome-dsh-plugin.com](https://awesome-dsh-plugin.com)

目标：[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。

## 提交内容

按[贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)，
PR **只新增一个文件**：`data/plugins/godv61__dsh-task-engine.yml`，内容复制本目录同名 YAML。

**标题：** `Add godv61/dsh-task-engine`

**分类：** `workflow` —— 插件本身提供工程流程预设与阶段门禁，分类与实际行为一致。

> 注意：`data/plugins/` 下的条目文件是数据源，仓库根的两个 README 由脚本生成。
> **不要手工编辑 README**，也不要往 `data/screenshots.json` 加键（新约定是插件仓库自己放 `screenshots.json`）。

## PR 正文

> Adds `godv61/dsh-task-engine` under `workflow`.
>
> The plugin adds a `dev_task` tool that holds an engineering state machine: three preset flows
> (`standard`, `agile`, `minimal`) with transitions gated on human confirmation, artifact
> completeness, implementation items, real verification receipts, and review outcome — plus a
> commit gate that checks stage, message format and file scope. A web workbench installs project- or
> user-level skills and rules, binds them to individual stages, and shows the task ledger.
>
> Repository includes source, a `dsh.bundle` manifest with `cordis.patch.yml`, user documentation,
> and a test suite (146 P0 assertions, 52 `node:test` cases including an end-to-end commit-hook
> suite). Published on npm; `repository` points back at this repo.

## 提交前的自查（对照指南逐条）

| 指南要求 | 本仓库状态 |
| :--- | :--- |
| `package.json` 声明 `dsh.bundle` | ✅ `"bundle": { "patch": "./cordis.patch.yml" }` |
| 仓库根有 `cordis.patch.yml` | ✅ |
| 真实可用代码（非占位/纯 README） | ✅ host 与 client 两个面均已实现并有测试 |
| 仓库创建满 1 天 | ✅ 创建于 2026-09-15 08:10:50 UTC |
| 已有 `dsh-plugin` topic | ✅ |
| 活跃维护 | ✅ |
| `repository` 指回本仓库 | ✅ `git+https://github.com/godv61/dsh-task-engine.git` |
| npm 包 `repository` 回指同一仓库 | ✅ |
| 非纯聚合包（自带行为） | ✅ 自带 `dev_task` 工具与工作台 UI |
| 描述不含 `: `（冒号+空格） | ✅ 已加引号 |
| 官方包用 `peerDependencies` | ✅ `@deepseek-ai/dsh-*` 均在 peer 中 |
| peer 范围带显式预发布分支 | ✅ `^0.1.2-rc.1 \|\| ^0.1.3-alpha.1 \|\| ^0.1.6-alpha.2 \|\| ^0.1.7-alpha.1` |

**关于 peer 范围**：指南特别警告过「不带显式预发布分支的范围会静默排除 harness 的预发布构建」。
本插件用的是显式 `||` 分支形式，正是指南推荐写法。

## 描述准确性

指南说明描述会被**当作对代码的声明并逐句核对**，因此上面那行只写了可验证的事实：

| 描述中的说法 | 代码依据 |
| :--- | :--- |
| `dev_task` 工具 | `src/dev-task.ts` 的 `defineTool` |
| 阶段流转门禁 | `src/engine.ts` 的 `assertAdvance` / `legalTargets` |
| 产物门禁 | guard `artifacts_present` + `ArtifactDef` |
| 验证门禁 | guard `verified` + 真实命令回执 |
| 审核门禁 | guard `review_passed` |
| 提交范围校验 | `checkFileScope` + `hooks/commit-msg` |
| 三个预设流程 | `FLOW_OPTIONS`：`standard` / `agile` / `minimal` |
| 工作台安装技能与规则 | `src/client/` 的 `ResourceManager` 等 |

**描述里刻意不写具体数字**（如「7 个技能、3 条规则」）：这类数字会随版本变化，
写死反而容易变成不准确声明。

## 备注

本目录此前一份材料提到「仓库创建满 24 小时」与手工核对 `created_at`。指南现已说明
**该门槛由 CI 自动检查**，无需在 PR 里论证，故此处不再展开。

截图可选：可在本仓库根放 `screenshots.json` 声明，市场会自动读取，无需在本列表仓库提交图片。
当前未声明，市场会从 README 自动抽取。
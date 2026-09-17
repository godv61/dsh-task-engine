# 提交规范

- 内置流程的提交消息使用 `【<task_id>】【TASK】说明` 或 `【<task_id>】【Tn】说明`，第一段必须是当前任务 id，不能填模块名；第二段使用 `dev_task status` 返回的 `commit.label`。自定义格式以任务冻结流程中的 `commit.message_hint` 和 `message_pattern` 为准。说明写结果，不写"修改代码"这类空泛动作。
- 只提交任务 files 范围内的文件；逐文件暂存，禁止 `git add .` / `git add -A`。
- 提交前 `git diff --cached --check`；发现范围外文件、密钥或环境配置时停止。
- 不 push、不合并、不建 PR、不部署、不发布。

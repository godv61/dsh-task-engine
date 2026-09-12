# 提交规范

- 提交消息：`【<module>】【TASK】说明` 或 `【<module>】【Tn】说明`，说明写结果，不写"修改代码"这类空泛动作。
- 只提交任务 files 范围内的文件；逐文件暂存，禁止 `git add .` / `git add -A`。
- 提交前 `git diff --cached --check`；发现范围外文件、密钥或环境配置时停止。
- 不 push、不合并、不建 PR、不部署、不发布。
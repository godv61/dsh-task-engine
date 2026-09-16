---
name: code-review
description: 代码审核节点：评审变更，产出结论与问题清单并落评审记录。仅在任务处于「代码审核」阶段时使用（以 dev_task status 的 stage 为准）。
---

# 代码审核

1. `dev_task`（operation=status）读当前变更与验证结果。
2. 评审：契约是否兼容、边界条件、错误处理、变更范围是否越界。按实际改动检查异步查询乱序、关闭/重开后的旧请求、加载/失败时旧数据可否提交，以及上游业务错误码、空响应和反序列化空对象；相邻旧实现的写法不能作为这些边界正确的证明。涉及交互时检查真实组件的事件、只读、清空和校验行为，不能只凭属性名判断。
3. 结论与问题用 `dev_task`（operation=record, artifact=review, fields={conclusion, issues}）落库。
4. 结论用 `dev_task`（operation=review, outcome=pass|blocked）记录；blocked 写清阻塞原因。

是否进入本节点由冻结流程的 legal_next 决定，标准流程必须审核。发现缺陷时在当前阶段修复并重跑 verify，更新结论；不要新建“收尾任务”绕过当前门禁。完成即将进入的终态技能义务后，按 status.commit 执行本地提交并回写真实 hash，再 advance。

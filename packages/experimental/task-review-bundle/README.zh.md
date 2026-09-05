# @deepseek-ai/dsh-experimental-task-review-bundle

[English](README.md) | 中文

按需安装的私有 Profile Bundle，装配 [Task Contract](../task-contract/README.md)、[Final Gate](../final-completeness-gate/README.md)、[Progress Observer](../progress-integrity-observer/README.md) 和 [Task Execution Control](../task-execution-control/README.md)。正式发布包不依赖此 Bundle。

## 配置与生命周期

补丁以 `mode: shadow` 安装四个 Provider，但只有三个辅助模型节点：需求变更解析、Progress Observer 和 Final Reviewer。TaskExecutionControl 是确定性程序，不增加模型调用或 Shadow 限制。三个模型节点分别拥有路由、预算和超时。只有交互式根 Agent 参与；子智能体与私有记忆维护 Session 被排除。卸载时取消并排空自有调用。

请明确安装到目标 Profile，并重启该 Profile。移除后在下次启动撤下所装配的提供方；已记录的 Session 事件仍可读取。Bundle 不修改记忆策略、记忆 generation 或提供方凭据。

可选浏览器贡献 [UI Task Review](../ui-task-review/README.md) 在聊天中展示准入前输入回执与需求变更解析失败。它不会把辅助响应加入 Worker 历史，也不改变准入策略。

## 模型体验

### 保留的需求与 Shadow 审查

#### 模型看到的内容

Worker 接收普通对话、已有运行时上下文，以及从权威需求账本派生的精简 `task-contract` 快照。快照只包含待完成、已完成和已取消的需求正文，以及用户正式批准的计划原文；不包含来源坐标、事件、证据或历史版本身份。Shadow Reviewer 与 Observer 位于 Worker 历史之外，不拒绝回答或注入引导。

#### Token 影响

需求变更解析、Reviewer 和 Observer 请求产生独立审计的 Provider 用量，各统计一次；TaskExecutionControl 不产生模型用量。

#### KV Cache 影响

只有快照渲染内容变化，或自动压缩遮蔽了当前保留副本时，才会向 Worker 输入追加精简任务快照。三个辅助调用拥有各自稳定前缀。

## 已知限制与暂缓事项

- 这是实验装配，不是任务完整性保证。提取和审查依赖所配置的模型；Bundle 不启用 Enforce 或自动中断工具。辅助调用可能增加延迟和费用；提供方失败保留在 Session 诊断中。

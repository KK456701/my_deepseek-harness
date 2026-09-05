# @deepseek-ai/dsh-experimental-final-completeness-gate

[English](README.md) | 中文

这个私有实验插件在 Enforce 模式下先暂存最终候选，再在写入普通 `assistant/message` 前审查。若发现漏答、过度声明或工作未完成，候选不会进入普通 Worker 历史；同一个 Turn 会进入受限改写、有限补做或重新规划。Shadow 模式无法拦截交付，因此只能审查已发送消息。

`maxCandidatesPerTurn` 限制最终回答尝试次数。包含工具调用的中间 Step 仍受字节配额约束，但不占用最终回答次数。

`maxCandidateBytes`、`maxTurnStagingBytes` 和 `maxSessionStagingBytes` 都按组装后的候选内容计量。相邻候选增量会在持久化前有界合并，Provider 的分段边界既不会放大持久事件数，也不会把同一正文重复计入 staging 容量；完整候选仍可回放。

## 配置

```yaml
- id: final-completeness-gate
  name: '@deepseek-ai/dsh-experimental-final-completeness-gate'
  config:
    mode: shadow
    reviewTiming: before-delivery
    reviewerProvider: deepseek-official
    reviewerModel: deepseek-v4-flash
    reviewerReasoningEffort: high
    allowCrossProviderReview: false
    reviewerMaxTokens: 2048
    reviewerTimeoutMs: 30000
    maxEvidenceLookupRounds: 4
```

跨 Provider 审查必须显式启用，因为相关真实用户原文、计划原文、结果证据和候选回答会离开 Worker Provider。

## 冻结审查输入

版本 8 输入只保留一份：相关真实用户消息、全部未取消需求（含已完成项）的 ID、版本、正文、验证方式和状态、可选的最新正式批准计划原文、带稳定 ID 的候选段落，以及结果证据的紧凑索引。索引只提供结果 ID、状态、调用 ID、工具名和可选的 120 码点目标提示；不包含结果预览或完整参数，所有选中结果仍可读取。程序在索引中标明当前有效、过期或适用范围未知；文件版本与保守工作区修改水位决定新鲜度，未观察到的外部修改不在保证范围内。它不包含 Worker 推理、完整工具 Schema、无关历史、Observer 长篇分析和长期记忆正文。

Reviewer 只有在需要核实某项结论时，才能调用其作用域内的 `session_event_search` 和 `session_event_read`，读取回答交付前已经冻结的 Session 结果事件；普通 Worker 的工具列表中没有这两个工具。按需读取不会再额外写一条访问事件。执行型需求只有在逐个读取被引用结果后才能标为 `verified`。初始请求告知 `maxEvidenceLookupRounds`，每轮可读取多个事件。最后一轮查询后，收束请求保留已收集证据，但不提供工具，要求返回审查结果。缺失证据仍须标为未验证；再次调用工具或返回非法结果时失败关闭。收束不会增加重试，也不重置超时和费用预算。

Reviewer 为每个未取消需求返回一个 `RequirementReview`：回答覆盖、直接覆盖要求的候选原文片段、工作状态、结果事件 ID 和简短缺口。工作状态为 `verified`、`needs-verification`、`not-done`、`incorrect` 或 `not-needed`。运行时验证身份、版本、精确原文片段、计划子串、已读结果及新鲜度。语义支持仍由 Reviewer 判断；泛化完成声明不能单独证明具体覆盖。旧审查不会自动获得版本 8 的通过结论。

## 交付动作

无工具的收束请求由原始冻结输入和每个已收集查询结果的一份正文重建，不携带查询对话中的助手推理及原生工具调用历史；此前请求仍保留在审计中。只有最终正文会被解析为审查结论。只有思考而无正文的响应属于校验失败，可使用既有的一次修复；不会将推理提升为已接受结果。

结果索引包含 `invocation` 定位（事件序号和工具名）；完整读取结果时一并返回原调用参数，无需二次查询调用。索引不复制参数，调用不能证明完成。共享结果投影对 `bash`、`pwsh` 复用 Shell 渲染器的退出状态解析：即使工具派发成功，非零退出或信号终止仍算失败。调用记录缺失或仅启动后台进程时，完成状态未知。旧日志保持原解释；自然语言结论仍须由模型判断证据是否支持。

完整覆盖且证据适用时，提交并完成对应需求版本。只缺说明时走禁止工具的改写。完成情况未知时选择 `verify`；有依据的缺失或错误工作才进入有预算的定点补救。审查后重新核对新鲜度，正式提交还须核对观察到的修改状态。如实的阻塞说明或用户要求的进度回复可以结束本轮，但不关闭未完成工作。未经用户要求的中间汇报不能关闭任务。审查不可用或引用无效时失败关闭。

当前 Step 的 Steering 会使候选失效，排队到下一 Turn 的输入不会。由 TaskExecutionControl 自身暂停通知触发的回复可以在任务工具仍暂停时接受审查并交付，使用户能够看到阻塞或待确认计划，但不会完成对应需求。候选失效时，Final Gate 会先补入新的 next-Step 输入，再把控制权交还 Agent Loop。Stop 会取消 Worker 与 Reviewer。最终版本检查和正式消息追加在同一同步调用栈完成，中间没有 `await`。

## 审计与恢复

已交付回答、冻结输入、辅助请求与响应及审查结果都能从现有 Session Event 重建。按需读取记录在辅助模型调用内部，不再为每次访问单独增加事件。无效或中断审查仍保留已接收输出和报告用量；校验错误最多针对同一冻结输入修复一次，并沿用已读证据、剩余查询额度和审查截止时间，不回灌失败响应或推理。数字结论须核对统计对象和单位；Worker 写入的文档不能独立证明其中的结论。

## 模型体验

### 需要修复的回答

#### 模型看到的内容

Worker 不会在普通历史中看到被拒绝候选，只会收到选择 `rewrite`、`verify`、`continue_work` 或重新规划的简短控制提示。

#### Token 影响

Enforce 增加一次有界 Reviewer 请求，并可能增加一个替代 Worker Step；被拒绝候选只保留在审计事件中，不进入普通 Worker 历史。

#### KV Cache 影响

Reviewer 使用独立稳定前缀；纠正提示只扩展 Worker 后缀。

## 已知限制与暂缓事项

- 程序校验能证明来源和版本有效，不能证明自然语言结论一定由证据支持；在独立标注的完整率和误判率达标前，生产继续使用 Shadow。

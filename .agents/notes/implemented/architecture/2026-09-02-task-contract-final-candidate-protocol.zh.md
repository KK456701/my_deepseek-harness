# Agent Note: Task Contract 与持久 Final Candidate 提交

Status: implemented

[English](2026-09-02-task-contract-final-candidate-protocol.md) | 中文

## Problem

Worker 可能完成很长的工具循环，却仍遗漏用户请求的一部分、沿用已经被替代的方向，或在同一 Turn 的 steering 等待处理时提交回答。附加在 `assistant/message` 之后的最终 Reviewer 可以测量这个问题，却不能阻止它。只在内存中缓冲响应虽然可以防止泄漏，但进程失败时会丢失 Candidate、usage 与已观察的 stream。对话 compaction 又增加一种失败模式：有损摘要可能漏掉 Requirement，即使原始用户事件仍然持久存在。

## Decision

**活跃用户任务与对话投影分开进行事件溯源。** `ctx.taskContract` 折叠带单调 revision 和稳定 Requirement 来源的原子 `task-contract/update` 批次。它只提取已领取直接用户消息。下游 pre-Step 工作（包括 compaction）完成后，它会向该 Step 消息追加权威完整快照。系统指令、工具、权限、skills 与派生执行义务始终区别于用户 Requirement。

**最终文本使用显式延迟交付路径。** Agent loop 在每次请求尝试前发出 `agent/request-starting`，随后通过 `agent/assistant-delivery` 询问响应 chunk 应 live 发布还是进入调用方自有持久 writer。Staged 工具调用响应会在执行前提交。Staged 最终文本进入 `agent/final-candidate`；其中可选 validator 会在普通 Assistant Message append 前立即同步运行。

**Candidate 有效性使用两个 revision。** Final Gate 在请求开始时冻结 Task Contract revision 与最新 `next-step` inbox splice。Steering 和插件注入会改变 next-Step revision 并 supersede Candidate；排队到 next-Turn 的输入不会。Task update 会改变 Contract revision。Stop 使用 Turn signal 并 abort Candidate。Reviewer 成功本身还不够：task revision、next-Step revision、inbox 空状态、signal、Candidate phase 与 Reviewer attempt 必须在同步提交点仍然匹配。

**模型所有的辅助调用使用持久审计，而不是隐藏 helper。** Contract extraction、final review 与 progress observation 会记录路由、确切来源数据、原始输出、usage、耗时、校验和终态失败。`llm/audited-call` 为公共计量消费者提供一条可加总记录，但不会伪装这些调用产生了普通 Assistant Message。

**方向观察保持独立且仅 Shadow。** Progress Observer 会对照同一 Task Contract 分类已完成 Step 的证据，但不会 steering、replan 或暂停工具。Final completeness 与执行进展只共享任务状态，不共享生命周期或干预策略。

## 持久状态与恢复

Final staging 会在请求下一 Provider chunk 前写入当前 chunk，之后写入完整 Candidate、Reviewer 尝试、decision 与终态 end。Rejected 与 superseded draft 不进入对话和模型投影。恢复可以补全 decision 尾部缺失的正式回答、继续完整 Candidate、重新注入 rejected Candidate 的 correction，或 supersede 中断生成。Requirement fulfillment 只在正式回答提交后，或独立持久证据确实支持时追加。

Compaction 可以替换 surface node，但不能移除 Contract 或 staging 事件。下一个 pre-Step 投影会从原始事件重建完整 Contract，并明确覆盖摘要细节。Snapshot 限额会明确失败，而不会丢掉开放 Requirement。

## Alternatives considered

- **仅通过提示让 Worker 自检**：使用产生遗漏的同一 Worker 与上下文，无法阻止竞态中的陈旧提交，也不产生独立测量。
- **只在 `agent/turn-stopping` 审查已提交回答**：适合 Shadow 校准，但无法 enforce，因为普通 Assistant Message 已经公开并进入模型历史。
- **只在内存中保存 Candidate chunk**：可以避免 draft 投影，但违反请求可重建与崩溃恢复保证。
- **把运行期间每条消息都视为 steering**：会因普通 queued follow-up 错误使 Candidate 失效，并混淆用户、插件与取消语义。
- **把进展干预放进 Final Gate**：会耦合证据、时序与发布门槛不同的两个分类器，使误报更难隔离。
- **异步 packed chunk write**：可以减少事件数，但仍保留未提交丢失窗口。第一版逐 chunk 持久 append；存储密度交给 Session 压缩处理。

## Consequences

Enforce 模式会增加 Reviewer 延迟、模型 usage 与持久 draft 存储。跨 Provider review 会发送用户来源、Contract 状态、证据与 Candidate，因此需要明确授权。Session vocabulary 会增长，但不需要格式版本升级，因为当前 reader 知道这些 required event type；更旧的外部预发布 reader 不属于兼容目标。

普通 Agent 行为仍保持 live，只有 delivery 插件显式启用时才变化。Shadow review 不延迟 `turn/end`。Progress intervention 在 precision、recall、F1、误报与发现延迟达到门槛前保持不可用。无密钥 Loader snapshot 与 package tests 固定 staging 不泄漏、revision guard 提交、提交后 fulfillment、compaction replay、后台 Shadow 行为和加法 usage 计量。

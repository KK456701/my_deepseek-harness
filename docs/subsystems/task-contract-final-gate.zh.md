# Task Contract、Final Gate 与 Progress Observer

[English](task-contract-final-gate.md) | 中文

这个实验子系统使用三个辅助模型节点分别判断：解析真实用户需求变化、检查 Worker Step 的进展，以及在交付前审查最终候选。确定性的执行控制器在 DSH 现有工具派发点落实通过校验的暂停。在语义判断完成校准前，这些包保持私有且需要显式启用。

## 组件

| 包 | 职责 | 干预方式 |
|---|---|---|
| `experimental/task-contract` | 输入账本与版本化需求 | Shadow 或 fail-closed 变更解析 |
| `experimental/final-completeness-gate` | Candidate staging、最终回答语义审查、同步提交 guard | Shadow 或 enforce |
| `experimental/progress-integrity-observer` | 事件与真实执行时间窗口的进展判断 | Shadow 或强制观察等待 |
| `experimental/task-execution-control` | 确定性暂停、补救预算与派发回执 | Shadow 或强制工具守卫 |

可运行的无密钥组合位于 [`examples/headless-agent/task-contract.cordis.snapshot.yml`](../../examples/headless-agent/task-contract.cordis.snapshot.yml)。它仅为确定性证明协议而让 Final Gate 使用 enforce；产品发布仍然必须先经过 Shadow。

## 输入语义

`steer` 进入 `next-step`，改变 `nextStepRevision`，并使请求开始早于该 splice 的 Candidate 失效。`queue` 与 follow-up 进入 `next-turn`，不会使当前 Candidate 失效。Stop 会中止 Turn signal、活跃模型请求、Reviewer 与可取消工具，并把 Candidate 记录为 aborted 而不是 rejected。

真实用户消息在解析前写入 `task-contract/input`，即使结果为空或失败也保留。一个模型调用只建议 `add`、`revise` 和 `cancel`；完整批次先验证，再通过 CAS 追加。纠正只重新打开目标版本并清除旧完成证据，其他需求与已取消状态保持不变。

最新 `plan/review-approved` 事件直接提供批准计划原文和来源，不再调用计划验收项提取模型。助手建议在批准前仍只是参考。用户明确询问进度时的中间回复，或如实的真实阻塞，可以发送但不关闭未完成需求。Worker 自行编写的进度汇报不能结束用户要求完整交付的工作；工作验证、回答覆盖和是否完成开放需求分别判断。

## Pre-Step 准入与压缩

独立用户问题保留不同 Requirement ID 和运行时生成的 `UserSourceRef`，包括一个总交付下明确列出的多个子问题。用户要求检查、运行、生成或核实时，即使交付物是文字报告，也使用 `execution`。解析模型不填写来源；程序把通过校验的每项变化绑定到当前完整用户消息及其 UTF-16 区间。模型也不填写 revision、任务 ID、完成状态或调用 ID。旧合并记录继续由 legacy projector 回放，所有新记录使用格式版本 3。

下游 `agent/pre-step` 工作完成后，Task Contract 保存新领取的真实用户消息，并在 Worker 请求前调用需求变更解析。没有新的真实用户消息就不调用。解析请求在 Worker 历史之外审计，有效批次会在 Worker 开始前提交。

Compaction 会改变模型可见对话 surface，但保留原始 Session 事件。因此需求清单从 `task-contract/input` 和 `task-contract/update` 重建，不依赖有损摘要。

系统提示词、工具 Schema、权限、Skill catalog 和其他 runtime context 都不是 Requirement，继续由原有插件独立组装或恢复。启用后，Task Contract 会追加一份精简快照：待完成、已完成、已取消需求和用户正式批准的完整计划；不包含来源、证据和旧版本。内容未变化且仍保留时不重复追加；压缩遮蔽后，下一次请求重新注入当前投影。append-only 需求清单仍是权威数据。

## Candidate 协议

```text
agent/request-starting
  freeze CandidateBasis(requirementRevision, inputRevision, approvedPlanSeq, incarnation, nextStepRevision)
agent/assistant-delivery
  final-draft/start
  provider chunk -> final-draft/chunk before reading the next chunk
  final-draft/candidate
agent/final-candidate
  verify frozen basis and empty next-step inbox
  final-review/input -> final-draft/review-start -> audited Reviewer -> review-result
  commit | rewrite | continue_work | replan
  synchronous revision guard -> assistant/message -> fulfilled updates
  final-draft/end
```

Basis 在请求组装前冻结，而不是输出后读取；重试会冻结新的替换 basis。Steering、插件注入、Contract update 或 Stop 都会中止活跃 Reviewer。Steering 产生 `superseded`，Stop 产生 `aborted`，Reviewer 不同意产生 `rejected`。Superseded Candidate 不占用 rewrite 次数，并且只会在补入新的 next-Step 输入后向 Agent Loop 返回 `continue`。

Reviewer 接收一份与全部未取消需求有关的用户原文、当前未取消需求、可选的批准计划原文、结果证据和稳定候选段落。每个未取消需求（包括已完成项）按当前版本检查一次；执行完成必须引用成功结果事件，回答覆盖必须引用候选段落。真实阻塞可以允许回复但不完成需求；由 TaskExecutionControl 自身暂停通知触发的回复可以在任务工具仍暂停时通过审查。Reviewer 文字不会授予工具权限。

只有 task revision、next-Step revision、inbox 空状态、Turn signal、Candidate phase 与 Reviewer attempt 全部仍匹配，`commit` 才会成为正式回答。Validation 与 `assistant/message` append 之间没有 `await`。Fulfilled update 只在该 append 后发生；rejected、superseded 或 aborted draft 不能关闭 Requirement。

工具调用响应会进入持久 staging，但绕过最终文本审查。其 Assistant Message 必须在工具关系执行前提交。普通 steering 无法回滚已经开始的副作用；Stop 是明确取消路径。

## 恢复、计量与隐私

`FrozenReviewInput.version = 5` 标识使用精简证据索引的逐项审查。`FinalReviewResult` 包含回复类型、每个未取消需求的回答／工作状态、遗漏的计划原文、无证据段落和简短原因。运行时校验身份、版本、段落 ID、计划子串及结果事件是否成功后推导下一步动作。成功结果仍不能证明语义相关性，这部分继续由 Reviewer 判断。旧输入仍可审计，但不能批准版本 5 候选。

Staging 生命周期可以重建 generating、awaiting review、reviewing、awaiting user choice、awaiting commit、committed、rejected、superseded 与 aborted phase。恢复会补全缺失终态记录、继续审查完整但未审 Candidate、补注入缺失修正，或 supersede 中断生成。Attempt 身份和 revision 检查会丢弃迟到结果。

需求变更解析、Reviewer 与 Observer 调用使用 `llm/audited-call`。Token Meter 与 Session Stats 对这些请求只统计一次；已提交 staging chunks 可以重建正式响应，不会重复 Worker usage。Candidate、Session、输出、证据与重试配额均 fail-closed。

每 Turn 的 Candidate 次数配额只统计最终回答尝试。工具调用 Step 继续受 staging 字节配额约束，但不占用最终回答次数。

Enforce 默认在交付前暂存候选，因此被拒绝草稿不会进入普通对话投影。Shadow 无法拦截交付，只能审查已经正式写入的 `assistant/message`，并且不会重新分类聊天行。跨 Provider Reviewer 会收到原始用户来源、Contract 状态、证据与 Candidate，因此必须显式配置。

实际工具入口前，Enforce 会拒绝旧 Worker 请求的所有未启动任务工具，只要真实 next-Step 输入仍待处理或尚未进入该请求。Next-Turn 排队不触发此屏障。解析失败一直保留为未解决，直到存在成功判断；仅有原始输入记录不能证明成功。

Reviewer 版本 8 引用精确回答片段，区分已验证、完成情况未知、缺失和错误工作。未知情况走只读 `verify`，不盲目重做；影响不明的核验需要精确单次审批。文件版本与保守工作区修改检查使过期证据失效，审查后再次核对。未观察到的外部状态不在保证范围内。批准计划带需求版本基线，后续内容变化须结合最新用户纠正核对。

## Progress Observer

Observer 在出现三次完全相同的调用与结果、三个相邻任务工具真实失败、结果不变的 `A-B-A-B-A-B` 排列，或真实执行五分钟且至少产生三个任务工具结果后调用。普通任务长度、同一工具使用不同参数或得到不同结果、单次失败都不会调用模型。时间窗口从 Turn 开始、带真实用户来源的需求更新、正式计划批准或上次有效 `progress=yes` 重新计算；审批等待、执行暂停和 Observer 自身耗时不计入。初始输入只保留选中窗口的精简索引；私有 `session_event_search/read` 只能按需读取这些冻结事件，不进入 Worker 工具目录。有效 `yes` 必须引用至少一个真实结果并重置窗口；Enforce 下 `no` 或任一风险立即暂停，`uncertain` 再执行五分钟后复查，连续十分钟没有确认进展则暂停。

精确重复由程序确定：工具名、深度稳定键排序后的参数、最终结果或错误必须全部一致，并且中间没有直接用户消息。第三个相同结果会加入提醒；第四次仍不变的调用会在工具实现启动前被拒绝。Observer 决定机械可疑序列是否仍有进展或需要重规划；`repeated-loop` 引用输入中的重复调用／结果对，`off-track` 与 `critical-assumption` 在 Enforce 中也会暂停任务工具。每个判断绑定触发时捕获的需求和输入版本，后续输入会使旧判断过期。TaskExecutionControl 默认另外设置单 Turn 80 次任务工具的派发保险丝；拥有独立总预算的隔离评测可以设为 `false`，生产继续使用有界值。Worker Step 数和普通 Turn 时长不设总上限。补救仍默认限制为 2 个 Worker Step、6 次任务派发和 120 秒。控制器不调用授权模型，也不替代 DSH 沙箱和审批策略。

对所请求活跃目标的可信轮询由 Guard 与 Observer 共用的运行时策略排除机械完全重复触发。终态、失败、缺失或不匹配的目标元数据仍采用严格规则。语义时间窗口继续有效。

## 发布门槛

Bundle 默认采用 Shadow。Enforce 需要部署方显式选择；依赖模型的判断不构成任务完整性保证。

## 辅助请求策略

共享辅助审计按 `callId` 区分已准备请求、派发入口、顺序 Provider 分段、终态响应与程序校验。流式持久化沿用 Session 批处理，输出对 Worker 隐藏。[UI 插件](../../packages/experimental/ui-task-review/README.md) 将需求变更解析放在 `before-step`、进度检查放在 `after-step`、Enforce 最终审查放在 `before-delivery`；Shadow 审查仍位于 `after-delivery`。定向筛查使用 `scope=evaluation`，不伪造对话事件。

三个辅助判断使用各自的中文系统指令、稳定 JSON Schema 前缀和类型化投影，不开放任务操作工具。需求变更解析使用投影版本 12（解析输入版本 5），只发送当前一条用户消息、精简后的未取消需求，以及存在时的一份最新批准计划；Web 实验装配使用 Low 推理、4,096 Token 输出上限和 30 秒超时，Reviewer 与 Observer 保持各自配置的 High。Reviewer 与 Observer 可以使用私有冻结事件查询 Schema，但不能读取本次准入集合之外的事件。来源日志与冻结审查记录继续完整保存，模型输入排除 Worker 推理及重复正文。请求元数据标识模板哈希、投影版本、生命周期位置和尝试序号。校验可以修复一次，超时、输出耗尽和取消不原样自动重试。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxprogressintegrityobserver--progressintegrityobserver"></a>

### `ctx.progressIntegrityObserver` — `ProgressIntegrityObserver`

Serial per-Agent observer; Enforce pauses after a validated event-triggered verdict.

```ts cordis-catalog
/**
 * Wait until already queued observations settle.
 * @param agent Root Agent whose observation queue must become idle.
 */
async whenSettled(agent: Agent): Promise<void>
```

Types: [Agent](core.md)

Source: [`packages/experimental/progress-integrity-observer/src/index.ts:128`](../../packages/experimental/progress-integrity-observer/src/index.ts)

<a id="ctxtaskcontract--taskcontractservice"></a>

### `ctx.taskContract` — `TaskContractService`

Durable owner of the Session requirement ledger.

```ts cordis-catalog
/**
 * Read current requirements and the latest formal plan approval.
 * @param session Session whose append-only events are projected.
 * @returns Current requirement ledger projection.
 */
snapshot(session: Session): TaskContractSnapshot

/**
 * Select source messages for uncancelled requirements plus newly received input in a delivery Turn.
 * @param snapshot Current requirement ledger projection.
 * @param turn Delivery Turn whose newly received input remains relevant.
 * @returns Relevant immutable user-input records.
 */
originalInputs(snapshot: TaskContractSnapshot, turn: number): readonly RequirementInputRecord[]

/**
 * Read the latest next-step steering sequence; next-turn queue entries are excluded.
 * @param session Session containing steering events.
 * @returns Sequence number, or -1 when no next-step steering exists.
 */
nextStepRevision(session: Session): number

/**
 * Append one validated update batch with compare-and-swap revision semantics.
 * @param session Session that owns the requirement ledger.
 * @param baseRevision Revision captured before model dispatch.
 * @param sourceMessageIds User messages the parser was allowed to cite.
 * @param updates Validated requirement changes to append.
 * @returns Resulting ledger revision.
 */
update(session: Session, baseRevision: number, sourceMessageIds: readonly MessageId[], updates: readonly RequirementUpdate[]): number
```

Types: [MessageId](llm-streaming.md) · [Session](session.md)

Source: [`packages/experimental/task-contract/src/index.ts:65`](../../packages/experimental/task-contract/src/index.ts)

<a id="ctxtaskexecutioncontrol--taskexecutioncontrol"></a>

### `ctx.taskExecutionControl` — `TaskExecutionControl`

Coordinates Gate and Observer holds at the existing tool execution point.

```ts cordis-catalog
/**
 * Reconstruct the latest Session execution state.
 * @param agent Agent whose Session owns the execution state.
 * @returns Latest persisted state or the initial running state.
 */
snapshot(agent: Agent): TaskExecutionSnapshot

/**
 * Enter repair or pause without resetting its budget.
 * @param agent Agent whose task-tool execution is restricted.
 * @param mode Repair or hold mode to enter.
 * @param reason User-visible reason for the restriction.
 */
restrict(agent: Agent, mode: Exclude<TaskExecutionMode, 'running'>, reason: string): void

/**
 * Register the observation barrier for the next task-tool dispatch.
 * @param agent Agent whose next dispatch must wait.
 * @param observation Promise for the latest required observation.
 */
waitForObservation(agent: Agent, observation: Promise<void>): void

/**
 * Release an answer-repair restriction after the Reviewer accepts the replacement.
 * @param agent Agent whose accepted repair resumes ordinary execution.
 */
finishRepair(agent: Agent): void

/**
 * Check restrictions in the synchronous final commit callback.
 * @param agent Agent attempting to commit a candidate answer.
 * @returns Whether deterministic execution state permits commit.
 */
canCommit(agent: Agent): boolean

/**
 * Register a provider-owned read-only recovery query.
 * @param name Tool name whose unknown dispatch can be queried.
 * @param probe Provider-owned status query implementation.
 * @returns Registration disposer.
 */
registerRecoveryProbe(name: string, probe: RecoveryProbe): () => void

/**
 * Verify one unknown call without reopening general Worker tools.
 * @param agent Agent whose Session contains the unmatched dispatch.
 * @param callId Dispatch identity to query.
 * @param signal Caller cancellation signal.
 * @returns Whether the provider confirmed that the dispatch settled.
 */
async verifyUnknown(agent: Agent, callId: CallId, signal: AbortSignal): Promise<boolean>
```

Types: [Agent](core.md) · [CallId](llm-streaming.md)

Source: [`packages/experimental/task-execution-control/src/index.ts:35`](../../packages/experimental/task-execution-control/src/index.ts)
<!-- END GENERATED cordis-surface -->

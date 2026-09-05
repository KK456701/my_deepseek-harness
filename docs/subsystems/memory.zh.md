# Profile 长期记忆

[English](memory.md) | 中文

记忆子系统从已完成的交互式 Session 中提取 task-first 可复用证据，将其归并为不可变 Markdown generation，注入高密度摘要，并提供窄化 lexical recall 工具。一个 profile 对应一个共享记忆空间；workspace 和 Session 标识只作为 provenance，不构成授权 scope。

## Capability 角色

`MemoryService` 是 profile 与 Session 控制、实时运行参数、带 lease 的 prompt snapshot、模型 recall、generation 浏览、语义记忆条目、显式 remember/update/forget note、手动扫描或归并、reset 和 quarantine retry 的公共接口。语义条目只能是校验后的 summary bullet 或完整 Task Group；update/delete 使用当前 generation、行区间和内容哈希并生成结构化 note，不修改已发布文件。`MemoryPipelineStore` 仅供 maintenance 使用，拥有 claim、attempt、audit 持久化、source-selection diff、staging handle、generation 校验和 fenced 发布。`MemoryMaintenanceService` 拥有合并调度和 quiescent disposal。Prompt、Remote 和 UI Consumer 只能解析 `MemoryService`。

依赖方向是 `memory-local → memory-pipeline-store ← memory-scheduler → memory-maintenance ← memory-maintenance-triggers`。本地 Provider 实现面向存储的 Service，但不调用模型；Scheduler 只消费不透明 Store handle，不导入 SQLite、pointer、Git 或 generation 文件系统实现。

## 证据与 generation

Phase 1 冻结有效 Session surface，排除 fork seed 历史和被替换节点，将工具与有效结果配对，并为每个 source range 产生一份多任务 Stage 1 结果。字段级 secret redaction 在 request audit 前和模型输出后执行。每个任务保留 outcome、scope、用户近似原话、偏好强度、失败纠正、命令、路径、环境条件和验证；弱推断停留在 rollout evidence。

Codex 后端消费私有 `CodexStructuredRunner`，每个阶段分别冻结模型、档位和 schema。Phase 1 返回任务级 JSON 证据；Phase 2 返回完整摘要、手册、Skill 内容及来源与 note 分区，Store 写入和校验文件。准确 app-server 请求在 dispatch 前审计，最终 JSON 在应用前审计。观察到工具调用会拒绝 attempt，不保留工具 payload 或推理。可选 LLM 后端保留私有五工具 maintenance Session。两条路径均执行来源闭包、规范 Markdown、secret、容量和发布 fencing 校验。

State 数据库拥有 source range、policy generation、lease、retry、audit payload、note、usage、reset watermark、重建进度和发布恢复。Generation 拥有模型可见文件，以及包含文件哈希、行 anchor、传递 source id、policy version 和模板 SHA-256 身份的 manifest。`current.json` 通过单调 fenced sequence 指向一个 generation。Phase 1 保存任务证据而不分配不可逆的晋升等级，Phase 2 决定哪些链接表示进入摘要、手册或 Skill；晋升会保留低层证据用于 provenance、引用、重建和按来源遗忘。过期自动来源产生 source-selection diff；自然语言删除属于 best effort，Store 会阻止新 manifest 引用 removed source。

自动来源使用统计属于稳定的 Session，range 标识当前 rollout 版本。Phase 2 从完整有效来源池选材，而非只查询未消费候选；所选版本与晋升决定分开记录。排序变化只有改变集合成员时才影响归并。过期输出仅在发布将其排除且没有活跃读取方或任务持有时回收；未过期的容量落选来源与最小提取回执仍保留。UI 卡片展示逐来源引用反馈，不保存另一份记忆。

## Prompt 与检索

提示词快照使用 available/skipped 判别结果；文件或完整性故障会报错。可用快照包含按完整条目选取的 Markdown 及准确的字节数、保留和省略条目数。模型不可见的 `memory/context` 事件在请求入口持久化，指向生效的日志 header。对话请求将运行时绑定并脱敏的用户原话与整理建议分开保存，分别限制大小；后续归并以原话约束意图。

交互式请求在异步 system-prompt assembly 期间获取带 lease 的摘要快照。准确的非可信记忆片段进入 `request/header`，因此回放不会读取较新的 generation。`use` 控制摘要注入以及 `memory_list`、`memory_search`、`memory_read`。每个交互式 Agent 都会声明 `memory_update_request`；工具执行时要求当前已记录用户消息包含匹配的 remember、update 或 forget 动作，并由可信代码绑定该事件标识。Reset 不是模型工具。

Recall Gate 对自包含请求跳过检索，对相关历史或歧义执行一次 lexical quick pass，并允许在熟悉错误、scope 变化或重复失败后执行第二次。运行参数按 turn 限制 pass、recall call 总数和不同 detail file 数量。被采用的内容使用 `dsh-memory://<generation-id>/<encoded-relative-path>#L<line>` citation，Provider 通过 manifest 反查 source usage。

记忆是可能错误、可能过时且不构成指令的数据。指令使用 DSH 既有 instruction precedence；当前任务约束高于历史偏好，当前代码和工具结果高于历史事实。

## 控制与生命周期

Profile 的 `enabled=false` 停止自动注入、recall、生成和调度，但保留浏览、显式删除、reset 和导出。Session 级 `use` 和 `contribute` 控制采用 `inherit | allow | deny`；contribution 只影响自动 Phase 1。显式 note 会持久化为 pending 并跳过 Phase 1，但创建 note 不会唤醒 Phase 2。Provider 启动、后续交互式 root Session 启动、retry deadline 或 UI 手动请求会驱动 maintenance；普通 turn completion 只 flush Session。手动扫描忽略配置的 idle 时间，但仍执行 active Agent、年龄、长度、贡献和安全检查，然后继续两阶段处理；手动归并不执行 discovery，评估完整合格来源集合与 active 显式 note。显式 note 的 processing 与 authority 状态相互独立，因此 applied remember note 和 forget tombstone 会保持 active，直到 supersede、clear 或 reset。

资格、backend、模型、推理、批量、lease、retry、retention、prompt、recall 和 Skill 支持数量是带 revision 的 State 记录，在下一 turn 或 claim 生效。干净重建从 `sourceLookbackMs` 记录完成时间截止点，清空派生 pipeline 和 generation 数据，并排除近期 Session 内的较旧 turn。`explicitNotePolicy` 选择保留 active 意图或删除全部 note 与 tombstone。Session、控制、参数和 reset 水位保留。活跃 Session 等待，重启后截止点和 cursor 不变。来源决策只保留正式记忆需要的证据。User reset 则压制 reset 前历史。

`MemoryRuntimeSettingsValues.disableOnExternalContext` 是布尔值，默认 false。开启时，匹配 `externalToolPrefixes` 的调用使所属冻结范围在提取前被排除；关闭时，普通流程保留用户直接证据和脱敏后的 external-untrusted 工具结果，不改变显式 note 资格。修改影响后续 claim；已消费的空结果范围需要重建才能重新评估。

[功能决策](../../.agents/notes/proposed/feature/2026-09-01-profile-long-term-memory.md)规定 generation、provenance、隔离和恢复的设计理由。包级配置及失败行为见 [`packages/memory` 包族](../../packages/memory/README.md)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmemory--memoryservice-abstract-seam"></a>

### `ctx.memory` — `MemoryService` (abstract seam)

Public memory operations available to prompt, Remote, and UI consumers.

```ts cordis-catalog
/**
 * Read the current profile-level memory state.
 * @returns Current profile-level state.
 */
abstract getProfileState(): Promise<MemoryProfileState>

/**
 * Apply revision-checked profile enable and default-control switches.
 * @param expectedRevision - Profile control revision observed by the caller.
 * @param patch - Switches to replace.
 * @returns Complete committed profile state.
 */
abstract updateProfileControls(expectedRevision: number, patch: MemoryProfileControlPatch): Promise<MemoryProfileState>

/**
 * Read the effective profile-wide scheduler settings.
 * @returns Complete settings and their optimistic revision.
 */
abstract getRuntimeSettings(): Promise<MemoryRuntimeSettings>

/**
 * Apply an optimistic live scheduler-settings update.
 * @param expectedRevision - Revision observed by the caller.
 * @param patch - Values to replace; omitted values remain unchanged.
 * @returns Complete committed settings.
 */
abstract updateRuntimeSettings( expectedRevision: number, patch: MemoryRuntimeSettingsPatch, ): Promise<MemoryRuntimeSettings>

/**
 * Return explicit controls and their revision for one Session.
 * @param sessionId - Interactive Session to inspect.
 * @returns Current revisioned controls.
 */
abstract getSessionControls(sessionId: SessionId): Promise<SessionMemoryControls>

/**
 * Apply an optimistic Session-control update.
 * @param sessionId - Interactive Session to update.
 * @param expectedRevision - Revision observed by the caller.
 * @param patch - Explicit control values to replace.
 * @returns Complete committed controls.
 */
abstract setSessionControls( sessionId: SessionId, expectedRevision: number, patch: SessionMemoryControlsPatch, ): Promise<SessionMemoryControls>

/**
 * Pin the current prompt summary when injection is enabled and a generation exists.
 * @param request - Session identity, byte limit, and lease owner.
 * @returns Leased complete-item summary with byte/item counts, or a reasoned skip. Read and integrity failures reject.
 */
abstract acquirePromptSnapshot(request: MemoryPromptSnapshotRequest): Promise<MemoryPromptSnapshotResult>

/**
 * Release an acquired generation read lease; repeated release is harmless.
 * @param leaseId - Lease returned with a prompt snapshot.
 */
abstract releaseReadLease(leaseId: MemoryReadLeaseId): Promise<void>

/**
 * List files from one immutable generation.
 * @param request - Generation, cursor, and page limit.
 * @returns Stable bounded file page.
 */
abstract listGenerationTree(request: MemoryTreeRequest): Promise<MemoryTreePage>

/**
 * Read a bounded UTF-8 range from one generation file.
 * @param request - Generation, verified relative path, offset, and byte limit.
 * @returns Verified file segment and continuation offset.
 */
abstract readGenerationFile(request: MemoryFileReadRequest): Promise<MemoryFileReadResult>

/**
 * List semantic items derived from verified summary and catalog Markdown.
 * @param request - Generation, cursor, and bounded page selection.
 * @returns Stable item page and deduplicated per-source citation feedback; legacy generations return no editable items.
 */
abstract listMemoryItems(request: MemoryItemListRequest): Promise<MemoryItemPage>

/**
 * Submit one explicit new memory without editing an immutable generation.
 * @param request - Exact user-authored memory text.
 * @returns Durable pending consolidation note.
 */
abstract rememberMemory(request: RememberMemoryRequest): Promise<AdHocNote>

/**
 * Submit a revision-safe replacement for one semantic memory item.
 * @param request - Verified item target and replacement text.
 * @returns Durable pending consolidation note.
 */
abstract updateMemoryItem(request: UpdateMemoryItemRequest): Promise<AdHocNote>

/**
 * Submit a revision-safe deletion for one semantic memory item.
 * @param request - Verified current item target.
 * @returns Durable active forget note.
 */
abstract deleteMemoryItem(request: DeleteMemoryItemRequest): Promise<AdHocNote>

/**
 * List the current memory catalog for a Session whose `use` control allows recall.
 * @param request - Calling Session and result limit.
 * @returns Stable catalog hits with citations.
 */
abstract listMemory(request: MemoryListRequest): Promise<readonly MemorySearchHit[]>

/**
 * Search the current generation with deterministic lexical matching.
 * @param request - Calling Session, query, and result limit.
 * @returns Authorized ranked hits.
 */
abstract searchMemory(request: MemorySearchRequest): Promise<readonly MemorySearchHit[]>

/**
 * Read one current-generation memory file for an authorized Session.
 * @param request - Calling Session, verified path, and byte limit.
 * @returns Verified bounded file content.
 */
abstract readMemory(request: MemoryReadRequest): Promise<MemoryFileReadResult>

/**
 * List user-authored consolidation requests.
 * @param request - Status, cursor, and page limit.
 * @returns Stable bounded note page.
 */
abstract listAdHocNotes(request: AdHocNoteListRequest): Promise<AdHocNotePage>

/**
 * Persist a user-authored consolidation request.
 * @param request - Exact user text and optional superseded note.
 * @returns Persisted revisioned note.
 */
abstract submitAdHocNote(request: SubmitAdHocNoteRequest): Promise<AdHocNote>

/**
 * Persist one explicitly requested conversation change with runtime-bound source identity.
 * @param request - User-authorized operation and trusted current-turn binding.
 * @returns Persisted dual-state note.
 */
abstract submitConversationMemory(request: SubmitConversationMemoryRequest): Promise<AdHocNote>

/**
 * Wake a bounded history scan that ignores only the configured idle delay.
 * Active, unsafe, ineligible, or out-of-age Sessions remain excluded. Discovered
 * ranges continue through Phase 1 and Phase 2 asynchronously.
 * @returns After the manual scan wake has been delivered; pipeline completion remains asynchronous.
 */
abstract requestScanAndConsolidation(): Promise<void>

/**
 * Delete derived state and rebuild eligible completed turns inside a frozen time window.
 * @param request - Destructive confirmation, lookback duration, and explicit-note retention policy.
 * @returns Durable rebuild state created before filesystem cleanup begins.
 */
abstract startCleanPolicyRebuild(request: StartCleanPolicyRebuildRequest): Promise<MemoryRebuild>

/**
 * Wake consolidation for already durable candidates and explicit notes.
 * @returns After the manual wake has been delivered; publication remains asynchronous.
 */
abstract requestConsolidation(): Promise<void>

/**
 * List source and consolidation ranges awaiting an explicit retry.
 * @param request - Cursor and page limit.
 * @returns Stable bounded quarantine page.
 */
abstract listQuarantines(request: MemoryQuarantineListRequest): Promise<MemoryQuarantinePage>

/**
 * Requeue one bounded quarantined source or consolidation range.
 * @param id - Quarantine identity returned by {@link listQuarantines}.
 */
abstract retryQuarantine(id: QuarantineRangeId): Promise<void>

/**
 * Clear generated memory and prevent automatic relearning from pre-reset Session history.
 * @param request - Exact destructive confirmation.
 */
abstract resetMemory(request: ResetMemoryRequest): Promise<void>
```

Types: [SessionId](core.md)

Source: [`packages/memory/memory/src/index.ts:283`](../../packages/memory/memory/src/index.ts)

<a id="ctxmemorymaintenance--memorymaintenanceservice-abstract-seam"></a>

### `ctx.memoryMaintenance` — `MemoryMaintenanceService` (abstract seam)

Coalesced scheduler driver and quiescent shutdown seam.

```ts cordis-catalog
/**
 * Coalesce a reason and arrange a scheduler pass without waiting for it.
 * @param reason - Work source that requested a pass.
 */
abstract wake(reason: MemoryWakeReason): void

/**
 * Run one bounded due-work pass using caller cancellation.
 * @param signal - Cancellation for claims and owned work.
 * @returns Counts and next wake deadline from the settled pass.
 */
abstract runDue(signal: AbortSignal): Promise<MemoryMaintenanceRun>

/**
 * Stop claims, cancel owned work, and wait until every owned operation settles.
 * @param signal - Caller deadline; settlement still completes after it aborts.
 */
abstract disposeAndDrain(signal: AbortSignal): Promise<void>
```

Source: [`packages/memory/memory-maintenance/src/index.ts:55`](../../packages/memory/memory-maintenance/src/index.ts)

<a id="ctxmemorypipelinestore--memorypipelinestore-abstract-seam"></a>

### `ctx.memoryPipelineStore` — `MemoryPipelineStore` (abstract seam)

Private persistence and publication operations consumed only by the scheduler.

```ts cordis-catalog
/**
 * Persist deployment defaults only when the profile has no scheduler settings yet.
 * @param defaults - Scheduler defaults resolved by the provider configuration.
 * @returns Effective durable settings, preserving any user-authored revision.
 */
abstract initializeRuntimeSettings(defaults: MemoryRuntimeSettingsValues): Promise<MemoryRuntimeSettings>

/**
 * Read the latest durable scheduler settings for one maintenance pass.
 * @returns Complete settings and revision.
 */
abstract getRuntimeSettings(): Promise<MemoryRuntimeSettings>

/**
 * Read frozen one-shot input.
 * @param claim - Owned claim.
 * @param workspace - Backend workspace handle.
 * @returns Bounded files and allowed source/note IDs.
 */
abstract readConsolidationInput(claim: Phase2Claim, workspace: Phase2Workspace): Promise<StructuredConsolidationInput>

/**
 * Persist dispatch request.
 * @param request - Owned claim and exact request.
 * @returns New audit identity.
 */
abstract recordPhase2Request(request: Phase2StructuredRequest): Promise<MemoryAttemptId>

/**
 * Persist final result before applying files.
 * @param result - Bounded final result and current owner.
 */
abstract recordPhase2Result(result: Phase2StructuredResult): Promise<void>

/**
 * Materialize validated files from the persisted result.
 * @param claim - Owned claim.
 * @param workspace - Current staging handle.
 * @param attemptId - Completed audit.
 */
abstract applyConsolidationResult(claim: Phase2Claim, workspace: Phase2Workspace, attemptId: MemoryAttemptId): Promise<void>

/**
 * Recover interrupted durable operations and pointer state.
 * @param signal - Cancellation for bounded recovery I/O.
 * @returns Recovery counts and whether due work remains.
 */
abstract recover(signal: AbortSignal): Promise<MemoryRecoveryResult>

/**
 * Read the unfinished clean rebuild, if one exists.
 * @returns Durable progress used to bypass ordinary age and idle discovery limits.
 */
abstract getActiveCleanRebuild(): Promise<MemoryRebuild | undefined>

/**
 * Commit one bounded all-retained discovery pass.
 * @param progress - Absolute progress counters for the currently active rebuild.
 */
abstract reportCleanRebuildDiscovery(progress: CleanRebuildDiscoveryProgress): Promise<void>

/**
 * Idempotently register completed interactive source ranges.
 * @param ranges - Frozen Session ranges discovered by the scheduler.
 * @returns Inserted and already-known counts.
 */
abstract registerSourceRanges(ranges: readonly RegisterSourceRange[]): Promise<RegisterSourceRangeResult>

/**
 * Claim one due Phase 1 job.
 * @param request - Current time, lease duration, and attempt limit.
 * @returns Owned claim, or `undefined` when none is due.
 */
abstract claimPhase1(request: Phase1ClaimRequest): Promise<Phase1Claim | undefined>

/**
 * Open one durable Phase 1 attempt.
 * @param claim - Current owned source claim.
 * @returns Durable attempt identity.
 */
abstract beginPhase1Attempt(claim: Phase1Claim): Promise<Phase1Attempt>

/**
 * Persist the exact request before network dispatch.
 * @param request - Frozen request audit and byte count.
 */
abstract recordPhase1Request(request: RecordedPhase1Request): Promise<void>

/**
 * Persist the observed result before applying candidates.
 * @param result - Complete observed result or bounded overflow prefix.
 */
abstract recordPhase1Result(result: RecordedPhase1Result): Promise<void>

/**
 * Atomically apply a validated Phase 1 outcome and source watermarks.
 * @param claim - Current owned source claim.
 * @param outcome - Validated candidates or terminal range outcome.
 */
abstract commitPhase1Outcome(claim: Phase1Claim, outcome: Phase1Outcome): Promise<void>

/**
 * Claim a frozen complete source selection or retry a due Phase 2 job.
 * @param request - Current time, lease, whole-source capacity, and attempt limits.
 * @returns Owned consolidation claim, or `undefined` when none is due.
 */
abstract claimPhase2(request: Phase2ClaimRequest): Promise<Phase2Claim | undefined>

/**
 * Create one isolated staging workspace.
 * @param claim - Current owned consolidation claim.
 * @returns Opaque rooted workspace handle and role policy.
 */
abstract createPhase2Workspace(claim: Phase2Claim): Promise<Phase2Workspace>

/**
 * Create or resume the private maintenance transcript.
 * @param claim - Current owned consolidation claim with a workspace.
 * @returns Private Session binding without its disk location.
 */
abstract openMaintenanceSession(claim: Phase2Claim): Promise<MaintenanceSessionBinding>

/**
 * Allocate a generation identity and monotonic publish sequence.
 * @param claim - Current owned consolidation claim after the Agent settles.
 * @returns Materializing generation handle.
 */
abstract allocateGeneration(claim: Phase2Claim): Promise<MaterializingGeneration>

/**
 * Validate staging output and persist an immutable prepared generation.
 * @param request - Claim, workspace, allocated generation, and transcript identity.
 * @returns Prepared immutable generation handle.
 */
abstract validateAndPrepareGeneration(request: PrepareGenerationRequest): Promise<PreparedGeneration>

/**
 * Publish and finalize one prepared generation behind a fencing check.
 * @param request - Current claim and prepared generation handle.
 * @returns Published generation identity and sequence.
 */
abstract publishGeneration(request: PublishGenerationRequest): Promise<PublishedGeneration>

/**
 * Renew a currently owned lease.
 * @param request - Phase, job, owner, current time, and lease duration.
 * @returns Renewed lease.
 */
abstract renewLease(request: RenewMemoryLeaseRequest): Promise<MemoryLease>

/**
 * Persist and classify one operational failure.
 * @param request - Owned failure identity, category, message, and optional retry deadline.
 * @returns Retry or terminal disposition committed by the Store.
 */
abstract recordFailure(request: MemoryFailureRecord): Promise<MemoryFailureDisposition>

/**
 * Perform bounded retention cleanup.
 * @param request - Current time plus row and byte limits.
 * @returns Removed audit, snapshot, generation, and byte counts.
 */
abstract prune(request: MemoryPruneRequest): Promise<MemoryPruneResult>
```

Source: [`packages/memory/memory-pipeline-store/src/index.ts:390`](../../packages/memory/memory-pipeline-store/src/index.ts)

<a id="memory-events"></a>

### `memory/*` events

<a id="memorychanged--parallel"></a>

#### `memory/changed` — parallel

A public memory baseline changed; listeners may refresh a previously read generation or profile state.

```ts cordis-catalog
/**
 * A public memory baseline changed; listeners may refresh a previously read generation or profile state.
 * @mode parallel
 * @param change - Committed change sequence and current generation identity.
 */
'memory/changed'(change: { changeSequence: number; generationId?: MemoryGenerationId }): void
```

Source: [`packages/memory/memory/src/index.ts:266`](../../packages/memory/memory/src/index.ts)

<a id="memorypipeline-work-available--parallel"></a>

#### `memory/pipeline-work-available` — parallel

Durable pipeline work became eligible; maintenance triggers may coalesce a scheduler wake.

```ts cordis-catalog
/**
 * Durable pipeline work became eligible; maintenance triggers may coalesce a scheduler wake.
 * @mode parallel
 * @param reason - Durable work category that became eligible.
 */
'memory/pipeline-work-available'(reason: { kind: 'source' | 'retry' | 'phase2' | 'ad-hoc' | 'manual-scan' | 'manual-consolidation' | 'clean-rebuild' | 'quarantine' | 'recovery' }): void
```

Source: [`packages/memory/memory-pipeline-store/src/index.ts:385`](../../packages/memory/memory-pipeline-store/src/index.ts)

<a id="memoryquota-remaining--bail"></a>

#### `memory/quota-remaining` — bail

Returns the remaining provider quota percentage when the active route exposes that telemetry.

```ts cordis-catalog
/**
 * Returns the remaining provider quota percentage when the active route exposes that telemetry.
 * @mode bail
 * @param query - Provider and model selected for a background memory call.
 */
'memory/quota-remaining'(query: MemoryQuotaQuery): number | undefined
```

Source: [`packages/memory/memory-maintenance/src/index.ts:50`](../../packages/memory/memory-maintenance/src/index.ts)

<a id="memoryruntime-settings-changed--parallel"></a>

#### `memory/runtime-settings-changed` — parallel

Profile-wide live scheduler settings committed; schedulers and management consumers must refresh.

```ts cordis-catalog
/**
 * Profile-wide live scheduler settings committed; schedulers and management consumers must refresh.
 * @mode parallel
 * @param settings - Complete committed settings and optimistic revision.
 */
'memory/runtime-settings-changed'(settings: MemoryRuntimeSettings): void
```

Source: [`packages/memory/memory/src/index.ts:278`](../../packages/memory/memory/src/index.ts)

<a id="memorysession-controls-changed--parallel"></a>

#### `memory/session-controls-changed` — parallel

Explicit controls for one Session committed; listeners may refresh prompt or scheduling policy.

```ts cordis-catalog
/**
 * Explicit controls for one Session committed; listeners may refresh prompt or scheduling policy.
 * @mode parallel
 * @param change - Session identity and complete committed controls.
 */
'memory/session-controls-changed'(change: { sessionId: SessionId; controls: SessionMemoryControls }): void
```

Types: [SessionId](core.md)

Source: [`packages/memory/memory/src/index.ts:272`](../../packages/memory/memory/src/index.ts)
<!-- END GENERATED cordis-surface -->

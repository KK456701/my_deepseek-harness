# Profile long-term memory

English | [中文](memory.zh.md)

The memory subsystem extracts task-first reusable evidence from completed interactive Sessions, consolidates it into immutable Markdown generations, injects a high-density summary, and exposes narrow lexical recall tools. One profile has one shared memory space; workspace and Session identifiers remain provenance rather than authorization scopes.

## Capability roles

`MemoryService` is the public interface for profile and Session controls, live runtime settings, leased prompt snapshots, model recall, generation browsing, semantic memory items, explicit remember/update/forget notes, manual scanning or consolidation, reset, and quarantine retry. Semantic items are verified summary bullets or complete Task Groups; update and delete requests use the current generation, line range, and content hash, then create structured notes instead of mutating published files. `MemoryPipelineStore` is private to maintenance and owns claims, attempts, audit durability, source-selection diffs, staging handles, generation validation, and fenced publication. `MemoryMaintenanceService` owns coalesced scheduling and quiescent disposal. Prompt, Remote, and UI consumers resolve only `MemoryService`.

The dependency direction is `memory-local → memory-pipeline-store ← memory-scheduler → memory-maintenance ← memory-maintenance-triggers`. The local provider implements storage-facing services without calling a model; the scheduler consumes opaque Store handles without importing SQLite, pointer, Git, or generation filesystem implementations.

## Evidence and generations

Phase 1 freezes the effective Session surface, omits fork seed history and replaced nodes, pairs tools with effective results, and emits one multi-task Stage 1 result per source range. Field-level secret redaction runs before request audit and after model output. Task sections retain outcome, scope, user wording, preference strength, failure corrections, commands, paths, environment conditions, and verification; weak inference stays in rollout evidence.

The Codex backend consumes private `CodexStructuredRunner`: each phase freezes its own model, effort, and schema. Phase 1 returns task-level JSON evidence. Phase 2 returns complete summary/manual/skill content plus source and note partitions; the Store writes and validates files. Exact app-server requests are audited before dispatch, final JSON before application. Observed tool calls reject an attempt without retaining tool payloads or reasoning. The selectable LLM backend retains a private five-tool maintenance Session. Both paths enforce source closure, canonical Markdown, secret checks, capacity, and publication fencing.

The State database owns source ranges, policy generations, leases, retries, audit payloads, notes, usage, reset watermarks, rebuild progress, and publication recovery. A generation owns the model-visible files and a manifest of file hashes, line anchors, transitive source ids, policy version, and a SHA-256 template identity. `current.json` names one generation through a monotonic fenced sequence. Phase 1 records task evidence without assigning an irreversible promotion tier; Phase 2 decides which linked representations belong in the summary, handbook, or a Skill. Promotion preserves lower-level evidence for provenance, citations, rebuilds, and source-aware forgetting. Expired automatic sources produce a source-selection diff; natural-language deletion is best effort, while the Store prevents the new manifest from citing removed sources.

The prompt snapshot is a discriminated available/skipped result; file or integrity errors reject. Available snapshots contain whole-item Markdown and exact byte/retained/omitted counts. A non-model-visible `memory/context` event is flushed at request dispatch and points to the effective logged header. Conversation notes store runtime-bound, redacted user wording separately from the draft, with independent size limits; later consolidation uses the original to constrain intent.

Automatic usage belongs to a stable Session; a range identifies its current rollout version. Phase 2 selects from the complete valid source pool, not just unconsumed candidates, and records the selected versions independently of promotion. Rank changes matter only when they change membership. Expired output is reclaimed after publication excludes it and no live reader or job holds it; unexpired capacity exclusions and minimal extraction receipts remain. UI cards expose per-source citation feedback without adding another copy of memory.

## Prompt and retrieval

An interactive request acquires a leased summary snapshot during asynchronous system-prompt assembly. The exact untrusted-memory section enters `request/header`, so replay never reads a newer generation. `use` controls summary injection and `memory_list`, `memory_search`, and `memory_read`. Every interactive Agent advertises `memory_update_request`; its execution requires a matching explicit remember, update, or forget action in the current logged user message and binds that event identity in trusted code. Reset is not a model tool.

The Recall Gate skips self-contained requests, performs a lexical quick pass for relevant history or ambiguity, and permits a second pass after a familiar error, scope change, or repeated failure. Runtime settings bound passes, total recall calls, and distinct detail files per turn. Adopted material uses `dsh-memory://<generation-id>/<encoded-relative-path>#L<line>` citations, which the provider resolves through the manifest to source usage.

Memory is fallible, potentially stale, and non-instructional data. Existing DSH instruction precedence handles instructions; current task constraints outrank historical preferences, while current code and tool results outrank remembered facts.

## Controls and lifecycle

Profile `enabled=false` stops automatic injection, recall, generation, and scheduling while retaining browsing, explicit deletion, reset, and export. Per-Session `use` and `contribute` controls use `inherit | allow | deny`; contribution affects automatic Phase 1 only. An explicit note is durably pending and skips Phase 1, but its creation does not wake Phase 2. Provider startup, a later interactive root Session startup, retry deadlines, or a manual UI request drive maintenance; ordinary turn completion only flushes the Session. Manual scan ignores the configured idle delay but retains active-Agent, age, length, contribution, and safety checks before continuing through both phases. Manual consolidation performs no discovery and evaluates the complete eligible source set plus active explicit notes. Explicit notes have independent processing and authority states, so applied remember notes and forget tombstones remain active until superseded, cleared, or reset.

Eligibility, backend, model, reasoning, batching, lease, retry, retention, prompt, recall, and Skill-support values are revisioned State records effective at the next turn or claim. Clean rebuild records a completion-time cutoff from `sourceLookbackMs`, clears derived pipeline and generation data, and excludes older turns even within recent Sessions. `explicitNotePolicy` chooses preserved active intent or removal of all notes and tombstones. Sessions, controls, settings, and reset watermarks remain. Active Sessions wait; restart retains the cutoff and cursor. Source decisions retain only evidence needed by final memory. User reset instead suppresses pre-reset history.

`MemoryRuntimeSettingsValues.disableOnExternalContext` is a boolean, defaulting to false. When true, calls matching `externalToolPrefixes` exclude their frozen range before extraction. When false, the ordinary pipeline preserves direct user evidence alongside redacted external-untrusted tool results. This does not alter explicit note eligibility. Changes affect later claims; previously consumed empty ranges require a rebuild to be reconsidered.

The [feature decision](../../.agents/notes/proposed/feature/2026-09-01-profile-long-term-memory.md) owns rationale and trade-offs. Package configuration and failure behavior live in the [`packages/memory` family](../../packages/memory/README.md).

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

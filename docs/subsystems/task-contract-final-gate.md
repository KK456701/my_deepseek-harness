# Task Contract, Final Gate, and Progress Observer

English | [中文](task-contract-final-gate.zh.md)

This experimental subsystem uses three auxiliary model nodes for separate judgments: parse changes to direct-user requirements, assess progress after completed Worker Steps, and review a final candidate before delivery. A deterministic execution controller applies validated holds at the existing DSH tool-dispatch point. The packages remain private and opt-in while their semantic judgments are calibrated.

## Components

| Package | Responsibility | Intervention |
|---|---|---|
| `experimental/task-contract` | Claimed-input ledger and revision-bound requirements | Shadow or fail-closed change parsing |
| `experimental/final-completeness-gate` | Candidate staging, semantic final review, synchronous commit guard | Shadow or enforce |
| `experimental/progress-integrity-observer` | Event- and active-time-window progress assessment | Shadow or enforced observation barrier |
| `experimental/task-execution-control` | Deterministic holds, repair budgets and dispatch receipts | Shadow or enforcing tool guard |

The runnable keyless composition is [`examples/headless-agent/task-contract.cordis.snapshot.yml`](../../examples/headless-agent/task-contract.cordis.snapshot.yml). It uses enforce mode for the Final Gate only to prove the protocol deterministically; product rollout remains Shadow-first.

## Input semantics

`steer` enters `next-step`, changes `nextStepRevision`, and invalidates a Candidate whose request started before that splice. `queue` and follow-up input enter `next-turn`; they do not invalidate the current Candidate. Stop aborts the Turn signal, active model request, Reviewer, and cancellable tool; it records an aborted Candidate rather than a rejection.

Claimed direct-user messages enter `task-contract/input` before parsing, including empty or failed parses. One model call proposes only `add`, `revise`, and `cancel`. An entire update batch is validated before compare-and-swap append. A correction reopens only its target revision and clears the old completion proof; unrelated and cancelled requirements keep their state.

The latest `plan/review-approved` event supplies exact approved plan text and provenance without another model call. Assistant proposals remain reference material until approval. A user-requested progress reply or a truthful blocked reply may be sent without closing unfinished requirements. A Worker-authored progress summary cannot end a complete-delivery request. Work verification, answer coverage, and whether the reply completes the open set remain separate judgments.

## Pre-Step admission and compaction

Independent user questions retain separate Requirement IDs and runtime-owned `UserSourceRef` values, including subquestions named under one overall deliverable. A request to inspect, run, generate, or verify uses `execution` even when the requested output is a prose report. The parser emits no provenance: the runtime binds every accepted change to the exact complete current message and its UTF-16 range. The model also does not assign revisions, task identities, completion, or call identities. Old combined records remain replayable through the legacy projector, while all new records use format version 3.

After downstream `agent/pre-step` work completes, Task Contract records newly claimed direct-user messages and runs requirement-change parsing before the Worker request. If there is no new direct-user message, it makes no parser call. The parser request is audited outside Worker history, and a valid batch is committed before the Worker starts.

Compaction changes the model-visible conversation surface but retains raw Session events. Ledger replay therefore reconstructs current Requirements from `task-contract/input` and `task-contract/update` instead of relying on the lossy summary.

System prompt sections, tool schemas, permissions, skill catalogs, and other runtime context are not requirements. Their owning plugins assemble or reinject them independently. When enabled, Task Contract appends a compact snapshot of open, fulfilled, and cancelled requirements plus the exact approved plan. It omits provenance, evidence, and old versions. An unchanged retained snapshot is not appended again; compaction shadowing makes the next request re-inject the current projection. The append-only ledger remains authoritative.

## Candidate protocol

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

The basis is frozen before request assembly, not after output, and retries freeze a replacement basis. Steering, plugin injection, Contract updates, or Stop abort an active Reviewer. Steering produces `superseded`; Stop produces `aborted`; Reviewer disagreement produces `rejected`. Superseded Candidates do not consume rewrite allowance and always enqueue fresh next-Step input before returning `continue` to the Agent Loop.

The Reviewer receives one copy of requirement-related user originals, current uncancelled requirements, optional approved plan text, result evidence, and stable candidate paragraphs. Each uncancelled requirement, including a fulfilled one, is checked once at its current revision. Execution completion needs a successful result event; answer coverage needs a candidate paragraph. A truthful blocker may permit a reply without completing the requirement. A reply admitted from TaskExecutionControl's own pause notice may pass this review while task tools remain paused. Reviewer text never grants tool authority.

`commit` becomes formal only if task revision, next-Step revision, inbox emptiness, Turn signal, Candidate phase, and Reviewer attempt still match. Validation and `assistant/message` append have no `await` between them. Fulfilled updates occur only after that append; rejected, superseded, or aborted drafts cannot close Requirements.

Tool-call responses are staged for durability but bypass final-text review. Their Assistant Message must commit before the tool relationship executes. Ordinary steering cannot roll back a side effect that has already started; Stop is the explicit cancellation path.

## Recovery, accounting, and privacy

`FrozenReviewInput.version = 5` identifies the simplified itemized review with a compact evidence index. `FinalReviewResult` reports reply kind, one answer/work row per uncancelled requirement, exact missing plan quotes, unsupported paragraph ids, and a short reason. The runtime derives the next action after validating identities, revisions, paragraph ids, plan substrings, and result-event success. A successful result still does not prove semantic relevance; that remains a Reviewer judgment. Older review inputs remain auditable but cannot approve a version 5 candidate.

The staged lifecycle makes generating, awaiting review, reviewing, awaiting user choice, awaiting commit, committed, rejected, superseded, and aborted phases reconstructable. Recovery finishes missing terminal records, resumes a complete unreviewed Candidate, reinjects a missing correction, or supersedes an interrupted generation. Attempt identity and revision checks discard late results.

Parser, Reviewer, and Observer calls use `llm/audited-call`. Token Meter and Session Stats count those requests exactly once, while committed staging chunks reconstruct the formal response without duplicating Worker usage. Candidate, Session, output, evidence, and retry quotas fail closed.

The per-Turn candidate-count quota applies to terminal answer attempts. Tool-call Steps remain bounded by staging-byte quotas and do not consume the terminal-answer quota.

Enforce stages the default candidate before delivery, so rejected drafts remain outside ordinary conversation projection. Shadow reviews an already formal `assistant/message` because it cannot intercept delivery and never reclassifies the chat row. A cross-provider Reviewer requires explicit configuration because it receives original user sources, Contract state, evidence, and the Candidate.

Before actual tool entry, Enforce rejects every unstarted task tool from an old Worker request when real next-Step input is pending or not yet admitted to that request. Next-Turn queueing does not activate this barrier. Parsing failure stays unresolved until a successful assessment; original input records alone do not prove success.

Reviewer version 8 cites exact answer snippets and separates verified, unknown, missing and incorrect work. Unknown completion selects read-only `verify`, not blind re-execution; uncertain-effect verification needs exact-call approval. File versions and conservative workspace mutation checks invalidate stale evidence, with a recheck after review. Unobserved external state is not covered. Approved plans carry a requirement revision baseline; later content changes require reconciliation against the latest user correction.

## Progress Observer

The Observer runs after three exact call/result repetitions, three adjacent task-tool failures, an unchanged `A-B-A-B-A-B` pattern, or a five-minute active-execution window with at least three task-tool results. Ordinary task length, repeated use of one tool with different arguments or results, and a single failure do not call the model. The elapsed window restarts at Turn start, a user-sourced requirement update, formal plan approval, or the last validated `progress=yes`; approval waits, execution holds, and Observer latency do not count. The initial request contains a compact index of the selected window. Private `session_event_search/read` schemas can inspect only those frozen events and never enter the Worker catalog. A valid `yes` cites at least one real result and resets the window. `no` or any risk pauses in Enforce; `uncertain` is checked after five further active minutes, and ten active minutes without confirmed progress pauses execution.

Exact repeat detection is deterministic: tool name, deeply key-sorted arguments, and settled result or error must all match, with no intervening direct-user message. The third identical result adds a reminder; the unchanged fourth attempt is denied before the tool body starts. The Observer decides whether a mechanically suspicious run has made progress or needs replanning; `repeated-loop` cites the supplied repeated call/result pairs, while `off-track` and `critical-assumption` also hold task tools in Enforce. Each verdict stays bound to the requirement and input revisions captured at the trigger; later input marks it stale. TaskExecutionControl separately applies an 80-task-tool per-Turn safety fuse by default. An isolated evaluation with its own total budget may set the fuse to `false`; production retains a bounded value. Worker Step count and ordinary Turn duration have no total cap. Repair remains bounded to two Worker Steps, six task dispatches, and 120 seconds by default. The controller does not call an authorization model or replace DSH sandbox and approval policy.

Trusted polling of the requested active target is excluded from mechanical exact-repeat triggers by the same runtime policy in Guard and Observer. Terminal, failed, missing or mismatched target metadata stays strict. Semantic time windows still apply.

## Rollout gates

The bundle defaults to Shadow. Enforce is an explicit deployment choice; model-dependent judgments are not a guarantee of task completeness.

## Auxiliary request policy

The shared auxiliary audit separates prepared requests, dispatch entry, ordered provider chunks, terminal responses, and consumer assessments by `callId`. Stream persistence uses Session batching; output is model-hidden. The [UI companion](../../packages/experimental/ui-task-review/README.md) places requirement parsing at `before-step`, progress inspection at `after-step`, and Enforce final review at `before-delivery`; Shadow review remains `after-delivery`. Fixed screening uses `scope=evaluation` rather than fabricated conversation events.

The three auxiliary judgments use role-specific Chinese system instructions, a stable JSON Schema prefix, and typed projections with no task-operation tools. Requirement parsing uses projection version 12 (parser input version 5): one current user message, compact uncancelled requirements, and one copy of the latest approved plan when present. It uses Low reasoning, a 4,096-token output ceiling, and a 30-second timeout in the experimental Web assembly; Reviewer and Observer retain their configured High effort. Reviewer and Observer may use the private frozen-event lookup schemas, which cannot see events outside the owning attempt's admitted set. The source log and frozen review record remain complete; model inputs omit Worker reasoning and repeated bodies. Request metadata identifies the template hash, projection version, lifecycle location, and attempt. Validation may repair once; timeout, output exhaustion, and cancellation do not trigger an identical automatic retry.

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

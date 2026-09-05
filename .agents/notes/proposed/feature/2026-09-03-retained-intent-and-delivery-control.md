# Agent Note: Requirement continuity and delivery review

Status: proposed

English | [中文](2026-09-03-retained-intent-and-delivery-control.zh.md)

## Problem

A long task can lose an early question, keep an obsolete requirement after a correction, repeat investigation without new evidence, or submit a fluent answer that omits work or overstates a result. Conversation history alone does not provide stable requirement identities or a mechanical point at which delivery can be rejected.

## Proposal

The experimental review bundle uses three auxiliary model nodes and one deterministic execution-control provider:

1. Requirement change parsing runs before a Worker Step only when new user messages exist. It proposes only `add`, `revise`, and `cancel` semantics. Independently answerable or verifiable subquestions remain separate changes, and requests for actual inspection or verification use `execution` even when the final deliverable is prose. The runtime binds every accepted change to the exact complete current message, validates target identities and the captured ledger revision, and then appends version 3 updates. The experimental Web assembly uses Low reasoning, a 4,096-token output ceiling, and a 30-second timeout for this parser; Reviewer and Observer remain High.
2. Progress Observer runs after three identical call/result pairs, three adjacent task-tool failures, an unchanged `A-B-A-B-A-B` call/result sequence, or a five-minute active-execution window containing at least three task-tool results. Approval waits, execution holds, and Observer latency do not count toward active time. The initial request carries a compact index of the selected Session events; the same frozen read-only adapter used by Final Reviewer exposes `session_event_search/read` only when the Observer requests full details. The Observer returns only progress, the most important risk, supporting event identities, and a short reason. Each call remains bound to the requirement and input revisions captured by its trigger; later input marks the result stale without re-running old work against new requirements.
3. Final Reviewer stages an Enforce candidate before ordinary `assistant/message` delivery. It checks each uncancelled requirement version, including already fulfilled requirements, the latest formally approved plan text, successful result events, answer paragraphs, and unsupported completion claims. A failed candidate stays outside normal Worker history while the same Turn continues through restricted rewrite, bounded work, or replanning. Shadow remains post-delivery because it cannot intercept the message.

TaskExecutionControl enforces holds and repair budgets but does not call a model or replace the existing sandbox, approval policy, or tool guard. The append-only requirement ledger remains authoritative. When enabled, a compact Worker snapshot groups open, fulfilled, and cancelled requirements and appends the exact approved plan; it excludes source coordinates, event identities, evidence identities, and historical versions. Unchanged snapshots are not re-appended, and compaction causes the current snapshot to be injected again on the next request.

Replanning and unknown-outcome holds bind the affected Agent to the deployment's resolved Plan Mode controller. Resolution checks the Agent context, the controller published behind its AgentPresets isolate, and the root Context in that order; durable mode remains Session-specific. TaskExecutionControl observes that controller's review, captures requirement and execution revisions before display, and returns to running only after the exact formal approval validates them. Generic question answers and mode toggles do not release a hold.

## Requirement state

Tool-dispatch success is distinct from command success. Reviewer version 8 freezes matching call identities with selected result events and shares the existing Shell exit-status parser with Observer failure detection. Nonzero exits and signals cannot support verified completion; background launch or missing invocation leaves completion unknown. Initial model inputs still contain only result locators, not another copy of the calls. This uses existing Session events rather than a new audit format.

Each current record contains a stable requirement identity, a content revision, current text, an `answer` or `execution` verification mode, its exact user source, lifecycle state, and any completion evidence. Revising a requirement preserves its identity, increments the revision, reopens it, and clears completion for the old revision. Cancelling changes state without deleting history. Append-only Session events retain prior versions.

Formal plan text comes directly from `plan/review-approved`; no auxiliary plan-extraction call is made. Suggestions that were not approved remain ordinary conversation content. The Reviewer may identify an unfulfilled necessary plan quote, but the runtime verifies that the quote exists in the approved plan.

## Progress and delivery

Progress means new evidence relevant to an open requirement: a new result, support or refutation of an important hypothesis, a verified artifact, a narrower diagnosis, a resolved blocker, or an answered question. A successful command without new relevant information, an unverified file edit, a build that does not reproduce the user-visible behavior, restated intent, repeated unchanged material, or another command that tests the same rejected hypothesis is not progress.

Exact repeat detection is deterministic: tool name, canonical arguments, and settled result or error must match without an intervening direct user message. The third identical pair adds a reminder; `ctx.tools.guard()` denies the unchanged fourth attempt before the tool body starts. The semantic Observer then decides whether the trigger calls for a changed approach, a blocker report, or replanning. Three adjacent failures and unchanged `A-B-A-B-A-B` sequences also dispatch the Observer. `off-track` and `critical-assumption` verdicts pause immediately. These holds are checked by the existing tool execution path.

The elapsed window begins at the current Turn start, a user-sourced requirement update, a formal plan approval, or the last validated `progress=yes`. After five active minutes and at least three completed task-tool results, the next result dispatches an observation. A validated `yes` must cite real `tool/result` evidence in that window; a failure that establishes a new diagnostic fact can support progress; a call event proves only dispatch and is rejected with one bounded repair attempt. A valid `yes` resets the window. `no` pauses immediately. `uncertain` schedules a second check after five further active minutes; ten active minutes without confirmed progress pauses execution. Any `repeated-loop`, `off-track`, or `critical-assumption` risk pauses regardless of the progress value.

The per-Turn task-tool safety fuse remains configurable and defaults to 80. Worker Step count and ordinary Turn duration have no total cap, and semantic no-progress detection belongs to Progress Observer.

Final review separates answer coverage from work verification. An answer-only requirement needs a located answer paragraph. An execution requirement needs both an appropriate paragraph or disclosed gap and successful result evidence. A user-requested progress answer or a truthful blocked answer may end the Turn without closing the requirement; a Worker-authored progress summary cannot end a complete-delivery request. Missing explanation triggers a tool-disabled rewrite; missing authorized work may continue within the repair budget; overclaim, invalid evidence, a changed direction, or required new authority pauses delivery repair or replanning. A successful repair releases its temporary execution restriction.

A reply prompted by TaskExecutionControl's own pause notice may pass final review while task tools remain paused. This exception is derived from the admitted plugin message, not Worker text. Superseding a staged candidate always provides fresh next-Step input before the Agent Loop continues.

The per-Turn candidate-count quota covers terminal answer attempts. Tool-call Steps still use the staging-byte budgets but do not consume the terminal-answer quota; otherwise an ordinary investigation can fail before reaching Final Reviewer.

The per-candidate, per-Turn, and per-Session staging byte limits all measure assembled candidate content rather than counting provider chunk wrappers again. Adjacent candidate deltas are boundedly coalesced before persistence; complete content remains replayable, while provider chunk granularity cannot change event volume or capacity admission.

The runtime validates all Requirement, paragraph, event, revision, and plan-quote references. It does not claim to prove natural-language entailment; semantic accuracy remains an evaluated model behavior.

## Audit and trajectory

Input admission is recorded at `agent/request-starting`, after real user messages enter history and outside Session event publication. Frozen result locators contain identity, outcome, tool name and an optional bounded target hint, not result previews. Full reads return result bodies with exact invocation parameters. Observer lists each call/result pair once; the original events remain available. Parser instructions consolidate overlapping rules without removing source text or changing the output schema. A validation repair retains retrieved evidence, the query allowance, and the original deadline; it does not repeat the failed reasoning. Full-conversation test metadata keeps normal conversation locations, and absent evaluation results remain unrecorded rather than inferred from Turn completion.

Every actual auxiliary dispatch has a durable call identity, role, template and input-projection versions, lifecycle location, provider output, terminal response, validation outcome, usage, and timing when reported. Requirement parser projection version 12 (input version 5) contains one user message, compact uncancelled requirements, and one copy of the latest formally approved plan when present; provenance and completion evidence stay outside the model input. Final Reviewer version 8 and Observer requests initially receive only frozen evidence indexes. Their scoped `session_event_search/read` schemas share one adapter, read only the caller-authorized event set, never enter the ordinary Worker tool catalog, and add no task-tool event. Observer advertises a closed four-field response schema and discards harmless provider-added top-level metadata before validating those owned fields, so unowned metadata cannot affect execution control or turn a valid verdict into an execution hold. The Trajectory places requirement parsing before its Step, Observer calls after the triggering result, and Enforce Final Reviewer before formal delivery. Evaluation fixtures use an evaluation location and never fabricate ordinary User, Tool, or Assistant events. Provider-returned reasoning is inspectable but is not added to Worker history.

Reviewer requests expose the configured evidence-query limit. The tool-free closing request contains frozen input and collected result data once, without assistant reasoning or native tool-call history whose tools are unavailable. DeepSeek requests JSON-object final content without lowering reasoning effort. Reasoning-only output remains a validation failure, never an accepted verdict. The original deadline, query limit and single repair still apply; unresolved gaps cannot become approval.

Old extraction, multi-task, plan-check, and model-authorization records remain readable only as legacy audit data. New code does not generate them. The compact task snapshot is derived from current ledger events and uses an ordinary snapshot-form context message rather than a new event type. Existing DSH sandbox, approval, and tool-guard behavior remains authoritative.

Incoming next-Step user feedback blocks every unstarted old-request task tool, including read-only and nested calls. Actual tool entry rechecks input admission after approval and persistence; the next Step parses the input instead of waiting inside the denied tool. Saved messages require a successful parser assessment before recovery treats them as parsed.

Evidence freshness uses existing dispatch/results, observed file versions, and conservative workspace mutation checks. Denied unstarted calls are not mutations; unknown started outcomes remain possible mutations. Generic command verification does not provide a file dependency graph or cover unobserved remote changes. Unknown completion selects read-only verification with exact-call approval for uncertain effects; supported missing or incorrect work selects targeted correction. All repair paths share the existing budget.

Answer coverage cites exact candidate snippets. Formal approval retains a requirement revision baseline, and later content changes mark the plan for reconciliation without restoring cancelled work. Trusted active-target polling is excluded from mechanical repetition by the shared Guard/Observer policy, not from semantic observation. Deterministic checks establish program rules, not model accuracy.

## Alternatives considered

The references below inform mechanisms only; no framework dependency or copied implementation is introduced. OpenHands informs result-sensitive repetition and reminder deduplication, Magentic-One informs fact-aware replanning, DeepAgents informs compact context with reachable originals, and τ²-bench informs separate environment and answer scoring. None establishes the proposed long-task accuracy claims.

| Reference | Fixed revision | License at revision |
| --- | --- | --- |
| [OpenHands StuckDetector](https://github.com/OpenHands/software-agent-sdk/blob/f47083cc370a85160f0348f32e531ee3514399e5/openhands-sdk/openhands/sdk/conversation/stuck_detector.py) | `f47083cc370a85160f0348f32e531ee3514399e5` | MIT |
| [Magentic-One orchestrator](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_magentic_one/_magentic_one_orchestrator.py) | `027ecf0a379bcc1d09956d46d12d44a3ad9cee14` | Package code: MIT; root documentation: CC-BY-4.0 |
| [DeepAgents summarization](https://github.com/langchain-ai/deepagents/blob/4e5f9350e4d77b8bf19e472e8414662d3fa59dc0/libs/deepagents/deepagents/middleware/summarization.py) | `4e5f9350e4d77b8bf19e472e8414662d3fa59dc0` | MIT |
| [τ²-bench evaluation](https://github.com/sierra-research/tau2-bench/blob/672227c6b6676edc20d57ea53b7000262aae77b9/docs/evaluation.md) | `672227c6b6676edc20d57ea53b7000262aae77b9` | MIT |

**Keep High reasoning and the larger parser response budget.** The parser only classifies three changes and returns compact JSON. Low reasoning and a 4,096-token ceiling bound classification output; Reviewer and Observer retain separately configured reasoning effort.

**Let the model return user-message identities and text ranges.** This gives the model control over provenance that the runtime already knows. The runtime instead binds every accepted change to the complete current user message and uses the captured ledger revision to reject late results.

**Omit the approved plan from parser input.** This reduces bytes but leaves references such as “follow the approved plan” unresolved. The latest formal approval is therefore included once, while unapproved suggestions and historical sources remain excluded.

**Fold requirement parsing into the Worker.** This would save a separate call but would make requirement-state updates depend on free-form Worker output and obscure their cost and failure state. An independently audited parser keeps requirement updates separate from free-form Worker output.

## Acceptance criteria

- A/B/C receive independent identities; revising B and adding D leaves A/C unchanged, and cancelling C affects only C.
- Revised requirements never inherit completion or evidence from the prior revision.
- Three identical settled calls produce one reminder, and the unchanged fourth attempt never enters the tool implementation.
- Three adjacent failures and unchanged `A-B-A-B-A-B` sequences trigger Observer; 6, 20, or more normal Steps do not trigger it by length.
- A late Observer result is archived once and never re-runs its completed Step against a newer user correction.
- New evidence, refuted hypotheses, and a narrowed diagnosis count as progress even without file writes.
- A completed operation with missing explanation produces only a rewrite; a call event without a successful result cannot prove work complete.
- A changed requirement snapshot appears in the next root Worker request, is not repeated while retained and unchanged, and is injected again after compaction shadows it; the existing sandbox and approval path is unchanged.
- Five active minutes plus three task-tool results dispatch an observation; approval waits, holds, and Observer latency do not count. Ten active minutes without validated progress pause execution.
- All three auxiliary calls appear at their actual lifecycle positions with input, provider reasoning, output, validation failure, and usage available for replay; Enforce Final Reviewer precedes formal delivery.
- Deterministic checks cover input races, assembled Loader behavior, and UI replay. The default bundle remains Shadow.
- A pause-notice response reaches the user without reopening tools, completing requirements, or producing an empty-continue Agent Loop failure.

## Risks

Runtime-owned whole-message references prove which message triggered a change, not correct semantic interpretation. Observer false positives can pause useful long investigations; its five-minute window is an explicit cost/latency trade-off rather than proof that all drift is found early. Final Reviewer false negatives can still miss an omitted idea. Keep Enforce isolated until independent evaluation meets its thresholds. Input budgets fail closed instead of dropping earlier requirements or evidence. This work does not change long-term memory, balances, skills, the production 3080 instance, or desktop startup behavior.

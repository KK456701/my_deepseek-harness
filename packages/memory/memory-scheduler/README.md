# @deepseek-ai/dsh-memory-scheduler

English | [中文](README.zh.md)

Provider for `MemoryMaintenanceService`. It consumes only `MemoryPipelineStore` for durable state and publication, plus Agent, Session, and LLM services for evidence freezing and model execution. It does not import SQLite, generation, pointer, Git, or filesystem publication implementations.

The scheduler coalesces wakeups, bounds discovery and claims, maintains leases, and drains every owned promise during unload. Every pass is an internal `ctx.jobs` record. `extractionBackend` and `consolidationBackend` select `llm` or `codex` independently. Codex requires the shared `CodexStructuredRunner` provider; a missing provider fails the pass explicitly. The consumer commits prepared requests before dispatch and final results before apply. Codex calls use task-evidence and full-generation JSON schemas, not a tool-enabled Agent. LLM consolidation retains its five-tool rooted maintenance Session.

Startup, interactive root Session startup, manual scan, and explicit pending-work consolidation may claim new pending ad-hoc notes. Manual scan runs bounded discovery while ignoring only `idleMs`; active-Agent, age, length, contribution, external-context, quota, and capacity checks remain unchanged, and newly registered ranges continue through Phase 1 and Phase 2 in the same pass. Manual consolidation skips discovery and evaluates the complete eligible source set plus authorized explicit notes. Timer and ordinary pipeline wakes may retry an already claimed note batch but cannot pull a newly saved note into Phase 2; this keeps “request saved” distinct from “formal memory published.”

Deployment configuration initializes durable settings once. Every pass reads the latest revision; one claimed operation retains coherent settings. Codex uses explicit model and reasoning effort per call; it never edits global Codex configuration. Choose `high` for extraction and `max` for consolidation when supported by the configured model. LLM `consolidationReasoningEffort: inherit` preserves the adapter default. Token limits apply to LLM calls; Codex results use the configured byte bound. A clean rebuild freezes `sourceLookbackMs` at startup, excludes older turns in otherwise recent Sessions, and persists that cutoff through restart.

`disableOnExternalContext` defaults to `false`, matching Codex's optional external-context guard. Classified tool results remain redacted, external-untrusted evidence in the normal Phase 1 pipeline; direct user requests in the same range remain eligible. When enabled, the guard rejects the whole frozen range before dispatch. `externalToolPrefixes` controls classification. Explicit notes bypass automatic extraction and are unaffected.

The remaining-quota threshold pauses a Phase 1 or Phase 2 claim when the selected route reports a percentage through `memory/quota-remaining`. Routes without quota telemetry continue normally; provider rate-limit failures still follow the durable retry policy.

Normal discovery also excludes turns completed before `now - maxSourceAgeMs`, including old prefixes of otherwise recent Sessions. This setting is separate from the frozen rebuild lookback; set both to the same duration when ongoing learning must remain within that window.

`phase1Concurrency` permits 1–8 simultaneous extraction owners and defaults to 2. `maxPhase1ClaimsPerRun` independently bounds total claims. Each worker claims only when free, keeps its own heartbeat and audit, and settles failures independently; Phase 2 waits for every launched extraction. Cancellation stops further claims and drains owned calls. Output format 2 renders raw memory from detailed task evidence and separately authored rollout summaries and slugs; recorded format-1 attempts remain format 1. Writing-template identity belongs to attempts, not source registration identity.

## Model Experience

### Background requests

#### What the model sees

Extraction receives redacted effective evidence with user and tool roles kept distinct. Codex output must reference known evidence ids, with user support for preferences and tool-result support for verified facts. Empty evidence leaves a receipt without a rollout. Consolidation compares independent sources by meaning, preserves scope and uncertainty, and returns source retain/discard decisions. Only retained evidence becomes a generation file. Runtime validation proves schema and link integrity, not semantic quality. `unexpected-tool-use` and result overflow cannot publish; invalid model output and generation validation use bounded retries.

#### Token effect

Each extraction sends one bounded evidence range. Each consolidation sends selected evidence, notes, and the baseline; unrelated interactive history is not copied into the request.

#### KV Cache effect

Background calls use independent audited requests or private maintenance Sessions. They do not enter an interactive task's prompt cache.

## Known Limitations and Deferred Work

- Natural-language promotion and conflict resolution remain model judgments; structural validation cannot guarantee semantic quality.
- When enabled, external-context rejection applies to the whole frozen range, including user messages. Admission does not make external content trustworthy.

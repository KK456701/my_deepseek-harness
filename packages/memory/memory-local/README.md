# @deepseek-ai/dsh-memory-local

English | [中文](README.zh.md)

Local provider for DSH long-term memory. It owns the SQLite pipeline state, bounded audit payloads, immutable generations, manifest validation, staging directories, read leases, and fenced `current.json` publication. It provides both the public `MemoryService` and private `MemoryPipelineStore`; it never calls a model or schedules work.

## Configuration

`root` is required and must be the active profile's absolute `profilePath('memories')`. Storage, audit, and generation safety limits are validated deployment settings. Scheduler and recall values are revisioned durable profile data with optimistic live updates. Schema versions 3 through 7 and 9 migrate incrementally to version 10. Schema 8 requires the offline, backup-first `upgradeMemoryUserText` operation with all writers stopped; it resolves originals only from already-bound user events and leaves unverifiable originals unavailable. Other versions and application ids are rejected.

## Privacy and durability

Schema 10 snapshots the prior database before incremental migration. Existing range counters aggregate once by their recorded Session identity; unknown origins are not inferred. `maxPhase2Candidates` migrates to `maxPhase2Sources`, and `phase1Concurrency` defaults to 2. Migration preserves generations, notes, controls, epoch, and policy, and dispatches no extraction. Range receipts prevent template updates or pruning from relearning unchanged history.

Phase 2 ranks the latest valid complete rollout of every eligible Session by citation count, last citation (or completion time when unused), completion time, then stable source id. `maxPhase2Sources` bounds this entire automatic set; active explicit notes have independent capacity and authority. Selected sources are emitted by id and recorded independently of the model's retain/discard choices. Legacy generations reconstruct selected inputs from the recorded baseline chain, so an adopted-only retained list cannot make previously considered evidence look new. Unchanged source versions and note content skip consolidation; rank-only changes within the same set do not rewrite files.

Expired outputs can be reclaimed only after a successful publication excludes them, without current-generation, live-read-lease, or running-job references. Merely missing Top-N does not permit deletion. Minimal source receipts and reset watermarks survive. Citation commits advance the public change sequence but neither revise memory content nor wake consolidation.

The provider creates private directories and database files where the platform honors owner permission bits. It does not encrypt data at rest. Logical deletion does not promise immediate removal from SQLite free pages, WAL files, backups, or original Session logs. Generations are immutable after publication; a read lease pins one generation while a prompt or UI read is in progress.

Codex consolidation uses private structured attempt records: the exact app-server request is committed before dispatch, and the final JSON, finish reason, exposed usage, and error are committed before file materialization. Source and note decisions must partition their frozen inputs exactly. The Store writes generated files, removes discarded evidence, and validates the generation before publication. The selectable LLM backend instead uses private maintenance Session events with durable `request/header` and terminal `turn/end`. Both audits have bounded capacity and terminal retention; ordinary Session APIs cannot enumerate them.

Explicit notes keep separate processing and authority states. Publication commits one unique disposition per claimed note only after the pointer succeeds. A confirmed clean rebuild raises the epoch, clears the pointer, and deletes derived ranges, candidates, attempts, failures, audits, jobs, staging, and generations. `sourceLookbackMs` freezes a completion cutoff; `explicitNotePolicy` chooses preserved active notes or deletion of all notes and tombstones. Original Sessions, controls, settings, and reset watermarks remain intact. The first consolidation claims all preserved active notes. User reset instead suppresses pre-reset ranges through clear watermarks.

The current generation retains raw memory and rollout summaries for provenance, citations, rebuilds, and source-aware forgetting. They are never injected as formal memory. Superseded generations and terminal pipeline payloads leave storage through bounded pruning; user reset removes the readable memory workspace while preserving the Session subsystem's original logs.

Range registration trims any prefix at or below a Session's reset watermark. A new post-reset turn cannot make earlier events eligible again.

Prompt snapshots select complete Markdown items in document order, preserving their original text, nested content, and source links. The byte budget includes the version marker, headings, separators, and reference definitions. Oversized items are omitted whole; counts accompany the snapshot. Cropping never modifies a generation. Writing-template changes alone do not invalidate a format-compatible generation; read failures remain errors rather than empty-memory results.

## Model Experience

Indirectly, through the prompt consumer and the scheduler's isolated consolidation Agent.

#### KV Cache effect

The provider does not add model-visible text. It returns a byte-bounded summary snapshot to the prompt consumer, which logs the exact injected text. Pending semantic updates and deletions are filtered before this snapshot and before recall reads, while the immutable generation remains unchanged for inspection and conflict detection.

## Known Limitations and Deferred Work

- Semantic support remains a model judgment; link validation verifies referenced sources, not the truth of generated statements.
- Logical deletion does not erase original Session history or guarantee physical erasure from database pages and backups.

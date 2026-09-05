# @deepseek-ai/dsh-memory-pipeline-store

English | [中文](README.zh.md)

Private Service Definition between the scheduler and a durable memory provider. Claims, audited attempts, staging handles, leases, validation, immutable generations, and fenced publication cross this seam as opaque branded values; no consumer receives database rows or pointer paths.

`openMaintenanceSession()` returns an opaque Session id plus a bound `flush()` barrier, not the application's `SessionPersistence` service or an audit path. The provider owns exact transcript admission and retention, while the scheduler owns Agent execution and can only wait for durability before validation and publication.

Phase 2 claims freeze the complete selected automatic source set, its content versions, the added/updated/retained/removed diff, and active authorized notes. Selection receipts are separate from model adoption decisions, so discarding a selected source does not itself enqueue another consolidation. Phase 1 attempts retain their output-format version with the exact request; new formats do not reinterpret stored results.

## Model Experience

None, as this package stores coordination state and exposes no model prompt or tool.

#### KV Cache effect

None. Scheduler-owned calls and prompt injection belong to separate consumers.

## Known Limitations and Deferred Work

- **Provider-specific durability** — this definition requires atomic CAS and fencing but does not prescribe SQLite, file locks, or remote transactions.

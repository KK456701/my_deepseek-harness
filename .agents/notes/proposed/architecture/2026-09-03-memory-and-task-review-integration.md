# Agent Note: Memory and task review on one Session protocol

Status: proposed

English | [中文](2026-09-03-memory-and-task-review-integration.zh.md)

## Problem

Profile memory and experimental task review extend the same Session, LLM, and client protocols. Deploying either implementation alone omits capabilities from the other; replacing shared files can discard request reconstruction, history classification, or delivery guards. Persisted user history must remain readable across their integration.

## Proposal

Use the rc.8 Session and stream implementation with required interactive, subagent, and maintenance purposes. Retain interrupted messages, deferred final drafts, audited auxiliary usage, and ignorable request-linked memory observations. Memory evidence excludes plugin instructions and uncommitted review drafts. Task requirements come only from direct user input, never injected memory or skills.

Keep memory's public, pipeline-store, and maintenance services separate. Keep the balance provider and privileged remote API independent of model requests. An opt-in experimental bundle composes Task Contract and Final Gate in Shadow mode with the non-intervening Progress Observer; release packages do not depend on experimental packages. Private memory consolidation does not inherit that bundle.

SQLite Session schema 18 retains rc.8 physical packing and compression and adds purpose metadata. An offline, backup-first upgrade handles known predecessor formats and rejects unknown ones. JSONL history already carrying purpose and the memory database and generations remain unchanged. Query indexes are derived and may be rebuilt without removing Session logs.

The [memory proposal](../../proposed/feature/2026-09-01-profile-long-term-memory.md), [capability audit proposal](2026-09-01-capability-owned-model-call-audits.md), and task-review decision retain their separate semantic and lifecycle responsibilities.

## Alternatives considered

**Replace one checkout with the other.** This loses independent changes and cannot preserve both Session protocols or local deployment configuration.

**Load plugins from both checkouts.** Mixed runtime versions can disagree about event decoding, generated remote types, and package identity. One build and one profile resolver must own the deployed graph.

**Enable enforced review during integration.** Existing experimental implementation does not establish the behavioral calibration required for enforced delivery. Shadow integration preserves observability without introducing answer rejection.

## Acceptance criteria

- Memory, balance, skills, model settings, and task review coexist in one real Loader composition without unresolved dependencies.
- Request reconstruction, history replay, interrupted output, draft exclusion, and exactly-once usage survive integration.
- Direct user intent is not confused with memory, plugin snapshots, or reviewer output.
- Offline migration preserves logical events, identifiers, sequence numbers, and lineage; unsupported formats fail before replacement.
- Existing memory content, active notes, control values, and reset watermarks are preserved without extraction or rebuilding.
- Isolated Web and SDK checks cover the shared event protocol before production startup.

## Risks

Shadow extraction and review add provider calls and remain model-dependent. Deployment configuration must retain route consent and independent memory settings. Physical storage changes require a consistent backup and paired code/data rollback. Historical derived indexes cannot be used to prove that raw Session data survived; preservation is checked against the source logs.

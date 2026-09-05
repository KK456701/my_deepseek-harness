# @deepseek-ai/dsh-memory

English | [中文](README.zh.md)

Public Service Definition for profile-scoped long-term memory. Prompt, Remote, and UI consumers use only `ctx.memory`; pipeline claims, model-call audits, staging workspaces, and publication are deliberately absent. The service exposes revisioned live scheduler settings so management consumers can change eligible operational values without reaching the private Store.

## Service API

`MemoryService` exposes profile state, per-session `use`/`contribute` controls, revisioned runtime settings, leased prompt snapshots, authorized lexical recall, immutable-generation browsing, verified semantic memory items, explicit remember/update/forget notes, separate manual scan and pending-work consolidation requests, a confirmed clean policy rebuild, reset, and quarantine retry. Clean rebuild deletes derived state, preserves original Sessions, controls and reset watermarks, applies the selected explicit-note retention policy, and relearns only turns within its frozen completion window. Manual scan ignores only the idle delay and continues through both phases; consolidation performs no discovery. Semantic update and delete requests carry a generation id, line range, and content hash; the Provider rejects stale targets and immediately filters a pending old item from prompt and recall. A saved note remains pending until later scheduled or manual Phase 2 work. `MemoryError.code` is stable at RPC boundaries.

`MemoryItemPage.sourceUsage` is a deduplicated set keyed by each item’s existing source ids. Each record contains a recognizable-citation count and optional last-citation time, not a precise item-use count. Browsing, prompt injection, and search/read do not increment it. Citation commits notify readers through the public change sequence without changing generation or edit revisions.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-memory-prompt`, which leases and logs the exact published summary injected into a request.

#### KV Cache effect

This definition contributes no tokens. A consumer may preserve a stable prefix while the published generation and session controls are unchanged.

## Known Limitations and Deferred Work

- **Profile-wide isolation** — workspace identity is provenance, not an authorization scope. Use separate profiles for isolated memory.

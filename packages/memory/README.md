# memory/ — profile long-term-memory capability

English | [中文](README.zh.md)

The memory family separates public browsing and prompt access, private durable pipeline operations, scheduler lifecycle, local persistence, triggers, prompt integration, and product UI. The stable dependency direction is `memory-local → pipeline-store definition ← memory-scheduler → maintenance definition ← triggers`; public consumers depend only on `memory`.

| Package | Role | Context key |
|---|---|---|
| [`memory/`](memory/README.md) | Public Service Definition | `ctx.memory` |
| [`memory-pipeline-store/`](memory-pipeline-store/README.md) | Private pipeline Store Definition | `ctx.memoryPipelineStore` |
| [`memory-maintenance/`](memory-maintenance/README.md) | Scheduler lifecycle Definition | `ctx.memoryMaintenance` |
| [`memory-staging-tools/`](memory-staging-tools/README.md) | Rooted Phase 2 filesystem and search tools | `ctx.fs`, tool registrations |
| [`memory-local/`](memory-local/README.md) | SQLite state and immutable-generation Provider | `ctx.memory`, `ctx.memoryPipelineStore` |
| [`memory-scheduler/`](memory-scheduler/README.md) | Two-phase pipeline coordinator | `ctx.memoryMaintenance` |
| [`memory-maintenance-triggers/`](memory-maintenance-triggers/README.md) | Lifecycle and durable-work wake consumer | maintenance events |
| [`memory-prompt/`](memory-prompt/README.md) | Leased summary injection Consumer | `system-prompt/assemble` |
| [`memory-remote/`](memory-remote/README.md) | Trusted Typert Remote Consumer | `remote.memory` |

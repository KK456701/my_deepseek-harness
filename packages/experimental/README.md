# experimental/ — private experimental packages

English | [中文](README.zh.md)

This group contains prototypes and internal-only Cordis plugins that use the repository's real runtime without joining an official release. Its packages are private, carry no stability or support promise, and retain the same engineering, security, documentation, lifecycle, testing, and snapshot requirements as release packages.

| Package | Role | ctx key |
|---|---|---|
| `agent-team/` | Implicit-root Agent Teams roster, durable peer mailbox, shared task DAG, and runtime coordination | `ctx.agentTeams` |
| `tool-agent-team/` | Scoped model-facing Agent Teams tools and collaboration guidance | — |
| `task-contract/` | Event-sourced current requirements and before-step requirement change parsing | `ctx.taskContract` |
| `final-completeness-gate/` | Background Shadow review and durable enforced final-answer submission | `ctx.finalCompletenessGate` |
| `progress-integrity-observer/` | Background Step progress and alignment classification | `ctx.progressIntegrityObserver` |

The [subtree rules](AGENTS.md) define dependency isolation, release exclusion, and promotion.

# @deepseek-ai/dsh-experimental-task-review-bundle

English | [中文](README.zh.md)

Private opt-in Profile bundle for [Task Contract](../task-contract/README.md), [Final Gate](../final-completeness-gate/README.md), [Progress Observer](../progress-integrity-observer/README.md), and [Task Execution Control](../task-execution-control/README.md). Release packages do not depend on this bundle.

## Configuration and lifecycle

The patch installs four providers with `mode: shadow`, but only three are auxiliary model nodes: requirement-change parsing, Progress Observer, and Final Reviewer. TaskExecutionControl is deterministic and adds no model call or Shadow restriction. Individual model nodes own their routes, budgets, and timeouts. Only interactive root Agents participate. Subagents and private memory-maintenance Sessions are excluded. Unloading providers aborts their owned calls and waits for settlement.

Install the bundle explicitly into the intended Profile and restart that Profile. Removal withdraws its providers at the next startup; recorded Session events remain readable. No memory policy, memory generation, or provider credential is modified by the bundle.

The optional browser contribution [UI Task Review](../ui-task-review/README.md) shows pre-admission input receipts and requirement-parsing failures inside Chat. It does not add auxiliary responses to Worker history or change admission policy.

## Model Experience

### Retained requirements and Shadow reviews

#### What the model sees

The Worker receives ordinary conversation, existing runtime context, and the compact `task-contract` snapshot derived from the authoritative requirement ledger. The snapshot contains only open, fulfilled, and cancelled requirement text plus the exact approved plan; it omits source coordinates, event identities, evidence identities, and historical revisions. Shadow Reviewer and Observer calls remain outside Worker history and do not reject answers or inject steering.

#### Token effect

Requirement parser, Reviewer, and Observer requests add separately audited provider usage, counted once. TaskExecutionControl adds no model usage.

#### KV Cache effect

The compact task snapshot is appended only when its rendered content changes or compaction has shadowed the retained copy. The three auxiliary calls have independent stable prefixes.

## Known Limitations and Deferred Work

- This is an experimental composition, not a completeness guarantee. Extraction and review depend on the configured model. The bundle does not enable Enforce or automatic tool interruption. Auxiliary requests may add latency and cost; provider failures remain visible in Session diagnostics.

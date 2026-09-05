# @deepseek-ai/dsh-repeat-tool-reminder

English | [中文](README.zh.md)

This deterministic guard detects one Agent repeating the same settled operation. It is not a model tool and adds no periodic model request. A run is identical only when the tool name, deeply key-sorted JSON arguments, and settled result or error all match. A direct user message resets the run.

## Configuration

```yaml
- id: repeat-tool-reminder
  name: '@deepseek-ai/dsh-repeat-tool-reminder'
  config:
    reminderCount: 3
    blockAttempt: 4
    include: []
    exclude: [todo_write]
    argumentsPreviewChars: 500
```

`blockAttempt` must equal `reminderCount + 1`. Invalid integers fail at load. `include` and `exclude` are `*`-wildcard predicates over tool names. Excluded calls are transparent: they neither increment nor reset a tracked run.

After the third identical call/result pair, the plugin appends one source-labelled notice telling the Agent to change its approach or explain the blocker. If the Agent prepares the unchanged fourth call, `ctx.tools.guard()` denies it before the tool body, shell, browser, or external provider starts. The denial becomes the normal tool error result, and a steering notice asks the Agent to replan. A changed tool, arguments, result, or direct user message starts a new run.

The live chain is keyed by Agent and reconstructed from existing Session call/result events after reload. Compaction does not delete that history. The guard's own rejection is not new evidence and does not reset the chain; further unchanged attempts remain denied. Reminder and block notices are emitted once per unchanged run. Detection is exact: semantically similar but byte-different values are not merged. Active polling is recognized through trusted runtime metadata.

Trusted `repeatPolicy: polling` tools exclude successful observations of the same active target from exact-repeat counting. The provider validates target identity and active status; missing metadata, failures and terminal results use strict repetition rules. Observer uses the same policy for mechanical triggers without disabling semantic time-window checks.

Decision history: [repeat-tool guard](../../../.agents/notes/archived/feature/2026-07-08-repeat-tool-guard.md) and [retained intent and delivery control](../../../.agents/notes/proposed/feature/2026-09-03-retained-intent-and-delivery-control.md).

## Model Experience

### Repeat reminder and blocked attempt

#### What the model sees

The third identical result adds a source-labelled reminder. An unchanged fourth attempt receives a normal tool error from `ctx.tools.guard()` and a replanning notice; no tool body starts.

#### Token effect

No model calls are made. Reminder and block text enter Worker history once per unchanged run.

#### KV Cache effect

Notices extend the history suffix; model tool schemas remain unchanged.

## Known Limitations and Deferred Work

- Exact comparison does not recognize semantically equivalent operations with different arguments.
- Polling exemptions require a trusted active-target result check and do not disable semantic progress observation.

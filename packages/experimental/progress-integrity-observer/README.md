# @deepseek-ai/dsh-experimental-progress-integrity-observer

English | [中文](README.zh.md)

This private plugin asks a semantic Observer after deterministic tool-history signals indicate a possible loop, or after a bounded active-execution window needs a progress check. Ordinary task length never triggers it.

## Configuration

```yaml
- id: progress-integrity-observer
  name: '@deepseek-ai/dsh-experimental-progress-integrity-observer'
  config:
    mode: shadow
    repeatOutcomeCount: 3
    failureStreak: 3
    alternatingCycles: 3
    semanticWindowMs: 300000
    maxUnconfirmedProgressMs: 600000
    minWindowToolResults: 3
    maxInputBytes: 262144
    provider: deepseek-official
    model: deepseek-v4-flash
    reasoningEffort: high
    maxTokens: 1024
    timeoutMs: 30000
    maxEvidenceLookupRounds: 2
    maxEvidenceSearchResults: 12
```

The runtime calls the Observer after three identical call/result pairs, three adjacent failed task tools, or an unchanged `A-B-A-B-A-B` action/result sequence. It also checks progress after five minutes of active execution and at least three completed task-tool results. The active window restarts at the Turn start, a user-sourced requirement change, formal plan approval, or the last validated `progress=yes`. Approval waits, execution holds, and Observer latency do not count. It does not call the model because a Turn contains 6, 20, or any other fixed number of Steps.

The Observer initially receives one locator per selected result, with its matching invocation and optional target hint; call entries and result previews are not duplicated. Its private `session_event_search/read` schemas can read only that frozen set when one missing detail could change the verdict. A rejected lookup returns a model-visible tool error so the Observer can decide from the frozen index instead of failing the whole observation. These tools reuse the same auxiliary adapter as Final Reviewer, do not enter the Worker tool catalog, and create no task-tool events. The Observer returns `progress=yes|no|uncertain`, one risk, cited existing Session events, and a short reason. The provider is asked for exactly those four fields; harmless top-level metadata is discarded and cannot affect execution control. For `progress=yes`, `evidenceEventIds` accepts only actual `tool/result` events in the current window, including failures that provide new diagnostic information; a `tool/call` proves dispatch but not progress, so validation rejects it and permits the single bounded repair attempt. In Enforce, validated no-progress or any risk pauses task tools immediately. A held or answer-rewrite execution does not schedule further observations from denied tool results. An uncertain verdict schedules another check after five further active minutes; ten active minutes without confirmed progress pauses execution. Shadow records the verdict without changing execution.

Query rounds and the observation deadline are shared with the single format-repair attempt. Repair retains retrieved evidence without replaying failed reasoning. The closing request offers no tools; insufficient evidence remains uncertain.

Failure streaks use the shared frozen-result outcome: nonzero Shell exits and termination signals are failures even when the tool protocol reports successful dispatch. Background launch alone is neither completed success nor failed execution. Failure evidence can still establish semantic progress by excluding an incorrect hypothesis.

## Model Experience

### Triggered progress judgment

#### What the model sees

Work shorter than the elapsed window and free of mechanical risk adds no Observer request or Worker tokens. A triggered request contains all uncancelled requirements, the approved plan when present, direct user inputs, and one compact index of the selected events. Full parameters and results are fetched only on demand through `session_event_read`. The latest valid stage conclusion for the same input and requirement versions may be included as a short comparison baseline, not as completion proof. Bookkeeping-only revisions do not reset the active-time window. Repeat-guard denials neither provide progress nor trigger another observation. Worker reasoning is excluded. The request is audited outside Worker history.

#### Token effect

Only a triggered observation adds bounded auxiliary requests; evidence lookups share its deadline and budget.

#### KV Cache effect

Observer requests use an independent stable prefix, separate from the Worker.

## Known Limitations and Deferred Work

- Pure semantic drift may remain undetected for up to the five-minute active window. Final Reviewer is the later whole-delivery check, not an execution-time monitor. Semantic verdicts remain experimental until labelled evaluation meets the deployment thresholds.

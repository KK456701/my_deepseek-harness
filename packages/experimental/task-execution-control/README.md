# @deepseek-ai/dsh-experimental-task-execution-control

English | [中文](README.zh.md)

TaskExecutionControl coordinates Final Reviewer and Progress Observer holds at the existing DSH tool-dispatch point. It does not classify authorization, replace the sandbox, or modify provider permissions.

## Configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-task-execution-control'
  config:
    mode: shadow
    maxRepairWorkerSteps: 2
    maxRepairToolCalls: 6
    maxRepairMs: 120000
    maxTaskToolCallsPerTurn: 80
```

Enforce supports answer-only rewrite, read-only verification, bounded corrective work, replanning, and unknown-outcome recovery. Pending direct-user `next-step` input blocks all unstarted task tools, including nested calls, until a new Worker request has consumed the input. The registry checks after approval, wrappers, and flushed dispatch intent, then starts the body without an intervening await. Queue entries and plugin notices are not user barriers; withdrawing unclaimed feedback removes its barrier. A flushed intent is not proof of startup: denied calls record `started=false`, while started calls without a reliable result require outcome recovery.

A replanning or unknown-outcome hold enters Plan Mode for the affected Agent. TaskExecutionControl first checks the Agent context, then uses `AgentPresets.serviceFor()` to address a controller published behind that Agent's preset isolate, and finally checks the deployment context. Plan Mode state remains per Session in every assembly. TaskExecutionControl registers its approval observer on the resolved controller, captures the requirement and execution revisions before review, and releases the hold only after the exact `plan/review-approved` callback validates those versions. A conversational confirmation or a Plan Mode toggle does not release task tools.

The 80-tool default is a dispatch safety fuse, not a semantic no-progress threshold. Reaching it pauses new task tools and asks the Agent to report completed work and replan. Set `maxTaskToolCallsPerTurn: false` only in an isolated evaluation that relies on a separate total budget. Worker Step count and ordinary Turn duration are not capped; semantic no-progress detection belongs to Progress Observer.

The normal DSH sandbox, approval policy, and tool guards remain authoritative. A provider-owned call-specific read-only probe may verify an unknown result without reopening general Worker tools.

File observations retain backend target/version identities. Final review rechecks these identities, and unscoped command checks conservatively become stale after concurrent or later possible workspace mutations. Denied bodies do not count as mutations; unknown started outcomes do. Historical results remain readable, but missing freshness metadata cannot prove a current version. These checks cannot cover unobserved external edits, deployments, or remote state.

Verification uses the existing repair budget. Trusted read-only tools may run; an unknown-effect query requires approval for that exact call and current execution revision. Approval does not reopen general task tools. Missing evidence selects verification, not automatic repetition of the original operation.

Replanning notices require the rejected hypothesis, its evidence, the remaining problem, and a different verification method. Approval still binds the exact displayed plan and current revisions; repeating “try another approach” does not establish progress or authorize new operations.

## Model Experience

### Execution restriction notice

#### What the model sees

A source-labelled notice identifies `rewrite`, `verify`, `continue_work`, or a hold. Verification requires read-only evidence; uncertain effects need exact-call approval. Accepted repair releases temporary restrictions.

#### Token effect

The controller calls no model. A state change appends one bounded notice to Worker history.

#### KV Cache effect

The notice extends the Worker suffix without replacing its system prompt.

## Known Limitations and Deferred Work

- Freshness covers observed file versions and workspace activity, not unobserved external mutations or remote state.
- Started effects cannot be undone; unknown outcomes require provider-supported recovery or user-approved verification.

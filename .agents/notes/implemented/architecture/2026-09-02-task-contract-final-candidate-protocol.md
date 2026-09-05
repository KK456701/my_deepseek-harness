# Agent Note: Task Contract and durable final-candidate submission

Status: implemented

English | [中文](2026-09-02-task-contract-final-candidate-protocol.zh.md)

## Problem

A Worker can complete a long tool loop and still omit one part of the user's request, follow a superseded direction, or submit an answer while same-Turn steering is waiting. A final Reviewer attached after `assistant/message` can measure that failure but cannot prevent it. Buffering the response only in memory prevents leakage but loses the Candidate, usage, and observed stream when the process fails. Conversation compaction adds a second failure mode: a lossy summary can omit a Requirement even though the original user event remains durable.

## Decision

**The active user task is event-sourced independently from conversation projection.** `ctx.taskContract` folds atomic `task-contract/update` batches with a monotonic revision and stable Requirement sources. It extracts only claimed direct-user messages. After downstream pre-Step work, including compaction, it appends a complete authoritative snapshot to that Step's messages. System instructions, tools, permissions, skills, and derived execution obligations remain distinct from user Requirements.

**Final text has an explicit deferred-delivery path.** The Agent loop emits `agent/request-starting` before each request attempt, then asks `agent/assistant-delivery` whether response chunks publish live or go to a caller-owned durable writer. A staged tool-call response commits before execution. A staged final text reaches `agent/final-candidate`; its optional validator runs synchronously immediately before the ordinary Assistant Message append.

**Candidate validity uses two revisions.** The Final Gate freezes Task Contract revision and the latest `next-step` inbox splice at request start. Steering and plugin injection change the next-Step revision and supersede the Candidate; queued next-Turn input does not. Task updates change the Contract revision. Stop uses the Turn signal and aborts the Candidate. Reviewer success is insufficient by itself: task revision, next-Step revision, inbox emptiness, signal, Candidate phase, and Reviewer attempt must still match at the synchronous commit point.

**Model-owned auxiliary calls are durable audits, not hidden helpers.** Contract extraction, final review, and progress observation record route, exact source data, raw output, usage, duration, validation, and terminal failure. `llm/audited-call` gives common accounting consumers one additive record without pretending those calls create ordinary Assistant Messages.

**Direction observation stays separate and Shadow-only.** The Progress Observer classifies completed Step evidence against the same Task Contract, but it does not steer, replan, or pause tools. Final completeness and execution progress share task state, not lifecycle or intervention policy.

## Durable state and recovery

Final staging writes every Provider chunk before requesting the next one, followed by the complete Candidate, Reviewer attempts, decisions, and a terminal end. Rejected and superseded drafts remain outside conversation and model projection. Recovery can settle a formal answer whose decision tail is missing, resume a complete Candidate, reinject a rejected Candidate's correction, or supersede an interrupted generation. Requirement fulfillment is appended only after a formal answer commits or independently durable evidence warrants it.

Compaction may replace surface nodes but cannot remove Contract or staging events. The next pre-Step projection rebuilds the complete Contract from raw events and explicitly supersedes summary details. Snapshot limits fail loud rather than dropping an open Requirement.

## Alternatives considered

- **Prompt-only self-checking** — uses the same Worker and context that produced the omission, cannot prevent a racing stale commit, and creates no independent measurement.
- **Reviewing committed answers at `agent/turn-stopping` only** — is appropriate for Shadow calibration but cannot enforce because the ordinary Assistant Message is already public and part of model history.
- **Holding Candidate chunks only in memory** — avoids draft projection but violates reconstructable-request and crash-recovery guarantees.
- **Treating every running-time message as steering** — incorrectly invalidates a Candidate for ordinary queued follow-ups and collapses user, plugin, and cancellation semantics.
- **Putting progress intervention inside the Final Gate** — couples two classifiers with different evidence, timing, and rollout thresholds, making false positives harder to isolate.
- **Asynchronous packed chunk writes** — reduce event count but retain an uncommitted loss window. Per-chunk durable append is the first implementation; Session compression handles storage density.

## Consequences

Enforce mode adds Reviewer latency, model usage, and durable draft storage. Cross-provider review requires explicit authorization because it transmits user sources, Contract state, evidence, and the Candidate. The Session vocabulary grows without a format bump because current readers know these required event types; external older pre-release readers are not compatibility targets.

Ordinary Agent behavior remains live unless a delivery plugin opts in. Shadow review does not delay `turn/end`. Progress intervention remains unavailable until its precision, recall, F1, false-positive, and detection-delay thresholds are met. The keyless Loader snapshot and package tests pin staging non-leakage, revision-guarded commit, post-commit fulfillment, compaction replay, background Shadow behavior, and additive usage accounting.

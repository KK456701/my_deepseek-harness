# @deepseek-ai/dsh-experimental-final-completeness-gate

English | [中文](README.zh.md)

This private experimental plugin stages an Enforce-mode final candidate before ordinary `assistant/message` delivery. If review finds omitted answers, unsupported claims, or unfinished work, the candidate stays outside normal Worker history while the same Turn continues through restricted rewrite, bounded work, or replanning. Shadow mode observes an already delivered message because it cannot intercept delivery.

`maxCandidatesPerTurn` bounds terminal answer attempts. Intermediate Steps that contain tool calls still use the byte quotas, but do not consume the terminal-answer quota.

`maxCandidateBytes`, `maxTurnStagingBytes`, and `maxSessionStagingBytes` all measure assembled candidate content. Adjacent candidate deltas are boundedly coalesced before persistence, so provider chunk boundaries neither multiply durable events nor count the same content again toward staging capacity; the complete candidate remains replayable.

## Configuration

```yaml
- id: final-completeness-gate
  name: '@deepseek-ai/dsh-experimental-final-completeness-gate'
  config:
    mode: shadow
    reviewTiming: before-delivery
    reviewerProvider: deepseek-official
    reviewerModel: deepseek-v4-flash
    reviewerReasoningEffort: high
    allowCrossProviderReview: false
    reviewerMaxTokens: 2048
    reviewerTimeoutMs: 30000
    maxEvidenceLookupRounds: 4
```

Cross-provider review requires explicit opt-in because direct-user text, plan text, result evidence, and the candidate leave the Worker provider.

## Frozen review input

Version 8 input contains one copy of the related direct-user messages and the id, revision, text, verification mode, and state of every uncancelled requirement, including fulfilled ones, the latest formally approved plan text when present, stable candidate paragraphs, and a compact result-evidence index. The index exposes result identity, outcome, invocation identity, tool name, and an optional 120-code-point target hint. Program-generated freshness accompanies each entry. It contains neither result previews nor full arguments; every selected result remains reachable. It excludes Worker reasoning, tool schemas, unrelated history, Observer prose, and long-term-memory bodies.

The Reviewer may call its scoped `session_event_search` and `session_event_read` only when it needs to verify a claim. They read result events frozen before the reviewed answer and are absent from the Worker tool list. No separate evidence-access event is added. An execution requirement can be `verified` only after every cited result has been read in full. The initial request exposes `maxEvidenceLookupRounds`; each round may read multiple events. After the final lookup round, one closing request retains the collected evidence but offers no tools and requires a review result. Missing evidence remains unverified; another tool call or an invalid result fails closed. Closing does not add a retry or reset the timeout and cost budgets.

The Reviewer returns one `RequirementReview` per uncancelled requirement. `answerEvidence` contains a paragraph id and exact supporting quote; the runtime checks the substring, while the model checks substantive coverage. Generic completion claims alone do not cover a requirement. `work` is `verified`, `needs-verification`, `not-done`, `incorrect`, or `not-needed`. Every cited result must have been read; completion requires current successful evidence. Unsupported not-done or incorrect assertions become needs-verification. Plan omissions must still apply after later user changes. Historical reviews are not promoted to version 8 approval.

## Delivery actions

A tool-free closing request reconstructs the original frozen input plus one copy of each collected lookup result. It excludes the lookup conversation's assistant reasoning and native tool-call history; earlier requests remain in the audit. Only final text is parsed as a verdict. A reasoning-only response is a validation failure and may use the existing single repair; reasoning is never promoted to an accepted result.

The result index includes an `invocation` locator (sequence and tool name). A full result read also includes its original parameters, avoiding a second call lookup. Arguments stay out of the index; calls cannot prove completion. Shared outcome projection uses the Shell renderer's exit-status parser for `bash` and `pwsh`: a nonzero exit or termination signal is failure even when tool dispatch itself succeeded. Missing invocation or background launch leaves completion unknown. Existing logs retain their original interpretation; natural-language claims still require semantic review.

Complete coverage plus applicable evidence commits and fulfills exact requirement versions. Missing explanations select tool-free rewrite. Unknown completion selects `verify`; only supported missing or incorrect work selects bounded correction. Freshness is rechecked after review, and the final commit also checks observed mutation state. Honest blocked or requested progress replies may end without fulfilling incomplete work. Unrequested interim replies cannot close the task. Unavailable review and invalid references fail closed.

Steering to the current Step invalidates the candidate; queued next-Turn input does not. A reply admitted from TaskExecutionControl's own pause notice may be reviewed and delivered while task tools remain paused, so the user can receive the blocker or proposed plan without completing the requirement. A superseded candidate always supplies fresh next-Step input before returning control to the Agent Loop. Stop cancels the Worker and Reviewer. The final revision guard and formal message append execute synchronously without an intervening await.

## Audit and recovery

The delivered message, frozen input, auxiliary request and response, and review result remain reconstructable from existing Session events. On-demand reads are represented inside the auxiliary model call instead of creating one event per access. Invalid or interrupted reviews retain received output and reported usage. Validation may repair once against the same frozen input, retaining previously retrieved evidence and the remaining query allowance. Repair does not replay the failed response or reasoning and does not reset the review deadline. Numeric claims must be checked against their population and units; a document written by the Worker is not independent proof of its own conclusions.

## Model Experience

### Answer that needs repair

#### What the model sees

The Worker does not see a rejected candidate in normal history. It receives a short control notice selecting `rewrite`, `verify`, `continue_work`, or replanning.

#### Token effect

Enforce adds one bounded Reviewer request and may add a replacement Worker Step. Rejected candidate text remains in audit events rather than ordinary Worker history.

#### KV Cache effect

Reviewer requests use a separate stable prefix. A correction notice extends only the Worker suffix.

## Known Limitations and Deferred Work

- Program checks establish provenance and current revisions, not semantic entailment. Production remains Shadow until independently labelled completeness and false-positive targets are met.

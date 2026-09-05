# @deepseek-ai/dsh-experimental-task-contract

English | [中文](README.zh.md)

This private experimental service keeps an event-sourced ledger of direct-user requirements. A tool-free requirement-change parser processes each newly received direct-user message in receive order and proposes `add`, `revise`, or `cancel`. The runtime assigns identities and revisions, binds every proposal to the complete current user message, and atomically rejects stale or invalid batches.

## Configuration

```yaml
- id: task-contract
  name: '@deepseek-ai/dsh-experimental-task-contract'
  config:
    mode: shadow
    injectWorkerContext: false
    parserProvider: deepseek-official
    parserModel: deepseek-v4-flash
    parserReasoningEffort: low
    parserMaxTokens: 4096
    parserTimeoutMs: 30000
    maxInputBytes: 65536
    maxRequirements: 128
```

`shadow` records a failed parse and lets the Worker continue. `enforce` rejects the Step when new user input cannot be reconciled. JSON, schema, or reference validation may repair once against the same frozen input. Timeout, cancellation, and output exhaustion do not automatically repeat an identical request.

## Ledger semantics

Every independently answerable, cancellable, or verifiable request has a stable `RequirementId`. Shared constraints are registered once with their scope. Fulfilled requirements remain available to the parser so a later correction reopens the same identity. Revision starts at one. `revise` keeps the identity, increments the revision, reopens the requirement, and clears its completion proof. `cancel` retires only the named requirement without deleting history. Completion records the exact requirement revision and answer or result events used as evidence.

`task-contract/input` preserves claimed user input before parsing, including empty and failed parses. `task-contract/update` format version 3 advances one compare-and-swap revision. Replay does not depend on the compacted conversation surface. Existing `plan/review-approved` events supply the latest approved plan text; there is no plan-item extraction model.

When `injectWorkerContext` is enabled, the next root Worker request receives one compact snapshot grouped into open, fulfilled, and cancelled requirements, followed by the exact approved-plan text when present. It excludes source coordinates, event identities, evidence identities, and prior versions. Unchanged text is not appended again. A newer snapshot states that it supersedes older task snapshots; if compaction shadows the retained snapshot, the next request injects the same current projection again. The append-only ledger remains authoritative.

## Auxiliary audit

Before the actual Worker request, `task-contract/input-admitted` records received message ids that already exist as direct `user/message` events. It is appended outside Session event publication, once per identity; parsing failure does not falsely admit a message. Shared frozen-result indexes expose a matching invocation locator and optional target hint instead of result previews. On-demand result reads include the exact original parameters and body.

Each real parser dispatch uses `purpose=requirement-change-parsing` and records its prepared request, dispatch, streamed output, terminal response, consumer assessment, template hash, projection version, route, timing, and reported usage. Consecutive text, reasoning, and tool-argument deltas are boundedly coalesced before persistence; the terminal response still retains the complete assembled content, so Trajectory replay does not depend on thousands of single-character events. These events are excluded from Worker history and long-term-memory extraction. Missing historical statistics remain unrecorded rather than inferred.

Saved input is not successful parsing. After a failed parse, the next real user input retries unresolved messages in original order; plugin notices do not silently retry failures. Plan applicability is derived from requirement ids/revisions at the original approval event. Later add/revise/cancel changes require reconciliation; fulfillment alone does not invalidate approval. Latest user corrections override stale plan text.

The shared frozen-event lookup retains invocation identity when deriving result success. Shell nonzero exits and signals count as failure independently of tool-dispatch success; background launch or missing invocation does not establish completion. This outcome is shared with the Observer and Reviewer without modifying source Session events.

## Model Experience

### Requirement-change parsing

#### What the model sees

The parser sees one new direct-user message, all uncancelled requirements, including fulfilled ones, as `id / revision / text / verification`, and the latest formally approved plan when one exists. The plan appears once and is reference material only. Independently answerable or verifiable subquestions are separate changes even when one overall deliverable names them; a request to inspect, run, generate, or verify remains `execution` even when its final deliverable is prose. Requirement provenance, state, completion evidence, cancelled history, Worker reasoning, and task tools are not sent. The model cannot provide provenance: after validation, the runtime binds each accepted change to UTF-16 range `0..message.length` and the exact complete message text.

#### Token effect

Each new direct-user message adds one bounded auxiliary request in receive order. The experimental Web assembly uses Low reasoning, a 4,096-token output ceiling, and a 30-second timeout; a validation repair may add one more request. Output exhaustion, timeout, cancellation, and transport failures are not retried automatically.

#### KV Cache effect

Parser requests use their own stable prefix and do not alter Worker cache continuity.

## Known Limitations and Deferred Work

- Semantic decomposition remains a model judgment. Source and revision checks prevent forged provenance and stale writes, but do not prove that the parser interpreted the user correctly.

# @deepseek-ai/dsh-experimental-ui-task-review

English | [中文](README.zh.md)

Optional browser presentation for the simplified task-review pipeline. It consumes durable events and owns no model request, decision, or second transcript.

The default Enforce path reviews a staged candidate before ordinary delivery, so a rejected draft appears only in Trajectory and never becomes an Assistant chat row. Explicit legacy after-delivery enforcement can still mark an already shown Assistant row as `Review failed` and collapse it; a later Assistant message in the same Turn changes the label to `Replaced by revised answer`. Shadow results and records without explicit enforcement metadata do not reclassify chat history.

## Auxiliary trajectory

Full-dialogue tests keep ordinary conversation locations; only fixed-material Reviewer screening uses an evaluation location. Missing input-admission receipts in historical logs do not prove the Worker never received the input. Missing test results display as unrecorded; Turn completion alone is not an acceptance result.

The existing Trajectory view displays exactly three current auxiliary roles as MODEL rows: requirement-change parsing at `before-step`, event-triggered progress inspection at `after-step`, and the default Enforce review at `before-delivery`. Shadow review remains at `after-delivery`. Fixed-material screening uses `scope=evaluation` and never fabricates USER, TOOL, or ASSISTANT events. `Between turns` is reserved for records that genuinely lack a Turn and Step.

Each `callId` joins the prepared request, actual dispatch, streamed reasoning or text, terminal response, consumer validation, route, timing, and reported usage. Provider-exposed reasoning is shown as safe plain text in its original language and defaults to collapsed. It does not claim access to undisclosed internal state.

Transport completion and business validation are distinct. Timeout, cancellation, invalid JSON, and validation failure retain received output. A request prepared but not dispatched is labelled accordingly. Historical missing location, timing, or usage remains unrecorded rather than inferred.

Legacy extraction and authorization records remain replayable with an explicit legacy label, but new runs never create authorization-model rows. Viewing or replaying the UI does not add tokens or usage.

## Model Experience

### Event-derived views

#### What the model sees

Nothing. The UI adds no `user/message`, `assistant/message`, tool event, or model-visible context.

#### Token effect

None. Displayed usage comes from durable audit records.

#### KV Cache effect

The UI does not modify model request prefixes.

## Known Limitations and Deferred Work

- Loading an incomplete page may temporarily omit the matching request or terminal record; pagination restores the exact stored relationship by `callId`.
- Pure semantic drift with no repeat, failure, or alternating trigger may remain unseen until the five-minute active-execution window or Final Reviewer.

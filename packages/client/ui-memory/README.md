# @deepseek-ai/dsh-client-ui-memory

English | [中文](README.zh.md)

Profile-memory manager contributed to the Workspace header. “Memory items” projects current summary and handbook files into revision-safe cards; it is not another knowledge store. “Memory files” separates formal knowledge, source evidence, explicit requests, and internal metadata. Card edits create pending notes for later publication.

“Scan and consolidate now” bypasses only the idle delay; “Consolidate pending work” skips discovery. Clean rebuild requires confirmation, deletes derived state, preserves conversations, and applies the user's explicit-request retention choice. The UI displays durable rebuild progress, failures, and Session-level use/contribute controls.

Runtime settings select the extraction and consolidation backends independently. Codex calls use per-call model and reasoning settings without changing global Codex configuration. Clean rebuild freezes the configured lookback window at confirmation and lets the user preserve or purge explicit requests; original conversations are retained in either case. Settings apply to subsequent calls without restarting the host.

The live external-context guard is off by default. Enabling it excludes entire ranges containing classified calls; it does not block explicit memory requests. The editor explains that admitted external evidence remains untrusted and redacted.

Change history shows a conversation request's redacted original user message and the model draft separately. Missing verified originals are labeled unavailable, never reconstructed from a draft. Processing and authority statuses continue to distinguish a saved request from a published memory.

Cards display each body once; Task Group headings appear only as card titles without changing edit targets. Source usage lists each source's recorded citation count and last citation separately, initially showing two sources. Automatic range versions share Session feedback. Counts are not summed into an item-use total, and zero means no recognizable citation, not proof of non-use. Browsing, injection, and ordinary recall do not increment these counters. Committed usage changes refresh connected managers without starting model work.

## Model Experience

None, as this package is a trusted product UI and does not contribute model input.

#### KV Cache effect

The UI contributes no prompt bytes; host consumers own the effects of committed settings and notes.

## Known Limitations and Deferred Work

- Published Markdown remains immutable; card operations create structured notes and rely on Phase 2 publication rather than editing files directly.
- A legacy generation is visibly marked rebuild-required and remains available only in the source-file view.
- The memory root, database behavior, and safety capacity ceilings remain deployment configuration. Profile enablement and operational settings are live.

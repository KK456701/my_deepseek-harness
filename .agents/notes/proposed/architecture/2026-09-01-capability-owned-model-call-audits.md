# Agent Note: Durable records for capability-owned model calls

Status: proposed

English | [中文](2026-09-01-capability-owned-model-call-audits.zh.md)

## Problem

The interactive agent loop records the exact request header and every model-visible result in its Session log. Long-term-memory generation adds two calls that do not belong to an interactive Session: a one-shot extraction request and a tool-using consolidation Agent. Sending either call without a durable pre-dispatch record would make provider activity impossible to reconstruct; copying both into an ordinary user Session would expose private maintenance work through list, resume, search, and export surfaces.

## Proposal

Retain the existing rule that every dispatched model request has a durable reconstruction record before network activity. Interactive loop calls continue to use the ordinary Session log. A capability-owned one-shot call uses a private append-only audit record containing the audit format version, exact prepared request, resolved configuration, input fingerprint, provider attempt, observed stream or failure, usage, and terminal classification. The request record must flush before dispatch and the result record must flush before domain state consumes it.

A capability-owned tool-using Agent uses a private SessionPersistence instance and a required `SessionPurpose` value of `maintenance`. The standard agent loop records `request/header`, assistant output, tool calls, tool results, retries, and termination unchanged. Ordinary Session query and UI services never mount the private backend. The owning capability applies bounded retention only after the maintenance operation and every dependent publication are terminal.

The durable record is an audit and recovery source, not the authority for generated memory. Deleting an expired terminal audit does not invalidate a published generation whose manifest and immutable evidence remain valid. Active, retryable, result-recovery, or publication-recovery records cannot expire.

This proposal extends rather than rewrites the [request reconstructability decision](../../implemented/architecture/2026-07-05-reconstructable-requests.md): a network dispatch always has a durable owner, while that owner may be the interactive Session log, a capability one-shot audit, or a private maintenance Session.

## Alternatives considered

**Write every background call to the originating interactive Session.** Rejected because extraction can combine old ranges and consolidation is profile maintenance rather than part of a user's conversational transcript.

**Keep only the final structured extraction result or generation diff.** Rejected because it cannot reconstruct the actual provider request, retries, invalid output, partial stream, timeout, or tool evidence the maintenance Agent observed.

**Treat every auxiliary call as a special Session event.** Rejected because one-shot audits and multi-step tool-using Agents have different lifecycle and storage needs. The standard Session vocabulary remains appropriate for the latter; a bounded append-only attempt record is smaller and clearer for the former.

## Acceptance criteria

- No capability-owned provider call begins before its exact request record is durably flushed.
- No extraction result affects candidates or watermarks before its complete observed result or classified overflow/failure is durably flushed.
- A maintenance Agent's prompt, request headers, tool calls, tool results, retries, and final state can be reconstructed from its private Session log.
- Ordinary Session list, tree, search, resume, fork, and export operations cannot discover a maintenance Session.
- Retry attempts retain one input fingerprint and distinct attempt identities; provider-hidden retries remain disabled.
- Terminal audit retention cannot delete active, retry-wait, result-recovery, or publication-recovery state, and deleting a terminal audit does not invalidate published generation provenance.

## Risks

Private records duplicate selected historical content and model output, increasing local privacy and capacity costs. Each capability needs strict byte limits, retention, owner-only directories, and reset documentation.

Two durable mechanisms can drift if they define overlapping retry or result semantics. The generic audit vocabulary should stay limited to dispatch reconstruction; the owning capability keeps domain state and failure policy.

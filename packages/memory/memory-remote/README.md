# @deepseek-ai/dsh-memory-remote

English | [中文](README.zh.md)

Trusted Host Remote Consumer for the public profile-memory service. It exposes profile and Session controls, live runtime settings, verified generation browsing, explicit notes, separate manual scan and pending-work consolidation requests, reset, and quarantine retry through generated Typert methods. Model recall remains process-local to the prompt consumer. The Remote never resolves or exposes the private pipeline Store, leases, audit payloads, staging paths, or publication operations.

## Model Experience

None, as this adapter serves trusted product clients and does not contribute model input.

#### KV Cache effect

The transport contributes no prompt bytes; host consumers render committed state.

## Known Limitations and Deferred Work

- Authorization is profile-level in v1; one profile is one intentionally shared memory space.
- File responses retain the provider's configured byte limits and never return an unverified generation file.

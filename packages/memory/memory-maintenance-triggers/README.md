# @deepseek-ai/dsh-memory-maintenance-triggers

English | [中文](README.zh.md)

Consumer-only wake bridge for `MemoryMaintenanceService`. It wakes after provider startup, interactive root Session creation or resume, control changes, explicit manual scan or consolidation, quarantine retries, and non-note Store work events. Interactive turn completion only flushes the Session; an ad-hoc note remains pending until a later root Session startup or manual consolidation. The package owns no timer, model call, database access, or publication logic.

## Model Experience

None, as this package only turns lifecycle facts into scheduler wake reasons.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- Trigger delivery does not guarantee model dispatch; scheduler eligibility and budget checks still apply.

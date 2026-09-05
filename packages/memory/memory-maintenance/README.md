# @deepseek-ai/dsh-memory-maintenance

English | [中文](README.zh.md)

Lifecycle Service Definition implemented by the memory scheduler. Trigger consumers can coalesce wake reasons, run one bounded pass, and require quiescent disposal without gaining access to pipeline storage.

## Model Experience

None, as this package exposes scheduler lifecycle only.

#### KV Cache effect

None. Model calls are owned by the scheduler provider.

## Known Limitations and Deferred Work

- **No generic job visibility** — maintenance work stays capability-private until the generic jobs seam gains internal visibility.

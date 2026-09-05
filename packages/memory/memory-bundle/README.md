# `@deepseek-ai/dsh-memory-bundle`

English | [中文](README.zh.md)

The standard profile-memory assembly. Its patch mounts the local public/store providers, scheduler, maintenance triggers, prompt consumer, and Host Remote consumer with `<Profile.dir>/memories/` as the only memory root. The public profile switch is disabled by default; the scheduler remains loaded so enabling memory in the UI takes effect without restarting.

This package contains no runtime pipeline logic. Each mounted package owns its service, lifecycle, persistence, and invariant checks.

## Configuration

Enable the feature in a profile patch:

```yaml
- id: memory-local
  inject: [profilePath]
  config:
    root: !!js ctx.profilePath('memories')
    enabled: true
    useByDefault: true
    contributeByDefault: true

- id: memory-scheduler
  config:
    extractionProvider: deepseek-official
    extractionModel: deepseek-v4-flash
    consolidationProvider: deepseek-official
    consolidationModel: deepseek-v4-flash
    consolidationReasoningEffort: inherit
    enabled: true
```

The complete provider and scheduler schemas expose capacity safety ceilings plus revisioned live eligibility, recall, lease, retry, model, and retention values. The root must remain profile-relative; the bundle never falls back to the Harness home.

## Model Experience

Indirectly, through the mounted prompt and scheduler consumers.

#### KV Cache effect

The bundle adds no prompt bytes; its mounted consumers own request assembly.

## Known Limitations and Deferred Work

- Codex execution requires its provider to be installed separately on the host.

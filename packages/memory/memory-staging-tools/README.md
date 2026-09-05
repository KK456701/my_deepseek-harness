# @deepseek-ai/dsh-memory-staging-tools

English | [中文](README.zh.md)

Operation-point confinement for the Phase 2 agent. `MemoryStagingFileSystem` rejects absolute paths, traversal, symlinks, alternate cwd values, backend-owned files, and writes outside `memory_summary.md`, `MEMORY.md`, and `skills/**`. The companion `glob` and `grep` walk only this provider; they never launch an unrestricted subprocess.

## Model Experience

### Phase 2 maintenance session

#### What the model sees

Only `read`, `write`, `edit`, `glob`, and `grep` are assembled by the scheduler. Search results use staging-relative paths.

#### Token effect

Tool schemas and selected results contribute only to the private maintenance session.

#### KV Cache effect

The maintenance session is independent from interactive request caches.

## Known Limitations and Deferred Work

- **ECMAScript grep syntax** — the private `grep` uses JavaScript regular expressions rather than ripgrep syntax so search stays inside the rooted filesystem service.

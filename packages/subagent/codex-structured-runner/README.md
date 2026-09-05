# @deepseek-ai/dsh-codex-structured-runner

English | [中文](README.zh.md)

Private Service Definition for one-shot Codex JSON calls. `dsh-subagent-codex` provides the service; `dsh-memory-scheduler` consumes it. Loading the definition does not spawn a process or register a model tool.

`prepareCall` starts app-server, reads MCP identities through `config/read`, and freezes a request that disables those servers, installed plugins, and the legacy notification command. It does not start a thread or call a model. The consumer must durably record `exactRequest` before the single-use `dispatch`, record the result before applying it, and always await `dispose` in `finally`. Cancellation covers preparation and settles after the owned process tree exits. The request record describes the app-server API boundary, not Codex's private provider request assembly.

## Model Experience

Indirectly, through the app-server provider and the scheduler's evidence-transformation requests.

#### KV Cache effect

Each call uses a fresh ephemeral Codex thread independent of interactive DSH Sessions.

## Known Limitations and Deferred Work

- The audit covers the app-server API, not Codex's internal provider request assembly.
- A successful result has no observed tool calls; observation cannot prove that an upstream tool never executed.

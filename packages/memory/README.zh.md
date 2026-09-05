# memory/ — profile 长期记忆 capability

[English](README.md) | 中文

记忆包族分离公共浏览和提示访问、私有持久化流水线操作、Scheduler 生命周期、本地存储、触发器、提示集成和产品 UI。稳定依赖方向是 `memory-local → pipeline-store definition ← memory-scheduler → maintenance definition ← triggers`；公共 Consumer 只依赖 `memory`。

| 包 | 角色 | Context key |
|---|---|---|
| [`memory/`](memory/README.md) | 公共 Service Definition | `ctx.memory` |
| [`memory-pipeline-store/`](memory-pipeline-store/README.md) | 私有流水线 Store Definition | `ctx.memoryPipelineStore` |
| [`memory-maintenance/`](memory-maintenance/README.md) | Scheduler 生命周期 Definition | `ctx.memoryMaintenance` |
| [`memory-staging-tools/`](memory-staging-tools/README.md) | Rooted Phase 2 文件系统和搜索工具 | `ctx.fs`、工具注册 |
| [`memory-local/`](memory-local/README.md) | SQLite 状态和不可变 generation Provider | `ctx.memory`、`ctx.memoryPipelineStore` |
| [`memory-scheduler/`](memory-scheduler/README.md) | 两阶段流水线协调者 | `ctx.memoryMaintenance` |
| [`memory-maintenance-triggers/`](memory-maintenance-triggers/README.md) | 生命周期和持久工作唤醒 Consumer | maintenance 事件 |
| [`memory-prompt/`](memory-prompt/README.md) | 带租约的摘要注入 Consumer | `system-prompt/assemble` |
| [`memory-remote/`](memory-remote/README.md) | 可信 Typert Remote Consumer | `remote.memory` |

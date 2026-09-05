# @deepseek-ai/dsh-memory

[English](README.md) | 中文

面向 profile 长期记忆的公共 Service Definition。Prompt、Remote 和 UI 只能使用 `ctx.memory`；任务 claim、模型调用审计、staging 工作区和发布操作不会通过该服务暴露。该服务提供带 revision 的实时 Scheduler 参数，使管理 Consumer 无需访问私有 Store 即可修改适合在线调整的运行值。

## 服务 API

`MemoryService` 提供 profile 状态、会话级 `use`/`contribute` 控制、带 revision 的运行参数、带 lease 的 prompt snapshot、授权 lexical recall、不可变 generation 浏览、显式 remember/update/forget note、相互独立的手动扫描与 pending 工作归并请求、用户确认的干净策略重建、reset 和 quarantine 重试。干净重建删除派生状态、保留原始 Session、控制和 reset 水位，应用用户选择的显式 note 保留策略，仅重新学习冻结完成时间窗口内的 turn。手动扫描只忽略 idle 时间并继续两阶段处理；手动归并不执行 discovery。带 generation、行区间和哈希的修改或删除会拒绝过期目标，并立即从 prompt 与 recall 中压制旧条目。已保存 note 会保持 pending，直到后续自动或手动 Phase 2。`MemoryError.code` 是 RPC 边界上的稳定错误分类。

`MemoryItemPage.sourceUsage` 按条目现有 source id 返回去重集合。每条记录包含可识别 citation 次数及可选的最后引用时间，不是精确的条目使用次数。浏览、提示注入和 search/read 不增加计数。引用提交通过公共变更序列通知读取方，不改变 generation 或编辑 revision。

## 模型体验

间接通过 `@deepseek-ai/dsh-memory-prompt` 生效；该消费者会租用并记录实际注入请求的已发布摘要。

#### KV Cache 影响

本 Definition 不直接增加 token。发布 generation 和会话控制不变时，消费者可以保持稳定前缀。

## 已知限制和后续工作

- **Profile 级隔离** — workspace 身份只作为 provenance，不构成授权 scope。需要隔离记忆时应使用不同 profile。

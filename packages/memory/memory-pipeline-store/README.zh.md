# @deepseek-ai/dsh-memory-pipeline-store

[English](README.md) | 中文

Scheduler 与持久化记忆 Provider 之间的私有 Service Definition。Claim、审计 attempt、staging handle、lease、验证、不可变 generation 和 fencing 发布都以不透明品牌值跨越此 seam；Consumer 不会获得数据库行或 pointer 路径。

`openMaintenanceSession()` 返回不透明 Session id 和与其绑定的 `flush()` 屏障，而不是应用的 `SessionPersistence` 服务或审计路径。Provider 拥有精确 transcript 的接纳与保留，scheduler 拥有 Agent 执行，并且只能在验证和发布前等待其持久化完成。

Phase 2 claim 冻结完整的自动来源集合、内容版本、added/updated/retained/removed 差分及获准处理的 active note。选材回执与模型采用决策分开，丢弃已选来源本身不会再次排入归并。Phase 1 attempt 将输出格式版本与准确请求一同保存；新格式不重新解释旧结果。

## 模型体验

无，因为本包只保存协调状态，不提供模型提示或工具。

#### KV Cache 影响

无。Scheduler 的模型调用和提示注入属于其他 Consumer。

## 已知限制和后续工作

- **持久化机制由 Provider 决定** — 本 Definition 要求原子 CAS 和 fencing，但不规定 SQLite、文件锁或远程事务实现。

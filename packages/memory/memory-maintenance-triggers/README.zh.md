# @deepseek-ai/dsh-memory-maintenance-triggers

[English](README.md) | 中文

只消费 `MemoryMaintenanceService` 的唤醒桥接包。它在 Provider 启动、交互式 root Session 创建或恢复、控制变化、用户手动扫描或归并、quarantine 重试和非 note 的 Store work 事件后唤醒。交互式 turn completion 只 flush Session；ad-hoc note 会保持 pending，直到后续 root Session 启动或用户手动归并。该包不拥有定时器、模型调用、数据库访问或发布逻辑。

## 模型体验

无；该包只把生命周期事实转换为 Scheduler 唤醒原因。

#### KV Cache 影响

无。

## 已知限制与后续工作

- 触发器投递不保证模型 dispatch，仍需通过 Scheduler 资格与预算检查。

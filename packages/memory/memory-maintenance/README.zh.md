# @deepseek-ai/dsh-memory-maintenance

[English](README.md) | 中文

由记忆 Scheduler 实现的生命周期 Service Definition。Trigger Consumer 可以合并唤醒原因、运行一次有界调度并要求静默卸载，但不能访问流水线存储。

## 模型体验

无，因为本包只暴露 Scheduler 生命周期。

#### KV Cache 影响

无。模型调用由 Scheduler Provider 所有。

## 已知限制和后续工作

- **不显示为普通 job** — 在通用 jobs seam 支持 internal visibility 前，maintenance 工作保持 capability 私有。

# @deepseek-ai/dsh-experimental-task-execution-control

[English](README.md) | 中文

TaskExecutionControl 在 DSH 现有工具派发点统一执行 Final Reviewer 和 Progress Observer 的暂停决定。它不判断授权，不替代沙箱，也不修改 Provider 权限。

## 配置

```yaml
- name: '@deepseek-ai/dsh-experimental-task-execution-control'
  config:
    mode: shadow
    maxRepairWorkerSteps: 2
    maxRepairToolCalls: 6
    maxRepairMs: 120000
    maxTaskToolCallsPerTurn: 80
```

Enforce 支持受限改写、只读核验、有限修正、重新规划和结果未知恢复。待处理的真实用户 `next-step` 输入会阻止所有尚未启动的任务工具，包括嵌套调用，直到新的 Worker 请求已处理输入。注册表在审批、包装器等待和派发意图落盘后复查，最后检查与工具启动之间没有异步等待。普通 Queue 和插件提醒不构成用户屏障；撤回未领取插话会移除对应屏障。意图落盘不代表已启动：拒绝调用记录 `started=false`，已启动但缺少可靠结果的调用需要结果核验。

重新规划或结果未知挂起会使受影响 Agent 进入 Plan Mode。TaskExecutionControl 依次查找 Agent Context、通过 `AgentPresets.serviceFor()` 定位的 preset 隔离服务和部署根 Context；各种装配方式下 Plan Mode 状态都仍按 Session 隔离。TaskExecutionControl 在解析到的 Controller 上注册批准观察器，展示计划前捕获需求与执行 revision，只有确切的 `plan/review-approved` 回调通过这些版本校验后才解除挂起。对话中的普通确认或单纯切换 Plan Mode 都不会重新开放任务工具。

默认的 80 次任务工具是派发保险丝，不是语义上的“无进展阈值”。达到上限后，系统暂停新的任务工具，要求 Agent 说明已完成内容并重新规划。只有具备独立总预算的隔离评测才可设置 `maxTaskToolCallsPerTurn: false` 关闭该保险丝。Worker Step 数和普通 Turn 时长不设上限；语义无进展由 Progress Observer 判断。

DSH 原有沙箱、审批策略和 Tool Guard 仍是权限权威。Provider 提供的调用级只读查询可以核验结果未知的操作，而不会重新开放普通 Worker 工具。

文件观察保留后端目标与版本身份，最终审查会重新核对。依赖范围不明的命令检查在并发或后续可能修改工作区的操作后保守标记为 stale；未启动的拒绝调用不算修改，已启动但结果未知的调用按可能修改处理。历史结果仍可读取，但缺少新鲜度元数据不能证明当前版本。这些检查不覆盖未观察到的外部编辑、部署或远端状态。

核验沿用同一补救预算。可信只读工具可执行，影响未知的查询须对准确调用及当前执行版本逐次审批；批准不会开放全部任务工具。缺少证据进入核验，不自动重复原操作。

重规划通知要求说明已否定假设、对应证据、剩余问题及不同的验证方法。批准仍绑定实际展示的计划与当前版本；只重复“换个思路”不能证明进展，也不能授予新操作权限。

## 模型体验

### 执行限制通知

#### 模型看到的内容

带来源标记的通知说明 `rewrite`、`verify`、`continue_work` 或暂停状态。核验要求只读证据，影响不明确时须精确单次审批。修复通过后解除临时限制。

#### Token 影响

控制器不调用模型。状态变化只向 Worker 历史追加一条有界通知。

#### KV Cache 影响

通知扩展 Worker 后缀，不替换系统提示词。

## 已知限制与暂缓事项

- 新鲜度只覆盖观察到的文件版本和工作区活动，不覆盖未观察到的外部修改或远端状态。
- 已启动的副作用无法撤销，结果未知时须由 Provider 支持的恢复查询或用户批准的核验解决。

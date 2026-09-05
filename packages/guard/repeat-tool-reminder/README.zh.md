# @deepseek-ai/dsh-repeat-tool-reminder

[English](README.md) | 中文

该确定性 Guard 用于识别同一个 Agent 重复已经结束的相同操作。它不是模型工具，也不会定期调用模型。只有工具名、深度键排序后的 JSON 参数，以及最终结果或错误都完全相同，才算同一条连续重复链；新的真实用户消息会重置该链。

## 配置

```yaml
- id: repeat-tool-reminder
  name: '@deepseek-ai/dsh-repeat-tool-reminder'
  config:
    reminderCount: 3
    blockAttempt: 4
    include: []
    exclude: [todo_write]
    argumentsPreviewChars: 500
```

`blockAttempt` 必须等于 `reminderCount + 1`，非法整数会在加载时直接报错。`include` 和 `exclude` 是针对工具名的 `*` 通配符规则。被排除的调用对重复链透明：既不增加计数，也不重置计数。

第三个完全相同的调用／结果对结束后，插件追加一条带来源标记的提醒，要求 Agent 改变验证方式或说明阻塞。如果 Agent 准备派发未改变的第四次调用，`ctx.tools.guard()` 会在工具实现、Shell、浏览器或外部 Provider 启动前拒绝。拒绝结果按普通工具错误写入，steering 提示 Agent 重新规划。工具名、参数、结果发生变化，或用户插入新反馈后，都会开始一条新链。

活跃链按 Agent 隔离，重新加载时从现有 Session 调用与结果事件恢复；压缩不删除这段历史。Guard 自身的拒绝不算新证据，也不重置计数，后续未改变的尝试仍会被拒绝。每条不变的链只发出一次提醒和一次阻止通知。检测只做精确比较，不合并语义相近但内容不同的结果。活跃轮询通过可信运行时元数据识别。

可信的 `repeatPolicy: polling` 工具对同一活跃目标的成功状态查询不累计完全重复。Provider 核对目标身份和活跃状态；缺少元数据、失败或终态结果仍使用严格重复规则。Observer 的机械触发使用同一策略，但不会关闭语义时间窗口检查。

决策记录：[重复工具 Guard](../../../.agents/notes/archived/feature/2026-07-08-repeat-tool-guard.md)与[需求保留和交付控制](../../../.agents/notes/proposed/feature/2026-09-03-retained-intent-and-delivery-control.md)。

## 模型体验

### 重复提醒与被阻止的调用

#### 模型看到的内容

第三次相同结果会追加来源明确的提醒。未改变的第四次调用收到 `ctx.tools.guard()` 产生的普通工具错误和重规划通知；工具实现不会启动。

#### Token 影响

不调用模型。每条不变的重复链只向 Worker 历史追加一次提醒和一次阻止通知。

#### KV Cache 影响

通知扩展历史后缀，模型工具 Schema 不变。

## 已知限制与暂缓事项

- 精确比较不能识别参数不同但语义等价的操作。
- 轮询例外要求可信的活跃目标结果检查，不会关闭语义进度观察。

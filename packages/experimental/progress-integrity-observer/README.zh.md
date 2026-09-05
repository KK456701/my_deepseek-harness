# @deepseek-ai/dsh-experimental-progress-integrity-observer

[English](README.md) | 中文

该私有插件在确定性工具历史信号表明可能空转，或真实执行时间窗口需要核对进展时调用语义 Observer。普通任务长度不会触发它。

## 配置

```yaml
- id: progress-integrity-observer
  name: '@deepseek-ai/dsh-experimental-progress-integrity-observer'
  config:
    mode: shadow
    repeatOutcomeCount: 3
    failureStreak: 3
    alternatingCycles: 3
    semanticWindowMs: 300000
    maxUnconfirmedProgressMs: 600000
    minWindowToolResults: 3
    maxInputBytes: 262144
    provider: deepseek-official
    model: deepseek-v4-flash
    reasoningEffort: high
    maxTokens: 1024
    timeoutMs: 30000
    maxEvidenceLookupRounds: 2
    maxEvidenceSearchResults: 12
```

出现三次完全相同的调用／结果对、三个相邻任务工具真实失败，或没有变化的 `A-B-A-B-A-B` 调用／结果排列后，运行时会调用 Observer。真实执行满五分钟且至少完成三个任务工具结果时也会检查一次。观察窗口从 Turn 开始、用户引起的需求变化、正式计划批准或上次有效 `progress=yes` 重新计算；审批等待、执行暂停和 Observer 自身耗时不计入。系统不会因为一个 Turn 含有 6、20 或任何固定数量的 Step 而调用模型。

Observer 初始为每个选中结果保留一条定位，包含对应调用和可选目标提示，不重复列出调用条目或结果预览；只有缺少的一项细节可能改变结论时，私有的 `session_event_search/read` 才读取这次冻结的事件集合。越界或无效查询会作为工具错误返回给模型，使 Observer 能改用冻结索引判断，而不是让整次观察失败。它与 Final Reviewer 复用同一辅助查询适配，不进入 Worker 工具目录，也不生成任务工具事件。Observer 返回 `progress=yes|no|uncertain`、一个风险、引用的现有 Session Event 和简短原因。系统要求 Provider 只返回这四个字段；额外的无害顶层元数据会被丢弃，不能影响执行控制。`progress=yes` 时，`evidenceEventIds` 只接受当前窗口内真实的 `tool/result` 事件；能够提供新诊断信息的失败结果也可以引用；`tool/call` 只能证明已派发，不能证明有进展，因此校验会拒绝它并允许一次有界修复。Enforce 模式下，经验证的 `no` 或任一风险会立即暂停任务工具；执行已挂起或处于仅改写状态时，被拒绝的工具结果不会再次触发 Observer。`uncertain` 在再运行五分钟后复查，连续十分钟仍没有确认进展则暂停。Shadow 只记录，不改变执行。

单次格式修复沿用查询轮数和观察截止时间，保留已读证据，不回灌失败推理。收束请求不提供工具，证据不足仍须保持不确定。

连续失败计数复用冻结结果的状态：即使工具协议报告派发成功，Shell 非零退出和信号终止仍是失败。仅启动后台进程既不证明工作完成，也不代表执行失败。失败证据若排除了错误假设，仍可以构成语义进展。

## 模型体验

### 触发后的进度判断

#### 模型看到的内容

短于时间窗口且没有机械风险的正常工作不会增加 Observer 请求，也不会增加 Worker Token。触发后的请求只包含全部未取消需求、存在时的已批准计划、真实用户输入，以及选中事件的精简索引；只有通过 `session_event_read` 按需查询才返回完整参数或结果。同一输入与需求版本的最近有效阶段结论可以作为简短比较基准，但不能证明任务完成。仅登记状态的版本更新不重置计时；重复 Guard 的拒绝既不算进展，也不会再次触发观察。不包含 Worker 私有推理。请求在 Worker 历史之外审计。

#### Token 影响

只有触发观察时才增加有界辅助请求；证据查询共用观察截止时间和预算。

#### KV Cache 影响

Observer 请求使用独立稳定前缀，与 Worker 分开。

## 已知限制与延期工作

- 纯语义跑偏最多可能到五分钟真实执行窗口后才被发现。Final Reviewer 只在最终交付前做整体检查，不是执行中监控器。语义判断在独立标注评测达到部署门槛前仍属于实验能力。

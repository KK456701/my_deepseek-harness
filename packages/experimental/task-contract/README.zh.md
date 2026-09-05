# @deepseek-ai/dsh-experimental-task-contract

[English](README.md) | 中文

这个私有实验服务维护事件溯源的直接用户需求清单。Step 收到新的真实用户消息后，按领取顺序逐条调用无任务工具的“需求变更解析”模型，建议 `add`、`revise` 或 `cancel`。运行时分配身份与版本，把每项建议绑定到当前完整用户消息，并原子拒绝过期或无效批次。

## 配置

```yaml
- id: task-contract
  name: '@deepseek-ai/dsh-experimental-task-contract'
  config:
    mode: shadow
    injectWorkerContext: false
    parserProvider: deepseek-official
    parserModel: deepseek-v4-flash
    parserReasoningEffort: low
    parserMaxTokens: 4096
    parserTimeoutMs: 30000
    maxInputBytes: 65536
    maxRequirements: 128
```

`shadow` 记录解析失败后让 Worker 继续；`enforce` 在新输入无法归并时拒绝该 Step。JSON、Schema 或引用校验失败可以针对同一冻结输入修复一次；超时、取消和输出耗尽不自动重复相同请求。

## 需求清单语义

每个可独立回答、取消或验证的要求拥有稳定 `RequirementId`；共同约束只登记一次并保留作用范围。解析器仍可看到已完成需求，以便后续纠正重新打开同一身份。版本从一开始。`revise` 保持身份、增加版本、重新打开需求并清除旧完成证据；`cancel` 只取消目标需求，不删除历史。完成记录绑定确切需求版本，以及作为证据的回答或结果事件。

`task-contract/input` 在解析前保存已领取用户原文，包括空结果和失败。`task-contract/update` 格式版本 3 使用 compare-and-swap 推进一个 revision；回放不依赖压缩后的对话 surface。最新正式计划直接来自现有 `plan/review-approved` 事件，不调用计划验收项提取模型。

启用 `injectWorkerContext` 后，下一次根 Worker 请求会收到一份精简任务快照：按待完成、已完成和已取消分组，并在存在时附上用户正式批准的完整计划。快照不包含来源坐标、事件 ID、证据 ID和历史版本；内容不变时不重复追加。新快照会明确替代旧任务快照；若自动压缩遮蔽了当前快照，下一次请求会重新注入同一份当前投影。append-only 需求清单仍是权威数据。

## 辅助调用审计

实际 Worker 请求前，`task-contract/input-admitted` 只记录已成为真实 `user/message` 事件的输入 ID；追加发生在 Session 事件发布之外，每个身份只记录一次。解析失败不会误记为已进入历史。共享冻结结果索引用对应调用定位和可选目标提示替代结果预览；按需读取结果时一并返回原始参数和完整正文。

每次真实解析派发使用 `purpose=requirement-change-parsing`，记录已准备请求、派发、流式输出、终态响应、程序校验、模板哈希、投影版本、路由、耗时和提供方用量。连续的文本、推理和工具参数增量会在持久化前有界合并；终态响应仍保存完整组装内容，因此轨迹回放不依赖数千个逐字事件。这些事件不进入 Worker 历史，也不参与长期记忆提取。旧日志缺失的统计保持“未记录”，不补造。

保存输入不等于解析成功。解析失败后，下一条真实用户输入按原顺序重试未解析消息；插件通知不会静默重试。计划适用性由原批准事件处的需求 ID 和版本推导。后续新增、修改或取消需要结合变更核对；单纯登记完成不使批准失效。最新用户纠正优先于过期计划正文。

共享冻结事件查询通过对应调用的身份判定结果是否成功。Shell 非零退出和信号终止独立于工具派发成功，仍计为失败；后台启动或缺少调用记录不能证明完成。Observer 与 Reviewer 复用该结果，不修改原始 Session 事件。

## 模型体验

### 需求变更解析

#### 模型看到的内容

解析器只看到一条新的真实用户原文、按 `id / revision / text / verification` 投影的全部未取消需求（包括已完成项），以及存在时的最新正式批准计划。计划只出现一次且仅用于理解指代。一个总交付中可以分别回答或验证的子问题必须拆成独立变化；用户要求检查、运行、生成或核实时，即使最后以文字报告交付，也仍属于 `execution`。需求来源、状态、完成证据、已取消历史、Worker 推理和任务工具都不发送。模型不能填写来源；结果通过校验后，运行时统一绑定 UTF-16 区间 `0..message.length` 和完整用户原文。

#### Token 影响

每条新用户消息按领取顺序增加一次有界辅助请求。Web 实验装配使用 Low 推理、4,096 Token 输出上限和 30 秒超时；校验修复最多再增加一次。输出耗尽、超时、取消和传输失败不自动重试。

#### KV Cache 影响

解析请求使用独立稳定前缀，不改变 Worker 的缓存连续性。

## 已知限制与暂缓事项

- 语义拆分仍由模型判断。来源和版本校验能阻止伪造出处及迟到覆盖，但不能证明模型一定正确理解用户。

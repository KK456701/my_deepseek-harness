# @deepseek-ai/dsh-memory-scheduler

[English](README.md) | 中文

`MemoryMaintenanceService` 的 Provider。它只通过 `MemoryPipelineStore` 使用持久状态和发布能力，并通过 Agent、Session 与 LLM 服务冻结证据和运行模型。它不导入 SQLite、generation、pointer、Git 或文件发布实现。

Scheduler 合并唤醒、限制 discovery 和 claim、续租，并在卸载时等待全部 owned promise 收敛。每个 pass 是 internal `ctx.jobs` 记录。`extractionBackend` 和 `consolidationBackend` 独立选择 `llm` 或 `codex`。Codex 要求共享 `CodexStructuredRunner` Provider，缺少 Provider 时该 pass 明确失败。Consumer 在 dispatch 前提交准备好的请求，在 apply 前提交最终结果。Codex 调用采用任务证据和完整 generation JSON schema，不使用带工具的 Agent。LLM 归并保留五工具 rooted maintenance Session。

Startup、交互式 root Session 启动、手动扫描和显式 pending 工作归并可以领取新的 pending ad-hoc note。手动扫描执行有界 discovery，只忽略 `idleMs`；active Agent、年龄、长度、贡献、external context、额度和容量检查保持不变，新登记范围会在同一 pass 中继续 Phase 1 与 Phase 2。手动归并跳过 discovery，评估完整合格来源集合与获准处理的显式 note。Timer 和普通 pipeline 唤醒只能重试已经领取过的 note batch，不能把刚保存的 note 拉入 Phase 2；“请求已保存”与“正式记忆已发布”保持不同状态。

部署配置只初始化持久参数一次。每个 pass 读取最新 revision，已领取操作保持一致的参数。Codex 按次使用明确的模型和推理档位，不修改全局 Codex 配置。模型支持时，提取可选 `high`，归并可选 `max`。LLM 的 `consolidationReasoningEffort: inherit` 保留 Adapter 默认值。Token 上限应用于 LLM 调用；Codex 结果使用配置的字节上限。干净重建在启动时冻结 `sourceLookbackMs`，排除近期 Session 内较旧的 turn，并在重启后保留该截止点。

`disableOnExternalContext` 默认为 `false`，与 Codex 的可选外部上下文保护一致。已分类的工具结果继续作为脱敏、external-untrusted 证据进入普通 Phase 1 流程；同一范围内的用户直接要求仍有资格。开启时，保护在 dispatch 前拒绝整个冻结范围。`externalToolPrefixes` 控制分类。显式 note 跳过自动提取，不受此保护影响。

当所选路由通过 `memory/quota-remaining` 报告剩余额度百分比时，最低剩余额度阈值会暂停 Phase 1 或 Phase 2 claim。未提供额度 telemetry 的路由继续正常执行；Provider rate-limit 失败仍走持久重试策略。

普通 discovery 同样排除完成时间早于 `now - maxSourceAgeMs` 的 turn，包括近期 Session 内的旧前缀。该参数独立于重建的冻结回看窗口；持续学习也需要遵守相同时间范围时，应将两者设为相同长度。

`phase1Concurrency` 允许同时拥有 1–8 个提取任务，默认为 2；`maxPhase1ClaimsPerRun` 独立限制领取总数。Worker 只在空闲时领取，分别维护 heartbeat、audit 与失败状态；Phase 2 等待本轮已启动的提取全部结束。取消会停止新领取并等待已拥有调用结束。输出格式 2 将详细任务证据渲染为 raw memory，另外保存独立编写的 rollout summary 和 slug；已记录的格式 1 attempt 仍按格式 1 处理。写入模板身份属于 attempt，不再参与来源登记身份。

## 模型体验

### 后台请求

#### 模型看到的内容

提取接收脱敏后的有效证据，并区分用户和工具角色。Codex 输出必须引用已知 evidence id：偏好需要用户支持，已验证事实需要 tool-result 支持。空证据只留下 receipt，不生成 rollout。归并按语义比较独立来源、保留作用域与不确定性，并返回来源 retain/discard 决策；只有保留的证据会成为 generation 文件。运行时验证能证明 schema 和链接完整性，不能证明语义质量。`unexpected-tool-use` 和结果溢出不能发布；模型输出错误和 generation 校验错误执行有界重试。

#### 对 token 的影响

每次提取发送一个有界证据范围。每次归并发送选中的证据、note 和 baseline，不复制无关交互历史。

#### KV Cache 影响

后台调用使用独立审计请求或私有 maintenance Session，不进入交互任务的 prompt cache。

## 已知限制与后续工作

- 自然语言晋升和冲突处理仍由模型判断，结构校验不能保证语义质量。
- 开启时，external context 拒绝规则应用于整个冻结范围，包括用户消息。允许进入提取不代表外部内容可信。

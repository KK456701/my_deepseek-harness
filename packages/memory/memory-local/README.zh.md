# @deepseek-ai/dsh-memory-local

[English](README.md) | 中文

DSH 长期记忆的本地 Provider。它拥有 SQLite 流水线状态、有界审计载荷、不可变 generation、manifest 校验、staging 目录、读租约和带 fencing 的 `current.json` 发布。它同时提供公共 `MemoryService` 和私有 `MemoryPipelineStore`；它不调用模型，也不调度任务。

## 配置

`root` 必填，且必须为当前 profile 的绝对 `profilePath('memories')`。存储、审计和 generation 安全上限属于经过验证的部署参数。调度与 recall 参数是带 revision 的持久 profile 数据，支持乐观并发热更新。Schema 版本 3 到 7 和 9 增量迁移至版本 10。Schema 8 需要停用所有写入者后，离线执行先备份的 `upgradeMemoryUserText` 操作；原话只从已绑定的用户事件恢复，无法核实的原话保持不可用。其他版本和 application id 会被拒绝。

## 隐私和持久性

Schema 10 在增量迁移前为旧数据库创建一致性快照。旧范围计数仅按已记录的 Session 身份聚合一次，不推断未知来源。`maxPhase2Candidates` 迁移为 `maxPhase2Sources`，`phase1Concurrency` 默认为 2。迁移保留 generation、note、控制、epoch 和 policy，不派发提取。范围登记回执防止模板更新或清理后重新学习未变化的历史。

Phase 2 从全部合格 Session 的最新有效完整 rollout 中，依次按引用次数、最后引用时间（未引用时使用完成时间）、完成时间和稳定来源 id 排序。`maxPhase2Sources` 限制整个自动来源集合，active 显式 note 独立参与且保持权威。选中来源按 id 输出，输入登记与模型 retain/discard 决策分开保存。旧 generation 从已记录的 baseline 链恢复完整输入，避免只包含已采用证据的 retained 列表把考虑过的来源误判为新增。来源版本与 note 内容不变时跳过归并；同一集合内仅排名变化不会重写文件。

过期输出只有在成功发布将其排除，且当前 generation、有效读租约及运行任务均不再引用时才可回收。仅未进入 Top-N 不允许删除。最小来源回执和 reset 水位保留。引用计数提交会递增公共变更序列，但不修改记忆正文，也不唤醒归并。

在平台支持 owner 权限位时，Provider 会创建私有目录和数据库文件。它不提供静态数据加密。逻辑删除不承诺立即清除 SQLite 空闲页、WAL、备份或原始 Session 日志中的数据。generation 发布后保持不可变；prompt 或 UI 读取期间由读租约固定对应 generation。

Codex 归并使用私有结构化 attempt 记录：准确 app-server 请求在 dispatch 前提交，最终 JSON、结束原因、已暴露 usage 和错误在文件生成前提交。来源与 note 决策必须完整且唯一地覆盖冻结输入。Store 写入生成文件、移除丢弃的证据，并在发布前验证 generation。可选 LLM 后端改用私有 maintenance Session event，要求已持久化的 `request/header` 和终止 `turn/end`。两种 audit 都有容量上限与终态保留期，普通 Session API 无法枚举。

显式 note 分别保存 processing 和 authority 状态。发布只在 pointer 成功后提交每个 claimed note 的唯一 disposition。确认式干净重建提升 epoch、清空指针，删除派生 range、candidate、attempt、failure、audit、job、staging 和 generation。`sourceLookbackMs` 冻结完成时间截止点；`explicitNotePolicy` 选择保留 active note 或删除全部 note 与 tombstone。原始 Session、控制、参数和 reset 水位保持不变。首次归并领取所有保留的 active note。User reset 则通过 clear watermark 压制 reset 前范围。

当前 generation 会保留 raw memory 与 rollout summary，用于 provenance、引用、重建和按来源遗忘；它们绝不会作为正式记忆注入。被替换 generation 和终态 pipeline payload 通过有界清理离开存储；user reset 会删除可读记忆工作区，但 Session 子系统仍保留自身的原始日志。

登记范围时会裁去位于 Session reset 水位及其之前的前缀。Reset 后的新 turn 不能让旧事件重新获得提取资格。

提示词快照按文档顺序选择完整 Markdown 条目，保留原文、嵌套内容和来源链接。字节预算包含版本标记、标题、分隔符和引用定义。超大条目整条省略；快照同时返回条目计数。裁剪不修改 generation。仅写入模板发生变化不会使格式兼容的 generation 失效；读取故障仍作为错误报告，不伪装成空记忆。

## 模型体验

通过 prompt Consumer 和 scheduler 的隔离归并 Agent 间接影响模型。

#### KV Cache 影响

Provider 本身不增加模型可见文本。它向 prompt Consumer 返回按字节限制的摘要快照，后者记录实际注入的文本。待处理的语义修改和删除会在快照与 recall 读取前过滤，不可变 generation 仍保留用于查看及冲突检测。

## 已知限制与后续工作

- 语义支持仍由模型判断；链接校验只能验证所引用的来源，不能证明生成内容为真。
- 逻辑删除不抹除原始 Session 历史，也不保证数据库页及备份中的物理擦除。

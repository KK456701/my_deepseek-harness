# Agent Note: 以 Profile 为作用域的长期记忆

Status: proposed

[English](2026-09-01-profile-long-term-memory.md) | 中文

## Problem

交互 Session 会保留自身的持久历史，但后续 Session 无法复用稳定偏好、已验证流程、失败纠正或用户要求保存的记忆，只能重新打开旧对话。把完整历史复制进每个请求既昂贵又不安全，因为历史证据可能过时、包含秘密或来自外部上下文，而当前指令与当前工具结果必须保持权威。

该能力还需要可恢复的后台模型调用、可检查的最终记忆、跨进程发布安全、明确的 remember/update/forget 语义和管理 UI。只用数据库会隐藏分层的模型可见材料，只用可变 Markdown 又无法提供 lease、audit 顺序、retry 状态、reset 水位或旧 writer fencing。

## Proposal

为每个已解析的 DSH profile 增加默认关闭的长期记忆能力，提取、归并和读取语义固定对照 Codex commit `eb10d91e48ccbd0930427461fb392337addb1ac0`，并叠加本 Note 规定的 DSH 发布与管理保护。私有 SQLite State 数据库协调 source range、policy generation、lease、retry、模型调用审计、显式 note、使用统计和发布。不可变 generation 目录是最终模型可见知识库：`memory_summary.md` 是高密度 prompt 层，`MEMORY.md` 是可检索 Task Group 层，`skills/` 保存重复且经过可靠验证的流程，后端所有的 rollout 文件保留任务证据。原子 `current.json` 指针选择一个经过 fencing 的 generation。

该能力有三层内部所有权。`memory-local` 提供公共 `MemoryService` 和私有 `MemoryPipelineStore`，独占 SQLite、私有 audit、staging、manifest、Git baseline、generation、锁和指针。`memory-scheduler` 消费私有 Store 以及 Agent、Session、LLM、Jobs 服务并提供 `MemoryMaintenanceService`，负责 discovery、证据冻结、提取、归并、重试和完全停稳，但不导入存储实现。`memory-maintenance-triggers` 消费维护服务，把 Provider 启动、交互式 root Session 启动、deadline、control、用户手动扫描或归并和非 note 的持久工作事件转换为合并唤醒。Prompt、Remote 和 UI Consumer 只能使用 `MemoryService`。

自动提取由后续 Session 调度：交互式 turn completion 只 flush Session，不唤醒记忆任务；后续交互式 root Session 创建或恢复时，才对已经充分 idle 的旧 Session 做有界 discovery。管理 UI 分开提供两个显式操作。手动扫描执行有界 discovery，只忽略配置的 idle 时间；活跃、不安全、过短、过旧或禁止贡献的 Session 仍被排除，新发现范围继续进入 Phase 1 和 Phase 2。手动归并不做 discovery，只消费已经持久化的候选与显式 note。显式 remember、update 或 forget 会立即持久化 active pending ad-hoc note、跳过 Phase 1，并等待下一次正常 Phase 2 唤醒。创建 note 不会隐式发起模型调用，也不能在新 generation 提交前宣称已发布。

Phase 1 以一个完整且符合资格的交互式 Session rollout 为 source，而不是把每个 turn 当作独立来源。它冻结到最后一个已完成 root turn 为止的有效 Session surface，排除 fork seed 和被 replacement 遮蔽的节点，把工具调用与有效结果配对，并在一份 Stage 1 结果中保留多个任务。精确请求在 audit 和发给模型前执行字段级 secret redaction，模型输出在写入 Stage 1 前再次检测。没有记忆内容的结果也是成功结果，并推进 source progress。

Phase 1 保留任务 outcome、scope、EvidenceId、用户近似原话、重复 steering、中断、redo、范围缩小、错误动作、替代动作、命令、路径、API、环境条件和验证，但不分配不可逆的晋升等级。短但有意义的纠正与长消息使用同一套证据规则。弱 next-step signal 只能作为任务证据，不能直接成为全局偏好；中断或 redo 首先形成 failure shield。Phase 2 先跨 rollout 归并偏好：语义一致的独立证据无需字符串完全相同即可提高稳定性，同一作用域的新明确表达可以更新旧表达，不同作用域可以并存，无法解决的冲突保留为正式详细记忆但不能成为自动注入的默认偏好。晋升会生成密度更高的链接表示而不删除低层证据。Skill 必须是重复、可执行且有可靠证据的流程，最低支持任务数由 `skillMinSupportingTasks` 配置；早期失败后得到验证修复的流程也可以形成 failure-shield Skill。

Codex 后端使用 app-server 集成提供的私有 `CodexStructuredRunner`。两个阶段按次传入冻结的模型、推理强度、提示词和 JSON schema，不修改全局 Codex 设置。Phase 1 返回任务级证据；Phase 2 返回完整摘要、手册、Skill 文件、来源决策及每个 claimed note 的唯一 disposition。Store 在 dispatch 前审计准确的 app-server 请求，在应用前审计最终结构化结果，然后自行生成并验证文件。调用使用空临时目录、只读沙箱、无人审批策略，并关闭可选工具功能。任何观察到的工具 item 都使 attempt 失败；该观察机制不证明上游工具绝对没有执行。Commentary 和推理过程不保留。现有 LLM 后端仍可选择，基于工具的归并继续使用私有 maintenance Session。

`memory_summary.md` 在固定字节预算内包含 `User Profile`、`User preferences`、`General Tips` 和 `What's in Memory`。摘要中的每个列表项都必须包含真实的相对 Markdown 链接，纯文件名和文字引用会被拒绝。`MEMORY.md` 以 `# Memory` 开头，使用顶级 `# Task Group:` block，并要求各 Task section 包含有链接的 rollout 文件及适合 grep 的关键词。生成链接形成后端校验的来源图，`generation-manifest.json` 记录哈希、heading、行区间和传递 source id。Source selection diff 支持 best-effort 局部遗忘：只由 removed 自动来源支持的内容会删除，仍有 retained 支持的内容保留，active 显式 note 继续具有权威，发布 manifest 不得包含 removed 来源。

Provider 从已经校验的 Markdown 和 manifest 派生可管理的语义条目，不把任意文本行暴露为编辑对象。User Profile、User preferences 和 General Tips 的 bullet 以及完整 Task Group 是带 revision 的目标。Update 和 delete 携带 generation、行区间与内容哈希，生成结构化显式 note，并在 Phase 2 生成下一份不可变 generation 期间立刻从 prompt 和 recall 中压制旧条目。Skill、rollout evidence、raw memory 与 manifest 始终只读。

公共控制把读取与贡献分开。`use` 控制摘要注入以及 `memory_list`、`memory_search`、`memory_read`；`contribute` 控制自动 Phase 1 登记。由于 prompt assembly 早于当前 inbox 消息接纳，每个交互式 Agent 都会声明 `memory_update_request`；工具执行时，可信 runtime 代码要求当前已记录用户消息包含匹配的 remember、update 或 forget 动作，并自动绑定 Session、turn 和 user event。Recall 被拒绝时 forget 仍可用，reset 绝不允许模型自主调用，disabled profile 仍可管理和删除。处理状态与持续权威相互独立，因此 applied remember note 和 forget tombstone 会保持 active，直到被 supersede、clear 或 reset。

读取路径只注入带 lease 且受字节限制的摘要和窄化 recall tools，准确 prompt section 写入 `request/header`。Recall Gate 对自包含请求跳过检索，在历史决策或歧义场景执行一次轻量 lexical pass，并允许在熟悉错误、scope 变化或重复失败后执行第二次。Runtime counter 强制限制每 turn 的 pass、tool call 和不同 detail file 数量。记忆始终是不可信且可能过时的数据：指令遵循 DSH 既有优先级，当前任务约束高于历史偏好，当前代码或工具输出高于历史事实。

运行参数使用乐观 revision，在下一 turn 或 claim 生效，无需重启。Backend、模型和推理档位按 attempt 冻结；模板身份参与提取 fingerprint 和 manifest。确认式干净重建提升 epoch、清空指针和派生状态，保留原始 Session、控制、参数与 reset 水位。持久完成时间截止点来自请求的回看窗口，默认五天；近期 Session 中较旧的 turn 不作为证据。`explicitNotePolicy` 选择保留 active note 与 tombstone，或全部清除。重建绕过 idle 和年龄资格限制，等待活跃 Session，不暴露半成品。User reset 则写入 `clearThroughSeq` 以阻止重新学习 reset 前历史。输出预算耗尽或验证失败不能发布部分文件，重试使用干净 staging。

可选的 `disableOnExternalContext` 保护默认关闭，与 Codex 文档默认值一致。已分类外部结果保留原始角色且仍是不可信证据；除非开启保护，否则不取消相邻用户直接消息的资格。两种设置使用相同的审计提取流程。显式管理在 recall 关闭或为空时仍有稳定的 prompt section，只有保存成功后才能确认。摘要选材同时考虑未来行为价值与证据支持：孤立的安装事实和脚本注意事项在有价值时进入详细记忆，不自动进入画像或通用经验。面向未来的称呼要求属于偏好证据，不是一次性寒暄。

请求级可见性通过模型不可见的观察记录实现，在请求入口关联实际持久化的 header，不伪造工具调用，也不把组装成功当作请求记录。重复摘要复用 header 正文。Markdown 完整条目选择限制每次注入大小，不修改已发布 generation，也不因写入模板变化使其失效。显式对话请求分别保留脱敏后的真实用户原话和模型建议；后续归并以原话约束作用域、否定、频率和位置。语义保真仍是模型行为验收标准，不是数据库能证明的等价性。历史原话只有在绑定的 Session 事件可以核实时才补充，否则保持不可用。schema 升级在停机备份后执行，不重新提取记忆、不改变调度，也不增加后台过程面板。

提取使用有界且独立的 worker，归并等待它们结束后按引用反馈从全部有效 Session 来源选材。Raw 任务证据与 rollout 摘要是用途独立的产物。持久完整输入集合防止模型丢弃决定造成重复归并；使用排名只选择输入，不决定摘要或手册布局。卡片正文只渲染一次，来源计数不等同于精确条目使用量。增量升级先备份，保留现有记忆与提取回执；新请求格式不触发历史提取。

## Alternatives considered

**独立的用户意图专用提取流程。** 否决，因为可选保护与现有区分角色、执行脱敏的证据投影已经能保留直接要求，无需增加另一套生命周期。用户引用材料与外部结果仍需判断语义归属，不能仅因出现在 transcript 中就成为用户意图。

**修改全局 Codex 模型设置。** 否决，因为提取和归并需要独立的按次模型与推理设置。部署选择受支持的模型和档位，不影响其他 Codex 任务。

**始终重建全部保留历史。** 限时重建不采用此方式。确认操作记录不可变的完成时间截止点，默认回看五天，同一个近期 Session 中更早的 turn 也不能进入证据。用户单独选择保留 active 显式 note，或清空全部 note 与 tombstone。原始 Session、控制、参数、consent 和 reset 水位保持不变。空提取只留下内部 receipt；来源决策使无用证据文件不参与发布。

**使用 SQLite 作为最终知识库。** 否决，因为模型可见记忆需要可检查、可链接、适合 grep 且压缩率不同的层。SQLite 继续作为协调和恢复存储。

**只使用可变 Markdown。** 否决，因为 dispatch 前 audit、跨进程 claim、reset 水位、note authority、原子发布和崩溃恢复需要事务状态。

**让普通文件工具读取 memory root。** 否决，因为专用 list/search/read 工具才能执行 `use=deny`、root 授权、确定性限额、citation telemetry 和模型可见工具发现。

**把一次观察到的行为直接变成偏好。** 否决，因为 task-local 要求和弱推断不等于长期用户意图。明确面向未来的请求可以一次晋升，普通推断需要重复且兼容的证据。

**在同一 profile 内按 workspace 划分记忆。** 本能力否决。Profile 是隔离单元，workspace 身份只作为来源和相关性元数据。

**允许 Phase 2 改写 rollout 证据。** 否决，因为 source 统计、局部遗忘、citation 和用户检查都依赖不可变证据。

## Acceptance criteria

- 独立提取 worker 遵守并发和领取限制，单项失败不取消其他任务。选材复用高频已消费来源，跳过未变化集合，note 不占自动容量。回收遵守发布、lease 与回执约束。迁移保留当前文件，不派发历史提取；UI 测试验证正文单次展示与逐来源跨进程反馈。
- Service Definition、Provider、Consumer 和 Loader 图保持三层所有权且没有依赖环；Scheduler 源码不导入 SQLite、pointer、Git 或 generation 实现。
- Phase 1 接受多个任务，在不丢弃安全内容的前提下脱敏，在 dispatch 和 apply 前分别完成 audit，并推进空结果。
- 外部与用户混合范围默认正常 dispatch，仅在开启保护时被排除。Recall 关闭时显式要求仍可保存，存储错误不能返回成功凭据。真实对话验收保存的 note 及其用户事件来源，而不只检查助手的口头确认。
- Codex attempt 拒绝观察到的工具活动，要求完整的结构化来源与 note 分区；LLM 后端的五工具限制于 staging。两个后端都必须通过规范 Task Group、摘要链接、来源闭包和所有权检查才能发布。
- Summary、Task Group、skill 和 rollout evidence 按各自压缩层保留链接表示；summary 超预算时整条删除低价值项。
- `use=deny` 隐藏注入和 recall tool，但显式管理仍可用；`contribute=deny` 阻止自动来源登记；disabled memory 仍可查看和 reset。
- 交互式 root Session 启动会唤醒 maintenance，普通 turn completion 只执行 flush。手动扫描只绕过 idle，仍执行其他全部资格检查；手动归并不执行 discovery。显式 note 不触发模型调用，会保持 pending，直到后续正常调度或用户手动归并。
- Recall 限额按 turn 强制执行，citation 更新 source usage，replay 使用已记录 prompt section 而不是当前磁盘状态。
- 过期来源产生 removal diff；retained 或显式支持阻止过度删除。preserve-active 重建保留显式权威，reset 阻止重新发现旧范围。
- 干净重建删除旧派生 source、candidate、audit、job、failure、staging 和 generation，保留 Session、控制和 reset 水位，应用所选 note 策略，重启后保留截止点，并在证据投影前排除较旧 turn。
- 普通 discovery 将配置的年龄上限应用于每个完整 turn，而不只检查 Session 的最后活动时间。即使同一 Session 新增 turn，reset 水位仍裁去旧前缀。
- 语义条目 update/delete 会拒绝旧 generation 或内容哈希，立即压制待处理的旧内容，并且只能通过校验后的新 generation 持久生效。
- Token budget 耗尽会显示分类、配置上限和尝试次数，且不能发布部分 generation；操作超时会取消 live maintenance Agent，并持久化为可重试的 Provider timeout。
- Fencing 阻止旧 owner 发布；私有 one-shot 和 maintenance audit 可重建每次后台模型调用；disposal 等待所有 owned work settle。
- Unit、backend、真实 Loader、keyless snapshot、Web component、可选 provider 和真实浏览器流程覆盖已装配能力。

## Risks

一个 profile 会有意在多个 workspace 间共享记忆。需要更强隔离的用户必须使用不同 profile。

Provenance link 只能证明生成内容引用了哪些证据，不能证明模型正确解释了证据。自然语言归并和部分遗忘仍是 best effort，manifest 完整性、removed-source 排除、lease 和发布 fencing 由代码强制。

Secret detection 基于模式，可能漏掉未知格式。命中 secret 的 generation 会被拒绝发布，但原始 Session 的保留由 Session 子系统负责。

SQLite 文件、WAL page、backup 和原始 Session log 不加密，逻辑删除也不承诺立即物理擦除。产品文档必须说明这一限制。

手动扫描可能比自动调度更早为刚完成的 Session 发起模型调用。它是明确的用户操作，仍使用相同的有界扫描和 claim 限额，也不会从活跃 Agent 手中取得 maintenance 所有权。

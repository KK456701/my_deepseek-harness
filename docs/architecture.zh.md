# DeepSeek Harness 架构

[English](architecture.md) | 中文

改动 `packages/` 下的任何内容之前，请先阅读本文。本文假定你已了解 Cordis；如果尚未了解，请先阅读[入门](cordis-primer.md)或[教程](cordis-tutorial/index.md)。

建议使用 agent（智能体）探索代码库并理解其架构。

## Cordis

[Cordis](cordis-primer.md) 是 dsh 底层的框架：插件向共享上下文贡献服务、类型化事件和可逆的副作用。产品的每一部分都是插件，包括模型适配器、工具注册表、会话日志，以及 agent loop（智能体循环）本身，因此每一部分都可以从配置替换。

不存在需要打补丁的特权内核：扩展 dsh 的方式是把插件挂载到其他插件旁边，而各项注册都是副作用，会在其插件卸载时撤销。

## Profile 与组合包

运行中的 `dsh` 是一棵插件树，由启动时按序叠加的各层组合而成。

**profile** 是存放在 Harness home 中的具名组装。它列出自己叠放的组合包，存放自己安装的树外插件，并保存用户自己的 `cordis.patch.yml`。`web` 和 `headless` 作为模板随发行版交付。

**组合包**是 Cordis 配置项及其挂载代码的分发格式，因此它插入的内容始终可被其上各层 patch。

两者都在各自的 `package.json` 中通过 `dsh` 字段声明自己：`dsh.profile` 列出一个 profile 的组合包，`dsh.bundle` 指向一个组合包的 patch 文件。

[`dsh-base`](../packages/bundle/base/README.md) 是每个 profile 的第一层：模型适配器、工具、持久化、沙箱与审批策略、设置、凭据、遥测。[`dsh-web-app`](../packages/bundle/web-app/README.md) 增加浏览器应用；[`dsh-headless`](../packages/bundle/headless/README.md) 增加一次性运行器，且完全不带服务器。

各层按此顺序应用在空条目列表之上：先按 profile 列出的顺序应用每个组合包，然后是 profile 的 `cordis.patch.yml`，然后是 home 级的那份，最后是任意 `--patch` overlay。一条 patch 按 id 定位某个条目并替换其整个 config，或插入新条目。

要查看你的机器实际启动的配置树：

```sh
dsh --profile web --dump-config
```

它打印出的任何条目，都可以由你自己的 patch 替换。

组装机制见 [app-boot](../packages/boot/app-boot/README.md#profiles)；配置字段见生成的[配置目录](config-catalog.md)。

## 核心包

以下是向 Cordis 树贡献内容的部分核心包。

| 包 | 职责 | `ctx` 键 |
|---|---|---|
| [`core/session`](subsystems/session.md) | 仅追加的 `SessionEvent` 日志和内存存储 | `ctx.sessions` |
| [`core/system-prompt`](subsystems/system-prompt.md) | 提示词片段与工具 schema 的组装 | `ctx.systemPrompt` |
| [`core/tools`](subsystems/tools.md) | 作用域化的工具注册表和带把关的执行流水线 | `ctx.tools` |
| [`core/agent`](subsystems/core.md) | `Agent` 接口、活跃 agent 注册表和 `agent/*` 事件 | `ctx.agents` |
| [`core/agent-loop`](subsystems/core.md) | 实现该接口的默认驱动器 | `ctx.agentLoop` |
| [`core/scope`](subsystems/scope.md) | 按 agent 划分作用域的注册原语 | 库，无 ctx 键 |
| [`llm/llm`](subsystems/llm-streaming.md) | 消息与流式词汇表，以及适配器 seam | `ctx.llm` |
| [`memory`](subsystems/memory.md) | Profile 级长期记忆、不可变 generation、召回和后台归并 | `ctx.memory` |

<a id="events"></a>

## 事件

事件就是扩展点，而选对事件域是大多数改动的第一个决定。

- **会话事件**是追加到日志并通过 `session/event` 广播的持久事实。当某个事实必须在重新加载后仍然存在时，使用它。
- **Agent 事件**（`agent/*`）携带活跃 `Agent`：inbox、步骤、状态、请求、验证、续跑。要观察或拦截进行中的工作时，使用它。
- **能力事件**无需导入循环即可向某个 seam（`fs/*`、`tools/*`、`telemetry/*`）附加策略和适配器。

[事件映射](event-producer-consumer.md)列出每个事件的生产方与消费方。

<a id="turn-flow"></a>

## 轮次流程

一个**步骤**是一次模型请求加上它调用的工具。一个**轮次**包含零个或多个步骤：它在领取首条输入之前打开，并在不再欠下任何工作时关闭。

```text
turn/start
  claim next-step input plus one queued message
  assemble prompt sections + tool schemas
  -> agent/pre-step                   reject | enter(messages)
     reject, or a first enter rewritten empty -> close the turn with no step
     step/start
     append entered messages as user/message
     agent/request-starting
     derive model history from the log
     agent/request -> llm/stream
       live: assistant/chunk* -> assistant/message
       deferred: private durable chunks -> agent/final-candidate -> guarded assistant/message
     tool/call* -> tools/pre-execute -> tools/execute -> tools/dispatch-ready -> body -> tools/post-execute -> tool/result*
     step/end
     tools owe another request, or next-step input arrived -> claim -> next step
  -> agent/turn-stopping
turn/end
```

`turn/*`、`step/*`、`user/message`、`assistant/*` 和 `tool/*` 是持久会话事件；其余是分属三个事件域的实时扩展点。`agent/request-starting` 是每次请求尝试都会同步发出的 broadcast，重试也包括在内。`agent/pre-step`、`agent/request`、`agent/assistant-delivery`、`agent/final-candidate`、`llm/stream` 和四个 `tools/*` 事件是 waterfall（瀑布式事件）；监听器需要调用 `next()` 才能委托，除非它负责返回该结果。`agent/turn-stopping` 是 serial 事件，没有 `next()`。`tools/dispatch-ready` 在派发包装器之后执行，随后在工具本体启动前同步复查取消信号和 guard。

输入通过同一个 inbox 到达驱动器。有些消息会立即唤醒它；注入的上下文会留在 inbox 中，直到另一条消息将其唤醒。

`agent/pre-step` 决定模型看到什么。监听器可以改写已领取的消息，也可以直接拒绝它们；首次领取被拒绝或被改写为空时，仍会关闭一个不含步骤的持久轮次，因此日志会记录这次尝试。每个步骤读取插件注册的提示词片段和工具 schema。

普通交付仍然是 live。显式启用的插件可以通过 `agent/assistant-delivery` 提供持久 staging writer。工具调用响应在 staging 后提交，以便继续执行；最终文本 Candidate 会进入 `agent/final-candidate`，其中的同步 validator 会在普通 Assistant Message append 前立即执行。[实验性 Task Contract 与 Final Gate](subsystems/task-contract-final-gate.md)使用这条路径阻止陈旧或不完整的最终回答，同时不把 rejected draft 放进模型历史。

详情见[时序图](agent-lifecycle.md)、[工具流水线](tool-execution-pipeline.md)和[取消与错误恢复](subsystems/core.md#the-agent-handle)。

## 会话日志

会话日志是交互式模型请求所见上下文的来源。`deriveMessages()` 从中投影出模型历史，原始 `assistant/chunk` 事件则保证回放和 UI 保真。fork、恢复、transcript（文本记录）、遥测和持久化都派生自该事件流。

**每个模型请求在分派前都可持久重建。** 交互式请求从会话日志重建，因此新增交互式模型可见输入需要新增 `SessionEventMap` 事件。经明确批准、由 capability 拥有的一次性调用可以改为在私有 audit store 中持久化准确的冻结请求和观察结果；只有结果持久化后，才能提交由它派生的状态转换。带工具的 Agent 式维护仍使用私有 Session，使其 prompt、工具调用、工具结果和最终回复均可重建。[请求重建决策](../.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md)规定通用规则，[capability 私有 audit 决策](../.agents/notes/proposed/architecture/2026-09-01-capability-owned-model-call-audits.md)规定例外条件。

## 能力 seam

一个 **seam** 是一项可替换能力，包含三种角色：声明接口的 **Service Definition**、实现它的 **Service Provider**，以及使用它的 **Consumer**（通常是面向模型的工具）。一个包可以合并承担多个角色，但单一角色本身不是 seam；添加一项能力意味着把三者一并设计（[能力图](capability-seams.md)）。

seam 正是替换一个提供方就能改变整个产品的原因。文件系统与进程提供方共享同一个执行世界，因此把它们指向远程沙箱，也就把 Bash、PTY 和 LSP 一并搬了过去，无需提供方专用 fork。[subagent 提供方](subsystems/subagent.md)在同一个接口之后同样千差万别，从新建一个子 agent，到把一个轮次委派给另一个产品。

[实验性 Agent Teams](subsystems/agent-team.md) 是 `ctx.agentTeams` 上的私有显式启用协作 seam，在可继续 subagent 之上提供持久 roster、任务板和 mailbox。

## 新行为的归属位置

新行为附加到已有文档记录的扩展点。改动循环本身时，本映射随之更新。

| 目标 | 机制 |
|---|---|
| 添加模型提供方 | 在 `ctx.llm` 上注册其适配器 |
| 添加面向模型的能力 | 在 `ctx.tools` 上注册；其 schema 加入提示词组装 |
| 让某个会话拥有不同的能力集合 | 组装一个 agent preset；其中的服务行需要 `isolate` realm |
| 添加 shell 执行 | 注册 `ctx.shell` 后端；本地后端通过 `ctx.subprocess` spawn 进程 |
| 添加持久化终端执行 | 注册 `ctx.terminals` 后端和 `dsh-tool-terminal` |
| 添加用户命令 | 在 `ctx.commands` 上注册；它无需模型轮次即可分派 |
| 添加后台工作 | 在 `ctx.jobs` 上注册；`job_*` 工具负责收集或停止 |
| 添加文件系统访问或策略 | 注册 `ctx.fs` 提供方，或监听 `fs/*` 事件 |
| 限制所启动的进程 | 使用 `ctx.sandbox` 后端；消费方在启动进程前包装 argv |
| 拦截请求、工具或轮次 | 使用相应的 `agent/*` 或 `tools/*` 事件；`agent/turn-stopping` 会停止轮次 |
| 添加模型可见上下文 | 调用 `agent.inject()`；它会落到下一次获准的请求中 |
| 添加 UI 或编辑器集成 | 驱动 `ctx.agents` 并从 `session/event` 渲染 |
| 添加 Web Client Chat 节点 | 注册 `ConversationNodeDefinition` + keyed renderer |
| 添加持久会话状态 | 扩展 `SessionEventMap`；从日志渲染和回放 |
| 生成会话标题 | 注册唯一的 `ctx.sessionTitle` 提供方 |
| 管理同会话目标 | 使用 `ctx.goals`；通过 `agent/*` 续跑 |
| fork 活跃会话 | `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| 将注册项限定到单个 agent | 使用该 agent 的 `agent.ctx` |

[扩展实操手册](cookbook/extension-cookbook.md)将功能映射到能力，并索引[包](cookbook/adding-a-package.md)、[工具](cookbook/adding-a-tool.md)、[LLM（大语言模型）适配器](cookbook/adding-an-llm-adapter.md)、[Chat 节点](cookbook/adding-a-conversation-node.md)和[设置卡片](cookbook/adding-a-settings-card.md)的分步指南。

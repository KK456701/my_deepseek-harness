# @deepseek-ai/dsh-codex-structured-runner

[English](README.md) | 中文

用于单次 Codex JSON 调用的私有 Service Definition。`dsh-subagent-codex` 提供该服务，`dsh-memory-scheduler` 消费该服务。加载 Definition 不会启动进程或注册模型工具。

`prepareCall` 启动 app-server，通过 `config/read` 读取 MCP 标识，再冻结关闭这些服务器、已安装插件和旧版通知命令的请求；此时不启动 thread，也不调用模型。Consumer 必须在单次 `dispatch` 前持久化 `exactRequest`，在应用结果前记录结果，并始终在 `finally` 中等待 `dispose`。取消覆盖准备阶段，并在所拥有进程树退出后完成。请求记录描述 app-server API 边界，不代表 Codex 内部的 Provider 请求装配。

## Model Experience

间接通过 app-server Provider 和 Scheduler 的证据转换请求生效。

#### KV Cache effect

每次调用使用新的 ephemeral Codex thread，与交互式 DSH Session 独立。

## 已知限制与后续工作

- Audit 覆盖 app-server API，不代表 Codex 内部的 Provider 请求装配。
- 成功结果没有被观察到的工具调用；观察机制不能证明上游工具从未执行。

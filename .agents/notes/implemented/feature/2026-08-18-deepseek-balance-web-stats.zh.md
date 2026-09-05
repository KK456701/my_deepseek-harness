# Agent Note: Web 统计中的 DeepSeek 余额

Status: implemented

[英文](2026-08-18-deepseek-balance-web-stats.md) | 中文

## Problem

Web 会话统计条能报告 Session 活动，却无法报告用于支付 DeepSeek 请求的账户余额。浏览器不能安全地直接请求提供方，因为 API key 属于 Host 凭据服务；把账户余额写入 Session 日志又会错误地将外部账户状态变成持久会话状态。

## Decision

`LlmRuntime` 拥有以 settings namespace 为键的账户余额 registry。提供方插件为自己的 namespace 注册一个查询，返回提供方无关的货币余额行，其中包含总额，以及可选的赠金和充值余额。注册是 Cordis effect，会随拥有它的 fiber 一起消失。

`dsh-llm-deepseek` 注册 `llm-deepseek` 查询。每次调用都会解析与模型请求相同的当前端点和凭据快照，发送 `GET {baseURL}/user/balance`，并在返回前校验不可信的 JSON。提供方错误可以指明端点或状态码，但绝不包含凭据。

Host 将该查询暴露为特权 `llm.balance` RPC。Web 统计条会在挂载时、token usage 增长后，以及浏览器窗口重新获得焦点时请求 DeepSeek namespace。较新的刷新会取消前一个刷新，组件卸载会取消活跃请求，所有返回的货币行都会按提供方顺序渲染；查询不可用时，余额分组保持缺席，不会改变 Session 统计。

## Alternatives considered

**由浏览器直接请求 DeepSeek。** 拒绝，因为这会把 API key 移入浏览器状态，绕过 Host 凭据权威，并依赖提供方的 CORS 行为。

**以固定间隔轮询。** 拒绝，因为任意的间隔是隐藏在展示组件中的部署策略，并且在没有余额变化活动时仍会持续产生网络流量。模型用量与窗口焦点提供了有意义的刷新点，无需定时器。

**在 Session 日志中记录余额。** 拒绝，因为账户余额是外部可变状态，而非某个会话的持久事实，它不得进入模型历史、回放、fork 或压缩。

## Consequences

Web 统计条会在首次加载后显示每种 DeepSeek 货币余额，并在本地已计费模型工作完成后立即刷新。当窗口持续处于后台时，其他客户端产生的变化会在该窗口下次获得焦点时出现，而不会通过后台轮询出现。

浏览器会收到金额，却永远不会收到凭据。余额读取不发起模型调用，不追加 Session 事件，也不添加任何 prompt 或 KV cache 内容。已配置的 gateway 必须在其 base URL 下暴露 DeepSeek 余额端点；否则会话仍然可用，余额分组保持隐藏。

提供方组合测试固定 HTTP method、path、凭据 header、响应校验与不泄露凭据的失败行为。Registry、Host RPC、carrier、client fixture 与组件测试固定生命周期 dispose、特权传输、多货币渲染、刷新触发与取消。

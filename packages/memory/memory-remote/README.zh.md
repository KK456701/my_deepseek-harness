# @deepseek-ai/dsh-memory-remote

[English](README.md) | 中文

面向公共 profile 记忆服务的可信 Host Remote Consumer。它通过生成的 Typert 方法暴露 profile 与 Session control、实时运行参数、已验证 generation 浏览、显式 note、相互独立的手动扫描与 pending 工作归并请求、reset 和 quarantine retry。模型 recall 保持在进程内 Prompt Consumer 中。它不会解析或暴露私有 pipeline Store、lease、audit payload、staging path 或发布操作。

## 模型体验

无。此适配器服务可信产品客户端，不贡献模型输入。

#### KV Cache 影响

传输层不贡献 prompt 字节；宿主 Consumer 渲染已提交状态。

## 已知限制与后续工作

- v1 的授权粒度是 profile；一个 profile 是一个有意共享的记忆空间。
- 文件响应保留 Provider 配置的字节上限，且不会返回未经验证的 generation 文件。

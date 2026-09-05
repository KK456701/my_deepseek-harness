# `@deepseek-ai/dsh-memory-bundle`

[English](README.md) | 中文

这是标准的 profile 长期记忆装配包。它通过 patch 挂载本地公共服务与存储提供者、调度器、维护触发器、Prompt Consumer 和 Host Remote Consumer，并且只使用 `<Profile.dir>/memories/` 作为记忆根目录。公共 profile 开关默认关闭；Scheduler 保持加载，因此在 UI 中启用记忆无需重启。

本包不包含流水线运行逻辑。每个被装配的包分别拥有自己的服务、生命周期、持久化实现和不变量检查。

## 配置

在 profile patch 中启用功能：

```yaml
- id: memory-local
  inject: [profilePath]
  config:
    root: !!js ctx.profilePath('memories')
    enabled: true
    useByDefault: true
    contributeByDefault: true

- id: memory-scheduler
  config:
    extractionProvider: deepseek-official
    extractionModel: deepseek-v4-flash
    consolidationProvider: deepseek-official
    consolidationModel: deepseek-v4-flash
    consolidationReasoningEffort: inherit
    enabled: true
```

提供者和调度器的完整 schema 还公开容量安全上限，以及带 revision 的实时资格、recall、lease、retry、model 和 retention 参数。根目录必须保持为 profile 相对路径；该 bundle 不会回退到 Harness home。

## 模型体验

间接通过所装配的 Prompt 与 Scheduler Consumer 生效。

#### KV Cache 影响

Bundle 不增加 prompt 字节，请求装配由所挂载的 Consumer 负责。

## 已知限制与后续工作

- Codex 执行要求宿主单独安装对应 Provider。

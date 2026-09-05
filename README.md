# DSH 智能体增强系统

[中文文档](README.zh.md)

## 项目简介

基于开源 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 二次开发，面向跨会话长期记忆与复杂长任务执行。保留上游基于 Cordis 的插件化架构，增加 Memory Pipeline 和多需求长任务可靠性机制。

当前为个人开发快照，不是稳定发布版本，仍有文档同步问题。长任务审查默认采用 Shadow（仅观察）模式，Enforce（执行拦截）需要显式配置。

## 长期记忆：Memory Pipeline

- **提取与归并**：异步处理历史会话，提取用户偏好、纠正反馈和验证证据，归并跨会话记忆并保留未决冲突。
- **分层读取**：请求组装时注入记忆摘要，通过 `memory_search`、`memory_read` 按需查找详细记忆。
- **经验复用**：将重复且经过验证的流程整理为可复用 Skill。
- **可视化管理**：在界面中查看、编辑、删除记忆，并分别控制读取与贡献。

实现说明见[长期记忆架构](docs/subsystems/memory.zh.md)，启用方式见[记忆配置](packages/memory/memory-bundle/README.zh.md)。

## 多需求长任务可靠性

| 节点 | 职责 |
| --- | --- |
| 需求解析 Parser | 解析初始要求及中途新增、修改和取消，维护版本化需求账本；上下文压缩后重新注入当前任务快照。 |
| 进度观察 Observer | 在重复调用、连续失败或执行时间窗口触发时按需核查证据，识别空转、跑偏与关键假设风险，推动主 Agent 重新规划。 |
| 交付复核 Reviewer | 正式答复提交前交叉核对有效需求、回答内容和产物证据，将缺口分流为回答改写、只读核验或补做。 |

执行控制由程序负责：处理插话屏障、证据失效、重复调用拦截与补救预算，复用原有沙箱和审批机制。模型判断不构成任务完整性保证。

设计说明见[长任务可靠性架构](docs/subsystems/task-contract-final-gate.zh.md)，装配方式见[审查插件配置](packages/experimental/task-review-bundle/README.zh.md)。

<a id="run"></a>
<a id="run-from-source"></a>

## 从源码运行

准备 Node.js 24 或更高版本，以及项目声明的 pnpm 版本。运行：

```powershell
git clone https://github.com/KK456701/my_deepseek-harness.git
cd my_deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 准备运行产物，`pnpm dsh web` 使用构建后的产物启动界面。模型提供方与凭据配置参见 [Web 使用指南](docs/user/guide/index.zh.md)。本仓库的增强代码不等同于 npm 上的官方发行包。

长期记忆与长任务审查分别配置；包含对应代码并不代表所有功能已默认启用。启用前请阅读各自的配置与限制说明。

## 中文文档导航

- [Web 使用指南](docs/user/guide/index.zh.md)
- [长期记忆架构](docs/subsystems/memory.zh.md)
- [记忆配置](packages/memory/memory-bundle/README.zh.md)
- [长任务可靠性架构](docs/subsystems/task-contract-final-gate.zh.md)
- [审查插件配置](packages/experimental/task-review-bundle/README.zh.md)
- [整体架构](docs/architecture.zh.md)
- [开发指南](docs/development.zh.md)

## 数据与开发状态

仓库包含功能源码、必要测试和使用说明，不包含个人凭据、私人会话日志、记忆数据库或内部评测材料。开发快照保留已知检查问题，不作为生产可用性承诺。

## 上游与许可证

本项目基于 DeepSeek AI 开发的 DeepSeek Harness，底层插件架构由 [Cordis](https://github.com/cordiverse/cordis) 支持。保留上游历史、归属说明与 [MIT 许可证](LICENSE)；第三方依赖及许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

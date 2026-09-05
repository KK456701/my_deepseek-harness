# Agent Note: 统一 Session 协议上的记忆与任务审查

Status: proposed

[English](2026-09-03-memory-and-task-review-integration.md) | 中文

## Problem

Profile 记忆与实验性任务审查扩展同一套 Session、LLM 和客户端协议。单独部署任一实现都会遗漏另一方的能力；替换共享文件可能丢失请求重建、历史分类或交付检查。整合后仍必须能够读取用户已持久化的历史。

## Proposal

以 rc.8 的 Session 和流实现为基础，要求会话明确标记为 interactive、subagent 或 maintenance。保留中断消息、延迟交付的最终草稿、辅助调用审计用量和关联真实请求的可忽略记忆观察事件。记忆证据排除插件指令和未提交的审查草稿。任务需求只来自用户直接输入，不来自注入的记忆或 skill（技能）。

保持记忆的公共服务、流水线存储和维护服务分离。余额提供方及特权远程 API 独立于模型请求。显式启用的实验组合包以 Shadow 模式装配 Task Contract、Final Gate 和不执行干预的 Progress Observer；发布包不依赖实验包。记忆的私有归并不会继承该组合包。

SQLite Session schema 18 保留 rc.8 的物理打包与压缩，并加入 purpose 元数据。离线升级先备份，只处理已知前序格式，拒绝未知格式。已经携带 purpose 的 JSONL 历史、记忆数据库及 generation 保持不变。查询索引属于派生数据，可以重建而不删除 Session 日志。

[记忆提案](../../proposed/feature/2026-09-01-profile-long-term-memory.md)、[能力审计提案](2026-09-01-capability-owned-model-call-audits.md)与任务审查决策继续分别承担各自的语义和生命周期职责。

## Alternatives considered

**用一份检出覆盖另一份。** 这会丢失独立改动，无法同时保留两套 Session 协议和本地部署配置。

**同时从两份检出加载插件。** 混合运行时版本可能在事件解码、生成的远程类型和包身份上存在分歧。部署图必须由一份构建和一个 Profile 解析器负责。

**整合时开启强制审查。** 现有实验实现不代表已完成强制交付所需的行为校准。Shadow 集成保留可观察性，不引入回答拒绝。

## Acceptance criteria

- 记忆、余额、skill、模型设置和任务审查在真实 Loader 组合中共存，没有未解析依赖。
- 请求重建、历史回放、中断输出、草稿排除和用量恰好统计一次的行为得到保留。
- 用户直接意图不会与记忆、插件快照或审查输出混淆。
- 离线迁移保留逻辑事件、标识、序号和父子关系；不支持的格式在替换前失败。
- 保留现有记忆正文、有效请求、控制值和重置水位，不进行提取或重建。
- 在正式启动前，用隔离 Web 和 SDK 检查覆盖共享事件协议。

## Risks

Shadow 提取和审查增加提供方调用，并依赖模型行为。部署配置必须保留路由授权和独立记忆设置。物理存储变更需要一致备份以及代码、数据配套回退。派生的历史索引不能证明原始 Session 数据得到了保留，必须与原始日志对账。

# Agent Note: Capability 所有模型调用的持久记录

Status: proposed

[English](2026-09-01-capability-owned-model-call-audits.md) | 中文

## Problem

交互 agent loop 会在 Session log 中记录准确请求 header 和所有模型可见结果。长期记忆生成新增了两个不属于交互 Session 的调用：一次性抽取请求和使用工具的归并 Agent。如果它们没有 dispatch 前持久记录，provider 活动将无法重建；如果把两者复制到普通用户 Session，又会通过列表、恢复、搜索和导出接口暴露私有维护工作。

## Proposal

保留现有规则：每个已 dispatch 的模型请求在网络活动前都必须拥有可持久重建的记录。交互 loop 调用继续使用普通 Session log。Capability 所有的一次性调用使用私有 append-only 审计记录，包含审计格式版本、准确 prepared request、已解析配置、输入 fingerprint、provider attempt、观察到的 stream 或失败、usage 和终止分类。请求记录必须在 dispatch 前 flush，结果记录必须在领域状态消费前 flush。

Capability 所有且使用工具的 Agent 使用私有 SessionPersistence 实例，并把必填 `SessionPurpose` 设为 `maintenance`。标准 agent loop 原样记录 `request/header`、assistant 输出、工具调用、工具结果、重试和终止。普通 Session query 和 UI 服务不挂载私有 backend。只有维护操作及其依赖的发布全部终态后，所属 capability 才能执行有界保留清理。

持久记录是审计和恢复来源，不是生成记忆的权威。清理过期的终态审计不会使 manifest 和不可变证据仍有效的已发布 generation 失效。Active、retryable、result-recovery 或 publication-recovery 记录不能过期。

该提案扩展而不是改写[请求可重建决策](../../implemented/architecture/2026-07-05-reconstructable-requests.md)：每次网络 dispatch 始终有一个持久 owner，而这个 owner 可以是交互 Session log、capability one-shot audit 或私有 maintenance Session。

## Alternatives considered

**把所有后台调用写入来源交互 Session。** 否决，因为抽取可能组合旧范围，而归并属于 profile 维护，不是用户对话 transcript 的一部分。

**只保存最终结构化抽取结果或 generation diff。** 否决，因为它们无法重建实际 provider 请求、重试、非法输出、部分 stream、timeout 或 maintenance Agent 观察到的工具证据。

**把每个辅助调用建模为特殊 Session event。** 否决，因为 one-shot audit 和多步骤工具 Agent 具有不同生命周期和存储需求。后者适合标准 Session vocabulary；前者使用有界 append-only attempt 记录更小也更清晰。

## Acceptance criteria

- Capability 所有的 provider 调用在准确请求记录持久 flush 前不能开始。
- 抽取结果在完整观察结果或已分类 overflow／失败持久 flush 前不能影响候选或水位。
- Maintenance Agent 的 Prompt、请求 header、工具调用、工具结果、重试和最终状态可以从私有 Session log 重建。
- 普通 Session 列表、树、搜索、恢复、fork 和导出操作无法发现 maintenance Session。
- Retry attempt 保留同一输入 fingerprint 和不同 attempt 身份；provider 隐藏重试保持关闭。
- 终态审计保留策略不能删除 active、retry-wait、result-recovery 或 publication-recovery 状态，删除终态审计不会使已发布 generation 来源失效。

## Risks

私有记录会复制部分历史内容和模型输出，增加本地隐私和容量成本。每个 capability 都需要严格字节上限、保留期、owner-only 目录和 reset 文档。

如果两个持久机制定义重叠的重试或结果语义，它们可能漂移。通用审计 vocabulary 只负责 dispatch 重建；领域状态和失败策略仍归所属 capability。

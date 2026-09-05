/** Provider output projected separately from Worker messages and tool calls. */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type { TrajectoryConversationViewNode, TrajectoryRecordContribution } from '@deepseek-ai/dsh-client-ui-trajectory/client'
import type { SessionEvent, SessionEventMap, JsonValue } from '@deepseek-ai/dsh-session/types'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-experimental-task-contract'

/** Terminal snapshots replace, never append to, streamed text. */
export interface AuxiliaryCallState {
  seq: number
  request?: SessionEventMap['task-contract/model-request']
  dispatchedAt?: number
  firstReasoningAt?: number
  firstTextAt?: number
  response?: SessionEventMap['task-contract/model-response']
  assessment?: SessionEventMap['task-contract/model-assessment']
  application?: SessionEventMap['task-contract/model-application']
  notDispatched?: string
  blocks: ReadonlyMap<number, { type: string; text: string }>
  usage?: TokenUsage | undefined
}
const roles: Record<string, string> = {
  'requirement-change-parsing': '需求变更解析', 'task-contract-extraction': '需求提取（旧版）',
  'final-candidate-review': '最终审查', 'final-shadow-review': '最终审查（Shadow）',
  'progress-integrity-observation': '进度检查', 'task-authorization': '授权判断（旧版）',
}
const json = (value: unknown) => value === undefined ? '未记录' : JSON.stringify(value, null, 2)
function object(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
function blockText(blocks: readonly ContentBlock[], type: 'text' | 'reasoning'): string {
  return blocks.flatMap(block => block.type === type ? [block.text] : []).join('')
}

function toolCallText(blocks: readonly ContentBlock[]): string {
  const calls = blocks.filter(block => block.type === 'tool-call')
  return calls.length === 0 ? '' : json(calls)
}

function readableMaterials(messages: JsonValue | undefined): string {
  if (!Array.isArray(messages)) return '未记录'
  return messages.flatMap((message) => {
    const content = object(message).content
    if (!Array.isArray(content)) return []
    return content.map((block) => {
      const text = object(block).text
      if (typeof text !== 'string') return json(block)
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch {
        // Older requests can carry plain text instead of a JSON material envelope.
        return text
      }
      return json(parsed)
    })
  }).join('\n\n')
}

/**
 * Project one ordered event without joining separate call identities.
 * @param state - Previous projection.
 * @param event - Ordered durable event.
 * @returns Next projection.
 */
export function reduceAuxiliaryCall(state: AuxiliaryCallState, event: SessionEvent): AuxiliaryCallState {
  switch (event.type) {
    case 'task-contract/model-request': return { ...state, seq: event.seq, request: event.data }
    case 'task-contract/model-dispatch': return { ...state, dispatchedAt: event.time }
    case 'task-contract/model-not-dispatched': return { ...state, notDispatched: event.data.error }
    case 'task-contract/model-response': return { ...state, response: event.data, usage: event.data.usage }
    case 'task-contract/model-assessment': return { ...state, assessment: event.data }
    case 'task-contract/model-application': return { ...state, application: event.data }
    case 'task-contract/model-chunk': {
      const chunk = event.data.chunk
      if (chunk.type === 'usage') return { ...state, usage: chunk.usage }
      if (chunk.type !== 'block-start' && chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta' && chunk.type !== 'block-end') return state
      const blocks = new Map(state.blocks)
      if (chunk.type === 'block-start') blocks.set(chunk.index, { type: chunk.blockType, text: '' })
      else if (chunk.type === 'block-end') blocks.set(chunk.index, {
        type: chunk.block.type, text: chunk.block.type === 'text' || chunk.block.type === 'reasoning' ? chunk.block.text : json(chunk.block),
      })
      else blocks.set(chunk.index, { type: chunk.type === 'text-delta' ? 'text' : 'reasoning', text: (blocks.get(chunk.index)?.text ?? '') + chunk.text })
      return { ...state, blocks,
        ...(chunk.type === 'reasoning-delta' && chunk.text && state.firstReasoningAt === undefined ? { firstReasoningAt: event.time } : {}),
        ...(chunk.type === 'text-delta' && chunk.text && state.firstTextAt === undefined ? { firstTextAt: event.time } : {}),
      }
    }
    default: return state // Other owners' events do not contain auxiliary response data.
  }
}

/**
 * Present recorded transport and consumer decisions independently.
 * @param state - One attempt.
 * @param id - Durable call identity.
 * @returns Data-only trajectory record.
 */
export function auxiliaryRecord(state: AuxiliaryCallState, id: string): TrajectoryRecordContribution {
  const input = object(object(state.request?.request).input)
  const roleKey = stringValue(state.request?.metadata?.templateId) ?? stringValue(input.purpose)
  const role = (roleKey === undefined ? undefined : roles[roleKey]) ?? '用途未记录'
  const streamed = (type: string) => [...state.blocks.values()].filter(block => block.type === type).map(block => block.text).join('')
  const reasoning = state.response === undefined ? streamed('reasoning') : blockText(state.response.rawOutput, 'reasoning')
  const responseText = state.response === undefined ? streamed('text') : blockText(state.response.rawOutput, 'text')
  const responseTools = state.response === undefined
    ? [...state.blocks.values()].filter(block => block.type === 'tool-call').map(block => block.text).join('\n')
    : toolCallText(state.response.rawOutput)
  const output = responseText || responseTools
  const termination = state.response?.response.termination
  const transport = state.notDispatched !== undefined ? '未派发' : termination === 'completed' ? '请求完成'
    : termination === 'timeout' ? '超时' : termination === 'cancelled' ? '已取消' : termination === 'failed' ? '请求失败'
      : state.dispatchedAt !== undefined ? '已派发，等待终态' : state.response !== undefined ? '历史响应'
        : state.assessment?.status === 'failed' ? '准备失败，未记录派发' : '请求已准备'
  const verdict = state.assessment?.status === 'validated' ? '校验通过（不等于任务完成）'
    : state.assessment?.status === 'failed' ? '校验未通过' : state.assessment?.status === 'stale' ? '已过期，未采用' : '处理结果未记录'
  const context = state.request?.metadata?.context
  const location = context?.location
  const usage = state.usage
  const assessed = object(state.assessment?.result)
  const requestTools = Array.isArray(input.tools)
    ? input.tools.map(tool => stringValue(object(tool).name) ?? '')
    : []
  const toolSummary = requestTools.length === 0 ? '无任务工具'
    : requestTools.every(name => name === 'session_event_search' || name === 'session_event_read')
      ? '仅提供冻结证据只读工具；无任务工具'
      : '请求包含工具；详见 tools'
  const parserDetails = state.request?.metadata?.templateId === 'requirement-change-parsing'
    ? `模型结构化建议：\n${json(assessed.modelProposal)}\n\n程序绑定的真实用户来源：\n${json(assessed.sourceBinding)}\n\n最终应用的需求变化：\n${json(assessed.appliedUpdates)}`
    : `程序校验：\n${json(state.assessment)}`
  const sections: NonNullable<TrajectoryRecordContribution['cell']['detailSections']> = [
    { id: 'status', label: '概览', format: 'text', content: `模型调用 · ${role}\n传输：${transport}\n处理：${verdict}\ncallId：${id}\n${state.notDispatched ?? ''}\n${state.assessment?.error ?? ''}` },
    { id: 'input', label: '输入', format: 'json', content: state.request === undefined ? '请求起始页尚未加载；请向前加载历史以查看实际输入。'
      : `${toolSummary}\n${json(state.request.request)}` },
    { id: 'thinking', label: '思考', format: 'text', content: `仅展示 Provider 返回的原文，不代表全部内部过程。\n\n${reasoning || '未记录推理原文'}` },
    { id: 'output', label: '输出与处理', format: 'text', content: `模型原始正文：\n${output || '未收到正文'}\n\n${parserDetails}\n\n程序校验终态：\n${json(state.assessment)}\n\n持久更新：\n${json(state.application)}` },
    { id: 'requirements', label: '需求与计划', format: 'text', content: `关联与版本：\n${json(context)}\n\n本次实际输入材料：\n${readableMaterials(input.messages)}\n\n提取或审查后的结果：\n${json(state.assessment?.result)}` },
    { id: 'metrics', label: '配置与统计', format: 'json', content: json({ provider: input.provider, model: input.model,
      reasoningEffort: input.reasoningEffort, maxTokens: input.maxTokens, metadata: state.request?.metadata,
      dispatchedAt: state.dispatchedAt ?? '未记录', response: state.response?.response ?? '未记录', usage: usage ?? '未记录',
      firstReasoningAt: state.firstReasoningAt ?? '未记录', firstTextAt: state.firstTextAt ?? '未记录',
      note: 'maxTokens 是输出上限；reasoningTokens 包含在 outputTokens 内。浏览与回放不增加调用。' }) },
  ]
  return { seq: state.seq, turn: location?.turn ?? null,
    ...(location?.step === undefined ? {} : { step: location.step }),
    ...(location?.phase === undefined ? {} : { phase: location.phase }),
    group: `模型调用 · ${role}`, cell: {
      recordId: `auxiliary:${id}`, sourceSeq: state.seq, kind: 'model', text: `模型调用 · ${role} · ${transport} · ${verdict}`,
      operationState: state.notDispatched !== undefined || (termination !== undefined && termination !== 'completed')
      || (state.response === undefined && state.assessment?.status === 'failed') ? 'error'
        : state.response !== undefined ? 'complete' : 'running',
      startedAt: state.dispatchedAt ?? null, timeSeconds: state.response === undefined ? null : state.response.response.durationMs / 1000,
      inputDetail: json(state.request?.request), outputDetail: output, thinkingDetail: reasoning, detailSections: sections,
      ...(usage === undefined ? {} : { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens,
        cacheWrite: usage.cacheWriteTokens, think: usage.reasoningTokens }),
    } }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Each attempt has its own row, including retries and historical failures. */
export const auxiliaryDefinition: ConversationNodeDefinition<AuxiliaryCallState> = {
  kind: 'auxiliary-model-call', target: 'trajectory',
  match: (event) => {
    switch (event.type) {
      case 'task-contract/model-request': return { id: event.data.callId, role: 'start' }
      case 'task-contract/model-dispatch': case 'task-contract/model-chunk': case 'task-contract/model-response':
      case 'task-contract/model-not-dispatched': case 'task-contract/model-assessment': return { id: event.data.callId, role: 'update' }
      case 'task-contract/model-application': return { id: event.data.callId, role: 'update' }
      default: return null
    }
  },
  start: (_context, match) => reduceAuxiliaryCall({ seq: match.event.seq, blocks: new Map() }, match.event),
  update: (context, match) => reduceAuxiliaryCall(context.state, match.event),
  publication: match => match.event.type === 'task-contract/model-chunk' ? 'animation-frame' : 'immediate',
  buildViewNode: (context): TrajectoryConversationViewNode | null => {
    const state = context.state ?? context.matches.reduce< AuxiliaryCallState>((prior, match) => reduceAuxiliaryCall(prior, match.event),
      { seq: context.matches[0]?.event.seq ?? 0, blocks: new Map() })
    if (context.matches.length === 0) return null
    return { key: context.key, id: context.id, kind: context.kind, target: 'trajectory', anchorSeq: state.seq,
      location: context.start?.location ?? { kind: 'unresolved' }, data: { kind: 'record', record: auxiliaryRecord(state, context.id) } }
  },
}

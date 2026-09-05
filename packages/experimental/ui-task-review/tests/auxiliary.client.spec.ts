import { describe, expect, it } from 'vitest'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationEventInput, ConversationNodeDefinition, ConversationViewDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import { auxiliaryDefinition } from '../src/client/auxiliary.ts'
import { trajectoryViewDefinition } from '../../../client/ui-trajectory/src/client/trajectory-snapshot-builder.ts'
import { inputReceiptDefinition } from '../src/client/definitions.ts'
import type { TrajectorySnapshot } from '../../../client/ui-trajectory/src/client/trajectory-contract.ts'

function event(seq: number, type: string, data: unknown): ConversationEventInput {
  return { event: { seq, time: 1000 + seq, type, data } as ConversationEventInput['event'], view: undefined }
}
function assemble(events: ConversationEventInput[]) {
  const assembler = new ConversationNodeAssembler(
    { entries: (): ConversationNodeDefinition[] => [auxiliaryDefinition], fallbackEntry: () => undefined },
    { entries: (): ConversationViewDefinition[] => [trajectoryViewDefinition] },
  )
  assembler.replaceWindow(events, false)
  assembler.flush()
  return (assembler.snapshot('trajectory') as TrajectorySnapshot)?.records ?? []
}
const request = (seq: number, id: string, purpose = 'requirement-change-parsing') => event(seq, 'task-contract/model-request', {
  callId: id, formatVersion: 1, request: { input: { purpose, model: 'fixture', messages: [], tools: [] } },
  metadata: { templateId: purpose, templateHash: 'fixture', projectionVersion: 7, attempt: 1 },
})
const chunk = (seq: number, callId: string, text: string) => event(seq, 'task-contract/model-chunk', { callId, chunk: { type: 'reasoning-delta', index: 0, text } })

describe('auxiliary trajectory', () => {
  it('replays precise answer references and verification separately from old unverified audit results', () => {
    for (const work of ['needs-verification', 'unverified']) {
      const record = assemble([request(0, 'review', 'final-candidate-review'),
        event(1, 'task-contract/model-assessment', { callId: 'review', status: 'validated', result: {
          action: 'verify', requirements: [{ work, answerEvidence: [{ paragraphId: 'p1', quote: '现有证据不足🙂' }] }],
        } })])[0]
      const output = record?.cell.detailSections?.find(section => section.id === 'output')?.content
      expect(output).toContain(work)
      expect(output).toContain('现有证据不足🙂')
      expect(output).toContain('verify')
      expect(output).not.toContain('verifiedRevision')
    }
  })
  it('expands actual material JSON for readable requirements without inventing missing context', () => {
    const record = assemble([event(0, 'task-contract/model-request', { callId: 'a', request: { input: {
      purpose: 'requirement-change-parsing', messages: [{ content: [{ type: 'text', text: JSON.stringify({ input: { requirements: [{ id: 'r', text: '保留原始问题🙂' }] } }) }] }],
    } } })])[0]
    const section = record?.cell.detailSections?.find(item => item.id === 'requirements')?.content
    expect(section).toContain('"text": "保留原始问题🙂"')
    expect(section).toContain('关联与版本：\n未记录')
    expect(section).not.toContain('\\"requirements\\"')
  })
  it('keeps three purposes and interleaved retry identities independent', () => {
    const purposes = ['requirement-change-parsing', 'final-candidate-review', 'progress-integrity-observation']
    const records = assemble([...purposes.map((purpose, index) => request(index, String(index), purpose)),
      chunk(3, '1', '审查'), chunk(4, '0', '解析'), request(5, 'retry'), chunk(6, 'retry', '修复')])
    expect(records).toHaveLength(4)
    expect(records.map(record => record.cell.thinkingDetail)).toEqual(['解析', '审查', '', '修复'])
    expect(records.every(record => record.cell.kind === 'model')).toBe(true)
  })
  it('uses the terminal snapshot once, preserving long Chinese and emoji reasoning after timeout', () => {
    const text = '核对中文🙂'.repeat(20000)
    const records = assemble([request(0, 'a'), event(1, 'task-contract/model-dispatch', { callId: 'a' }), chunk(2, 'a', text),
      event(3, 'task-contract/model-response', { callId: 'a', rawOutput: [{ type: 'reasoning', text }],
        response: { durationMs: 180000, termination: 'timeout' }, usage: { inputTokens: 10, outputTokens: 200, reasoningTokens: 200 } })])
    expect(records[0]?.cell.thinkingDetail === text).toBe(true)
    expect(records[0]?.cell.operationState).toBe('error')
    expect(records[0]?.cell.output).toBe(200)
    expect(records[0]?.cell.detailSections?.[0]?.content).toContain('处理结果未记录')
  })
  it('shows pre-dispatch cancellation without a dispatch time or reported token usage', () => {
    const record = assemble([request(0, 'a'), event(1, 'task-contract/model-not-dispatched', { callId: 'a', error: 'cancelled before flush' })])[0]
    expect(record?.cell.startedAt).toBeNull()
    expect(record?.cell.input).toBeUndefined()
    expect(record?.cell.text).toContain('未派发')
  })
  it('replays old response-only windows and replaces them when the request page arrives', () => {
    const response = event(4, 'task-contract/model-response', { callId: 'old', rawOutput: [{ type: 'reasoning', text: '旧原文' }], response: { durationMs: 20, termination: 'completed' } })
    expect(assemble([response])[0]?.cell.thinkingDetail).toBe('旧原文')
    const complete = assemble([request(0, 'old'), response])
    expect(complete).toHaveLength(1)
    expect(complete[0]?.cell.startedAt).toBeNull()
    expect(complete[0]?.cell.text).toContain('请求完成')
  })
  it('separates transport success from rejected validation', () => {
    const record = assemble([request(0, 'a'), event(1, 'task-contract/model-response', { callId: 'a', rawOutput: [{ type: 'text', text: '{}' }], response: { durationMs: 20, termination: 'completed' } }),
      event(2, 'task-contract/model-assessment', { callId: 'a', status: 'failed', error: 'missing evidence' })])[0]
    expect(record?.cell.text).toContain('请求完成 · 校验未通过')
    expect(record?.cell.detailSections?.find(section => section.id === 'output')?.content).toContain('missing evidence')
  })
  it('shows frozen-evidence reads as model output without calling them task tools', () => {
    const record = assemble([
      event(0, 'task-contract/model-request', { callId: 'review', formatVersion: 1, request: { input: {
        purpose: 'final-candidate-review', messages: [], tools: [
          { name: 'session_event_search', parameters: {} },
          { name: 'session_event_read', parameters: {} },
        ],
      } }, metadata: { templateId: 'final-candidate-review', templateHash: 'fixture', projectionVersion: 7, attempt: 1 } }),
      event(1, 'task-contract/model-response', { callId: 'review', rawOutput: [{
        type: 'tool-call', id: 'read-1', name: 'session_event_read', arguments: '{"seq":35}',
      }], response: { durationMs: 20, termination: 'completed', finishReason: 'tool-calls' } }),
    ])[0]
    expect(record?.cell.outputDetail).toContain('session_event_read')
    expect(record?.cell.detailSections?.find(section => section.id === 'input')?.content)
      .toContain('仅提供冻结证据只读工具；无任务工具')
  })
  it('separates parser output, runtime-owned provenance, and the persisted update', () => {
    const record = assemble([
      request(0, 'parser'),
      event(1, 'task-contract/model-response', { callId: 'parser', rawOutput: [{ type: 'text', text: '{"changes":[]}' }], response: { durationMs: 20, termination: 'completed' } }),
      event(2, 'task-contract/model-application', { callId: 'parser', eventSeq: 9, eventType: 'task-contract/update', decision: { updates: [{ kind: 'add' }] } }),
      event(3, 'task-contract/model-assessment', { callId: 'parser', status: 'validated', result: {
        modelProposal: { changes: [{ op: 'add', text: '回答 D', verification: 'answer' }] },
        sourceBinding: { messageId: 'user-1', start: 0, end: 4, quote: '增加 D' },
        appliedUpdates: [{ kind: 'add', requirement: { text: '回答 D' } }], resultingRevision: 1,
      } }),
    ])[0]
    const output = record?.cell.detailSections?.find(section => section.id === 'output')?.content
    expect(output).toContain('模型结构化建议')
    expect(output).toContain('程序绑定的真实用户来源')
    expect(output).toContain('最终应用的需求变化')
    expect(output).toContain('task-contract/update')
  })
  it('keys receipt admission by message identity, retaining equal-text independent inputs', () => {
    const state = { messages: [{ id: 'a', content: [] }, { id: 'b', content: [] }], stopped: false, seq: 0 }
    const updated = inputReceiptDefinition.update({ state } as unknown as Parameters<typeof inputReceiptDefinition.update>[0],
      { ...event(1, 'task-contract/input-admitted', { turn: 1, messageIds: ['a'] }), role: 'update', location: { kind: 'session' } })
    expect(updated.messages.map((message: { readonly id: string }) => message.id)).toEqual(['b'])
    expect(inputReceiptDefinition.match(event(2, 'step/start', { turn: 1, step: 1 }).event)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatSnapshot, ConversationEventInput } from '@deepseek-ai/dsh-client-runtime/client'
import { chatViewDefinition } from '../../../client/ui-conversation/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { messageDefinition } from '../../../client/ui-conversation/src/client/conversation-nodes/message.ts'
import { inputReceiptDefinition, extractionFailureDefinition } from '../src/client/definitions.ts'
import { deliveryReviewDefinition, deliveryReviewViewDefinition } from '../src/client/delivery.tsx'

function event(seq: number, type: string, data: unknown, surfaceOp?: 'append'): ConversationEventInput {
  // Test wire fixtures deliberately omit host event brands.
  return { event: { seq, time: 1000 + seq, type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) } as ConversationEventInput['event'], view: undefined }
}
const inputs = [
  event(0, 'turn/start', { turn: 1 }),
  event(1, 'task-contract/input', { turn: 1, messages: [{ id: 'a', content: [{ type: 'text', text: 'Original A' }] }, { id: 'b', content: [{ type: 'text', text: 'Original B' }] }] }),
  event(2, 'task-contract/input', { turn: 1, messages: [{ id: 'c', content: [{ type: 'text', text: 'Also C' }] }] }),
]

function assembler(events = inputs, hasMore = false) {
  const value = new ConversationNodeAssembler({
    entries: () => [inputReceiptDefinition, extractionFailureDefinition, messageDefinition],
    fallbackEntry: () => undefined,
  }, { entries: () => [chatViewDefinition] })
  value.replaceWindow(events, hasMore)
  value.flush()
  return value
}
function visible(value: ConversationNodeAssembler) {
  const snapshot = value.snapshot('chat') as ChatSnapshot
  return snapshot.order.map(key => snapshot.nodes.get(key)!)
}

describe('input receipt and failure replay', () => {
  it('shows all unadmitted direct inputs after cancellation and reload', () => {
    const rows = visible(assembler([...inputs, event(3, 'turn/end', { turn: 1, reason: { kind: 'aborted' } })]))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.data).toMatchObject({ stopped: true, messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })
  })
  it('replaces pre-admission receipts with normal user messages without duplicate content', () => {
    const value = assembler()
    const suffix = [event(3, 'step/start', { turn: 1, step: 1 }), event(4, 'user/message', { id: 'a', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Original A' }] }, 'append'),
      event(5, 'task-contract/input-admitted', { turn: 1, messageIds: ['a'] })]
    for (const item of suffix) value.append(item)
    value.flush()
    expect(visible(value).map(row => row.kind)).toEqual(['task-input-receipt', 'user'])
    expect(visible(value)[0]?.data).toMatchObject({ messages: [{ id: 'b' }, { id: 'c' }] })
    expect(visible(value)).toEqual(visible(assembler([...inputs, ...suffix])))
  })
  it('recovers an update-only input page when its turn start is prepended', () => {
    const value = assembler(inputs.slice(1), true)
    expect(visible(value)).toEqual([])
    value.prepend(inputs.slice(0, 1), false)
    value.flush()
    expect(visible(value)).toEqual(visible(assembler()))
  })
  it('retains failed attempts even after a later successful extraction', () => {
    const request = { baseRevision: 0, sourceMessageIds: ['a'], sourceMessages: [[{ type: 'text', text: 'Original A' }]], provider: 'mock', model: 'model', maxTokens: 512 }
    const rows = visible(assembler([...inputs,
      event(3, 'task-contract/extraction-start', { ...request, attemptId: 'fail' }),
      event(4, 'task-contract/extraction-result', { attemptId: 'fail', baseRevision: 0, rawOutput: [], error: 'aborted' }),
      event(5, 'task-contract/extraction-start', { ...request, attemptId: 'success' }),
      event(6, 'task-contract/extraction-result', { attemptId: 'success', baseRevision: 0, rawOutput: [], extracted: [] }),
    ]))
    expect(rows.filter(row => row.kind === 'task-extraction-failure')).toHaveLength(1)
    expect(rows.at(-1)?.data).toMatchObject({ request: { attemptId: 'fail' }, result: { error: 'aborted' } })
  })
})

describe('post-delivery review replay', () => {
  it('projects only enforcing rejected deliveries and keeps later replacements addressable', () => {
    const value = new ConversationNodeAssembler({
      entries: () => [deliveryReviewDefinition], fallbackEntry: () => undefined,
    }, { entries: () => [deliveryReviewViewDefinition] })
    value.replaceWindow([
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'step/start', { turn: 1, step: 1 }),
      event(2, 'assistant/message', { turn: 1, step: 1, message: { id: 'a', role: 'assistant', content: [] } }, 'append'),
      event(3, 'final-review/shadow-result', { candidateId: 'delivered-2', turn: 1, candidateSeq: 2,
        enforced: false, action: 'rewrite', rawOutput: [] }),
      event(4, 'final-review/shadow-result', { candidateId: 'delivered-2', turn: 1, candidateSeq: 2,
        enforced: true, action: 'rewrite', rawOutput: [] }),
      event(5, 'step/start', { turn: 1, step: 2 }),
      event(6, 'assistant/message', { turn: 1, step: 2, message: { id: 'b', role: 'assistant', content: [] } }, 'append'),
      event(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ], false)
    value.flush()
    expect(value.snapshot('task-review-delivery')).toEqual({
      markers: [{ seq: 4, turn: 1, candidateSeq: 2 }],
    })
  })

  it('does not guess a disposition for old results missing enforcement metadata', () => {
    const value = new ConversationNodeAssembler({
      entries: () => [deliveryReviewDefinition], fallbackEntry: () => undefined,
    }, { entries: () => [deliveryReviewViewDefinition] })
    value.replaceWindow([
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'final-review/shadow-result', { candidateId: 'delivered-0', rawOutput: [], result: {} }),
      event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ], false)
    value.flush()
    expect(value.snapshot('task-review-delivery')).toEqual({ markers: [] })
  })
})

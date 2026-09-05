import { describe, expect, it } from 'vitest'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { foldTaskContract, parsedInputIds, RequirementId } from '../src/index.ts'
import type { RequirementUpdate, UserSourceRef } from '../src/index.ts'

function setup() {
  const session = Session.create(SessionId('requirement-ledger'))
  const body = '回答 A、B 和 C。'
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: body }] })
  session.append('turn/start', { turn: 1 })
  session.append('task-contract/input', { turn: 1, messages: [{ id: message.id, content: message.content }] })
  const user = session.append('user/message', message, { surfaceOp: 'append' })
  const source: UserSourceRef = { messageId: message.id, start: 0, end: body.length, quote: body }
  const apply = (updates: readonly RequirementUpdate[], sourceMessageIds = [message.id]) => {
    const baseRevision = foldTaskContract(session).revision
    session.append('task-contract/update', {
      formatVersion: 3, baseRevision, revision: baseRevision + 1, sourceMessageIds, updates,
    })
  }
  apply(['A', 'B', 'C'].map(name => ({
    kind: 'add' as const,
    requirement: {
      id: RequirementId(name), revision: 1, text: `回答 ${name}`, verification: 'answer' as const,
      source, state: 'open' as const, evidenceEventIds: [],
    },
  })))
  return { session, message, user, source, apply }
}

describe('requirement ledger replay', () => {
  it('recognizes an applied update even if its later auxiliary assessment was not persisted', () => {
    const { session, message } = setup()
    expect(session.events.some(event => event.type === 'task-contract/model-assessment')).toBe(false)
    expect(parsedInputIds(session).has(message.id)).toBe(true)
    const unresolved = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '再加 D' }] })
    session.append('task-contract/input', { turn: 1, messages: [{ id: unresolved.id, content: unresolved.content }] })
    expect(parsedInputIds(session).has(unresolved.id)).toBe(false)
  })
  it('binds plan approval to requirement versions, not completion bookkeeping', () => {
    const { session, source, apply } = setup()
    const callId = CallId('approved')
    const review = session.append('plan/review-start', { callId, plan: '回答 A、B、C。' })
    session.append('plan/review-approved', { callId, reviewSeq: review.seq })
    expect(foldTaskContract(session).approvedPlan?.applicability).toBe('current')
    apply([{ kind: 'fulfill', id: RequirementId('A'), requirementRevision: 1, evidenceEventIds: [] }], [])
    expect(foldTaskContract(session).approvedPlan?.applicability).toBe('current')
    apply([{ kind: 'revise', id: RequirementId('B'), text: '改后的 B', verification: 'answer', source },
      { kind: 'cancel', id: RequirementId('C'), source }])
    expect(foldTaskContract(session).approvedPlan).toMatchObject({ applicability: 'needs-reconciliation',
      changedRequirementIds: ['B', 'C'], requirementRevisions: [{ id: 'A', revision: 1 }, { id: 'B', revision: 1 }, { id: 'C', revision: 1 }] })
  })
  it('retains independent requirements and resolves their user-event source', () => {
    const { session, user } = setup()
    expect(foldTaskContract(session).requirements).toMatchObject([
      { id: 'A', text: '回答 A', state: 'open', source: { event: { kind: 'local', seq: user.seq } } },
      { id: 'B', text: '回答 B', state: 'open' },
      { id: 'C', text: '回答 C', state: 'open' },
    ])
  })

  it('reopens only a revised requirement and clears its old completion proof', () => {
    const { session, source, apply } = setup()
    apply([{ kind: 'fulfill', id: RequirementId('B'), requirementRevision: 1, evidenceEventIds: [{ kind: 'local', seq: 2 }] }])
    apply([{ kind: 'revise', id: RequirementId('B'), source, text: '回答修正后的 B', verification: 'answer' }])

    expect(foldTaskContract(session).requirements.map(item => ({
      id: item.id, revision: item.revision, state: item.state, verifiedRevision: item.verifiedRevision,
      evidenceEventIds: item.evidenceEventIds,
    }))).toEqual([
      { id: 'A', revision: 1, state: 'open', verifiedRevision: undefined, evidenceEventIds: [] },
      { id: 'B', revision: 2, state: 'open', verifiedRevision: undefined, evidenceEventIds: [] },
      { id: 'C', revision: 1, state: 'open', verifiedRevision: undefined, evidenceEventIds: [] },
    ])
  })

  it('adds D and cancels only C without deleting history', () => {
    const { session, apply } = setup()
    const body = '增加 D，不再回答 C。'
    const correction = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: body }] })
    session.append('task-contract/input', { turn: 1, messages: [{ id: correction.id, content: correction.content }] })
    session.append('user/message', correction, { surfaceOp: 'append' })
    const source = { messageId: correction.id, start: 0, end: body.length, quote: body }
    apply([
      { kind: 'add', requirement: { id: RequirementId('D'), revision: 1, text: '回答 D', verification: 'answer', source, state: 'open', evidenceEventIds: [] } },
      { kind: 'cancel', id: RequirementId('C'), source },
    ], [correction.id])

    expect(foldTaskContract(session).requirements.map(item => [item.id, item.state])).toEqual([
      ['A', 'open'], ['B', 'open'], ['C', 'cancelled'], ['D', 'open'],
    ])
  })

  it('replays independently of a compacted conversation surface', () => {
    const { session, message, user } = setup()
    session.append('user/message', createUserMessage({
      source: { kind: 'plugin', plugin: 'compaction-fixture' }, content: [{ type: 'text', text: '压缩摘要' }],
    }), { surfaceOp: { op: 'replace', start: user.seq, end: user.seq }, sourceEventSeqs: [user.seq] })
    const restored = foldTaskContract({ events: JSON.parse(JSON.stringify(session.events)) as typeof session.events })
    expect(restored.inputs[0]?.messageId).toBe(message.id)
    expect(restored.requirements.map(item => item.id)).toEqual(['A', 'B', 'C'])
  })

  it('rejects non-contiguous ledger revisions', () => {
    const session = Session.create(SessionId('requirement-ledger-gap'))
    session.append('task-contract/update', { formatVersion: 3, baseRevision: 1, revision: 2, sourceMessageIds: [], updates: [] })
    expect(() => foldTaskContract(session)).toThrow(/does not follow 0/)
  })
})

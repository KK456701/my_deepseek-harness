import { describe, expect, it } from 'vitest'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { RequirementId, foldTaskContract, renderWorkerSnapshot } from '../src/index.ts'
import type { RequirementUpdate } from '../src/index.ts'
import { validateTaskUpdates } from '../src/fold.ts'

function fixture() {
  const session = Session.create(SessionId('requirement-validation'))
  const body = '修复并解释原因。'
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: body }] })
  session.append('task-contract/input', { turn: 1, messages: [{ id: message.id, content: message.content }] })
  const source = { messageId: message.id, start: 0, end: body.length, quote: body }
  return { session, message, source }
}

describe('requirement update admission', () => {
  it('accepts an exact UTF-16 source and applies a complete batch atomically', () => {
    const { session, message, source } = fixture()
    const updates: RequirementUpdate[] = [{ kind: 'add', requirement: {
      id: RequirementId('repair'), revision: 1, text: '修复并解释原因', verification: 'execution',
      source, state: 'open', evidenceEventIds: [],
    } }]
    validateTaskUpdates(session, updates, [message.id])
    session.append('task-contract/update', { formatVersion: 3, baseRevision: 0, revision: 1, sourceMessageIds: [message.id], updates })
    expect(foldTaskContract(session).requirements).toMatchObject([{ id: 'repair', verification: 'execution', state: 'open' }])
  })

  it('rejects forged quotations and leaves the Session unchanged', () => {
    const { session, message, source } = fixture()
    const before = session.events.length
    const updates: RequirementUpdate[] = [{ kind: 'add', requirement: {
      id: RequirementId('repair'), revision: 1, text: '修复', verification: 'execution',
      source: { ...source, quote: '伪造原文' }, state: 'open', evidenceEventIds: [],
    } }]
    expect(() => { validateTaskUpdates(session, updates, [message.id]) }).toThrow(/does not match/)
    expect(session.events).toHaveLength(before)
  })

  it('rejects an invalid suffix before any caller can publish the prefix', () => {
    const { session, message, source } = fixture()
    const updates: RequirementUpdate[] = [
      { kind: 'add', requirement: { id: RequirementId('valid'), revision: 1, text: '有效', verification: 'answer', source, state: 'open', evidenceEventIds: [] } },
      { kind: 'cancel', id: RequirementId('missing'), source },
    ]
    expect(() => { validateTaskUpdates(session, updates, [message.id]) }).toThrow(/missing or cancelled/)
    expect(foldTaskContract(session).requirements).toEqual([])
  })
})

describe('Worker requirement snapshot', () => {
  it('projects only current open, fulfilled, cancelled, and approved-plan text', () => {
    const { session, message, source } = fixture()
    const base = { id: RequirementId('open'), revision: 1, text: '完成导出', verification: 'execution' as const,
      source, state: 'open' as const, evidenceEventIds: [] }
    const text = renderWorkerSnapshot({
      revision: 4, inputRevision: 1, inputs: [{ messageId: message.id, content: message.content, inputSeq: 0, turn: 1 }],
      requirements: [base,
        { ...base, id: RequirementId('done'), text: '检查旧格式', state: 'fulfilled', verifiedRevision: 1 },
        { ...base, id: RequirementId('cancelled'), text: '实现 Python SDK', state: 'cancelled' }],
      approvedPlan: { callId: CallId('plan'), text: '先实现导出，再运行只读验证。',
        review: { kind: 'local', seq: 1 }, approval: { kind: 'local', seq: 2 } },
    })
    expect(text).toBe([
      '当前任务状态。本快照替代更早的任务状态快照。',
      '', '待完成：', '- R1：完成导出',
      '', '已完成，请勿重复：', '- R2：检查旧格式',
      '', '已取消，请勿恢复：', '- R3：实现 Python SDK',
      '', '计划需结合后续需求变更核对；最新用户纠正优先，不恢复取消项。',
      '', '用户批准的当前计划：', '先实现导出，再运行只读验证。',
    ].join('\n'))
    expect(text).not.toContain(message.id)
    expect(text).not.toContain('evidence')
    expect(session.events).toHaveLength(1)
  })

  it('omits an empty ledger without an approved plan', () => {
    expect(renderWorkerSnapshot({ revision: 0, inputRevision: 0, inputs: [], requirements: [] })).toBeUndefined()
  })
})

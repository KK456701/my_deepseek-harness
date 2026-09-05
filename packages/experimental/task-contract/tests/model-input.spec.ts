import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { auxiliaryPrompt, deliveredContent, foldTaskContract, projectRequirementParserInput, projectStepEvidence, projectTask, RequirementId } from '../src/index.ts'

describe('auxiliary model projections', () => {
  it('keeps independent identical user messages while projecting requirements once', () => {
    const session = Session.create(SessionId('projection'))
    const messages = [1, 2].map(() => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '保留这个独立要求。' }] }))
    session.append('task-contract/input', { turn: 1, messages: messages.map(message => ({ id: message.id, content: message.content })) })
    const snapshot = foldTaskContract(session)
    expect(snapshot.inputs.map(value => value.messageId)).toEqual(messages.map(message => message.id))
    expect(projectTask(snapshot)).toEqual({ revision: 0, requirements: [] })
  })

  it('retains event identity while removing assistant reasoning', () => {
    const session = Session.create(SessionId('events'))
    const first = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '原文' }] }), { surfaceOp: 'append' })
    expect(projectStepEvidence(first)).toMatchObject({ seq: first.seq, type: 'user/message' })
    expect(deliveredContent([{ type: 'reasoning', text: 'private deliberation' }, { type: 'text', text: '可交付正文' }]))
      .toEqual([{ type: 'text', text: '可交付正文' }])
  })

  it('uses a stable tool-free prompt prefix across dynamic inputs and repairs', () => {
    const first = auxiliaryPrompt('requirement-change-parsing', ['中文规则'], {}, { text: '用户甲' })
    const retry = auxiliaryPrompt('requirement-change-parsing', ['中文规则'], {}, { text: '用户乙' }, 2, 'invalid source')
    expect(first.options.system).toBe(retry.options.system)
    expect(first.metadata.templateHash).toBe(retry.metadata.templateHash)
    expect(retry.metadata.attempt).toBe(2)
    expect(first.options).not.toHaveProperty('tools')
    expect(first.options.system).not.toContain('用户甲')
    expect(first.metadata.projectionVersion).toBe(12)
  })

  it('projects uncancelled requirements including fulfilled ones, without their audit fields', () => {
    const source = { messageId: createUserMessage({ source: { kind: 'user' }, content: [] }).id, start: 0, end: 1, quote: '旧' }
    const snapshot = {
      revision: 3,
      inputs: [],
      inputRevision: 0,
      requirements: [
        { id: RequirementId('A'), revision: 1, text: '回答 A', verification: 'answer' as const, source, state: 'open' as const, evidenceEventIds: [] },
        { id: RequirementId('B'), revision: 2, text: '执行 B', verification: 'execution' as const, source, state: 'fulfilled' as const, verifiedRevision: 2, evidenceEventIds: [{ kind: 'local' as const, seq: 9 }] },
        { id: RequirementId('C'), revision: 1, text: '取消 C', verification: 'answer' as const, source, state: 'cancelled' as const, evidenceEventIds: [] },
      ],
      approvedPlan: { callId: CallId('plan-1'), text: '先检查 A，再验证 B。', review: { kind: 'local' as const, seq: 10 }, approval: { kind: 'local' as const, seq: 11 } },
    }
    const input = projectRequirementParserInput(snapshot, '按计划增加 D。')
    expect(input).toEqual({
      version: 5,
      currentRequirements: [{ id: 'A', revision: 1, text: '回答 A', verification: 'answer' },
        { id: 'B', revision: 2, text: '执行 B', verification: 'execution' }],
      approvedPlan: { callId: 'plan-1', text: '先检查 A，再验证 B。' },
      message: { text: '按计划增加 D。' },
    })
    const serialized = JSON.stringify(input)
    expect(serialized.match(/先检查 A，再验证 B。/gu)).toHaveLength(1)
    expect(serialized).not.toContain('evidenceEventIds')
    expect(serialized).not.toContain('source')
    expect(serialized).not.toContain('fulfilled')
  })
})

import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { isSurfaceEvent, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import TaskContractService from '../src/index.ts'

function requestText(request: { messages: readonly { content: readonly unknown[] }[] }): string {
  return request.messages.flatMap(message => message.content).flatMap((block) => {
    if (typeof block !== 'object' || block === null || !('type' in block) || !('text' in block)) return []
    return block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  }).join('\n')
}

describe('Worker requirement context', () => {
  it('retries a saved but failed message before admitting the next real input', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TaskContractService, { mode: 'enforce', parserProvider: 'parser', parserModel: 'parser' })
    await ctx.plugin(AgentLoop, { agents: [] })
    const parser = new MockAdapter([textResponse('invalid'), textResponse('invalid'),
      textResponse(JSON.stringify({ changes: [{ op: 'add', text: '保留原始需求', verification: 'answer' }] })),
      textResponse(JSON.stringify({ changes: [] }))])
    const worker = new MockAdapter([textResponse('完整回答')])
    ctx.llm.registerAdapter(['parser'], parser); ctx.llm.registerAdapter(['worker'], worker)
    const agent = ctx.agentLoop.create(SessionId('parser-failed-resume'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '保留原始需求' }] }))
    await agent.whenIdle()
    expect(worker.requests).toHaveLength(0)
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '重试' }] }))
    await agent.whenIdle()
    expect(parser.requests).toHaveLength(4)
    expect(requestText(parser.requests[2]!)).toContain('保留原始需求')
    expect(worker.requests).toHaveLength(1)
    expect(ctx.taskContract.snapshot(agent.session).requirements.map(item => item.text)).toEqual(['保留原始需求'])
    await ctx.fiber.dispose()
  })
  it('injects the newly parsed ledger into the same Worker request and does not repeat an unchanged snapshot', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TaskContractService, {
      mode: 'enforce', injectWorkerContext: true, parserProvider: 'parser', parserModel: 'parser',
    })
    await ctx.plugin(AgentLoop, { agents: [] })
    const parser = new MockAdapter([
      textResponse(JSON.stringify({ changes: [{ op: 'add', text: '实现诊断包导出', verification: 'execution' }] })),
      textResponse(JSON.stringify({ changes: [] })),
      textResponse(JSON.stringify({ changes: [] })),
      textResponse(JSON.stringify({ changes: [] })),
    ])
    const worker = new MockAdapter([textResponse('第一轮完成'), textResponse('第二轮完成'),
      textResponse('第三轮完成'), textResponse('第四轮完成')])
    ctx.llm.registerAdapter(['parser'], parser)
    ctx.llm.registerAdapter(['worker'], worker)
    const agent = ctx.agentLoop.create(SessionId('task-contract-worker-context'), { provider: 'worker', model: 'worker' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: '实现诊断包导出。' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(requestText(worker.requests[0]!)).toContain('待完成：')
    expect(requestText(worker.requests[0]!)).toContain('实现诊断包导出')

    agent.followup(createUserMessage({ content: [{ type: 'text', text: '继续。' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const snapshots = agent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === '@deepseek-ai/dsh-experimental-task-contract')
    expect(snapshots).toHaveLength(1)
    expect(requestText(worker.requests[1]!)).toContain('实现诊断包导出')

    const planCallId = CallId('approved-plan')
    const review = agent.session.append('plan/review-start', { callId: planCallId, plan: '先导出，再进行只读校验。' })
    agent.session.append('plan/review-approved', { callId: planCallId, reviewSeq: review.seq })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '按批准计划继续。' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(requestText(worker.requests[2]!)).toContain('用户批准的当前计划：')
    expect(requestText(worker.requests[2]!)).toContain('先导出，再进行只读校验。')

    const snapshot = agent.session.events.findLast(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === '@deepseek-ai/dsh-experimental-task-contract')!
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '较早内容已经压缩。' }],
      source: { kind: 'plugin', plugin: 'test-compaction', form: 'snapshot',
        sections: [{ name: 'test-compaction', text: '较早内容已经压缩。' }] },
    }), {
      surfaceOp: { op: 'replace', start: snapshot.seq, end: snapshot.seq },
      sourceEventSeqs: [snapshot.seq],
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '压缩后继续。' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const taskSnapshots = agent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === '@deepseek-ai/dsh-experimental-task-contract')
    expect(taskSnapshots, JSON.stringify(agent.session.events.map(event => ({ seq: event.seq, type: event.type,
      source: event.type === 'user/message' ? event.data.source : undefined,
      surface: isSurfaceEvent(event) ? event.surfaceOp : undefined })))).toHaveLength(3)
    expect(requestText(worker.requests[3]!)).toContain('实现诊断包导出')
    expect(requestText(worker.requests[3]!)).toContain('先导出，再进行只读校验。')
    const admitted = agent.session.events.filter(event => event.type === 'task-contract/input-admitted')
    const directUsers = agent.session.events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user'
      ? [{ id: event.data.id, seq: event.seq }] : [])
    expect(admitted.flatMap(event => event.data.messageIds)).toEqual(directUsers.map(event => event.id))
    for (const receipt of admitted) {
      expect(directUsers.filter(event => receipt.data.messageIds.includes(event.id)).every(event => event.seq < receipt.seq)).toBe(true)
    }
    await ctx.fiber.dispose()
  })

  it('retains the receipt without claiming Worker admission when parsing rejects the Step', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TaskContractService, { mode: 'enforce', parserProvider: 'parser', parserModel: 'parser' })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['parser'], new MockAdapter([textResponse('invalid'), textResponse('invalid')]))
    const worker = new MockAdapter([])
    ctx.llm.registerAdapter(['worker'], worker)
    const agent = ctx.agentLoop.create(SessionId('task-contract-rejected-receipt'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '先核查。' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.events.filter(event => event.type === 'task-contract/input')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'task-contract/input-admitted')).toHaveLength(0)
    expect(worker.requests).toHaveLength(0)
    await ctx.fiber.dispose()
  })
})

import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId, AuditedLlmCallId } from '@deepseek-ai/dsh-session'
import TaskContract, { auditedReviewStream } from '@deepseek-ai/dsh-experimental-task-contract'
import TaskExecutionControl from '@deepseek-ai/dsh-experimental-task-execution-control'
import Gate from '@deepseek-ai/dsh-experimental-final-completeness-gate'
import Observer from '@deepseek-ai/dsh-experimental-progress-integrity-observer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

function parserResponse(options: { messages: readonly { content: readonly unknown[] }[] }, body: string) {
  const text = options.messages.flatMap(message => message.content).flatMap((block) => {
    if (typeof block !== 'object' || block === null || !('type' in block) || !('text' in block)) return []
    return block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  }).join('\n')
  const input = (JSON.parse(text) as { input: { version: number; message: { text: string } } }).input
  if (input.version !== 5 || input.message.text !== body) throw new Error('missing parser message')
  return textResponse(JSON.stringify({ changes: [{ op: 'add', text: body, verification: 'answer' }] }))
}

async function mount(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TaskContract, { mode: 'shadow' })
  await ctx.plugin(TaskExecutionControl)
  await ctx.plugin(Gate, { mode: 'shadow' })
  await ctx.plugin(Observer)
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

describe('memory-safe task review assembly', () => {
  it('rejects followup execution in a fixed-material Reviewer session before any model dispatch', async () => {
    const ctx = await mount()
    const adapter = new MockAdapter([textResponse('must not execute')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('readonly-screen'), { provider: 'mock', model: 'mock' })
    agent.session.append('task-review/test-case', { version: 1, kind: 'reviewer', caseId: 'fixed', title: 'fixed material' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] }))
    await agent.whenIdle()
    expect(adapter.requests).toEqual([])
  })
  it('rechecks queued judgment authority after durable flush and spends nothing on obsolete work', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const adapter = new MockAdapter([textResponse('must not run')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const session = ctx.sessions.create(SessionId('obsolete-audit'))
    let current = true
    vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async () => { current = false; return true })
    const run = async () => {
      for await (const _ of auditedReviewStream(ctx, session, AuditedLlmCallId('obsolete'), {
        provider: 'mock', model: 'mock', messages: [], purpose: 'progress-integrity-observation',
      }, undefined, () => { if (!current) throw new Error('stale observation') })) { /* Drain the owned judgment. */ }
    }
    await expect(run()).rejects.toThrow('stale observation')
    expect(adapter.requests).toEqual([])
    expect(session.events.at(-1)?.type).toBe('task-contract/model-not-dispatched')
    expect(session.events.filter(event => event.type === 'llm/audited-call' || event.type === 'task-contract/model-response')).toEqual([])
  })
  it('bounds Shadow parsing attempts and preserves the independent effort override', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TaskContract, { mode: 'shadow', parserTimeoutMs: 10, parserReasoningEffort: 'off' })
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter(['hang', textResponse('worker continues')], { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }] })
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('bounded-extraction'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Give a short answer.' }] }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]?.reasoningEffort).toBe('off')
    expect(agent.session.events.filter(event => event.type === 'task-contract/model-response')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'task-contract/model-assessment')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
  })

  it.each(['maintenance', 'subagent'] as const)('does not extract or review a %s session', async (purpose) => {
    const ctx = await mount()
    const adapter = new MockAdapter([textResponse('one private answer')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const handle = await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId(`private-${purpose}`), meta: { purpose }, agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Internal maintenance input' }] }))
    await handle.agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(handle.agent.session.events.filter(event => /^(task-contract|final-review|progress-integrity)\//u.test(event.type))).toEqual([])
  })

  it('does not make plugin context into direct user requirements', async () => {
    const ctx = await mount()
    const worker = new MockAdapter([textResponse('answer')])
    const reviews = new MockAdapter(['hang', 'hang'])
    ctx.llm.registerAdapter(['mock'], worker)
    ctx.llm.registerAdapter(['reviews'], reviews)
    // A plugin-only step is valid model context but cannot authorize Contract extraction.
    const agent = ctx.agentLoop.create(SessionId('plugin-context'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ source: { kind: 'plugin', plugin: 'memory-context' }, content: [{ type: 'text', text: 'Historical preference, not a user request' }] }))
    await agent.whenIdle()
    expect(agent.session.events.some(event => event.type === 'task-contract/model-request'
      && event.data.metadata?.templateId === 'requirement-change-parsing')).toBe(false)
    expect(ctx.taskContract.snapshot(agent.session).requirements).toEqual([])
  })

  it('waits for the durable exact request before dispatch and rejects failed flushes', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const adapter = new MockAdapter([textResponse('audited')], undefined, 512)
    ctx.llm.registerAdapter(['mock'], adapter)
    const session = ctx.sessions.create(SessionId('review-audit'))
    let release!: () => void
    const flush = vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(() => new Promise((resolve) => { release = () =>{  resolve(true) } }))
    const run = async (): Promise<void> => {
      for await (const _chunk of auditedReviewStream(ctx, session, AuditedLlmCallId('review-1'), {
        provider: 'mock', model: 'mock', sessionId: session.id, messages: [],
      })) { /* Stream drainage is part of the owned call. */ }
    }
    const pending = run()
    await vi.waitFor(() => { expect(flush).toHaveBeenCalledOnce() })
    expect(adapter.requests).toHaveLength(0)
    expect(session.events.at(-1)).toMatchObject({ type: 'task-contract/model-request', data: { formatVersion: 1, request: { input: { maxTokens: 512 } } } })
    const recorded = JSON.stringify(session.events.at(-1))
    expect(recorded).not.toContain('"signal"')
    release()
    await pending
    const types = session.events.map(event => event.type)
    expect(types.indexOf('task-contract/model-dispatch')).toBeLessThan(types.indexOf('task-contract/model-chunk'))
    expect(types.indexOf('task-contract/model-chunk')).toBeLessThan(types.indexOf('task-contract/model-response'))
    expect(types.filter(type => type === 'llm/audited-call')).toHaveLength(1)
    expect(adapter.requests).toHaveLength(1)
    expect(session.events.some(event => event.type === 'request/header' || event.type === 'memory/context')).toBe(false)
    flush.mockRejectedValueOnce(new Error('durability unavailable'))
    await expect(run()).rejects.toThrow('durability unavailable')
    expect(adapter.requests).toHaveLength(1)
  })

  it('drains a slow cancelled Shadow call before plugin disposal resolves', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TaskContract, { mode: 'shadow' })
    await ctx.plugin(TaskExecutionControl)
    const gateFiber = ctx.plugin(Gate, { mode: 'shadow' })
    await gateFiber
    await ctx.plugin(AgentLoop, { agents: [] })
    const body = 'Answer only'
    const adapter = new MockAdapter([options => parserResponse(options, body), textResponse('answer'), 'hang-slow'])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('shadow-drain'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: body }] }))
    await agent.whenIdle()
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(3) })
    let disposed = false
    const draining = gateFiber.dispose().then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(disposed).toBe(false)
    await draining
    expect(disposed).toBe(true)
    expect(agent.session.events.some(event => event.type === 'final-review/shadow-result')).toBe(false)
  })

  it('cancels and drains an enforcing post-delivery review without inventing a result', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TaskContract, { mode: 'enforce' })
    await ctx.plugin(TaskExecutionControl, { mode: 'enforce' })
    const gate = ctx.plugin(Gate, { mode: 'enforce', reviewTiming: 'after-delivery' })
    await gate
    await ctx.plugin(AgentLoop, { agents: [] })
    const body = 'Answer this'
    const adapter = new MockAdapter([options => parserResponse(options, body), textResponse('draft only'), 'hang-slow'])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('enforce-drain'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: body }] }))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(3) })
    let disposed = false
    const drain = gate.dispose().then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(disposed).toBe(false)
    await drain
    await agent.whenIdle()
    expect(agent.session.events.some(event => event.type === 'assistant/message')).toBe(true)
    expect(agent.session.events.some(event => event.type === 'final-review/shadow-result')).toBe(false)
    expect(adapter.requests).toHaveLength(3)
  })
})

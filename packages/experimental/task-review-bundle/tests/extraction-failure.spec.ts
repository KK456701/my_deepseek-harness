import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import TaskContract from '@deepseek-ai/dsh-experimental-task-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter, maxTokensResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function mount(adapter: MockAdapter, timeoutMs = 1_000) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TaskContract, { mode: 'shadow', parserTimeoutMs: timeoutMs })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId('requirement-parser-evidence'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '解释原因和数据影响。' }] }))
  return { agent }
}

describe('failed requirement-parser response evidence', () => {
  it.each([
    ['max-tokens', maxTokensResponse('partial JSON'), 1, 'failed'],
    ['invalid JSON', textResponse('not JSON'), 2, 'completed'],
    ['invalid changes', textResponse('{"changes":[{"op":"invalid"}]}'), 2, 'completed'],
  ] as const)('retains provider output and usage for %s without conflating transport with validation', async (_label, chunks, attempts, termination) => {
    const adapter = new MockAdapter([...Array.from({ length: attempts }, () => [...chunks]), textResponse('worker response')])
    const { agent } = await mount(adapter)
    await agent.whenIdle()
    const responses = agent.session.events.filter(event => event.type === 'task-contract/model-response')
    const assessments = agent.session.events.filter(event => event.type === 'task-contract/model-assessment')
    expect(responses).toHaveLength(attempts)
    expect(assessments).toHaveLength(attempts)
    expect(assessments.every(event => event.data.status === 'failed')).toBe(true)
    for (const event of responses) {
      expect(event.data.rawOutput).not.toEqual([])
      expect(event.data.usage).toMatchObject({ inputTokens: 10 })
      expect(event.data.response.termination).toBe(termination)
      expect(event.data.response.textBytes).toBeGreaterThan(0)
    }
    expect(agent.session.events.filter(event => event.type === 'llm/audited-call')).toHaveLength(attempts)
    expect(agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
  })

  const partial: StreamChunk[] = [
    { type: 'reasoning-delta', index: 0, text: '分析🙂' },
    { type: 'text-delta', index: 1, text: '{"changes":' },
    { type: 'usage', usage: { inputTokens: 12, outputTokens: 23, reasoningTokens: 17 } },
  ]

  it('retains partial reasoning, text, and usage on timeout without treating bytes as tokens', async () => {
    const adapter = new MockAdapter([{ hangAfter: partial }, textResponse('worker')])
    const { agent } = await mount(adapter, 30)
    await agent.whenIdle()
    const response = agent.session.events.find(event => event.type === 'task-contract/model-response')
    expect(response?.type === 'task-contract/model-response' && response.data.rawOutput)
      .toEqual([{ type: 'reasoning', text: '分析🙂' }, { type: 'text', text: '{"changes":' }])
    expect(response?.type === 'task-contract/model-response' && response.data.response)
      .toMatchObject({ termination: 'timeout', reasoningBytes: 10, textBytes: 11, outputChunks: 2 })
    expect(response?.type === 'task-contract/model-response' && response.data.usage)
      .toEqual({ inputTokens: 12, outputTokens: 23, reasoningTokens: 17 })
  })

  it('retains a cancelled prepared input and partial output without fabricating usage', async () => {
    const adapter = new MockAdapter([{ hangAfter: partial.slice(0, 2) }])
    const { agent } = await mount(adapter)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    const response = agent.session.events.find(event => event.type === 'task-contract/model-response')
    expect(response?.type === 'task-contract/model-response' && response.data.response)
      .toMatchObject({ termination: 'cancelled', reasoningBytes: 10, textBytes: 11 })
    expect(response?.type === 'task-contract/model-response' && response.data.usage).toBeUndefined()
    expect(agent.session.events.filter(event => event.type === 'task-contract/input')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'user/message' || event.type === 'request/header')).toEqual([])
  })
})

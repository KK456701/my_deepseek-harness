import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, CallId  } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture, defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as RepeatToolGuard from '@deepseek-ai/dsh-repeat-tool-reminder'
import type { Config } from '@deepseek-ai/dsh-repeat-tool-reminder'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const testToolSignal = new AbortController().signal

/**
 * Behavior suite for the repeat-tool-call guard: chain semantics (identical /
 * different-tracked / untracked-transparent / per-agent / resets), threshold
 * reminder/block thresholds, outcome-aware resets, canonicalization, and
 * fail-loud config validation — all driven
 * through a real agent loop against a scripted mock adapter (no network).
 */

/** Boot the core spine + the guard; the caller registers adapters and extra listeners. */
async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(RepeatToolGuard, config)
  ctx.tools.register(defineContentToolFixture({ name: 'probe', description: 'p', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  ctx.tools.register(defineContentToolFixture({ name: 'other', description: 'o', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => { const d = ctx.on('agent/status', ({ agent: s, status: st }) => { if (s === agent && st === 'idle') { d(); resolve() } }) })
}

/** Every injected-context user message in the agent's log, flattened to joined text + source for terse assertions. */
function reminders(agent: Agent): { text: string; source: unknown }[] {
  return [...agent.session.events]
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind !== 'user')
    .map(e => ({
      text: e.data.content.map(block => block.type === 'text' ? block.text : '').join('|'),
      source: e.data.source,
    }))
}

// The reminder is a `notice`-form context; its summary names the repeated
// call so a reader sees it without expanding the row.
const guardSource = (tool: string, count: number) => ({
  kind: 'plugin',
  plugin: 'repeat-tool-reminder',
  form: 'notice',
  summary: `${tool} × ${count}`,
})

describe('outcome-aware reminder and block', () => {
  it('allows active target-bound polls but blocks the fourth terminal repeat', async () => {
    const ctx = await harness()
    let calls = 0
    ctx.tools.register(defineTool({ name: 'poll', description: '', parameters: { id: { type: 'string', required: true } },
      effect: 'read-only', repeatPolicy: 'polling',
      activePollingResult: (args, meta) => meta !== null && typeof meta === 'object' && !Array.isArray(meta)
        && typeof args === 'object' && args !== null && 'id' in args && args.id === meta.id && meta.active === true,
      output: { schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, active: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.active ? 'running' : 'completed' }], presentationMeta: (_args, value) => value },
      execute: async args => ({ id: args.id, active: ++calls <= 4 }),
    }))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      ...Array.from({ length: 8 }, (_, i) => toolCallResponse(`poll-${i}`, 'poll', { id: 'existing-job' })), textResponse('done'),
    ]))
    const agent = ctx.agentLoop.create(SessionId('polling-repeat'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'wait' }] }))
    await agent.whenIdle()
    expect(calls).toBe(7)
    expect(agent.session.events.filter(event => event.type === 'tool/result' && event.data.message.content[0].isError)).toHaveLength(1)
    await ctx.fiber.dispose()
  })
  it('keeps rejecting unchanged retries after the fourth denial without repeating the notice', async () => {
    const ctx = await harness()
    let dispatched = 0
    ctx.on('tools/dispatch-ready', async (_exec, next) => { dispatched += 1; await next() })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      ...Array.from({ length: 7 }, (_, index) => toolCallResponse(`retry-${index}`, 'probe', {})), textResponse('blocked'),
    ]))
    const agent = ctx.agentLoop.create(SessionId('repeat-after-denial'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(dispatched).toBe(3)
    expect(reminders(agent)).toHaveLength(2)
    const results = agent.session.events.filter(event => event.type === 'tool/result')
    expect(results.filter(event => event.data.message.content[0].isError)).toHaveLength(4)
    await ctx.fiber.dispose()
  })

  it('rebuilds the unchanged chain and notice deduplication after the plugin is reloaded', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const guard = await ctx.plugin(RepeatToolGuard)
    let bodies = 0
    ctx.tools.register(defineContentToolFixture({ name: 'probe', description: 'p', parameters: {},
      async execute() { bodies += 1; return [{ type: 'text', text: 'same' }] } }))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      ...Array.from({ length: 4 }, (_, index) => toolCallResponse(`before-${index}`, 'probe', { b: 2, a: 1 })),
      textResponse('paused'), toolCallResponse('after', 'probe', { a: 1, b: 2 }), textResponse('still blocked'),
    ]))
    const agent = ctx.agentLoop.create(SessionId('repeat-restored'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await guard.dispose()
    await ctx.plugin(RepeatToolGuard)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'resume' }], source: { kind: 'plugin', plugin: 'recovery-test' } }))
    await agent.whenIdle()
    expect(bodies).toBe(3)
    expect(reminders(agent).filter(item => (item.source as { plugin: string }).plugin === 'repeat-tool-reminder')).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('reminds after three identical outcomes and denies the fourth call before dispatch', async () => {
    const ctx = await harness()
    let dispatched = 0
    ctx.on('tools/dispatch-ready', async (exec, next) => {
      if (exec.name === 'probe') dispatched += 1
      await next()
    })
    const adapter = new MockAdapter([
      ...Array.from({ length: 4 }, (_, i) => toolCallResponse(`c${i}`, 'probe', { q: 'same' })),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const found = reminders(agent)
    expect(found).toHaveLength(2)
    expect(found[0]!.text).toContain('same result 3 times')
    expect(found[0]!.source).toEqual(guardSource('probe', 3))
    expect(found[1]!.text).toContain('blocked before attempt 4')
    expect(found[1]!.source).toEqual({ kind: 'plugin', plugin: 'repeat-tool-reminder', form: 'notice', summary: 'probe blocked × 4' })
    expect(dispatched).toBe(3)
  })

  it('uses configured adjacent reminder and block counts', async () => {
    const ctx = await harness({ reminderCount: 2, blockAttempt: 3 })
    const adapter = new MockAdapter([
      ...Array.from({ length: 3 }, (_, i) => toolCallResponse(`c${i}`, 'probe', {})),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const found = reminders(agent)
    expect(found).toHaveLength(2)
    expect(found[0]!.text).toContain('same result 2 times')
    expect(found[1]!.text).toContain('blocked before attempt 3')
  })

  it('allows a fourth identical call when the third result changed', async () => {
    const ctx = await harness()
    let settled = 0
    let dispatched = 0
    ctx.on('tools/dispatch-ready', async (exec, next) => {
      if (exec.name === 'probe') dispatched += 1
      await next()
    })
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      settled += 1
      return settled === 3
        ? { kind: 'accept' as const, value: [{ type: 'text' as const, text: 'changed' }] }
        : next()
    })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      ...Array.from({ length: 4 }, (_, index) => toolCallResponse(`c${index}`, 'probe', { q: 'same' })),
      textResponse('done'),
    ]))
    const agent = ctx.agentLoop.create(SessionId('changed-third-result'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(dispatched).toBe(4)
    expect(reminders(agent)).toHaveLength(0)
  })
})

describe('chain semantics', () => {
  it('caps the detailed reminder arguments at argumentsPreviewChars (detection still keys on the full string)', async () => {
    const ctx = await harness({ reminderCount: 2, blockAttempt: 3, argumentsPreviewChars: 24 })
    const bigPayload = 'x'.repeat(400)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { body: bigPayload }),
      toolCallResponse('c2', 'probe', { body: bigPayload }),
      toolCallResponse('c3', 'probe', { body: bigPayload }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const found = reminders(agent)
    expect(found).toHaveLength(2)
    const blocked = found[1]!.text
    expect(blocked).toContain('{"body":"xxxxxxxxxxxxxx')
    expect(blocked).toContain('… (+387 more chars)')
    expect(blocked).not.toContain(bigPayload)
  })

  it('a different tracked call resets the chain', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 1 }),
      toolCallResponse('c2', 'probe', { q: 1 }),
      toolCallResponse('c3', 'other', {}), // tracked, different → reset
      toolCallResponse('c4', 'probe', { q: 1 }),
      toolCallResponse('c5', 'probe', { q: 1 }),
      toolCallResponse('c6', 'probe', { q: 1 }), // 3rd consecutive AFTER the reset
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(reminders(agent)).toHaveLength(1)
  })

  it('excluded calls are transparent: they neither count nor reset', async () => {
    const ctx = await harness({ exclude: ['other'] })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 1 }),
      toolCallResponse('c2', 'other', {}), // excluded → invisible to the chain
      toolCallResponse('c3', 'probe', { q: 1 }),
      toolCallResponse('c4', 'other', {}),
      toolCallResponse('c5', 'probe', { q: 1 }), // 3rd consecutive probe
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const found = reminders(agent)
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toContain('same result 3 times')
  })

  it('include patterns track only matching tools (wildcard star)', async () => {
    const ctx = await harness({ include: ['pro*'] })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'other', {}),
      toolCallResponse('c2', 'other', {}),
      toolCallResponse('c3', 'other', {}), // 3 identical, but untracked
      toolCallResponse('c4', 'probe', {}),
      toolCallResponse('c5', 'probe', {}),
      toolCallResponse('c6', 'probe', {}), // 3 identical, tracked
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const found = reminders(agent)
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toContain('same result 3 times')
  })

  it('escapes regex metacharacters in patterns (a dot matches only a literal dot)', async () => {
    const ctx = await harness({ exclude: ['pr.be'] }) // would match 'probe' as a regex; must not as a wildcard
    const adapter = new MockAdapter([
      ...Array.from({ length: 3 }, (_, i) => toolCallResponse(`c${i}`, 'probe', {})),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(reminders(agent)).toHaveLength(1) // probe was NOT excluded
  })

  it('canonicalization ignores property order, deeply', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { a: 1, nested: { x: [1, 2], y: null } }),
      toolCallResponse('c2', 'probe', { nested: { y: null, x: [1, 2] }, a: 1 }),
      toolCallResponse('c3', 'probe', { a: 1, nested: { x: [1, 2], y: null } }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(reminders(agent)).toHaveLength(1) // all three canonicalize identically
  })

  it('keys chains per agent: one agent repeating never trips another', async () => {
    const ctx = await harness()
    ctx.llm.registerAdapter(['mock-a'], new MockAdapter([
      toolCallResponse('a1', 'probe', { q: 1 }),
      toolCallResponse('a2', 'probe', { q: 1 }),
      textResponse('done'),
    ]))
    ctx.llm.registerAdapter(['mock-b'], new MockAdapter([
      toolCallResponse('b1', 'probe', { q: 1 }),
      toolCallResponse('b2', 'probe', { q: 1 }),
      toolCallResponse('b3', 'probe', { q: 1 }),
      textResponse('done'),
    ]))
    const agentA = ctx.agentLoop.create(SessionId('a'), { provider: 'mock-a', model: 'model-a' })
    const agentB = ctx.agentLoop.create(SessionId('b'), { provider: 'mock-b', model: 'model-b' })
    agentA.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    agentB.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await Promise.all([waitForIdle(ctx, agentA), waitForIdle(ctx, agentB)])

    expect(reminders(agentA)).toHaveLength(0) // 2 repeats < 3, despite B's 3 in the same registry
    expect(reminders(agentB)).toHaveLength(1)
  })

  it('a new user prompt resets the chain', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 1 }),
      toolCallResponse('c2', 'probe', { q: 1 }),
      textResponse('turn one done'),
      toolCallResponse('c3', 'probe', { q: 1 }), // without the reset this would be the 3rd
      textResponse('turn two done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(reminders(agent)).toHaveLength(0)
  })

  it('drops an agent chain on disposal', async () => {
    const ctx = await harness({ reminderCount: 2, blockAttempt: 3 })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 1 }),
      textResponse('done'),
      toolCallResponse('c2', 'probe', { q: 1 }), // same id, fresh agent: count 1, not 2
      textResponse('done'),
    ]))
    // Loop agents are torn down by disposing the scope that created them
    // (the loop.spec pattern): a child plugin fiber owns `first`.
    let first!: Agent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      first = inner.agentLoop.create(SessionId('reused'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))
    first.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, first)
    await fiber.dispose()
    await first.whenIdle()

    const second = ctx.agentLoop.create(SessionId('reused'), { provider: 'mock', model: 'mock' })
    second.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, second)

    expect(reminders(second)).toHaveLength(0)
  })

  it('counts identical denied outcomes and then blocks before another dispatch', async () => {
    const ctx = await harness({ reminderCount: 2, blockAttempt: 3 })
    ctx.on('tools/pre-execute', async () => ({ kind: 'deny' as const, reason: 'sealed' }))
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 1 }),
      toolCallResponse('c2', 'probe', { q: 1 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(reminders(agent)).toHaveLength(1)
  })

  it('ignores direct executes with no agent (they neither crash nor advance any chain)', async () => {
    const ctx = await harness({ reminderCount: 2, blockAttempt: 3 })
    const direct = await ctx.tools.execute({ signal: testToolSignal, callId: CallId('d1'), name: 'probe', arguments: { q: 1 } })
    expect(direct.isError).toBe(false)

    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 1 }), // if the direct call had counted, this would be #2
      textResponse('done'),
    ]))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(reminders(agent)).toHaveLength(0)
  })
})

describe('final result observation', () => {
  it('counts the downstream block result rather than the pre-policy result', async () => {
    const ctx = await harness({ reminderCount: 2, blockAttempt: 3 })
    ctx.on('tools/post-execute', async () => ({
      kind: 'block' as const,
      feedback: [{ type: 'text' as const, text: 'nope' }],
      additionalContexts: [createUserMessage({
        content: [{ type: 'text' as const, text: 'downstream-ctx' }], source: { kind: 'plugin' as const, plugin: 'test' },
      })],
    }))
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 1 }),
      toolCallResponse('c2', 'probe', { q: 1 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const found = reminders(agent)
    expect(found).toHaveLength(3)
    expect(found[0]!.text).toBe('downstream-ctx')
    expect(found[0]!.source).toEqual({ kind: 'plugin', plugin: 'test' })
    expect(found[1]!.text).toContain('same result 2 times')
    expect(found[1]!.source).toEqual(guardSource('probe', 2))
    expect(found[2]).toEqual({ text: 'downstream-ctx', source: { kind: 'plugin', plugin: 'test' } })
    const results = [...agent.session.events].filter((e): e is SessionEvent<'tool/result'> => e.type === 'tool/result')
    expect(results.every(r => r.data.message.content[0].isError)).toBe(true)
    expect(results[1]!.data.message.content[0].content).toEqual([{ type: 'text', text: 'nope' }])
  })

  it('preserves a downstream canonical value replacement while folding', async () => {
    const ctx = await harness({ reminderCount: 2, blockAttempt: 3 })
    ctx.on('tools/post-execute', async () => ({
      kind: 'accept' as const,
      value: [{ type: 'text' as const, text: 'replaced' }],
    }))
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 1 }),
      toolCallResponse('c2', 'probe', { q: 1 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const found = reminders(agent)
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toContain('same result 2 times')
    const results = [...agent.session.events].filter((e): e is SessionEvent<'tool/result'> => e.type === 'tool/result')
    expect(results[1]!.data.message.content[0].content).toEqual([{ type: 'text', text: 'replaced' }])
  })
})

describe('config validation fails loud', () => {
  async function spine(): Promise<Context> {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    return ctx
  }

  it('rejects a reminder count below two', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(RepeatToolGuard, { reminderCount: 1 })).rejects.toThrow(/reminderCount/)
  })

  it('rejects a non-adjacent block attempt', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(RepeatToolGuard, { reminderCount: 3, blockAttempt: 5 })).rejects.toThrow(/blockAttempt/)
  })

  it('rejects a non-integer reminder count', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(RepeatToolGuard, { reminderCount: 2.5 })).rejects.toThrow(/reminderCount/)
  })

  it('rejects a non-positive or fractional argumentsPreviewChars', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(RepeatToolGuard, { argumentsPreviewChars: 0 })).rejects.toThrow(/argumentsPreviewChars/)
    const ctx2 = await spine()
    await expect(ctx2.plugin(RepeatToolGuard, { argumentsPreviewChars: 12.5 })).rejects.toThrow(/argumentsPreviewChars/)
  })
})

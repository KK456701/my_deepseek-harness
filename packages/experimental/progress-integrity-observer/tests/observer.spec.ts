import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture, defineTool } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TaskContractService from '@deepseek-ai/dsh-experimental-task-contract'
import TaskExecutionControl from '@deepseek-ai/dsh-experimental-task-execution-control'
import ProgressIntegrityObserver from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

type MockScript = ConstructorParameters<typeof MockAdapter>[0]

function promptText(options: { messages: readonly { content: readonly unknown[] }[] }): string {
  return options.messages.flatMap(message => message.content).flatMap((block) => {
    if (typeof block !== 'object' || block === null || !('type' in block) || !('text' in block)) return []
    return block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  }).join('\n')
}

function parserResponse(options: { messages: readonly { content: readonly unknown[] }[] }, body: string) {
  const input = (JSON.parse(promptText(options)) as { input: { version: number; message: { text: string } } }).input
  if (input.version !== 5 || input.message.text !== body) throw new Error('parser request omitted the current message')
  return textResponse(JSON.stringify({ changes: [{ op: 'add', text: body, verification: 'execution' }] }))
}

async function harness(options: {
  worker: MockScript
  observer?: MockScript
  mode?: 'shadow' | 'enforce'
  fail?: boolean
  advanceMsPerTool?: number
  approvalWaitAfterTool?: { tool: number; durationMs: number }
  observerConfig?: {
    semanticWindowMs?: number
    maxUnconfirmedProgressMs?: number
    minWindowToolResults?: number
    maxEvidenceLookupRounds?: number
  }
}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TaskContractService, { mode: options.mode ?? 'shadow' })
  await ctx.plugin(TaskExecutionControl, { mode: options.mode ?? 'shadow' })
  await ctx.plugin(ProgressIntegrityObserver, {
    mode: options.mode ?? 'shadow', provider: 'observer', model: 'observer', ...options.observerConfig,
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  const worker = new MockAdapter(options.worker)
  const observer = new MockAdapter(options.observer ?? [])
  ctx.llm.registerAdapter(['worker'], worker)
  ctx.llm.registerAdapter(['observer'], observer)
  let completedTools = 0
  ctx.tools.register(defineContentToolFixture({
    name: 'inspect', description: '', parameters: {}, effect: 'read-only',
    async execute(args, execution) {
      completedTools += 1
      if (options.approvalWaitAfterTool?.tool === completedTools) {
        if (execution.agent === undefined) throw new Error('observer fixture requires an agent execution')
        const id = ApprovalRequestId(`observer-wait-${completedTools}`)
        execution.agent.session.append('approval/asked', { id, toolName: 'inspect' })
        vi.setSystemTime(Date.now() + options.approvalWaitAfterTool.durationMs)
        execution.agent.session.append('approval/decided', { id, outcome: 'allowed-once' })
      }
      if (options.advanceMsPerTool !== undefined) vi.setSystemTime(Date.now() + options.advanceMsPerTool)
      if (options.fail) throw new Error(`failed ${JSON.stringify(args)}`)
      return [{ type: 'text', text: `result ${JSON.stringify(args)}` }]
    },
  }))
  return { ctx, observer, worker }
}

function verdict(options: { messages: readonly { content: readonly unknown[] }[] },
  progress: 'yes' | 'no' | 'uncertain', risk: 'none' | 'repeated-loop') {
  const evidence = (JSON.parse(promptText(options)) as {
    input: { evidenceIndex: Array<{ eventId: { seq: number } }> }
  }).input.evidenceIndex
  return textResponse(JSON.stringify({
    progress, risk,
    evidenceEventIds: progress === 'yes' ? [{ kind: 'local', seq: evidence.at(-1)!.eventId.seq }]
      : evidence.map(item => ({ kind: 'local', seq: item.eventId.seq })),
    reason: progress === 'yes' ? '结果包含新的证据。' : '重复调查没有新增证据。',
  }))
}

afterEach(() => vi.useRealTimers())

describe('Progress Integrity Observer', () => {
  it('does not mechanically observe unchanged active polling results', async () => {
    const body = '等待现有任务。'
    const { ctx, observer } = await harness({ mode: 'enforce', worker: [options => parserResponse(options, body),
      ...Array.from({ length: 6 }, (_, i) => toolCallResponse(`poll-${i}`, 'poll', { id: 'job' })), textResponse('等待中。')] })
    ctx.tools.register(defineTool({ name: 'poll', description: '', parameters: { id: { type: 'string', required: true } },
      effect: 'read-only', repeatPolicy: 'polling',
      activePollingResult: (args, meta) => typeof args === 'object' && args !== null && 'id' in args && args.id === meta,
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'running' }], presentationMeta: (_args, value) => value },
      execute: async args => args.id,
    }))
    const agent = ctx.agentLoop.create(SessionId('observer-poll'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: body }] }))
    await agent.whenIdle(); await ctx.progressIntegrityObserver.whenSettled(agent)
    expect(observer.requests).toHaveLength(0)
    expect(ctx.taskExecutionControl.snapshot(agent).mode).toBe('running')
    await ctx.fiber.dispose()
  })
  it('observes three nonzero Shell exits despite successful tool dispatches', async () => {
    const body = '核对三个失败的测试。'
    const { ctx, observer } = await harness({ mode: 'enforce',
      worker: [options => parserResponse(options, body),
        ...[1, 2, 3].map(q => toolCallResponse(`shell-${q}`, 'pwsh', { command: `test ${q}` })), textResponse('已排除错误假设。')],
      observer: [(options) => {
        const input = (JSON.parse(promptText(options)) as { input: { evidenceIndex: Array<{ type: string; success?: boolean }> } }).input
        expect(input.evidenceIndex.filter(item => item.type === 'tool/result').map(item => item.success)).toEqual([false, false, false])
        expect(promptText(options)).toContain('"trigger":"mechanical"')
        return verdict(options, 'yes', 'none')
      }],
    })
    ctx.tools.register(defineContentToolFixture({ name: 'pwsh', description: '', parameters: {}, effect: 'read-only',
      execute: async args => [{ type: 'text', text: `failed ${JSON.stringify(args)}\n[exit code: 1]` }] }))
    const agent = ctx.agentLoop.create(SessionId('shell-exit-failures'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: body }] }))
    await agent.whenIdle(); await ctx.progressIntegrityObserver.whenSettled(agent)
    expect(observer.requests).toHaveLength(1)
    expect(ctx.taskExecutionControl.snapshot(agent).mode).toBe('running')
    await ctx.fiber.dispose()
  })
  it('does not re-observe the same task evidence when a control tool finishes', async () => {
    const body = '完成调查后请求确认。'
    const { ctx, observer } = await harness({ mode: 'enforce', fail: true,
      worker: [options => parserResponse(options, body),
        ...[1, 2, 3].map(q => toolCallResponse(`control-evidence-${q}`, 'inspect', { q })),
        toolCallResponse('ask-once', 'confirm', {}), textResponse('done')],
      observer: [options => verdict(options, 'yes', 'none')],
    })
    ctx.tools.register(defineContentToolFixture({ name: 'confirm', description: '', parameters: {},
      taskControl: 'ask-user', effect: 'read-only', execute: async () => [{ type: 'text', text: 'confirmed' }] }))
    const agent = ctx.agentLoop.create(SessionId('control-does-not-reobserve'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: body }] }))
    await agent.whenIdle(); await ctx.progressIntegrityObserver.whenSettled(agent)
    expect(observer.requests).toHaveLength(1)
    await ctx.fiber.dispose()
  })
  it('does not conflate numeric and textual arguments when results are otherwise identical', async () => {
    const body = '核对不同类型的参数。'
    const { ctx, observer } = await harness({ worker: [options => parserResponse(options, body),
      ...[1, '1', 1].map((q, index) => toolCallResponse(`typed-${index}`, 'constant', { q })), textResponse('done')] })
    ctx.tools.register(defineContentToolFixture({ name: 'constant', description: '', parameters: {}, effect: 'read-only',
      execute: async () => [{ type: 'text', text: 'unchanged' }] }))
    const agent = ctx.agentLoop.create(SessionId('typed-argument-no-repeat'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: body }] }))
    await agent.whenIdle(); await ctx.progressIntegrityObserver.whenSettled(agent)
    expect(observer.requests).toHaveLength(0)
    await ctx.fiber.dispose()
  })
  it('allows a failed tool result to support new diagnostic progress', async () => {
    const body = '分别核对三个故障假设。'
    const { ctx, observer } = await harness({
      worker: [options => parserResponse(options, body),
        ...[1, 2, 3].map(q => toolCallResponse(`failure-${q}`, 'inspect', { q })), textResponse('已排除一种假设。')],
      observer: [options => verdict(options, 'yes', 'none')], fail: true, mode: 'enforce',
    })
    const agent = ctx.agentLoop.create(SessionId('failed-result-new-evidence'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: body }] }))
    await agent.whenIdle()
    await ctx.progressIntegrityObserver.whenSettled(agent)
    expect(observer.requests).toHaveLength(1)
    expect(ctx.taskExecutionControl.snapshot(agent).mode).toBe('running')
    expect(agent.session.events.findLast(event => event.type === 'progress-integrity/observation')?.data.verdict?.progress).toBe('yes')
    await ctx.fiber.dispose()
  })

  it('does not reset active progress time for bookkeeping-only ledger revisions', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-04T00:00:00Z'))
    const body = '持续检查不同目标。'
    const { ctx, observer } = await harness({
      worker: [options => parserResponse(options, body),
        ...[1, 2, 3].map(q => toolCallResponse(`bookkeeping-${q}`, 'inspect', { q })), textResponse('done')],
      observer: [options => verdict(options, 'yes', 'none')], advanceMsPerTool: 100_000,
    })
    ctx.on('tools/result', (exec) => {
      if (!exec.agent) return
      const snapshot = ctx.taskContract.snapshot(exec.agent.session)
      exec.agent.session.append('task-contract/update', { formatVersion: 3, baseRevision: snapshot.revision,
        revision: snapshot.revision + 1, sourceMessageIds: [], updates: [] })
    })
    const agent = ctx.agentLoop.create(SessionId('bookkeeping-window'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: body }] }))
    await agent.whenIdle(); await ctx.progressIntegrityObserver.whenSettled(agent)
    expect(observer.requests).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('does not call the model for long normal work', async () => {
    const body = '完成一项较长检查。'
    const calls = Array.from({ length: 20 }, (_, index) => toolCallResponse(`c${index}`, 'inspect', { index }))
    const { ctx, observer } = await harness({ worker: [options => parserResponse(options, body), ...calls, textResponse('done')] })
    const agent = ctx.agentLoop.create(SessionId('observer-long-normal-work'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await ctx.progressIntegrityObserver.whenSettled(agent)
    expect(observer.requests).toHaveLength(0)
    expect(agent.session.events.some(event => event.type === 'progress-integrity/start')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('observes three productive task results after five minutes of active execution', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-04T00:00:00Z'))
    const body = '执行持续诊断。'
    const { ctx, observer } = await harness({
      worker: [options => parserResponse(options, body), toolCallResponse('c1', 'inspect', { q: 1 }),
        toolCallResponse('c2', 'inspect', { q: 2 }), toolCallResponse('c3', 'inspect', { q: 3 }), textResponse('done')],
      observer: [options => verdict(options, 'yes', 'none')],
      advanceMsPerTool: 120_000,
    })
    const agent = ctx.agentLoop.create(SessionId('observer-time-window'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle(); await ctx.progressIntegrityObserver.whenSettled(agent)
    expect(observer.requests).toHaveLength(1)
    expect(promptText(observer.requests[0]!)).toContain('"trigger":"time-window"')
    expect(agent.session.events.find(event => event.type === 'progress-integrity/observation')?.data.verdict?.progress).toBe('yes')
    await ctx.fiber.dispose()
  })

  it('ignores provider-added top-level metadata without changing the validated verdict', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-04T00:00:00Z'))
    const body = '执行持续诊断。'
    const { ctx, observer } = await harness({
      worker: [options => parserResponse(options, body), toolCallResponse('c1', 'inspect', { q: 1 }),
        toolCallResponse('c2', 'inspect', { q: 2 }), toolCallResponse('c3', 'inspect', { q: 3 }), textResponse('done')],
      observer: [(options) => {
        const evidence = (JSON.parse(promptText(options)) as {
          input: { evidenceIndex: Array<{ eventId: { seq: number }; type: string }> }
        }).input.evidenceIndex
        return textResponse(JSON.stringify({
          progress: 'yes', risk: 'none',
          evidenceEventIds: [{ kind: 'local', seq: evidence.findLast(item => item.type === 'tool/result')!.eventId.seq }],
          reason: '结果包含新的证据。', evidenceIndexVerified: true,
        }))
      }],
      advanceMsPerTool: 120_000,
      mode: 'enforce',
    })
    const agent = ctx.agentLoop.create(SessionId('observer-provider-metadata'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle(); await ctx.progressIntegrityObserver.whenSettled(agent)
    expect(observer.requests).toHaveLength(1)
    expect(agent.session.events.find(event => event.type === 'progress-integrity/observation')?.data.verdict)
      .toEqual(expect.objectContaining({ progress: 'yes', risk: 'none' }))
    expect(ctx.taskExecutionControl.snapshot(agent).mode).toBe('running')
    await ctx.fiber.dispose()
  })

  it('repairs a progress verdict that cites a call instead of its successful result', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-04T00:00:00Z'))
    const body = '执行持续诊断。'
    const { ctx, observer } = await harness({
      worker: [options => parserResponse(options, body), toolCallResponse('c1', 'inspect', { q: 1 }),
        toolCallResponse('c2', 'inspect', { q: 2 }), toolCallResponse('c3', 'inspect', { q: 3 }), textResponse('done')],
      observer: [
        (options) => {
          const evidence = (JSON.parse(promptText(options)) as {
            input: { evidenceIndex: Array<{ eventId: { seq: number }; type: string; invocation: { seq: number } }> }
          }).input.evidenceIndex
          return textResponse(JSON.stringify({
            progress: 'yes', risk: 'none',
            evidenceEventIds: [{ kind: 'local', seq: evidence[0]!.invocation.seq }],
            reason: '调用显示完成了新工作。',
          }))
        },
        (options) => {
          expect(promptText(options)).toContain('progress=yes requires at least one result event')
          return verdict(options, 'yes', 'none')
        },
      ],
      advanceMsPerTool: 120_000,
    })
    const agent = ctx.agentLoop.create(SessionId('observer-result-reference-repair'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle(); await ctx.progressIntegrityObserver.whenSettled(agent)
    expect(observer.requests).toHaveLength(2)
    expect(agent.session.events.find(event => event.type === 'progress-integrity/observation')?.data.verdict?.progress).toBe('yes')
    expect(agent.session.events.filter(event => event.type === 'task-contract/model-assessment'
      && event.data.status === 'failed')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('pauses after two five-minute windows without confirmed progress', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-04T00:00:00Z'))
    const body = '持续核对但无法确认。'
    const calls = Array.from({ length: 6 }, (_, index) => toolCallResponse(`c${index}`, 'inspect', { q: index }))
    const { ctx, observer } = await harness({
      worker: [options => parserResponse(options, body), ...calls, textResponse('等待重新规划'), textResponse('已暂停')],
      observer: [options => verdict(options, 'uncertain', 'none'), options => verdict(options, 'uncertain', 'none')],
      advanceMsPerTool: 120_000,
      mode: 'enforce',
    })
    const agent = ctx.agentLoop.create(SessionId('observer-ten-minute-hold'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle(); await ctx.progressIntegrityObserver.whenSettled(agent)
    expect(observer.requests).toHaveLength(2)
    expect(ctx.taskExecutionControl.snapshot(agent).mode).toBe('replanning')
    expect(promptText(observer.requests[1]!)).toContain('"pauseIfProgressRemainsUnconfirmed":true')
    await ctx.fiber.dispose()
  })

  it('pauses immediately when the first elapsed-window verdict confirms no progress', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-04T00:00:00Z'))
    const body = '持续执行但没有新证据。'
    const { ctx, observer } = await harness({
      worker: [options => parserResponse(options, body), toolCallResponse('c1', 'inspect', { q: 1 }),
        toolCallResponse('c2', 'inspect', { q: 2 }), toolCallResponse('c3', 'inspect', { q: 3 }),
        textResponse('等待重新规划'), textResponse('已暂停')],
      observer: [options => verdict(options, 'no', 'none')],
      advanceMsPerTool: 120_000,
      mode: 'enforce',
    })
    const agent = ctx.agentLoop.create(SessionId('observer-five-minute-no'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle(); await ctx.progressIntegrityObserver.whenSettled(agent)
    expect(observer.requests).toHaveLength(1)
    expect(ctx.taskExecutionControl.snapshot(agent).mode).toBe('replanning')
    await ctx.fiber.dispose()
  })

  it('excludes approval waiting from the five-minute active-execution window', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-04T00:00:00Z'))
    const body = '执行三次短检查。'
    const { ctx, observer } = await harness({
      worker: [options => parserResponse(options, body), toolCallResponse('c1', 'inspect', { q: 1 }),
        toolCallResponse('c2', 'inspect', { q: 2 }), toolCallResponse('c3', 'inspect', { q: 3 }), textResponse('done')],
      advanceMsPerTool: 60_000,
      approvalWaitAfterTool: { tool: 2, durationMs: 600_000 },
    })
    const agent = ctx.agentLoop.create(SessionId('observer-approval-wait'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle(); await ctx.progressIntegrityObserver.whenSettled(agent)
    expect(observer.requests).toHaveLength(0)
    expect(agent.session.events.filter(event => event.type === 'approval/asked')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'approval/decided')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('observes the third identical call/result pair exactly once', async () => {
    const body = '调查同一个问题。'
    const { ctx, observer } = await harness({
      worker: [options => parserResponse(options, body), toolCallResponse('c1', 'inspect', { q: 1 }),
        toolCallResponse('c2', 'inspect', { q: 1 }), toolCallResponse('c3', 'inspect', { q: 1 }), textResponse('done')],
      observer: [options => verdict(options, 'no', 'repeated-loop')],
    })
    const agent = ctx.agentLoop.create(SessionId('observer-repeat'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await ctx.progressIntegrityObserver.whenSettled(agent)
    expect(observer.requests, JSON.stringify(agent.session.events.filter(event => event.type === 'tool/call' || event.type === 'tool/result'))).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'progress-integrity/start')).toHaveLength(1)
    expect(agent.session.events.findLast(event => event.type === 'progress-integrity/observation')?.data.verdict)
      .toMatchObject({ progress: 'no', risk: 'repeated-loop' })
    await ctx.fiber.dispose()
  })

  it.each([false, true])('closes Observer lookup tools and preserves evidence through format repair=%s', async (repair) => {
    const body = '核查重复调用。'
    const final = JSON.stringify({ progress: 'uncertain', risk: 'none', evidenceEventIds: [], reason: '现有证据不足。' })
    const { ctx, observer } = await harness({
      worker: [options => parserResponse(options, body), ...[1, 2, 3].map(id => toolCallResponse(`c${id}`, 'inspect', { q: 1 })), textResponse('done')],
      observerConfig: { maxEvidenceLookupRounds: 1 },
      observer: [
        (options) => {
          const { input } = JSON.parse(promptText(options)) as {
            input: { evidenceIndex: { type: string; eventId: { seq: number } }[] }
          }
          expect(input.evidenceIndex).toHaveLength(3)
          expect(input.evidenceIndex.every((item: { type: string }) => item.type === 'tool/result')).toBe(true)
          return toolCallResponse('read', 'session_event_read', { seq: input.evidenceIndex[0]!.eventId.seq })
        },
        (options) => {
          expect(options.tools).toBeUndefined()
          expect(promptText(options)).toContain('证据查询预算已用尽')
          expect(JSON.stringify(options.messages)).toContain('result')
          return textResponse(repair ? '{"progress":' : final)
        },
        ...(repair ? [(options: Parameters<typeof promptText>[0] & { tools?: unknown }) => {
          expect(options.tools).toBeUndefined()
          const prior = JSON.parse((options.messages[1]!.content[0] as { text: string }).text) as {
            remainingEvidenceLookupRounds: number
            priorEvidenceLookups: unknown[]
          }
          expect(prior.remainingEvidenceLookupRounds).toBe(0)
          expect(prior.priorEvidenceLookups).toHaveLength(1)
          return textResponse(final)
        }] : []),
      ],
    })
    const agent = ctx.agentLoop.create(SessionId(`observer-budget-${repair}`), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle(); await ctx.progressIntegrityObserver.whenSettled(agent)
    expect(observer.requests).toHaveLength(repair ? 3 : 2)
    expect(agent.session.events.findLast(event => event.type === 'progress-integrity/observation')?.data.verdict)
      .toMatchObject({ progress: 'uncertain', risk: 'none' })
    await ctx.fiber.dispose()
  })

  it('lets only the Observer read a frozen suspicious event on demand', async () => {
    const body = '调查同一个问题。'
    let targetSeq = -1
    const { ctx, observer, worker } = await harness({
      worker: [options => parserResponse(options, body), toolCallResponse('c1', 'inspect', { q: 1 }),
        toolCallResponse('c2', 'inspect', { q: 1 }), toolCallResponse('c3', 'inspect', { q: 1 }), textResponse('done')],
      observer: [
        (options) => {
          const input = (JSON.parse(promptText(options)) as {
            input: { evidenceIndex: Array<{ eventId: { seq: number }; type: string }> }
          }).input
          targetSeq = input.evidenceIndex.findLast(item => item.type === 'tool/result')!.eventId.seq
          expect(options.tools?.map(tool => tool.name)).toEqual(['session_event_search', 'session_event_read'])
          return toolCallResponse('evidence-read', 'session_event_read', { seq: targetSeq })
        },
        (options) => {
          expect(promptText(options)).toContain(`\"seq\":${targetSeq}`)
          return textResponse(JSON.stringify({
            progress: 'no', risk: 'repeated-loop',
            evidenceEventIds: [{ kind: 'local', seq: targetSeq }],
            reason: '完整结果确认重复调查没有新增证据。',
          }))
        },
      ],
    })
    const agent = ctx.agentLoop.create(SessionId('observer-frozen-read'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await ctx.progressIntegrityObserver.whenSettled(agent)
    expect(observer.requests).toHaveLength(2)
    expect(worker.requests.every(request => request.tools?.every(tool => !tool.name.startsWith('session_event_')) ?? true)).toBe(true)
    expect(agent.session.events.filter(event => event.type === 'tool/call'
      && event.data.name.startsWith('session_event_'))).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('returns a frozen evidence lookup error to the Observer so it can finish from the index', async () => {
    const body = '调查同一个问题。'
    let targetSeq = -1
    const { ctx, observer } = await harness({
      worker: [options => parserResponse(options, body), toolCallResponse('c1', 'inspect', { q: 1 }),
        toolCallResponse('c2', 'inspect', { q: 1 }), toolCallResponse('c3', 'inspect', { q: 1 }), textResponse('done')],
      observer: [
        (options) => {
          const input = (JSON.parse(promptText(options)) as {
            input: { evidenceIndex: Array<{ eventId: { seq: number }; type: string }> }
          }).input
          targetSeq = input.evidenceIndex.findLast(item => item.type === 'tool/result')!.eventId.seq
          return toolCallResponse('invalid-evidence-read', 'session_event_read', { seq: targetSeq + 10_000 })
        },
        (options) => {
          expect(JSON.stringify(options.messages)).toContain('outside the frozen Session event set')
          return textResponse(JSON.stringify({
            progress: 'no', risk: 'repeated-loop',
            evidenceEventIds: [{ kind: 'local', seq: targetSeq }],
            reason: '索引已足以确认重复结果；越界读取不影响判断。',
          }))
        },
      ],
    })
    const agent = ctx.agentLoop.create(SessionId('observer-frozen-read-error'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await ctx.progressIntegrityObserver.whenSettled(agent)
    expect(observer.requests).toHaveLength(2)
    const observations = agent.session.events.filter(event => event.type === 'progress-integrity/observation')
    expect(observations.at(-1)?.data, JSON.stringify(observations))
      .toMatchObject({ verdict: { progress: 'no', risk: 'repeated-loop' } })
    await ctx.fiber.dispose()
  })

  it('does not schedule another observation from tool denials after a replanning hold', async () => {
    const body = '反复调查同一个问题。'
    const { ctx, observer } = await harness({
      worker: [options => parserResponse(options, body), toolCallResponse('c1', 'inspect', { q: 1 }),
        toolCallResponse('c2', 'inspect', { q: 1 }), toolCallResponse('c3', 'inspect', { q: 1 }),
        toolCallResponse('c4', 'inspect', { q: 1 }), textResponse('已暂停。'), textResponse('等待计划。')],
      observer: [options => verdict(options, 'no', 'repeated-loop')],
      mode: 'enforce',
    })
    const agent = ctx.agentLoop.create(SessionId('observer-held-denials'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await ctx.progressIntegrityObserver.whenSettled(agent)
    expect(ctx.taskExecutionControl.snapshot(agent).mode).toBe('replanning')
    expect(observer.requests).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'progress-integrity/start')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('observes three consecutive failures with different arguments', async () => {
    const body = '检查三个不同目标。'
    const { ctx, observer } = await harness({
      worker: [options => parserResponse(options, body), toolCallResponse('c1', 'inspect', { q: 1 }),
        toolCallResponse('c2', 'inspect', { q: 2 }), toolCallResponse('c3', 'inspect', { q: 3 }), textResponse('blocked')],
      observer: [options => verdict(options, 'no', 'none')], fail: true,
    })
    const agent = ctx.agentLoop.create(SessionId('observer-failures'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await ctx.progressIntegrityObserver.whenSettled(agent)
    expect(observer.requests).toHaveLength(1)
    expect(agent.session.events.find(event => event.type === 'progress-integrity/observation')?.data.verdict)
      .toMatchObject({ progress: 'no', risk: 'none' })
    await ctx.fiber.dispose()
  })

  it('observes A-B-A-B-A-B only when both action and outcome repeat', async () => {
    const body = '交替检查两个目标。'
    const sequence = [1, 2, 1, 2, 1, 2]
    const { ctx, observer } = await harness({
      worker: [options => parserResponse(options, body),
        ...sequence.map((q, index) => toolCallResponse(`c${index}`, 'inspect', { q })), textResponse('done')],
      observer: [options => verdict(options, 'yes', 'none')], mode: 'enforce',
    })
    const agent = ctx.agentLoop.create(SessionId('observer-alternating'), { provider: 'worker', model: 'worker' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await ctx.progressIntegrityObserver.whenSettled(agent)
    expect(observer.requests).toHaveLength(1)
    expect(agent.session.events.find(event => event.type === 'progress-integrity/observation')?.data.verdict)
      .toMatchObject({ progress: 'yes', risk: 'none' })
    expect(ctx.taskExecutionControl.snapshot(agent).mode).toBe('running')
    await ctx.fiber.dispose()
  })
})

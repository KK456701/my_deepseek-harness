import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import TaskContract from '@deepseek-ai/dsh-experimental-task-contract'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import PlanMode, { EXIT_PLAN_MODE, foldPlanMode } from '@deepseek-ai/dsh-plan-mode'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import Approval from '@deepseek-ai/dsh-user-approval'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import Control from '../src/index.ts'
import type { ExecutionIncarnation } from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function setup(config = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TaskContract)
  await ctx.plugin(Control, { mode: 'enforce', ...config })
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = ctx.agentLoop.create(SessionId('control-test'), { provider: 'mock', model: 'mock' })
  const steer = vi.spyOn(agent, 'steer').mockImplementation(() => {})
  const run = (name: string, id: string) => ctx.tools.execute({
    agent, name, callId: CallId(id), arguments: {}, signal: new AbortController().signal,
  })
  return { ctx, agent, run, steer }
}

describe('shared task execution restrictions', () => {
  it('persists file versions observed by the actual tool body with its started receipt', async () => {
    const { ctx, agent, run } = await setup()
    const target = { targetKey: FsTargetKey('fixture:file'), displayPath: 'file.txt' }
    const observation = { kind: 'present', version: FsVersion('v1') } as const
    ctx.tools.register(defineContentToolFixture({ name: 'inspect-file', description: '', parameters: {}, effect: 'read-only',
      execute: async (_args, exec) => { ctx.emit('fs/observed', target, observation, exec); return [] },
    }))
    await run('inspect-file', 'read-file')
    expect(agent.session.events.find(event => event.type === 'task-execution/result')?.data).toMatchObject({
      callId: 'read-file', started: true, files: [{ target, observation }],
    })
  })
  it.each(['before-dispatch', 'wrapper-wait', 'after-flush'])('blocks unstarted old task tools when feedback arrives at %s', async (stage) => {
    const { ctx, agent, run } = await setup()
    const message = createUserMessage({ content: [{ type: 'text', text: '不要再写文件了。' }], source: { kind: 'user' } })
    const insert = (): void => { agent.inbox.append('next-step', message) }
    if (stage === 'before-dispatch') insert()
    if (stage === 'wrapper-wait') ctx.on('tools/execute', async (_exec, next) => { await Promise.resolve(); insert(); return next() })
    if (stage === 'after-flush') vi.spyOn(ctx.sessions, 'flush').mockImplementation(async () => { insert(); return true })
    const body = vi.fn(async () => [])
    ctx.tools.register(defineContentToolFixture({ name: 'inspect', description: '', parameters: {}, effect: 'read-only', execute: body }))
    expect((await run('inspect', `barrier-${stage}`)).isError).toBe(true)
    expect(body).not.toHaveBeenCalled()
    expect(ctx.taskExecutionControl.snapshot(agent).mode).toBe('running')
    const results = agent.session.events.filter(event => event.type === 'task-execution/result')
    expect(results.every(event => event.data.started === false)).toBe(true)
  })

  it('allows normal queues and plugin notices, and lifts a withdrawn next-step barrier', async () => {
    const { ctx, agent, run } = await setup()
    const user = createUserMessage({ content: [{ type: 'text', text: 'later' }], source: { kind: 'user' } })
    agent.inbox.append('next-turn', user)
    agent.inbox.append('next-step', createUserMessage({ content: [{ type: 'text', text: 'notice' }], source: { kind: 'plugin', plugin: 'test' } }))
    const body = vi.fn(async () => [])
    ctx.tools.register(defineContentToolFixture({ name: 'inspect', description: '', parameters: {}, effect: 'read-only', execute: body }))
    expect((await run('inspect', 'queue')).isError).toBe(false)
    const feedback = createUserMessage({ content: [{ type: 'text', text: 'stop X' }], source: { kind: 'user' } })
    agent.inbox.append('next-step', feedback)
    expect((await run('inspect', 'blocked')).isError).toBe(true)
    expect(agent.inbox.remove(feedback.id)).toBe(true)
    expect((await run('inspect', 'withdrawn')).isError).toBe(false)
    expect(body).toHaveBeenCalledTimes(2)
  })

  it('blocks later nested children without undoing a child already started', async () => {
    const { ctx, agent } = await setup()
    const body = vi.fn(async () => [])
    ctx.tools.register(defineContentToolFixture({ name: 'inspect', description: '', parameters: {}, effect: 'read-only', execute: body }))
    const child = (id: string) => ctx.tools.execute({ agent, name: 'inspect', rootCallId: CallId('code-mode'), callId: CallId(id), arguments: {}, signal: new AbortController().signal })
    expect((await child('first')).isError).toBe(false)
    agent.inbox.append('next-step', createUserMessage({ content: [{ type: 'text', text: '取消后续检查' }], source: { kind: 'user' } }))
    const rest = await Promise.all([child('second'), child('third')])
    expect(rest.every(result => result.isError)).toBe(true)
    expect(body).toHaveBeenCalledTimes(1)
  })

  it('requires a separate exact approval for every unknown-effect verification call', async () => {
    const { ctx, agent, run } = await setup()
    await ctx.plugin(Approval)
    agent.session.append('turn/start', { turn: 1 })
    const approvals = vi.fn(async () => 'allowed-once' as const)
    ctx.on('approval/request', approvals)
    const body = vi.fn(async () => [])
    ctx.tools.register(defineContentToolFixture({ name: 'query', description: '', parameters: {}, execute: body }))
    ctx.taskExecutionControl.restrict(agent, 'verify', '先核验，不重复副作用')
    const first = await run('query', 'approved-one')
    expect(first.isError, JSON.stringify(first)).toBe(false)
    expect((await run('query', 'approved-two')).isError).toBe(false)
    expect(approvals).toHaveBeenCalledTimes(2)
    expect(ctx.taskExecutionControl.snapshot(agent).repairCalls).toBe(2)
    expect(body).toHaveBeenCalledTimes(2)
  })

  it('rejects an approval if user feedback arrived while it was pending', async () => {
    const { ctx, agent, run } = await setup()
    await ctx.plugin(Approval)
    agent.session.append('turn/start', { turn: 1 })
    ctx.on('approval/request', async () => {
      agent.inbox.append('next-step', createUserMessage({ content: [{ type: 'text', text: '取消检查' }], source: { kind: 'user' } }))
      return 'allowed-once'
    })
    const body = vi.fn(async () => [])
    ctx.tools.register(defineContentToolFixture({ name: 'query', description: '', parameters: {}, execute: body }))
    ctx.taskExecutionControl.restrict(agent, 'verify', '核验')
    expect((await run('query', 'late-approval')).isError).toBe(true)
    expect(agent.inbox.nextStep).toHaveLength(1)
    expect(body).not.toHaveBeenCalled()
  })
  it('does not wake the Worker repeatedly for the same hold', async () => {
    const { ctx, agent, steer } = await setup()
    ctx.taskExecutionControl.restrict(agent, 'replanning', 'Observer is unavailable')
    const revision = ctx.taskExecutionControl.snapshot(agent).revision
    ctx.taskExecutionControl.restrict(agent, 'replanning', 'Observer is unavailable')
    expect(steer).toHaveBeenCalledTimes(1)
    expect(ctx.taskExecutionControl.snapshot(agent).revision).toBe(revision)
  })

  it('uses the agent-scoped Plan Mode approval to release a replanning hold', async () => {
    const { ctx, agent, run } = await setup()
    await ctx.plugin(UserQuestions)
    ctx.userQuestions.registerProvider({
      ask: () => Promise.resolve({ answers: [{ id: 'plan-review', selected: ['Approve'] }] }),
    })
    await agent.ctx.plugin(PlanMode, { section: 'Plan before resuming task tools.' })
    const body = vi.fn(async () => [])
    ctx.tools.register(defineContentToolFixture({ name: 'inspect', description: '', parameters: {}, effect: 'read-only', execute: body }))

    ctx.taskExecutionControl.restrict(agent, 'replanning', 'Replan before another operation')
    expect(foldPlanMode(agent.session.events)).toBe(true)
    expect(ctx.taskExecutionControl.snapshot(agent).mode).toBe('replanning')

    const approved = await ctx.tools.execute({
      agent,
      name: EXIT_PLAN_MODE,
      callId: CallId('approve-replan'),
      arguments: { plan: '# Resume plan\n\nVerify the remaining work, then continue.' },
      signal: new AbortController().signal,
    })

    expect(approved.isError).toBe(false)
    expect(ctx.taskExecutionControl.snapshot(agent)).toMatchObject({ mode: 'running', reason: '用户批准当前计划' })
    expect((await run('inspect', 'after-approval')).isError).toBe(false)
    expect(body).toHaveBeenCalledTimes(1)
  })

  it('uses the root-scoped Web Plan Mode approval to release a replanning hold', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(UserQuestions)
    ctx.userQuestions.registerProvider({
      ask: () => Promise.resolve({ answers: [{ id: 'plan-review', selected: ['Approve'] }] }),
    })
    await ctx.plugin(PlanMode, { section: 'Plan before resuming task tools.' })
    await ctx.plugin(TaskContract)
    await ctx.plugin(Control, { mode: 'enforce' })
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = ctx.agentLoop.create(SessionId('root-plan-control-test'), { provider: 'mock', model: 'mock' })
    const body = vi.fn(async () => [])
    ctx.tools.register(defineContentToolFixture({ name: 'inspect', description: '', parameters: {}, effect: 'read-only', execute: body }))

    agent.session.append('turn/start', { turn: 1 })
    ctx.taskExecutionControl.restrict(agent, 'replanning', 'Replan before another operation')
    const message = createUserMessage({ content: [{ type: 'text', text: 'replan' }], source: { kind: 'user' } })
    await agentEvents(ctx, agent).waterfall('agent/pre-step', {
      messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter' as const, messages: [message] }))
    expect(foldPlanMode(agent.session.events)).toBe(true)

    const approved = await ctx.tools.execute({
      agent,
      name: EXIT_PLAN_MODE,
      callId: CallId('approve-root-replan'),
      arguments: { plan: '# Resume plan\n\nVerify the remaining work, then continue.' },
      signal: new AbortController().signal,
    })

    expect(approved.isError).toBe(false)
    expect(ctx.taskExecutionControl.snapshot(agent)).toMatchObject({ mode: 'running', reason: '用户批准当前计划' })
    expect((await ctx.tools.execute({
      agent,
      name: 'inspect',
      callId: CallId('after-root-approval'),
      arguments: {},
      signal: new AbortController().signal,
    })).isError).toBe(false)
    expect(body).toHaveBeenCalledTimes(1)
  })

  it('resolves an isolated Web Plan Mode through the agent preset roster', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const set = vi.fn()
    const observeApprovals = vi.fn(() => () => {})
    const serviceFor = vi.fn((_agent: unknown, name: string) => name === 'planMode'
      ? { set, observeApprovals } : undefined)
    ctx.provide('agentPresets', { serviceFor } as never)
    await ctx.plugin(TaskContract)
    await ctx.plugin(Control, { mode: 'enforce' })
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = ctx.agentLoop.create(SessionId('isolated-plan-control-test'), { provider: 'mock', model: 'mock' })

    ctx.taskExecutionControl.restrict(agent, 'replanning', 'Replan before another operation')

    expect(serviceFor).toHaveBeenCalledWith(agent, 'planMode')
    expect(observeApprovals).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith(agent, true)
  })

  it('blocks direct and nested task tools during answer-only rewrite', async () => {
    const { ctx, agent, run } = await setup()
    const body = vi.fn(async () => [])
    ctx.tools.register(defineContentToolFixture({ name: 'inspect', description: '', parameters: {}, effect: 'read-only', execute: body }))
    ctx.taskExecutionControl.restrict(agent, 'rewrite', 'Only the explanation is missing')
    expect((await run('inspect', 'direct')).isError).toBe(true)
    expect((await ctx.tools.execute({ agent, name: 'inspect', callId: CallId('nested'), rootCallId: CallId('outer'), arguments: {}, signal: new AbortController().signal })).isError).toBe(true)
    expect(body).not.toHaveBeenCalled()
  })

  it('rechecks the hold after another wrapper finishes waiting', async () => {
    const { ctx, agent, run } = await setup()
    let release!: () => void
    let entered!: () => void
    const ready = new Promise<void>((resolve) => { entered = resolve })
    const waiting = new Promise<void>((resolve) => { release = resolve })
    ctx.on('tools/execute', async (_exec, next) => { entered(); await waiting; return next() })
    const body = vi.fn(async () => [])
    ctx.tools.register(defineContentToolFixture({ name: 'inspect', description: '', parameters: {}, effect: 'read-only', execute: body }))
    const running = run('inspect', 'late')
    await ready
    ctx.taskExecutionControl.restrict(agent, 'replanning', 'Replan before another operation')
    release()
    expect((await running).isError).toBe(true)
    expect(body).not.toHaveBeenCalled()
  })

  it('counts real repair calls without resetting the budget on another rejection', async () => {
    const { ctx, agent, run } = await setup({ maxRepairToolCalls: 2 })
    const body = vi.fn(async () => [])
    ctx.tools.register(defineContentToolFixture({ name: 'inspect', description: '', parameters: {}, effect: 'read-only', execute: body }))
    ctx.taskExecutionControl.restrict(agent, 'continue_work', 'Verify the missing result')
    expect((await run('inspect', 'one')).isError).toBe(false)
    ctx.taskExecutionControl.restrict(agent, 'continue_work', 'Still incomplete')
    expect((await run('inspect', 'two')).isError).toBe(false)
    expect((await run('inspect', 'three')).isError).toBe(true)
    expect(body).toHaveBeenCalledTimes(2)
    expect(ctx.taskExecutionControl.snapshot(agent)).toMatchObject({ mode: 'replanning', repairCalls: 2 })
  })

  it('pauses before dispatching a task tool beyond the per-Turn safety limit', async () => {
    const { ctx, agent, run } = await setup({ maxTaskToolCallsPerTurn: 2 })
    agent.session.append('turn/start', { turn: 1 })
    const body = vi.fn(async () => [])
    ctx.tools.register(defineContentToolFixture({ name: 'inspect', description: '', parameters: {}, effect: 'read-only', execute: body }))
    expect((await run('inspect', 'one')).isError).toBe(false)
    expect((await run('inspect', 'two')).isError).toBe(false)
    expect((await run('inspect', 'three')).isError).toBe(true)
    expect(body).toHaveBeenCalledTimes(2)
    expect(ctx.taskExecutionControl.snapshot(agent)).toMatchObject({ mode: 'replanning' })
    expect(ctx.taskExecutionControl.snapshot(agent).reason).toContain('运行保险上限')
  })

  it('allows an isolated deployment to disable the per-Turn dispatch fuse', async () => {
    const { ctx, agent, run } = await setup({ maxTaskToolCallsPerTurn: false })
    agent.session.append('turn/start', { turn: 1 })
    const body = vi.fn(async () => [])
    ctx.tools.register(defineContentToolFixture({ name: 'inspect', description: '', parameters: {}, effect: 'read-only', execute: body }))
    for (let index = 0; index < 81; index += 1) {
      const result = await run('inspect', `unbounded-${index}`)
      expect(result.isError, `dispatch ${index}: ${JSON.stringify(result)}`).toBe(false)
    }
    expect(body).toHaveBeenCalledTimes(81)
    expect(ctx.taskExecutionControl.snapshot(agent).mode).toBe('running')
  })

  it('waits for the latest Observer barrier before dispatch', async () => {
    const { ctx, agent, run } = await setup()
    let first!: () => void
    let second!: () => void
    ctx.taskExecutionControl.waitForObservation(agent, new Promise((resolve) => { first = resolve }))
    const body = vi.fn(async () => [])
    ctx.tools.register(defineContentToolFixture({ name: 'inspect', description: '', parameters: {}, effect: 'read-only', execute: body }))
    const running = run('inspect', 'barrier')
    await Promise.resolve()
    ctx.taskExecutionControl.waitForObservation(agent, new Promise((resolve) => { second = resolve }))
    first()
    await new Promise(resolve => setImmediate(resolve))
    expect(body).not.toHaveBeenCalled()
    second()
    expect((await running).isError).toBe(false)
    expect(body).toHaveBeenCalledTimes(1)
  })

  it('blocks an unknown prior outcome and verifies it only through a call-specific probe', async () => {
    const { ctx, agent, run } = await setup()
    const old = 'previous-process' as ExecutionIncarnation
    agent.session.append('task-execution/dispatch', {
      incarnation: old, callId: CallId('old'), rootCallId: CallId('old'), name: 'restart', argumentsJson: '{}',
      requirementRevision: 0, inputRevision: -1,
    })
    const body = vi.fn(async () => [])
    ctx.tools.register(defineContentToolFixture({ name: 'inspect', description: '', parameters: {}, effect: 'read-only', execute: body }))
    expect((await run('inspect', 'blocked')).isError).toBe(true)
    await expect(ctx.taskExecutionControl.verifyUnknown(agent, CallId('old'), new AbortController().signal))
      .rejects.toThrow('no call-specific recovery probe')
    const probe = vi.fn(async () => 'settled' as const)
    ctx.taskExecutionControl.registerRecoveryProbe('restart', { check: probe })
    expect(await ctx.taskExecutionControl.verifyUnknown(agent, CallId('old'), new AbortController().signal)).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(body).not.toHaveBeenCalled()
    expect(ctx.taskExecutionControl.snapshot(agent).mode).toBe('replanning')
  })

  it('does not call any auxiliary authorization model', async () => {
    const { ctx, run } = await setup()
    const body = vi.fn(async () => [])
    ctx.tools.register(defineContentToolFixture({ name: 'inspect', description: '', parameters: {}, effect: 'read-only', execute: body }))
    expect((await run('inspect', 'plain')).isError).toBe(false)
    expect(body).toHaveBeenCalledTimes(1)
    expect(ctx.sessions.list().flatMap(session => session.events)
      .filter(event => event.type === 'task-contract/model-request')).toHaveLength(0)
  })
})

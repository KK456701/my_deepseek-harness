/** Shared execution pauses, repair budgets, and crash-safe dispatch receipts. */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Optional preset roster: Web presets can publish Plan Mode behind an isolate realm.
import type {} from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type { TaskFileObservation } from './types.ts'
import { mutationWatermark } from './evidence.ts'
export { freezeEvidenceFreshness, mutationWatermark } from './evidence.ts'
import type PlanModeController from '@deepseek-ai/dsh-plan-mode'
import type TaskContractService from '@deepseek-ai/dsh-experimental-task-contract'
import type { Config, ExecutionIncarnation, PendingTaskOperation, TaskExecutionMode, TaskExecutionSnapshot } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    taskContract: TaskContractService
    taskExecutionControl: TaskExecutionControl
  }
}

/** Provider-owned read-only query for one persisted operation. */
export interface RecoveryProbe {
  check(operation: PendingTaskOperation, signal: AbortSignal): Promise<'settled' | 'unknown'>
}

/** Coordinates Gate and Observer holds at the existing tool execution point. */
export class TaskExecutionControl extends Service {
  static inject = ['agents', 'sessions', 'taskContract', 'tools']
  static Config: z<Config> = z.object({
    mode: z.union(['shadow', 'enforce'] as const).default('shadow'),
    maxRepairWorkerSteps: z.number().step(1).min(1).default(2),
    maxRepairToolCalls: z.number().step(1).min(1).default(6),
    maxRepairMs: z.number().step(1).min(1).default(120_000),
    maxTaskToolCallsPerTurn: z.union([z.number().step(1).min(1), z.const(false)]).default(80),
  })

  private readonly config: Required<Config>
  private readonly instances = new WeakMap<Agent, ExecutionIncarnation>()
  private readonly observations = new WeakMap<Agent, Promise<void>>()
  private readonly inFlight = new Map<ToolExecution, AbortController>()
  private readonly dispatched = new WeakMap<Agent, Set<CallId>>()
  private readonly prepared = new WeakMap<ToolExecution, { requirementRevision: number; inputRevision: number }>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly probes = new Map<string, RecoveryProbe>()
  private readonly planApprovalAgents = new WeakSet<Agent>()
  private readonly requestInputs = new WeakMap<Agent, ReadonlySet<MessageId>>()
  private readonly verificationApprovals = new WeakMap<ToolExecution, number>()
  private readonly observedFiles = new WeakMap<object, TaskFileObservation[]>()
  private readonly shutdown = new AbortController()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'taskExecutionControl')
    this.config = TaskExecutionControl.Config(config) as Required<Config>
    ctx.effect(() => async () => {
      this.shutdown.abort(new Error('task execution control disposed'))
      for (const controller of this.inFlight.values()) controller.abort(this.shutdown.signal.reason)
      await Promise.allSettled([...this.pending])
    }, 'taskExecutionControl.drain')
    if (!this.enforcing) return

    ctx.on('fs/observed', (target, observation, actor) => {
      if (actor === undefined) return
      const files = this.observedFiles.get(actor)
      if (files !== undefined) files.push({ target, observation })
    })

    ctx.effect(() => ctx.tools.guard(exec => this.denial(exec)), 'taskExecutionControl.guard')
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      if (decision.kind === 'deny' || !this.owns(exec.agent) || this.isControl(exec)) return decision
      const state = this.snapshot(exec.agent)
      if (state.mode !== 'verify' || this.ctx.tools.get(exec.name, exec.agent)?.effect === 'read-only') return decision
      this.verificationApprovals.set(exec, state.revision)
      return { kind: 'ask', reason: `${decision.kind === 'ask' ? (decision.reason ?? '') + '\n' : ''}当前仅允许核验。此调用的副作用范围不明确，需要单次批准：${exec.name} ${JSON.stringify(exec.arguments)}` }
    })
    ctx.on('tools/execute', async (exec, next) => {
      if (!this.owns(exec.agent) || this.isControl(exec)) return next()
      const controller = new AbortController(); this.inFlight.set(exec, controller)
      this.observedFiles.set(exec, [])
      exec.signal = AbortSignal.any([exec.signal, controller.signal, this.shutdown.signal])
      const promise = next(); this.pending.add(promise)
      try { return await promise } finally { this.pending.delete(promise); this.inFlight.delete(exec) }
    })
    ctx.on('tools/dispatch-ready', async (exec, next) => {
      await next()
      if (this.owns(exec.agent) && !this.isControl(exec)) await this.beforeDispatch(exec, exec.agent)
    })
    ctx.on('tools/result', (exec, result) => {
      if (!this.owns(exec.agent) || !this.dispatched.get(exec.agent)?.delete(exec.callId)) return
      if (exec.started && result.isError && result.error.info?.code === 'ABORTED') {
        this.restrict(exec.agent, 'outcome_unknown', '已启动操作被取消且外部结果未知；核验回执前不得重试。')
        return
      }
      exec.agent.session.append('task-execution/result', {
        incarnation: this.incarnation(exec.agent), callId: exec.callId, isError: result.isError, started: exec.started,
        mutationSeq: mutationWatermark(exec.agent.session.events), files: this.observedFiles.get(exec) ?? [],
      })
    })
    ctx.on('agent/request-starting', ({ agent, turn, step }) => {
      if (!this.owns(agent)) return
      this.requestInputs.set(agent, new Set(agent.session.events.flatMap(event =>
        event.type === 'user/message' && event.data.source.kind === 'user' ? [event.data.id] : [])))
      const state = this.snapshot(agent)
      if (state.mode !== 'rewrite' && state.mode !== 'verify' && state.mode !== 'continue_work') return
      const key = `${turn}:${step}`
      if (state.lastWorkerStep === key) return
      if (this.expired(state) || state.repairSteps >= this.config.maxRepairWorkerSteps) {
        this.restrict(agent, 'replanning', '补救预算已耗尽；提交新计划后再继续。')
        return
      }
      this.save(agent, { ...state, repairSteps: state.repairSteps + 1, lastWorkerStep: key })
    })
    ctx.on('agent/session-start', ({ agent }) => {
      if (!this.owns(agent)) return
      this.bindPlanApproval(agent)
      this.recover(agent)
    })
    ctx.on('agent/disposed', ({ agent }) => {
      for (const [exec, controller] of this.inFlight) if (exec.agent === agent) controller.abort(new Error('Agent disposed'))
    })
  }

  private bindPlanApproval(agent: Agent): PlanModeController | undefined {
    const planMode = agent.ctx.get('planMode')
      ?? this.ctx.get('agentPresets')?.serviceFor(agent, 'planMode')
      ?? this.ctx.get('planMode')
    if (planMode === undefined || this.planApprovalAgents.has(agent)) return planMode
    agent.ctx.effect(() => planMode.observeApprovals(({ agent: reviewedAgent }) => {
      if (reviewedAgent !== agent) return { validate: () => {}, approved: () => {} }
      const state = this.snapshot(agent)
      const contract = this.ctx.taskContract.snapshot(agent.session)
      const nextStep = this.ctx.taskContract.nextStepRevision(agent.session)
      return {
        validate: () => {
          this.shutdown.signal.throwIfAborted()
          if (this.inputBarrier(agent) !== undefined) throw new Error('用户插话尚未处理；不能批准旧计划')
          const current = this.ctx.taskContract.snapshot(agent.session)
          if (this.snapshot(agent).revision !== state.revision || current.revision !== contract.revision
            || current.inputRevision !== contract.inputRevision || this.ctx.taskContract.nextStepRevision(agent.session) !== nextStep
            || this.ctx.agents.get(agent.session.id) !== agent) throw new Error('需求或执行状态已变化；请重新展示计划')
          if (state.mode === 'outcome_unknown' || this.unknownOperations(agent).length > 0) {
            throw new Error('先前操作结果未知；核验回执后才能恢复')
          }
        },
        approved: () => {
          this.save(agent, {
            incarnation: this.incarnation(agent), revision: state.revision, mode: 'running', reason: '用户批准当前计划',
            repairCalls: 0, repairSteps: 0,
          })
        },
      }
    }), 'taskExecutionControl.plan-approval')
    this.planApprovalAgents.add(agent)
    return planMode
  }

  /** Whether this deployment enforces restrictions. */
  get enforcing(): boolean { return this.config.mode === 'enforce' }

  /**
   * Reconstruct the latest Session execution state.
   * @param agent Agent whose Session owns the execution state.
   * @returns Latest persisted state or the initial running state.
   */
  snapshot(agent: Agent): TaskExecutionSnapshot {
    const record = agent.session.events.findLast(event => event.type === 'task-execution/state')
    return record?.type === 'task-execution/state' ? record.data.snapshot
      : { incarnation: this.incarnation(agent), revision: 0, mode: 'running', reason: '', repairSteps: 0, repairCalls: 0 }
  }

  /**
   * Enter repair or pause without resetting its budget.
   * @param agent Agent whose task-tool execution is restricted.
   * @param mode Repair or hold mode to enter.
   * @param reason User-visible reason for the restriction.
   */
  restrict(agent: Agent, mode: Exclude<TaskExecutionMode, 'running'>, reason: string): void {
    if (!this.enforcing) return
    const state = this.snapshot(agent)
    const held = state.mode === 'replanning' || state.mode === 'outcome_unknown'
    const selected = held && mode !== 'outcome_unknown' ? state.mode : mode
    if (state.mode === selected && state.reason === reason) return
    this.save(agent, { ...state, mode: selected, reason, repairStartedAt: state.repairStartedAt ?? Date.now() })
    if (selected === 'replanning' || selected === 'outcome_unknown' || selected === 'rewrite') {
      for (const [exec, controller] of this.inFlight) if (exec.agent === agent) controller.abort(new Error(reason))
    }
    if (selected === 'replanning' || selected === 'outcome_unknown') this.bindPlanApproval(agent)?.set(agent, true)
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: `Task execution state: ${selected}. ${reason}\n${selected === 'rewrite'
        ? '仅用已有证据改写回答，不得运行任务工具。'
        : selected === 'verify' ? '先用只读工具核验现有结果；没有证据不等于没有执行，不得重复原操作。影响不明的核验调用需要单次批准。'
          : selected === 'continue_work' ? '只在现有授权和剩余预算内修正有证据的缺失工作，不重做整个任务。'
            : '任务工具已暂停。提交计划或询问用户；计划应写清已否定的假设及其证据、尚未解决的问题和不同的验证方法。不要只说换个思路，也不要重跑已经完成的副作用。经用户批准具体计划后才能恢复，切换计划模式本身不会解除暂停。'}` }],
      source: { kind: 'plugin', plugin: 'task-execution-control', form: 'notice', summary: reason },
    }))
  }

  /**
   * Register the observation barrier for the next task-tool dispatch.
   * @param agent Agent whose next dispatch must wait.
   * @param observation Promise for the latest required observation.
   */
  waitForObservation(agent: Agent, observation: Promise<void>): void { this.observations.set(agent, observation) }

  /**
   * Release an answer-repair restriction after the Reviewer accepts the replacement.
   * @param agent Agent whose accepted repair resumes ordinary execution.
   */
  finishRepair(agent: Agent): void {
    if (!this.enforcing) return
    const state = this.snapshot(agent)
    if (state.mode !== 'rewrite' && state.mode !== 'verify' && state.mode !== 'continue_work') return
    this.save(agent, {
      incarnation: this.incarnation(agent), revision: state.revision, mode: 'running',
      reason: '交付复核已通过', repairSteps: 0, repairCalls: 0,
    })
  }

  /**
   * Check restrictions in the synchronous final commit callback.
   * @param agent Agent attempting to commit a candidate answer.
   * @returns Whether deterministic execution state permits commit.
   */
  canCommit(agent: Agent): boolean {
    if (!this.enforcing) return true
    const state = this.snapshot(agent)
    return state.mode !== 'replanning' && state.mode !== 'outcome_unknown'
      && this.unknownOperations(agent).length === 0 && !this.expired(state) && !this.shutdown.signal.aborted
  }

  /**
   * Register a provider-owned read-only recovery query.
   * @param name Tool name whose unknown dispatch can be queried.
   * @param probe Provider-owned status query implementation.
   * @returns Registration disposer.
   */
  registerRecoveryProbe(name: string, probe: RecoveryProbe): () => void {
    if (this.probes.has(name)) throw new Error(`recovery probe already registered for ${name}`)
    this.probes.set(name, probe)
    const dispose = this.ctx.effect(() => () => { this.probes.delete(name) }, 'taskExecutionControl.recovery-probe')
    return () => { void dispose() }
  }

  /**
   * Verify one unknown call without reopening general Worker tools.
   * @param agent Agent whose Session contains the unmatched dispatch.
   * @param callId Dispatch identity to query.
   * @param signal Caller cancellation signal.
   * @returns Whether the provider confirmed that the dispatch settled.
   */
  async verifyUnknown(agent: Agent, callId: CallId, signal: AbortSignal): Promise<boolean> {
    const receipt = agent.session.events.findLast(event => event.type === 'task-execution/dispatch' && event.data.callId === callId)
    if (receipt?.type !== 'task-execution/dispatch') throw new Error('unknown dispatch receipt')
    if (!this.unknownOperations(agent).some(item => item.callId === callId && item.incarnation === receipt.data.incarnation)) {
      throw new Error('dispatch is active or already settled')
    }
    const probe = this.probes.get(receipt.data.name)
    if (probe === undefined) throw new Error('no call-specific recovery probe; obtain approval for a verification plan')
    const promise = probe.check(receipt.data, AbortSignal.any([signal, this.shutdown.signal])); this.pending.add(promise)
    let result: 'settled' | 'unknown'
    try { result = await promise } finally { this.pending.delete(promise) }
    signal.throwIfAborted(); this.shutdown.signal.throwIfAborted()
    if (result === 'unknown') return false
    agent.session.append('task-execution/result', { callId, incarnation: receipt.data.incarnation, isError: false })
    if (this.unsettled(agent).length === 0) this.save(agent, { ...this.snapshot(agent), mode: 'replanning', reason: '操作结果已核验；提交计划后再恢复' })
    return true
  }

  private async beforeDispatch(exec: ToolExecution, agent: Agent): Promise<void> {
    let observation: Promise<void> | undefined
    do { observation = this.observations.get(agent); await observation } while (observation !== this.observations.get(agent))
    exec.signal.throwIfAborted()
    const denial = this.denial(exec); if (denial !== undefined) throw new Error(denial)
    const contract = this.ctx.taskContract.snapshot(agent.session)
    let state = this.snapshot(agent)
    if (state.mode === 'continue_work' || state.mode === 'verify') {
      if (state.repairCalls >= this.config.maxRepairToolCalls) {
        this.restrict(agent, 'replanning', '补救工具调用预算已耗尽。')
        throw new Error('task repair tool-call budget exhausted')
      }
      const approvedRevision = this.verificationApprovals.get(exec)
      state = { ...state, repairCalls: state.repairCalls + 1 }; this.save(agent, state)
      if (approvedRevision === state.revision) this.verificationApprovals.set(exec, this.snapshot(agent).revision)
    }
    const current = this.ctx.taskContract.snapshot(agent.session)
    if (current.revision !== contract.revision || current.inputRevision !== contract.inputRevision) throw new Error('requirements changed before tool dispatch')
    const latestDenial = this.denial(exec); if (latestDenial !== undefined) throw new Error(latestDenial)
    agent.session.append('task-execution/dispatch', {
      incarnation: this.incarnation(agent), callId: exec.callId, rootCallId: exec.rootCallId, name: exec.name,
      argumentsJson: JSON.stringify(exec.arguments), requirementRevision: current.revision, inputRevision: current.inputRevision,
      effect: this.ctx.tools.get(exec.name, agent)?.effect ?? 'unknown', mutationSeq: mutationWatermark(agent.session.events),
    })
    let calls = this.dispatched.get(agent)
    if (calls === undefined) { calls = new Set(); this.dispatched.set(agent, calls) }
    calls.add(exec.callId)
    this.prepared.set(exec, { requirementRevision: current.revision, inputRevision: current.inputRevision })
    await this.ctx.sessions.flush(agent.session)
    exec.signal.throwIfAborted()
  }

  private denial(exec: ToolExecution): string | undefined {
    if (!this.owns(exec.agent) || this.isControl(exec)) return undefined
    if (this.shutdown.signal.aborted) return 'task execution control disposed'
    const inputBarrier = this.inputBarrier(exec.agent)
    if (inputBarrier !== undefined) return inputBarrier
    const prepared = this.prepared.get(exec)
    if (prepared !== undefined) {
      const current = this.ctx.taskContract.snapshot(exec.agent.session)
      if (prepared.requirementRevision !== current.revision || prepared.inputRevision !== current.inputRevision) return 'requirements changed after dispatch intent was flushed'
    }
    const state = this.snapshot(exec.agent)
    if (state.mode === 'verify' && this.ctx.tools.get(exec.name, exec.agent)?.effect !== 'read-only'
      && (!exec.approvedOnce || this.verificationApprovals.get(exec) !== state.revision)) {
      return '核验阶段只允许可信只读工具或当前状态下单次批准的准确调用。'
    }
    if (state.mode === 'rewrite' || state.mode === 'replanning' || state.mode === 'outcome_unknown') return `Task tools paused (${state.mode}): ${state.reason}`
    const safetyReason = this.safetyLimitReason(exec.agent, prepared === undefined ? 0 : 1)
    if (safetyReason !== undefined) {
      this.restrict(exec.agent, 'replanning', safetyReason)
      return safetyReason
    }
    if (this.expired(state)) return 'task repair time budget exhausted; submit a new plan'
    if (this.unknownOperations(exec.agent).length > 0) return 'earlier operation outcome is unknown; no blind retry'
    return undefined
  }

  private inputBarrier(agent: Agent): string | undefined {
    if (agent.inbox.nextStep.some(message => message.source.kind === 'user')) {
      return '用户插话等待处理；本步骤尚未启动的任务工具已阻止，请先领取输入并更新需求。'
    }
    const captured = this.requestInputs.get(agent)
    if (captured !== undefined && agent.session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'user' && !captured.has(event.data.id))) {
      return '当前操作来自尚未包含最新用户输入的旧请求。'
    }
    return undefined
  }

  private isControl(exec: ToolExecution): boolean { return this.ctx.tools.get(exec.name, exec.agent)?.taskControl !== undefined }
  private owns(agent?: Agent): agent is Agent { return agent !== undefined && agent.session.header.purpose === 'interactive' && this.ctx.agents.roots().includes(agent) }
  private safetyLimitReason(agent: Agent, currentDispatchReceipts = 0): string | undefined {
    if (this.config.maxTaskToolCallsPerTurn === false) return undefined
    const start = agent.session.events.findLast(event => event.type === 'turn/start' && !agent.session.events
      .some(candidate => candidate.type === 'turn/end' && candidate.data.turn === event.data.turn))
    if (start?.type !== 'turn/start') return undefined
    const dispatchCount = agent.session.events
      .filter(event => event.seq > start.seq && event.type === 'task-execution/dispatch').length - currentDispatchReceipts
    if (dispatchCount >= this.config.maxTaskToolCallsPerTurn) {
      return `本轮已达到 ${this.config.maxTaskToolCallsPerTurn} 次任务工具派发的运行保险上限；这不代表任务跑偏，请说明已完成内容并重新规划。`
    }
    return undefined
  }
  private expired(state: TaskExecutionSnapshot): boolean {
    return state.repairStartedAt !== undefined && Date.now() - state.repairStartedAt >= this.config.maxRepairMs
  }
  private incarnation(agent: Agent): ExecutionIncarnation {
    let id = this.instances.get(agent)
    if (id === undefined) { id = randomUUID() as ExecutionIncarnation; this.instances.set(agent, id) }
    return id
  }
  private save(agent: Agent, state: TaskExecutionSnapshot): void {
    agent.session.append('task-execution/state', {
      snapshot: { ...state, incarnation: this.incarnation(agent), revision: this.snapshot(agent).revision + 1 },
    })
  }
  private unsettled(agent: Agent): Array<PendingTaskOperation & { incarnation: ExecutionIncarnation }> {
    const results = new Set(agent.session.events.filter(event => event.type === 'task-execution/result')
      .map(event => `${event.data.incarnation}:${event.data.callId}`))
    return agent.session.events.flatMap(event => event.type === 'task-execution/dispatch'
      && !results.has(`${event.data.incarnation}:${event.data.callId}`)
      ? [{ incarnation: event.data.incarnation, callId: event.data.callId,
        name: event.data.name, argumentsJson: event.data.argumentsJson }]
      : [])
  }
  private recover(agent: Agent): void {
    if (this.unknownOperations(agent).length > 0) this.restrict(agent, 'outcome_unknown', '先前操作没有可靠结果；使用调用级只读查询或请求核验计划，不得盲目重试。')
  }
  private unknownOperations(agent: Agent): Array<PendingTaskOperation & { incarnation: ExecutionIncarnation }> {
    return this.unsettled(agent).filter(item => item.incarnation !== this.incarnation(agent)
      || !this.dispatched.get(agent)?.has(item.callId))
  }
}

export default TaskExecutionControl

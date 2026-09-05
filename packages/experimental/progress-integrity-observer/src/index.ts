/** Event-triggered progress judgment for mechanically suspicious tool runs. */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zz } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createToolResultMessage, createUserMessage, errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import { AuditedLlmCallId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  auditedReviewStream,
  auxiliaryPrompt,
  AuxiliaryValidationError,
  executeFrozenSessionEvidenceTool,
  ExtractionCapture,
  frozenSessionEvidenceIndex,
  frozenSessionEvidenceTools,
  taskToolResultSuccess,
  recordAuxiliaryAssessment,
  validateAuxiliary,
} from '@deepseek-ai/dsh-experimental-task-contract'
import type { EventRef, TaskContractSnapshot } from '@deepseek-ai/dsh-experimental-task-contract'
import type {} from '@deepseek-ai/dsh-experimental-task-execution-control'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { progressRules } from './prompt.ts'
import { isRepeatGuardRejection } from '@deepseek-ai/dsh-repeat-tool-reminder'
import { isActivePollingResult } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/cordis' {
  interface Context { progressIntegrityObserver: ProgressIntegrityObserver }
}

/** Observer route and program-owned threshold settings. */
export interface Config {
  /** Whether observations only record diagnostics or may pause task tools. */
  readonly mode?: 'shadow' | 'enforce'
  /** Identical completed call/result pairs that trigger one observation. */
  readonly repeatOutcomeCount?: number
  /** Consecutive failed task-tool results that trigger one observation. */
  readonly failureStreak?: number
  /** A/B cycles whose unchanged outcomes trigger one observation. */
  readonly alternatingCycles?: number
  /** Active execution milliseconds before a semantic progress observation becomes due. */
  readonly semanticWindowMs?: number
  /** Active execution milliseconds without a confirmed `progress=yes` before Enforce pauses. */
  readonly maxUnconfirmedProgressMs?: number
  /** Completed task-tool results required before a time-window observation. */
  readonly minWindowToolResults?: number
  /** Maximum UTF-8 bytes in the complete Observer request. */
  readonly maxInputBytes?: number
  /** Observer provider; empty inherits the Worker provider. */
  readonly provider?: string
  /** Observer model; empty inherits the Worker model. */
  readonly model?: string
  /** Adapter-owned Observer effort; empty inherits the route default. */
  readonly reasoningEffort?: string
  /** Maximum provider output tokens for one observation attempt. */
  readonly maxTokens?: number
  /** Milliseconds allowed for one observation attempt. */
  readonly timeoutMs?: number
  /** Maximum read-only Session lookup rounds inside one observation attempt. */
  readonly maxEvidenceLookupRounds?: number
  /** Maximum matches returned by one frozen Session search. */
  readonly maxEvidenceSearchResults?: number
}

/** Minimal semantic judgment for one completed Step. */
export interface ProgressVerdict {
  readonly progress: 'yes' | 'no' | 'uncertain'
  readonly risk: 'none' | 'repeated-loop' | 'off-track' | 'critical-assumption'
  readonly evidenceEventIds: readonly EventRef[]
  readonly reason: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Freezes the requirement revision and selected execution evidence before dispatch. */
    'progress-integrity/start': {
      version?: 2
      turn: number
      step: number
      requirementRevision?: number
      inputRevision?: number
      evidenceEventIds?: readonly EventRef[]
      provider: string
      model: string
      /** Legacy payload retained for read-only replay. */
      contract?: TaskContractSnapshot
      evidenceSeqs?: number[]
    }
    /** Validated verdict for one mechanically selected tool-result window. */
    'progress-integrity/observation': {
      version?: 2
      requirementRevision?: number
      inputRevision?: number
      stale?: boolean
      turn: number
      step: number
      verdict?: ProgressVerdict
      /** Legacy every-Step counter retained for read-only replay. */
      consecutiveNoProgress?: number
      rawOutput: ContentBlock[]
      usage?: TokenUsage
      error?: string
      /** Legacy model-authored observation retained for old logs. */
      observation?: unknown
      taskId?: string
    }
  }
}

const eventRefSchema = zz.object({ kind: zz.literal('local'), seq: zz.number().int().nonnegative() }).strict()
const verdictOutputSchema = zz.object({
  progress: zz.enum(['yes', 'no', 'uncertain']),
  risk: zz.enum(['none', 'repeated-loop', 'off-track', 'critical-assumption']),
  evidenceEventIds: zz.array(eventRefSchema),
  reason: zz.string(),
}).strict()
// The advertised JSON schema remains closed, but provider-added top-level
// metadata cannot influence execution control and is discarded before the
// four owned fields are validated.
const verdictSchema = verdictOutputSchema.strip()

/** Serial per-Agent observer; Enforce pauses after a validated event-triggered verdict. */
export class ProgressIntegrityObserver extends Service {
  static inject = ['agents', 'llm', 'sessions', 'taskContract', 'taskExecutionControl', 'tools']
  static Config: z<Config> = z.object({
    mode: z.union(['shadow', 'enforce'] as const).default('shadow'),
    repeatOutcomeCount: z.number().step(1).min(2).default(3),
    failureStreak: z.number().step(1).min(2).default(3),
    alternatingCycles: z.number().step(1).min(2).default(3),
    semanticWindowMs: z.number().step(1).min(1).default(300_000),
    maxUnconfirmedProgressMs: z.number().step(1).min(1).default(600_000),
    minWindowToolResults: z.number().step(1).min(1).default(3),
    maxInputBytes: z.number().step(1).min(1).default(262_144),
    provider: z.string().default(''), model: z.string().default(''), reasoningEffort: z.string().default(''),
    maxTokens: z.number().step(1).min(1).default(1_024), timeoutMs: z.number().step(1).min(1).default(30_000),
    maxEvidenceLookupRounds: z.number().step(1).min(1).default(2),
    maxEvidenceSearchResults: z.number().step(1).min(1).default(12),
  })

  private readonly config: Required<Config>
  private readonly tails = new WeakMap<Agent, Promise<void>>()
  private readonly scheduled = new WeakSet<Agent>()
  private readonly observing = new WeakSet<Agent>()
  private readonly lifecycle = new WeakMap<Agent, AbortController>()
  private readonly shutdown = new AbortController()
  private readonly pending = new Set<Promise<void>>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'progressIntegrityObserver')
    this.config = {
      mode: config.mode ?? 'shadow', repeatOutcomeCount: positive(config.repeatOutcomeCount ?? 3),
      failureStreak: positive(config.failureStreak ?? 3), alternatingCycles: positive(config.alternatingCycles ?? 3),
      semanticWindowMs: positive(config.semanticWindowMs ?? 300_000),
      maxUnconfirmedProgressMs: positive(config.maxUnconfirmedProgressMs ?? 600_000),
      minWindowToolResults: positive(config.minWindowToolResults ?? 3),
      maxInputBytes: positive(config.maxInputBytes ?? 262_144),
      provider: config.provider ?? '', model: config.model ?? '', reasoningEffort: config.reasoningEffort ?? '',
      maxTokens: positive(config.maxTokens ?? 1_024), timeoutMs: positive(config.timeoutMs ?? 30_000),
      maxEvidenceLookupRounds: positive(config.maxEvidenceLookupRounds ?? 2),
      maxEvidenceSearchResults: positive(config.maxEvidenceSearchResults ?? 12),
    }
    if (this.config.maxUnconfirmedProgressMs < this.config.semanticWindowMs * 2) {
      throw new Error('maxUnconfirmedProgressMs must permit at least two semantic progress windows')
    }
    if (this.config.mode === 'enforce' && !ctx.get('taskExecutionControl')?.enforcing) {
      throw new Error('Observer Enforce requires enforcing TaskExecutionControl')
    }
    ctx.on('session/event', (session, event) => {
      if (this.shutdown.signal.aborted || session.header.purpose !== 'interactive' || event.type !== 'tool/result') return
      const agent = ctx.agents.get(session.id)
      if (agent === undefined || !ctx.agents.roots().includes(agent)) return
      if (this.observing.has(agent)) return
      const executionMode = ctx.taskExecutionControl.snapshot(agent).mode
      if (executionMode === 'replanning' || executionMode === 'outcome_unknown' || executionMode === 'rewrite') return
      const trigger = observationTrigger(session, event, this.config,
        name => ctx.tools.get(name, agent)?.taskControl === undefined,
        (name, args, result) => isActivePollingResult(ctx.tools.get(name, agent), args, {
          isError: result.data.message.content[0].isError === true,
          ...(result.data.meta === undefined ? {} : { meta: result.data.meta }),
        }))
      if (trigger === undefined || this.scheduled.has(agent)) return
      const contract = ctx.taskContract.snapshot(session)
      const route = this.route(agent)
      this.scheduled.add(agent)
      queueMicrotask(() => {
        try {
          if (this.shutdown.signal.aborted || ctx.agents.get(session.id) !== agent) return
          const executionMode = ctx.taskExecutionControl.snapshot(agent).mode
          if (executionMode === 'replanning' || executionMode === 'outcome_unknown' || executionMode === 'rewrite') return
          const current = ctx.taskContract.snapshot(session)
          if (current.revision !== contract.revision || current.inputRevision !== contract.inputRevision) return
          this.enqueue(agent, event.data.turn, event.data.step, contract, trigger, route)
        } catch (error: unknown) {
          session.append('progress-integrity/observation', { version: 2, turn: event.data.turn, step: event.data.step,
            requirementRevision: contract.revision, inputRevision: contract.inputRevision, rawOutput: [], error: errorChain(error) })
          if (this.config.mode === 'enforce') ctx.taskExecutionControl.restrict(agent, 'replanning', '进度检查不可用；核对失败后再继续。')
        } finally {
          this.scheduled.delete(agent)
        }
      })
    }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => this.lifecycle.get(agent)?.abort(new Error('progress observer disposed')))
    ctx.effect(() => async () => {
      this.shutdown.abort(new Error('progress observer disposed'))
      await Promise.allSettled([...this.pending])
    }, 'progressIntegrityObserver.drain')
  }

  /**
   * Wait until already queued observations settle.
   * @param agent Root Agent whose observation queue must become idle.
   */
  async whenSettled(agent: Agent): Promise<void> {
    let tail: Promise<void> | undefined
    do { tail = this.tails.get(agent); await tail } while (tail !== this.tails.get(agent))
  }

  private enqueue(agent: Agent, turn: number, step: number, contract: TaskContractSnapshot,
    observation: ObservationTrigger, route: { provider: string; model: string }): void {
    const controller = this.controller(agent)
    const currentBasis = (): boolean => {
      const current = this.ctx.taskContract.snapshot(agent.session)
      return this.ctx.agents.get(agent.session.id) === agent && current.revision === contract.revision
        && current.inputRevision === contract.inputRevision
    }
    const trigger = agent.session.append('progress-integrity/start', { version: 2, turn, step,
      requirementRevision: contract.revision, inputRevision: contract.inputRevision,
      evidenceEventIds: observation.evidenceEventIds, ...route })
    const prior = this.tails.get(agent) ?? Promise.resolve()
    const next = prior.then(async () => {
      if (controller.signal.aborted || this.shutdown.signal.aborted) return
      // A completed Step is judged against the task state frozen when that Step ended.
      // Replaying it against a later user correction creates a false temporal relation.
      if (!currentBasis()) {
        agent.session.append('progress-integrity/observation', { version: 2, turn, step,
          requirementRevision: contract.revision, inputRevision: contract.inputRevision,
          stale: true, rawOutput: [], error: 'requirement or input revision changed before dispatch' })
        return
      }
      const callId = AuditedLlmCallId(`progress-${randomUUID()}`)
      try {
        const reviewed = await this.observe(agent, contract, observation, route,
          AbortSignal.any([controller.signal, this.shutdown.signal]), callId, currentBasis,
          { triggerSeq: trigger.seq, turn, step })
        if (!currentBasis()) {
          recordAuxiliaryAssessment(agent.session, reviewed.callId, { status: 'stale', error: 'requirement or input revision changed' })
          agent.session.append('progress-integrity/observation', { version: 2, turn, step,
            requirementRevision: contract.revision, inputRevision: contract.inputRevision, stale: true,
            verdict: reviewed.verdict, rawOutput: reviewed.rawOutput, ...(reviewed.usage === undefined ? {} : { usage: reviewed.usage }) })
          return
        }
        recordAuxiliaryAssessment(agent.session, reviewed.callId, { status: 'validated', result: { verdict: reviewed.verdict } })
        agent.session.append('progress-integrity/observation', { version: 2, turn, step,
          requirementRevision: contract.revision, inputRevision: contract.inputRevision, stale: false,
          verdict: reviewed.verdict, rawOutput: reviewed.rawOutput,
          ...(reviewed.usage === undefined ? {} : { usage: reviewed.usage }) })
        if (this.config.mode === 'enforce' && (reviewed.verdict.progress === 'no'
          || reviewed.verdict.risk !== 'none'
          || (reviewed.verdict.progress === 'uncertain' && observation.pauseIfUnconfirmed))) {
          this.ctx.taskExecutionControl.restrict(agent, 'replanning', reviewed.verdict.reason)
        }
      } catch (error: unknown) {
        if (anyAborted(controller.signal, this.shutdown.signal)) return
        agent.session.append('progress-integrity/observation', { version: 2, turn, step,
          requirementRevision: contract.revision, inputRevision: contract.inputRevision,
          stale: !currentBasis(), rawOutput: [], error: errorChain(error) })
        if (!currentBasis()) return
        if (this.config.mode === 'enforce') this.ctx.taskExecutionControl.restrict(agent, 'replanning', '进度检查失败；确认下一步计划后再继续。')
      }
    })
    const settled = next.catch((error: unknown) => {
      this.ctx.logger.warn(`progress observer failed: ${errorChain(error)}`)
    })
    this.tails.set(agent, settled)
    if (this.config.mode === 'enforce') this.ctx.taskExecutionControl.waitForObservation(agent, settled)
    this.pending.add(settled)
    this.observing.add(agent)
    void settled.finally(() => { this.pending.delete(settled); this.observing.delete(agent) })
  }

  private async observe(agent: Agent, contract: TaskContractSnapshot, observation: ObservationTrigger,
    route: { provider: string; model: string }, parentSignal: AbortSignal, callId: AuditedLlmCallId,
    assertCurrent: () => boolean, context: { triggerSeq: number; turn: number; step: number }):
  Promise<{ callId: AuditedLlmCallId; verdict: ProgressVerdict; rawOutput: ContentBlock[]; usage?: TokenUsage }> {
    const evidence = observation.evidenceEventIds.map((ref) => {
      if (ref.kind !== 'local') throw new Error('observer only accepts local evidence')
      const event = agent.session.events[ref.seq]
      if (event === undefined) throw new Error(`missing observation event ${ref.seq}`)
      return event
    })
    const previous = agent.session.events.findLast(event => event.type === 'progress-integrity/observation'
      && event.data.stale === false && event.data.requirementRevision === contract.revision
      && event.data.inputRevision === contract.inputRevision && event.data.verdict?.progress === 'yes'
      && event.data.verdict.risk === 'none')
    const input = {
      version: 4,
      latestStep: { turn: context.turn, step: context.step },
      observationWindow: {
        trigger: observation.kind,
        activeExecutionMs: observation.activeExecutionMs,
        pauseIfProgressRemainsUnconfirmed: observation.pauseIfUnconfirmed,
      },
      ...(previous?.type !== 'progress-integrity/observation' ? {} : { previousProgress: previous.data.verdict?.reason }),
      requirements: contract.requirements.filter(item => item.state !== 'cancelled')
        .map(({ id, revision, text, verification }) => ({ id, revision, text, verification })),
      ...(contract.approvedPlan === undefined ? {} : { approvedPlan: contract.approvedPlan.text }),
      originalUserMessages: this.ctx.taskContract.originalInputs(contract, context.turn)
        .map(item => ({ messageId: item.messageId, content: item.content })),
      evidenceIndex: evidence.filter(event => event.type !== 'tool/call')
        .map(event => frozenSessionEvidenceIndex(event, evidence)),
    }
    let diagnostic: string | undefined
    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs)
    let lookupRounds = 0
    const priorLookups = new Map<string, { name: string; arguments: string; content: string; isError: boolean }>()
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const attemptCallId = AuditedLlmCallId(`${callId}-${attempt}`)
      const prompt = auxiliaryPrompt('progress-integrity-observation', progressRules,
        zz.toJSONSchema(verdictOutputSchema), { ...input,
          maxEvidenceLookupRounds: this.config.maxEvidenceLookupRounds }, attempt, diagnostic)
      if (prompt.bytes > this.config.maxInputBytes) throw new Error('progress review input exceeds maxInputBytes; no evidence was truncated')
      const messages = [...prompt.options.messages]
      if (priorLookups.size > 0) messages.push(createUserMessage({
        source: { kind: 'plugin', plugin: 'progress-integrity-observation' },
        content: [{ type: 'text', text: JSON.stringify({ priorEvidenceLookups: [...priorLookups.values()],
          remainingEvidenceLookupRounds: this.config.maxEvidenceLookupRounds - lookupRounds }) }],
      }))
      let usage: TokenUsage | undefined
      let assessmentCallId = attemptCallId
      try {
        for (let round = 0; round <= this.config.maxEvidenceLookupRounds; round += 1) {
          timeoutSignal.throwIfAborted()
          const closing = lookupRounds === this.config.maxEvidenceLookupRounds
          const tools = closing ? [] : [...frozenSessionEvidenceTools]
          const requestMessages = closing ? [...messages, createUserMessage({
            source: { kind: 'plugin', plugin: 'progress-integrity-observation' },
            content: [{ type: 'text', text: '证据查询预算已用尽；仅根据已读材料输出判断 JSON，证据不足用 uncertain。' }],
          })] : messages
          assessmentCallId = round === 0 ? attemptCallId : AuditedLlmCallId(`${attemptCallId}-evidence-${round}`)
          const capture = new ExtractionCapture()
          capture.timeoutSignal = timeoutSignal
          const requestBytes = Buffer.byteLength(JSON.stringify({ system: prompt.options.system,
            messages: requestMessages, tools }))
          if (requestBytes > this.config.maxInputBytes) throw new Error('progress review request exceeds maxInputBytes; no evidence was truncated')
          for await (const chunk of auditedReviewStream(this.ctx, agent.session, assessmentCallId, {
            ...route, ...prompt.options, messages: requestMessages, ...(tools.length === 0 ? {} : { tools }),
            ...(this.config.reasoningEffort === '' ? {} : { reasoningEffort: ReasoningEffortId(this.config.reasoningEffort) }),
            maxTokens: this.config.maxTokens, sessionId: agent.session.id,
            signal: AbortSignal.any([parentSignal, timeoutSignal]),
          }, { ...prompt.metadata, context: { triggerSeq: context.triggerSeq, requirementRevision: contract.revision,
            location: { scope: 'conversation', turn: context.turn, step: context.step, phase: 'after-step', subjectId: `${context.turn}:${context.step}` } } },
          () => { if (!assertCurrent()) throw new Error('queued observation has an obsolete requirement revision') })) capture.push(chunk)
          parentSignal.throwIfAborted(); timeoutSignal.throwIfAborted()
          usage = addUsage(usage, capture.assembler.usage)
          const rawOutput = capture.assembler.blocks()
          const toolCalls = rawOutput.filter(block => block.type === 'tool-call')
          if (toolCalls.length > 0) {
            if (closing) {
              throw new Error(`progress observer exceeded ${this.config.maxEvidenceLookupRounds} evidence lookup rounds`)
            }
            lookupRounds += 1
            messages.push(createAssistantMessage({ content: rawOutput, source: { provider: route.provider, model: route.model } }))
            for (const toolCall of toolCalls) {
              try {
                const result = executeFrozenSessionEvidenceTool(evidence, toolCall.name, toolCall.arguments,
                  this.config.maxEvidenceSearchResults)
                priorLookups.set(JSON.stringify([toolCall.name, toolCall.arguments]), {
                  name: toolCall.name, arguments: toolCall.arguments, content: result.content, isError: false,
                })
                messages.push(createToolResultMessage({ callId: toolCall.id, isError: false,
                  content: [{ type: 'text', text: result.content }] }))
              } catch (error: unknown) {
                const content = errorChain(error)
                priorLookups.set(JSON.stringify([toolCall.name, toolCall.arguments]), {
                  name: toolCall.name, arguments: toolCall.arguments, content, isError: true,
                })
                messages.push(createToolResultMessage({ callId: toolCall.id, isError: true,
                  content: [{ type: 'text', text: content }] }))
              }
            }
            continue
          }
          if (capture.assembler.finish.kind !== 'stop') throw new Error(`progress observation ended with ${capture.assembler.finish.kind}`)
          const verdict = validateAuxiliary(() => {
            const parsed = verdictSchema.parse(JSON.parse(stripFence(rawOutput.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))))
            const allowed = new Set(observation.evidenceEventIds.flatMap(ref => ref.kind === 'local' ? [ref.seq] : []))
            if (parsed.evidenceEventIds.some(ref => !allowed.has(ref.seq))) throw new Error('progress verdict cited evidence outside the frozen window')
            if (parsed.progress === 'yes') {
              if (parsed.evidenceEventIds.length === 0) throw new Error('progress=yes requires evidence')
              if (parsed.evidenceEventIds.length === 0
                || !parsed.evidenceEventIds.every(ref => agent.session.events[ref.seq]?.type === 'tool/result')) {
                throw new Error('progress=yes requires at least one result event and cannot cite call-only events')
              }
            }
            return parsed
          })
          return { callId: assessmentCallId, verdict, rawOutput, ...(usage === undefined ? {} : { usage }) }
        }
        throw new Error('progress evidence lookup exhausted')
      } catch (error: unknown) {
        recordAuxiliaryAssessment(agent.session, assessmentCallId, { status: 'failed', error: errorChain(error) })
        if (parentSignal.aborted || !(error instanceof AuxiliaryValidationError) || attempt === 2) throw error
        diagnostic = error.message
      }
    }
    throw new Error('progress validation exhausted')
  }

  private route(agent: Agent): { provider: string; model: string } {
    const header = agent.session.requestHeader()?.config
    const provider = this.config.provider || header?.provider || agent.options.provider || ''
    const model = this.config.model || header?.model || agent.options.model || ''
    if (!provider || !model) throw new Error('progress observer has no provider/model')
    return { provider, model }
  }

  private controller(agent: Agent): AbortController {
    let controller = this.lifecycle.get(agent)
    if (controller === undefined) {
      controller = new AbortController(); this.lifecycle.set(agent, controller)
      const owned = controller
      agent.ctx.effect(() => async () => { owned.abort(new Error('progress observer owner disposed')); await this.tails.get(agent) }, 'progressIntegrityObserver.agentDrain')
    }
    return controller
  }
}

interface ToolPair {
  readonly actionKey: string
  readonly outcomeKey: string
  readonly failed: boolean
  readonly eventIds: readonly EventRef[]
}

interface ObservationTrigger {
  readonly evidenceEventIds: EventRef[]
  readonly kind: 'mechanical' | 'time-window'
  readonly activeExecutionMs: number
  readonly pauseIfUnconfirmed: boolean
}

/** Select mechanically suspicious runs or an elapsed semantic progress window. */
function observationTrigger(session: Session, current: Extract<SessionEvent, { type: 'tool/result' }>,
  config: Required<Config>, isTaskTool: (name: string) => boolean,
  isPolling: (name: string, args: unknown, result: Extract<SessionEvent, { type: 'tool/result' }>) => boolean): ObservationTrigger | undefined {
  const events = session.events.some(event => event.seq === current.seq) ? session.events : [...session.events, current]
  const currentIndex = events.findIndex(event => event.seq === current.seq)
  const currentCall = events.slice(0, currentIndex).findLast(event => event.type === 'tool/call'
    && event.data.callId === current.data.message.source.callId)
  if (currentCall?.type !== 'tool/call' || !isTaskTool(currentCall.data.name)) return undefined
  if (current.data.message.content.some(block => block.isError && isRepeatGuardRejection(block.content))) return undefined
  if (isPolling(currentCall.data.name, parseArguments(currentCall.data.arguments), current)) {
    return timeWindowTrigger(events, currentIndex, current, config, isTaskTool)
  }
  const lastDirectUserIndex = events.slice(0, currentIndex + 1)
    .findLastIndex(event => event.type === 'user/message' && event.data.source.kind === 'user')
  const pairs = taskToolPairs(events.slice(lastDirectUserIndex + 1, currentIndex + 1)
    .filter(event => (event.type !== 'tool/call' && event.type !== 'tool/result') || event.data.turn === current.data.turn), isTaskTool, isPolling)
  const repeated = pairs.slice(-config.repeatOutcomeCount)
  const firstRepeated = repeated[0]
  let mechanical: ObservationTrigger | undefined
  if (repeated.length === config.repeatOutcomeCount
    && firstRepeated !== undefined
    && repeated.every(pair => pair.actionKey === firstRepeated.actionKey && pair.outcomeKey === firstRepeated.outcomeKey)) {
    mechanical = mechanicalTrigger(repeated)
  }
  const failures = pairs.slice(-config.failureStreak)
  if (mechanical === undefined && failures.length === config.failureStreak && failures.every(pair => pair.failed)) {
    mechanical = mechanicalTrigger(failures)
  }
  const alternating = pairs.slice(-(config.alternatingCycles * 2))
  const alternatingFirst = alternating[0]
  const alternatingSecond = alternating[1]
  if (mechanical === undefined && alternating.length === config.alternatingCycles * 2
    && alternatingFirst !== undefined && alternatingSecond !== undefined
    && alternatingFirst.actionKey !== alternatingSecond.actionKey
    && alternating.every((pair, index) => {
      const expected = index % 2 === 0 ? alternatingFirst : alternatingSecond
      return pair.actionKey === expected.actionKey && pair.outcomeKey === expected.outcomeKey
    })) {
    mechanical = mechanicalTrigger(alternating)
  }
  const elapsed = timeWindowTrigger(events, currentIndex, current, config, isTaskTool)
  if (mechanical === undefined) return elapsed
  return elapsed === undefined ? mechanical : {
    ...mechanical,
    evidenceEventIds: uniqueEventRefs([...mechanical.evidenceEventIds, ...elapsed.evidenceEventIds]),
    activeExecutionMs: elapsed.activeExecutionMs,
    pauseIfUnconfirmed: elapsed.pauseIfUnconfirmed,
  }
}

function mechanicalTrigger(pairs: readonly ToolPair[]): ObservationTrigger {
  return { evidenceEventIds: pairs.flatMap(pair => pair.eventIds), kind: 'mechanical',
    activeExecutionMs: 0, pauseIfUnconfirmed: false }
}

function timeWindowTrigger(events: readonly SessionEvent[], currentIndex: number,
  current: Extract<SessionEvent, { type: 'tool/result' }>, config: Required<Config>,
  isTaskTool: (name: string) => boolean): ObservationTrigger | undefined {
  const turnStartIndex = events.slice(0, currentIndex + 1)
    .findLastIndex(event => event.type === 'turn/start' && event.data.turn === current.data.turn)
  if (turnStartIndex < 0) return undefined
  let baselineIndex = turnStartIndex
  for (let index = turnStartIndex + 1; index <= currentIndex; index += 1) {
    const event = events[index]
    if ((event?.type === 'task-contract/update' && event.data.sourceMessageIds.length > 0) || event?.type === 'plan/review-approved'
      || (event?.type === 'progress-integrity/observation' && event.data.stale !== true
        && event.data.verdict?.progress === 'yes' && event.data.verdict.risk === 'none')) baselineIndex = index
  }
  const windowEvents = events.slice(baselineIndex, currentIndex + 1)
  const resultPairs = taskToolPairs(windowEvents, isTaskTool)
  if (resultPairs.length < config.minWindowToolResults) return undefined
  const activeExecutionMs = activeDuration(events, baselineIndex, currentIndex)
  const lastObservationIndex = events.slice(baselineIndex, currentIndex + 1)
    .findLastIndex(event => event.type === 'progress-integrity/observation' && event.data.stale !== true)
  const checkpointIndex = lastObservationIndex < 0 ? baselineIndex : baselineIndex + lastObservationIndex
  const sinceCheckMs = activeDuration(events, checkpointIndex, currentIndex)
  if (sinceCheckMs < config.semanticWindowMs) return undefined
  return {
    evidenceEventIds: resultPairs.flatMap(pair => pair.eventIds),
    kind: 'time-window',
    activeExecutionMs,
    pauseIfUnconfirmed: activeExecutionMs >= config.maxUnconfirmedProgressMs,
  }
}

function taskToolPairs(events: readonly SessionEvent[], isTaskTool: (name: string) => boolean,
  isPolling?: (name: string, args: unknown, result: Extract<SessionEvent, { type: 'tool/result' }>) => boolean): ToolPair[] {
  const calls = new Map<string, Extract<SessionEvent, { type: 'tool/call' }>>()
  return events.flatMap((event): ToolPair[] => {
    if (event.type === 'tool/call') { calls.set(event.data.callId, event); return [] }
    if (event.type !== 'tool/result') return []
    const call = calls.get(event.data.message.source.callId)
    if (call === undefined || !isTaskTool(call.data.name)) return []
    if (isPolling?.(call.data.name, parseArguments(call.data.arguments), event)) return []
    if (event.data.message.content.some(block => block.isError && isRepeatGuardRejection(block.content))) return []
    return [{
      actionKey: `${call.data.name}\u0000${canonicalJson(parseArguments(call.data.arguments))}`,
      outcomeKey: canonicalJson({ content: event.data.message.content.map(block => ({
        type: block.type, content: block.content, isError: block.isError,
      })), error: event.data.error }),
      failed: taskToolResultSuccess(event, call) === false,
      eventIds: [{ kind: 'local', seq: call.seq }, { kind: 'local', seq: event.seq }],
    }]
  })
}

function activeDuration(events: readonly SessionEvent[], startIndex: number, endIndex: number): number {
  const start = events[startIndex]
  const end = events[endIndex]
  if (start === undefined || end === undefined || end.time <= start.time) return 0
  const prefix = events.slice(0, startIndex + 1)
  const paused = prefix.findLast(event => event.type === 'task-execution/state')
  let isPaused = paused?.type === 'task-execution/state'
    && (paused.data.snapshot.mode === 'replanning' || paused.data.snapshot.mode === 'outcome_unknown')
  const approvals = new Set<string>()
  let observing = false
  for (const event of prefix) {
    if (event.type === 'approval/asked') approvals.add(String(event.data.id))
    else if (event.type === 'approval/decided') approvals.delete(String(event.data.id))
    else if (event.type === 'progress-integrity/start') observing = true
    else if (event.type === 'progress-integrity/observation') observing = false
  }
  let cursor = start.time
  let active = 0
  for (const event of events.slice(startIndex + 1, endIndex + 1)) {
    if (!isPaused && approvals.size === 0 && !observing && event.time > cursor) active += event.time - cursor
    cursor = Math.max(cursor, event.time)
    if (event.type === 'task-execution/state') {
      isPaused = event.data.snapshot.mode === 'replanning' || event.data.snapshot.mode === 'outcome_unknown'
    } else if (event.type === 'approval/asked') approvals.add(String(event.data.id))
    else if (event.type === 'approval/decided') approvals.delete(String(event.data.id))
    else if (event.type === 'progress-integrity/start') observing = true
    else if (event.type === 'progress-integrity/observation') observing = false
  }
  return active
}

function uniqueEventRefs(refs: readonly EventRef[]): EventRef[] {
  const seen = new Set<number>()
  return refs.filter((ref) => {
    if (ref.kind !== 'local' || seen.has(ref.seq)) return false
    seen.add(ref.seq)
    return true
  })
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  if (value === undefined) return 'undefined'
  return JSON.stringify(value)
}

function parseArguments(text: string): unknown {
  try { return JSON.parse(text) } catch { return text } // The executor retains malformed argument text.
}

function anyAborted(...signals: readonly AbortSignal[]): boolean {
  return signals.some(signal => signal.aborted)
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('observer limits must be positive safe integers')
  return value
}

function stripFence(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('```') ? trimmed.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '') : trimmed
}

function addUsage(left: TokenUsage | undefined, right: TokenUsage | undefined): TokenUsage | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  const optional = (key: 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens'): number | undefined => {
    const value = (left[key] ?? 0) + (right[key] ?? 0)
    return value === 0 && left[key] === undefined && right[key] === undefined ? undefined : value
  }
  const cacheReadTokens = optional('cacheReadTokens')
  const cacheWriteTokens = optional('cacheWriteTokens')
  const reasoningTokens = optional('reasoningTokens')
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

export default ProgressIntegrityObserver

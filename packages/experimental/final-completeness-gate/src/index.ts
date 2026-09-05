/** Durable deferred-output writer, final reviewer, and non-blocking shadow reviewer. */

import { randomUUID } from 'node:crypto'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zz } from 'zod'
import { freezeReviewInput, fulfilledReviews, projectReviewInput, reviewAction, reviewCompletesTask, reviewSchema, validateReview } from './review.ts'
import { reviewRules } from './prompt.ts'
import type {
  Agent,
  AssistantCandidateFinish,
  AssistantStagingWriter,
  FinalCandidateDecision,
} from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createToolResultMessage, createUserMessage, errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, ContentBlock, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { AuditedLlmCallId, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { RequirementUpdate, TaskContractSnapshot } from '@deepseek-ai/dsh-experimental-task-contract'
import { auditedReviewStream, recordAuxiliaryAssessment, recordAuxiliaryApplication, auxiliaryPrompt, ExtractionCapture, StreamChunkBatcher, AuxiliaryValidationError, validateAuxiliary } from '@deepseek-ai/dsh-experimental-task-contract'
import { freezeEvidenceFreshness, mutationWatermark } from '@deepseek-ai/dsh-experimental-task-execution-control'
import {
  CandidateId,
  ReviewAttemptId,
} from './types.ts'
import type {
  CandidateBasis,
  Config,
  FinalReviewResult,
  FrozenReviewInput,
} from './types.ts'
import { executeReviewEvidenceTool, reviewEvidenceTools, reviewLookupEvents } from './evidence.ts'

export * from './types.ts'

const DEFAULT_MAX_TOKENS = 2048
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_CANDIDATE_BYTES = 262_144
const DEFAULT_TURN_BYTES = 2_097_152
const DEFAULT_SESSION_BYTES = 16_777_216
const DEFAULT_CANDIDATES_PER_TURN = 8
const DEFAULT_REVIEW_BYTES = 131_072
const DEFAULT_EVIDENCE_REFS = 64
const DEFAULT_EVIDENCE_LOOKUP_ROUNDS = 4

interface CandidateRecord {
  readonly id: CandidateId
  readonly basis: CandidateBasis
  readonly sourceSeqs: number[]
  candidateSeq?: number
  status: 'generating' | 'awaiting_review' | 'reviewing' | 'awaiting_user' | 'awaiting_commit' | 'committed' | 'rejected' | 'superseded' | 'aborted'
}

/** Final-answer review plugin. */
export class FinalCompletenessGate extends Service {
  static inject = ['agents', 'llm', 'sessions', 'taskContract', 'taskExecutionControl']
  static Config: z<Config> = z.object({
    mode: z.union(['shadow', 'enforce'] as const).default('shadow'),
    reviewTiming: z.union(['after-delivery', 'before-delivery'] as const).default('before-delivery'),
    reviewerProvider: z.string().default(''),
    reviewerModel: z.string().default(''),
    reviewerReasoningEffort: z.string().default(''),
    reviewerMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
    reviewerTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TIMEOUT_MS),
    allowCrossProviderReview: z.boolean().default(false),
    maxCandidateBytes: z.number().step(1).min(1).default(DEFAULT_CANDIDATE_BYTES),
    maxTurnStagingBytes: z.number().step(1).min(1).default(DEFAULT_TURN_BYTES),
    maxSessionStagingBytes: z.number().step(1).min(1).default(DEFAULT_SESSION_BYTES),
    maxCandidatesPerTurn: z.number().step(1).min(1).default(DEFAULT_CANDIDATES_PER_TURN),
    maxReviewOutputBytes: z.number().step(1).min(1).default(DEFAULT_REVIEW_BYTES),
    maxEvidenceRefs: z.number().step(1).min(1).default(DEFAULT_EVIDENCE_REFS),
    maxEvidenceLookupRounds: z.number().step(1).min(1).default(DEFAULT_EVIDENCE_LOOKUP_ROUNDS),
    maxReviewInputBytes: z.number().step(1).min(1).default(262_144),
  })

  private readonly incarnations = new WeakMap<Agent, string>()
  private readonly config: Required<Config>
  private readonly candidates = new WeakMap<Agent, Map<string, CandidateRecord>>()
  private readonly requestBases = new WeakMap<Agent, Map<string, CandidateBasis>>()
  private readonly shadowTails = new WeakMap<Agent, Promise<void>>()
  private readonly lifecycle = new WeakMap<Agent, AbortController>()
  private readonly shutdown = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'finalCompletenessGate')
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'final-draft/decision') return
      const review = session.events.findLast(candidate => candidate.type === 'final-draft/review-result'
        && candidate.data.candidateId === event.data.candidateId)
      if (review?.type === 'final-draft/review-result') recordAuxiliaryApplication(session, AuditedLlmCallId(review.data.attemptId), event)
    })
    ctx.effect(() => async () => {
      this.shutdown.abort(new Error('final review disposed'))
      await Promise.allSettled([...this.pending])
    }, 'finalCompletenessGate.drain')
    this.config = resolveConfig(config)
    if (this.config.mode === 'enforce' && !ctx.get('taskExecutionControl')?.enforcing) throw new Error('Final Gate Enforce requires enforcing TaskExecutionControl')
    if (this.config.mode === 'shadow') this.registerAfterDelivery(ctx, false)
    else if (this.config.reviewTiming === 'after-delivery') this.registerAfterDelivery(ctx, true)
    else {
      this.registerEnforce(ctx)
      ctx.on('agent/session-start', ({ agent }) => {
        if (isInteractiveRoot(agent)) this.recover(agent)
      })
    }
    ctx.on('agent/disposed', ({ agent }) => { this.lifecycle.get(agent)?.abort(new Error('final review disposed')) })
  }

  private registerAfterDelivery(ctx: Context, enforce: boolean): void {
    ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
      if (!isInteractiveRoot(agent) || this.shutdown.signal.aborted) return
      const event = agent.session.events.findLast(candidate => candidate.type === 'assistant/message' && candidate.data.turn === turn)
      if (event?.type !== 'assistant/message') return
      if (agent.session.events.some(candidate => candidate.type === 'final-review/shadow-result'
        && candidate.data.candidateId === CandidateId(`delivered-${event.seq}`))) return
      const attempts = agent.session.events.filter(candidate => candidate.type === 'final-review/shadow-start'
        && candidate.data.turn === turn).length
      if (attempts >= this.config.maxCandidatesPerTurn) {
        if (enforce) ctx.taskExecutionControl.restrict(agent, 'replanning',
          `本轮交付复核已达到 ${this.config.maxCandidatesPerTurn} 次运行保险上限；请说明现状并重新规划。`)
        return
      }
      const route = this.reviewRoute(agent, event.data.message.source.provider)
      const id = CandidateId(`delivered-${event.seq}`)
      const contract = ctx.taskContract.snapshot(agent.session)
      agent.session.append('final-review/shadow-start', {
        candidateId: id,
        turn,
        message: event.data.message,
        contract,
        provider: route.provider,
        model: route.model,
      })
      const controller = this.controller(agent)
      const cancelled = (): boolean => controller.signal.aborted || this.shutdown.signal.aborted
      const prior = this.shadowTails.get(agent) ?? Promise.resolve()
      const next = prior.then(async () => {
        if (cancelled()) return
        try {
          const signal = AbortSignal.any([controller.signal, this.shutdown.signal])
          const reviewed = await this.review(agent, id, event.data.message, contract, event.seq, route, signal, false,
            enforce ? 'final-candidate-review' : 'final-shadow-review')
          if (cancelled()) return
          const action = reviewed.result === undefined ? undefined : reviewAction(reviewed.result)
          agent.session.append('final-review/shadow-result', {
            candidateId: id,
            turn,
            candidateSeq: event.seq,
            enforced: enforce,
            ...reviewed,
            ...(action === undefined ? {} : { action }),
          })
          if (!enforce || reviewed.result === undefined) return
          const appliedAction = reviewAction(reviewed.result)
          if (appliedAction === 'commit') {
            this.applyFulfilled(agent, reviewed.result)
            ctx.taskExecutionControl.finishRepair(agent)
            return
          }
          ctx.taskExecutionControl.restrict(agent, appliedAction === 'replan' ? 'replanning' : appliedAction,
            correction(id, reviewed.result, appliedAction))
        } catch (error: unknown) {
          if (!cancelled()) {
            agent.session.append('final-review/shadow-result', {
              candidateId: id,
              turn,
              candidateSeq: event.seq,
              enforced: enforce,
              ...(enforce ? { action: 'replan' as const } : {}),
              rawOutput: [],
              error: errorChain(error),
            })
            if (enforce) ctx.taskExecutionControl.restrict(agent, 'replanning',
              `交付复核失败，未自动放行：${errorChain(error)}`)
          }
        }
      })
      const settled = next.catch((error: unknown) => { ctx.logger.warn(`shadow review failed: ${errorChain(error)}`) })
      this.shadowTails.set(agent, settled)
      this.pending.add(settled)
      void settled.then(() => { this.pending.delete(settled) })
      if (enforce) await settled
    })
  }

  private registerEnforce(ctx: Context): void {
    ctx.on('agent/request-starting', ({ agent, turn, step }) => {
      if (!isInteractiveRoot(agent)) return
      const contract = ctx.taskContract.snapshot(agent.session)
      const basis: CandidateBasis = {
        requirementRevision: contract.revision,
        inputRevision: contract.inputRevision,
        ...(contract.approvedPlan?.approval.kind === 'local' ? { approvedPlanSeq: contract.approvedPlan.approval.seq } : {}),
        incarnation: this.incarnation(agent),
        nextStepRevision: ctx.taskContract.nextStepRevision(agent.session),
        turn,
        step,
        ...(isExecutionControlNotice(agent.session, turn, step) ? { controlNotice: true as const } : {}),
      }
      let bases = this.requestBases.get(agent)
      if (bases === undefined) {
        bases = new Map()
        this.requestBases.set(agent, bases)
      }
      bases.set(key(turn, step), basis)
    })

    ctx.on('agent/assistant-delivery', async ({ agent, turn, step }, next) => {
      if (!isInteractiveRoot(agent)) return next()
      const basis = this.requestBases.get(agent)?.get(key(turn, step))
      if (basis === undefined) throw new Error('final draft staging has no request-starting basis')
      const id = CandidateId(`candidate-${agent.session.seq + 1}`)
      const route = agent.session.requestHeader()?.config
      if (route === undefined) throw new Error('final draft staging requires a request header')
      this.assertBudget(agent.session, turn)
      const record: CandidateRecord = { id, basis, sourceSeqs: [], status: 'generating' }
      this.records(agent).set(key(turn, step), record)
      const start = agent.session.append('final-draft/start', { candidateId: id, basis, provider: route.provider, model: route.model })
      record.sourceSeqs.push(start.seq)
      return { kind: 'deferred' as const, writer: this.writer(agent, record) }
    })

    ctx.on('agent/final-candidate', async ({ agent, turn, step, message, signal }, next): Promise<FinalCandidateDecision> => {
      if (!isInteractiveRoot(agent)) return next()
      return this.own(async () => {
        signal = AbortSignal.any([signal, this.shutdown.signal, this.controller(agent).signal])
        signal.throwIfAborted()
        const record = this.records(agent).get(key(turn, step))
        if (record === undefined || record.candidateSeq === undefined) throw new Error('final candidate has no durable staging record')
        if (!this.basisCurrent(agent, record.basis)) return this.supersede(agent, record, 'next-step input or task revision changed')
        record.status = 'reviewing'
        const contract = ctx.taskContract.snapshot(agent.session)
        const route = this.reviewRoute(agent, message.source.provider)
        const reviewController = new AbortController()
        const abort = (): void =>{  reviewController.abort(signal.reason ?? new Error('candidate basis changed')) }
        signal.addEventListener('abort', abort, { once: true })
        const dispose = ctx.on('session/event', (session, event) => {
          if (session !== agent.session) return
          if (event.type === 'agent/inbox/spliced' && event.data.target === 'next-step') abort()
          if (event.type === 'task-contract/update' && event.data.revision !== record.basis.requirementRevision) abort()
        })
        try {
          let reviewed: Awaited<ReturnType<FinalCompletenessGate['review']>>
          try {
            reviewed = await this.review(agent, record.id, message, contract, record.candidateSeq, route,
              AbortSignal.any([reviewController.signal, this.shutdown.signal, this.controller(agent).signal]), true,
              'final-candidate-review')
          } catch (firstError: unknown) {
            if (signal.aborted) throw firstError
            if (reviewController.signal.aborted) return this.supersede(agent, record, 'candidate basis changed during review')
            const recovery = await this.reviewFailureChoice(agent, record, firstError, signal)
            if (recovery === 'bypass') {
              record.status = 'awaiting_commit'
              agent.session.append('final-draft/decision', {
                candidateId: record.id,
                status: 'awaiting_commit',
                action: 'commit',
                reason: 'user authorized a one-candidate reviewer bypass',
              })
              return {
                kind: 'commit',
                validate: () => record.status === 'awaiting_commit' && this.basisCurrent(agent, record.basis),
                committed: () =>{  this.committedWithoutReview(agent, record) },
              }
            }
            record.status = 'reviewing'
            reviewed = await this.review(agent, record.id, message, contract, record.candidateSeq, route,
              AbortSignal.any([reviewController.signal, this.shutdown.signal, this.controller(agent).signal]), true,
              'final-candidate-review')
          }
          if (!this.basisCurrent(agent, record.basis)) return this.supersede(agent, record, 'candidate basis changed during review')
          const result = reviewed.result
          if (result === undefined) throw new Error('review completed without a parsed result')
          const action = reviewAction(result)
          if (action !== 'commit') return this.reject(agent, record, result, action)
          record.status = 'awaiting_commit'
          const mutationStamp = this.workspaceMutationStamp(agent)
          agent.session.append('final-draft/decision', { candidateId: record.id, status: 'awaiting_commit', action: 'commit' })
          return {
            kind: 'commit',
            validate: () => record.status === 'awaiting_commit' && this.basisCurrent(agent, record.basis)
              && this.workspaceMutationStamp(agent) === mutationStamp,
            committed: () =>{  this.committed(agent, record, result) },
          }
        } catch (error: unknown) {
          if (signal.aborted) {
            record.status = 'aborted'
            agent.session.append('final-draft/decision', { candidateId: record.id, status: 'aborted', reason: errorChain(signal.reason) })
            agent.session.append('final-draft/end', { candidateId: record.id })
            throw error
          }
          if (reviewController.signal.aborted) return this.supersede(agent, record, 'candidate basis changed during review')
          record.status = 'rejected'
          agent.session.append('final-draft/decision', { candidateId: record.id, status: 'rejected', reason: errorChain(error) })
          agent.session.append('final-draft/end', { candidateId: record.id })
          throw error
        } finally {
          signal.removeEventListener('abort', abort)
          dispose()
        }
      })
    })
  }

  private async own<T>(run: () => Promise<T>): Promise<T> {
    const promise = run()
    this.pending.add(promise)
    try { return await promise } finally { this.pending.delete(promise) }
  }

  private async reviewFailureChoice(
    agent: Agent,
    record: CandidateRecord,
    error: unknown,
    signal: AbortSignal,
  ): Promise<'retry' | 'bypass'> {
    const questions = this.ctx.get('userQuestions')
    if (questions === undefined) throw error
    record.status = 'awaiting_user'
    agent.session.append('final-draft/decision', { candidateId: record.id, status: 'awaiting_user', reason: errorChain(error) })
    const answer = await questions.ask({
      agent,
      signal,
      questions: [{
        id: 'final-review-failure',
        header: '最终审查失败',
        question: '最终回答审查连续失败。请选择下一步。',
        options: [
          { label: '重试审查', description: '再次运行 Reviewer，仍然保留提交门禁。' },
          { label: '仅本次跳过', description: '由你授权只提交当前 Candidate，不关闭后续门禁。' },
          { label: '取消本轮', description: '中止当前 Turn，不提交草稿。' },
        ],
      }],
    })
    const selected = answer.answers.find(item => item.id === 'final-review-failure')?.selected[0]
    if (selected === '重试审查') return 'retry'
    if (selected === '仅本次跳过') return 'bypass'
    agent.cancel({ kind: 'user' })
    throw new Error('final review cancelled by user')
  }

  private recover(agent: Agent): void {
    const starts = agent.session.events.filter(event => event.type === 'final-draft/start')
    let restart = false
    for (const start of starts) {
      const candidateId = start.data.candidateId
      const events = agent.session.events.filter(event => 'candidateId' in event.data && event.data.candidateId === candidateId)
      if (events.some(event => event.type === 'final-draft/end')) continue
      const candidate = events.find(event => event.type === 'final-draft/candidate')
      const review = events.findLast(event => event.type === 'final-draft/review-result' && event.data.result !== undefined)
      const decision = events.findLast(event => event.type === 'final-draft/decision')
      if (decision?.type === 'final-draft/decision' && decision.data.status === 'committed') {
        if (review?.type === 'final-draft/review-result' && review.data.result !== undefined) {
          this.applyFulfilled(agent, review.data.result)
        }
        agent.session.append('final-draft/end', { candidateId })
        continue
      }
      if (candidate?.type === 'final-draft/candidate' && review?.type === 'final-draft/review-result'
        && review.data.result !== undefined && decision?.type === 'final-draft/decision'
        && decision.data.status === 'awaiting_commit') {
        const committedMessage = agent.session.events.find(event => event.type === 'assistant/message'
          && sameSeqs(event.sourceEventSeqs, candidate.data.chunkSeqs))
        if (committedMessage !== undefined) {
          const record: CandidateRecord = {
            id: candidateId,
            basis: candidate.data.basis,
            sourceSeqs: [...candidate.data.chunkSeqs, candidate.seq],
            candidateSeq: candidate.seq,
            status: 'awaiting_commit',
          }
          this.committed(agent, record, review.data.result)
          continue
        }
      }
      if (decision?.type === 'final-draft/decision' && decision.data.status === 'rejected'
        && review?.type === 'final-draft/review-result' && review.data.result !== undefined) {
        const action = reviewAction(review.data.result)
        if (action !== 'commit') this.ctx.taskExecutionControl.restrict(agent, action === 'replan' ? 'replanning' : action, correction(candidateId, review.data.result, action))
        agent.session.append('final-draft/end', { candidateId })
        continue
      }
      agent.session.append('final-draft/decision', {
        candidateId,
        status: 'superseded',
        reason: 'process resumed before the candidate reached a recoverable committed state',
      })
      agent.session.append('final-draft/end', { candidateId })
      restart = true
    }
    if (restart) agent.steer(createUserMessage({
      content: [{ type: 'text', text: 'Resume the current Task Contract after an interrupted final-candidate attempt. Reuse durable evidence and do not repeat completed side effects.' }],
      source: { kind: 'plugin', plugin: 'final-completeness-gate-recovery' },
    }))
  }

  private writer(agent: Agent, record: CandidateRecord): AssistantStagingWriter {
    let bytes = 0
    let terminal = false
    const chunkSeqs: number[] = []
    const streamedBlocks = new Set<number>()
    const chunkBatcher = new StreamChunkBatcher()
    const persistChunks = (chunks: readonly StreamChunk[]): number[] => chunks.map((chunk) => {
      const event = agent.session.append('final-draft/chunk', { candidateId: record.id, chunk })
      record.sourceSeqs.push(event.seq)
      chunkSeqs.push(event.seq)
      return event.seq
    })
    return {
      append: (chunk: StreamChunk): readonly number[] => {
        if (terminal) throw new Error('final draft writer is terminal')
        bytes += candidateChunkBytes(chunk, streamedBlocks)
        if (bytes > this.config.maxCandidateBytes) throw new Error(`final candidate exceeds ${this.config.maxCandidateBytes} UTF-8 bytes`)
        return persistChunks(chunkBatcher.push(chunk))
      },
      complete: (message: AssistantMessage, usage: TokenUsage | undefined, finish: AssistantCandidateFinish): readonly number[] => {
        if (terminal) throw new Error('final draft writer is terminal')
        const contentBytes = Buffer.byteLength(JSON.stringify(message.content))
        if (contentBytes > this.config.maxCandidateBytes) {
          throw new Error(`final candidate exceeds ${this.config.maxCandidateBytes} UTF-8 bytes`)
        }
        this.assertBudget(agent.session, record.basis.turn, contentBytes)
        this.assertFinalCandidateBudget(agent.session, record.basis.turn, message, finish)
        persistChunks(chunkBatcher.flush())
        const event = agent.session.append('final-draft/candidate', {
          candidateId: record.id,
          basis: record.basis,
          message,
          finish,
          chunkSeqs: [...chunkSeqs],
          ...(usage === undefined ? {} : { usage }),
        })
        terminal = true
        record.sourceSeqs.push(event.seq)
        record.candidateSeq = event.seq
        record.status = 'awaiting_review'
        return [...chunkSeqs]
      },
      committed: (): void => {
        if (record.status !== 'awaiting_review') throw new Error('only a complete staged response can be committed')
        record.status = 'committed'
        agent.session.append('final-draft/decision', { candidateId: record.id, status: 'committed', action: 'commit' })
        agent.session.append('final-draft/end', { candidateId: record.id })
      },
      abort: (reason: unknown): void => {
        if (terminal) return
        persistChunks(chunkBatcher.flush())
        terminal = true
        record.status = 'aborted'
        agent.session.append('final-draft/decision', { candidateId: record.id, status: 'aborted', reason: errorChain(reason) })
        agent.session.append('final-draft/end', { candidateId: record.id })
      },
    }
  }

  private async review(
    agent: Agent,
    candidateId: CandidateId,
    message: AssistantMessage,
    contract: TaskContractSnapshot,
    candidateSeq: number,
    route: { provider: string; model: string },
    parentSignal: AbortSignal,
    durable: boolean,
    purpose: 'final-candidate-review' | 'final-shadow-review',
  ): Promise<{ result?: FinalReviewResult; rawOutput: ContentBlock[]; usage?: TokenUsage }> {
    const input = await this.frozenInput(agent, candidateId, message, contract, candidateSeq, parentSignal)
    const lookup = {
      rounds: 0,
      results: new Map<string, { name: string; arguments: string; content: string; isError: boolean }>(),
      readEventIds: new Set<number>(),
      timeoutSignal: AbortSignal.timeout(this.config.reviewerTimeoutMs),
    }
    let lastError: unknown
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const attemptId = ReviewAttemptId(`${candidateId}-review-${randomUUID()}`)
      const state = { capture: new ExtractionCapture(), callId: AuditedLlmCallId(attemptId) }
      const trigger = durable ? agent.session.append('final-draft/review-start', {
        candidateId,
        attemptId,
        contract,
        provider: route.provider,
        model: route.model,
        maxTokens: this.config.reviewerMaxTokens,
      }) : agent.session.events.findLast(event => event.type === 'final-review/shadow-start' && event.data.candidateId === candidateId)
      let output: Awaited<ReturnType<FinalCompletenessGate['reviewAttempt']>> | undefined
      try {
        output = await this.reviewAttempt(
          agent, input, route, parentSignal, AuditedLlmCallId(attemptId), state, attempt, purpose,
          trigger?.seq ?? input.candidateSeq, lookup,
          lastError === undefined ? undefined : errorChain(lastError))
        parentSignal.throwIfAborted()
        const parsed = output.result
        const readEvidenceIds = output.readEvidenceIds
        const validated = validateAuxiliary(() => validateReview(parsed, input, this.config.maxEvidenceRefs, readEvidenceIds))
        const result = await this.recheckEvidence(agent, input, validated, parentSignal)
        const complete = { result, rawOutput: output.rawOutput, ...(output.usage === undefined ? {} : { usage: output.usage }) }
        recordAuxiliaryAssessment(agent.session, output.callId, { status: 'validated', result })
        if (durable) agent.session.append('final-draft/review-result', { candidateId, attemptId, ...complete })
        return complete
      } catch (error: unknown) {
        recordAuxiliaryAssessment(agent.session, state.callId, { status: 'failed', error: errorChain(error) })
        if (parentSignal.aborted) throw error
        lastError = error
        if (durable) agent.session.append('final-draft/review-result', {
          candidateId, attemptId, rawOutput: state.capture.assembler.interruptedBlocks(), error: errorChain(error),
          ...(state.capture.assembler.usage === undefined ? {} : { usage: state.capture.assembler.usage }),
        })
        if (!(error instanceof AuxiliaryValidationError)) break
      }
    }
    throw lastError
  }

  private async reviewAttempt(
    agent: Agent,
    input: FrozenReviewInput,
    route: { provider: string; model: string },
    parentSignal: AbortSignal,
    callId: AuditedLlmCallId,
    state: { capture: ExtractionCapture; callId: AuditedLlmCallId },
    attempt: number,
    purpose: 'final-candidate-review' | 'final-shadow-review',
    triggerSeq: number,
    lookup: {
      rounds: number
      results: Map<string, { name: string; arguments: string; content: string; isError: boolean }>
      readEventIds: Set<number>
      timeoutSignal: AbortSignal
    },
    previousFailure?: string,
  ): Promise<{
    callId: AuditedLlmCallId
    result: unknown
    rawOutput: ContentBlock[]
    readEvidenceIds: ReadonlySet<number>
    usage?: TokenUsage
  }> {
    const timeoutSignal = lookup.timeoutSignal
    const prompt = auxiliaryPrompt(purpose,
      reviewRules, zz.toJSONSchema(reviewSchema), {
        ...projectReviewInput(input), maxEvidenceLookupRounds: this.config.maxEvidenceLookupRounds,
      }, attempt, previousFailure)
    const candidateEvent = agent.session.events.find(event => event.seq === input.candidateSeq)
    const location = candidateEvent?.type === 'final-draft/candidate' ? candidateEvent.data.basis
      : candidateEvent?.type === 'assistant/message' ? candidateEvent.data : undefined
    const messages = [...prompt.options.messages]
    const priorEvidence = () => createUserMessage({
      source: { kind: 'plugin', plugin: purpose },
      content: [{ type: 'text', text: JSON.stringify({
        priorEvidenceLookups: [...lookup.results.values()],
        remainingEvidenceLookupRounds: this.config.maxEvidenceLookupRounds - lookup.rounds,
      }) }],
    })
    if (lookup.results.size > 0) messages.push(priorEvidence())
    const readEvidenceIds = lookup.readEventIds
    let usage: TokenUsage | undefined
    const evidenceTools = input.evidence.length === 0 ? [] : [...reviewEvidenceTools]
    const lookupEvents = reviewLookupEvents(agent.session.events, input)
    const evaluation = agent.session.events.some(event => event.type === 'task-review/test-case' && event.data.kind === 'reviewer')
    for (let round = 0; round <= this.config.maxEvidenceLookupRounds; round += 1) {
      timeoutSignal.throwIfAborted()
      const closing = lookup.rounds === this.config.maxEvidenceLookupRounds
      const roundTools = closing ? [] : evidenceTools
      // A tool-free conclusion carries result data, not an unfinished tool conversation.
      const requestMessages = closing ? [...prompt.options.messages, priorEvidence(), createUserMessage({
        source: { kind: 'plugin', plugin: purpose },
        content: [{ type: 'text', text: '证据查询预算已用尽。本次不提供工具；请基于已经读取的材料返回最终审查 JSON。尚未读取或不足以支持结论的证据不能标为 verified；如实记录 needs-verification、缺口或过度声明，不得为了结束审查而放行。' }],
      })] : messages
      const roundCallId = round === 0 ? callId : AuditedLlmCallId(`${callId}-evidence-${round}`)
      const capture = new ExtractionCapture()
      capture.timeoutSignal = timeoutSignal
      state.capture = capture
      state.callId = roundCallId
      const requestBytes = Buffer.byteLength(JSON.stringify({ system: prompt.options.system,
        messages: requestMessages, tools: roundTools }))
      if (requestBytes > this.config.maxReviewInputBytes) {
        throw new Error('complete review request exceeds maxReviewInputBytes; review cannot omit input')
      }
      for await (const chunk of auditedReviewStream(this.ctx, agent.session, roundCallId, {
        ...route, ...prompt.options, messages: requestMessages, ...(roundTools.length === 0 ? {} : { tools: roundTools }),
        ...(this.config.reviewerReasoningEffort === '' ? {} : { reasoningEffort: ReasoningEffortId(this.config.reviewerReasoningEffort) }),
        maxTokens: this.config.reviewerMaxTokens, sessionId: agent.session.id,
        signal: AbortSignal.any([parentSignal, timeoutSignal]),
      }, { ...prompt.metadata, context: { triggerSeq, requirementRevision: input.contract.revision,
        location: { scope: evaluation ? 'evaluation' : 'conversation',
          ...(location === undefined ? {} : { turn: location.turn, step: location.step }),
          phase: evaluation ? 'evaluation'
            : candidateEvent?.type === 'assistant/message' ? 'after-delivery' : 'before-delivery',
          subjectId: String(input.candidateSeq) } } })) capture.push(chunk)
      parentSignal.throwIfAborted()
      timeoutSignal.throwIfAborted()
      usage = addUsage(usage, capture.assembler.usage)
      const rawOutput = capture.assembler.blocks()
      const toolCalls = rawOutput.filter(block => block.type === 'tool-call')
      if (toolCalls.length > 0) {
        if (closing) {
          throw new Error(`final reviewer exceeded ${this.config.maxEvidenceLookupRounds} evidence lookup rounds`)
        }
        lookup.rounds += 1
        messages.push(createAssistantMessage({ content: rawOutput, source: { provider: route.provider, model: route.model } }))
        for (const toolCall of toolCalls) {
          try {
            const result = executeReviewEvidenceTool(
              lookupEvents, toolCall.name, toolCall.arguments, this.config.maxEvidenceRefs,
            )
            for (const eventId of result.readEventIds) readEvidenceIds.add(eventId)
            lookup.results.set(JSON.stringify([toolCall.name, toolCall.arguments]), {
              name: toolCall.name, arguments: toolCall.arguments, content: result.content, isError: false,
            })
            messages.push(createToolResultMessage({
              callId: toolCall.id, isError: false, content: [{ type: 'text', text: result.content }],
            }))
          } catch (error: unknown) {
            const content = JSON.stringify({ error: errorChain(error) })
            lookup.results.set(JSON.stringify([toolCall.name, toolCall.arguments]), {
              name: toolCall.name, arguments: toolCall.arguments, content, isError: true,
            })
            messages.push(createToolResultMessage({
              callId: toolCall.id,
              isError: true,
              content: [{ type: 'text', text: content }],
            }))
          }
        }
        continue
      }
      if (capture.assembler.finish.kind !== 'stop') throw new Error(`final review ended with ${capture.assembler.finish.kind}`)
      const text = rawOutput.filter(block => block.type === 'text').map(block => block.text).join('')
      if (Buffer.byteLength(JSON.stringify(rawOutput)) > this.config.maxReviewOutputBytes) throw new Error(`final review exceeds ${this.config.maxReviewOutputBytes} UTF-8 bytes`)
      validateAuxiliary(() => {
        if (text.trim().length === 0) throw new Error('最终正文为空；请在最终正文返回审查 JSON，不能仅在思考字段中返回。')
      })
      return { callId: roundCallId, result: validateAuxiliary((): unknown => JSON.parse(stripFence(text))), rawOutput,
        readEvidenceIds, ...(usage === undefined ? {} : { usage }) }
    }
    throw new Error('final reviewer evidence lookup exhausted')
  }

  private reject(
    agent: Agent, record: CandidateRecord, result: FinalReviewResult, action: Exclude<import('./types.ts').ReviewDeliveryAction, 'commit'>,
  ): FinalCandidateDecision {
    record.status = 'rejected'
    agent.session.append('final-draft/decision', { candidateId: record.id, status: 'rejected', action })
    this.ctx.taskExecutionControl.restrict(agent, action === 'replan' ? 'replanning' : action, correction(record.id, result, action))
    agent.session.append('final-draft/end', { candidateId: record.id })
    return { kind: 'continue' }
  }

  private supersede(agent: Agent, record: CandidateRecord, reason: string): FinalCandidateDecision {
    record.status = 'superseded'
    agent.session.append('final-draft/decision', { candidateId: record.id, status: 'superseded', reason })
    agent.session.append('final-draft/end', { candidateId: record.id })
    if (agent.inbox.nextStep.length === 0) agent.steer(createUserMessage({
      content: [{ type: 'text', text: '任务状态在候选回答交付前发生变化。请基于当前需求重新作答，不要重复已经完成的副作用操作。' }],
      source: { kind: 'plugin', plugin: 'final-completeness-gate', form: 'notice', summary: reason },
    }))
    return { kind: 'continue' }
  }

  private committed(agent: Agent, record: CandidateRecord, result: FinalReviewResult): void {
    record.status = 'committed'
    agent.session.append('final-draft/decision', {
      candidateId: record.id, status: 'committed', action: 'commit',
      delivery: { replyAllowed: true, turnEnds: true, taskCompleted: reviewCompletesTask(result) },
    })
    this.applyFulfilled(agent, result)
    agent.session.append('final-draft/end', { candidateId: record.id })
  }

  private committedWithoutReview(agent: Agent, record: CandidateRecord): void {
    record.status = 'committed'
    agent.session.append('final-draft/decision', {
      candidateId: record.id,
      status: 'committed',
      action: 'commit',
      reason: 'user authorized a one-candidate reviewer bypass',
    })
    agent.session.append('final-draft/end', { candidateId: record.id })
  }

  private applyFulfilled(agent: Agent, result: FinalReviewResult): void {
    const fulfilled = fulfilledReviews(result)
    const contract = this.ctx.taskContract.snapshot(agent.session)
    const open = new Set(contract.requirements.filter(requirement => requirement.state === 'open').map(requirement => requirement.id))
    const pending = fulfilled.filter(requirement => open.has(requirement.requirementId)
      && contract.requirements.some(current => current.id === requirement.requirementId
        && current.revision === requirement.requirementRevision))
    const updates: RequirementUpdate[] = pending.map(requirement => ({
      kind: 'fulfill' as const,
      id: requirement.requirementId,
      requirementRevision: requirement.requirementRevision,
      evidenceEventIds: requirement.evidenceEventIds,
    }))
    if (updates.length > 0) this.ctx.taskContract.update(agent.session, contract.revision, [], updates)
  }

  private basisCurrent(agent: Agent, basis: CandidateBasis): boolean {
    const current = this.ctx.taskContract.snapshot(agent.session)
    const planSeq = current.approvedPlan?.approval.kind === 'local' ? current.approvedPlan.approval.seq : undefined
    return current.revision === (basis.requirementRevision ?? basis.taskRevision)
      && current.inputRevision === basis.inputRevision
      && planSeq === basis.approvedPlanSeq
      && this.incarnation(agent) === basis.incarnation
      && this.ctx.taskContract.nextStepRevision(agent.session) === basis.nextStepRevision
      && agent.inbox.nextStep.length === 0
      && !this.shutdown.signal.aborted
      && (this.config.mode !== 'enforce' || basis.controlNotice === true
        || this.ctx.get('taskExecutionControl')?.canCommit(agent) === true)
  }

  private async frozenInput(
    agent: Agent, candidateId: CandidateId, message: AssistantMessage, contract: TaskContractSnapshot, candidateSeq: number,
    signal: AbortSignal,
  ): Promise<FrozenReviewInput> {
    const stored = agent.session.events.find(event => event.type === 'final-review/input' && event.data.candidateId === candidateId)
    if (stored?.type === 'final-review/input' && stored.data.input.version === 8) return stored.data.input
    if (stored?.type === 'final-review/input') throw new Error('historical candidate needs a fresh itemized review after task reconciliation')
    const turnEvent = agent.session.events.findLast(event => event.seq <= candidateSeq && event.type === 'turn/start')
    const turn = turnEvent?.type === 'turn/start' ? turnEvent.data.turn : 0
    const sources = this.ctx.taskContract.originalInputs(contract, turn)
    const frozen = freezeReviewInput(agent.session, contract, sources, message, candidateSeq)
    const input: FrozenReviewInput = { ...frozen, freshness: await freezeEvidenceFreshness(agent.session, frozen.evidence,
      agent.ctx.get('fs') ?? this.ctx.get('fs'), signal,
      this.ctx.sessions.list().filter(session => session !== agent.session
        && (session.header.cwd === undefined || agent.session.header.cwd === undefined
          || session.header.cwd === agent.session.header.cwd))) }
    if (Buffer.byteLength(JSON.stringify(projectReviewInput(input))) > this.config.maxReviewInputBytes) throw new Error('review input exceeds maxReviewInputBytes; original requirements were not truncated')
    agent.session.append('final-review/input', { candidateId, input })
    return input
  }

  private workspaceMutationStamp(agent: Agent): string {
    return this.ctx.sessions.list().filter(session => session.header.cwd === undefined || agent.session.header.cwd === undefined
      || session.header.cwd === agent.session.header.cwd).map(session => `${session.id}:${mutationWatermark(session.events)}`).join('|')
  }

  private async recheckEvidence(agent: Agent, input: FrozenReviewInput, result: FinalReviewResult,
    signal: AbortSignal): Promise<FinalReviewResult> {
    if (!result.requirements.some(item => item.work === 'verified')) return result
    const current = await freezeEvidenceFreshness(agent.session, input.evidence, agent.ctx.get('fs') ?? this.ctx.get('fs'), signal,
      this.ctx.sessions.list().filter(session => session !== agent.session && (session.header.cwd === undefined
        || agent.session.header.cwd === undefined || session.header.cwd === agent.session.header.cwd)))
    const requirements = result.requirements.map(item => item.work === 'verified'
      && item.evidenceEventIds.some(ref => current[ref.seq]?.status !== 'current')
      ? { ...item, work: 'needs-verification' as const, gap: '审查期间受测状态发生变化，先重新核验，不重复原操作。' } : item)
    return requirements.some((item, index) => item !== result.requirements[index])
      ? { ...result, reply: 'continue', requirements } : result
  }

  private incarnation(agent: Agent): string {
    let id = this.incarnations.get(agent)
    if (id === undefined) { id = randomUUID(); this.incarnations.set(agent, id) }
    return id
  }

  private reviewRoute(agent: Agent, workerProvider: string): { provider: string; model: string } {
    const header = agent.session.requestHeader()?.config
    const provider = this.config.reviewerProvider || header?.provider || agent.options.provider || ''
    const model = this.config.reviewerModel || header?.model || agent.options.model || ''
    if (!provider || !model) throw new Error('final reviewer has no provider/model')
    if (provider !== workerProvider && !this.config.allowCrossProviderReview) throw new Error(`cross-provider review from ${workerProvider} to ${provider} requires allowCrossProviderReview`)
    return { provider, model }
  }

  private assertBudget(session: Session, turn: number, additionalBytes = 0): void {
    let bytes = 0
    let turnBytes = 0
    for (const event of session.events) {
      if (event.type !== 'final-draft/candidate') continue
      const size = Buffer.byteLength(JSON.stringify(event.data.message.content))
      bytes += size
      if (event.data.basis.turn === turn) turnBytes += size
    }
    const overSession = additionalBytes === 0
      ? bytes >= this.config.maxSessionStagingBytes
      : bytes + additionalBytes > this.config.maxSessionStagingBytes
    const overTurn = additionalBytes === 0
      ? turnBytes >= this.config.maxTurnStagingBytes
      : turnBytes + additionalBytes > this.config.maxTurnStagingBytes
    if (overSession) throw new Error(`Session staging exceeds ${this.config.maxSessionStagingBytes} UTF-8 bytes`)
    if (overTurn) throw new Error(`Turn staging exceeds ${this.config.maxTurnStagingBytes} UTF-8 bytes`)
  }

  private assertFinalCandidateBudget(
    session: Session,
    turn: number,
    message: AssistantMessage,
    finish: AssistantCandidateFinish,
  ): void {
    if (!requiresFinalReview(message, finish)) return
    const candidates = session.events.filter(event => event.type === 'final-draft/candidate'
      && event.data.basis.turn === turn
      && requiresFinalReview(event.data.message, event.data.finish)).length
    if (candidates >= this.config.maxCandidatesPerTurn) {
      throw new Error(`Turn final-candidate count exceeds ${this.config.maxCandidatesPerTurn}`)
    }
  }

  private records(agent: Agent): Map<string, CandidateRecord> {
    let records = this.candidates.get(agent)
    if (records === undefined) {
      records = new Map()
      this.candidates.set(agent, records)
    }
    return records
  }

  private controller(agent: Agent): AbortController {
    let controller = this.lifecycle.get(agent)
    if (controller === undefined) {
      controller = new AbortController()
      this.lifecycle.set(agent, controller)
    }
    return controller
  }
}

function resolveConfig(config: Config): Required<Config> {
  return {
    mode: config.mode ?? 'shadow',
    reviewTiming: config.reviewTiming ?? 'before-delivery',
    reviewerProvider: config.reviewerProvider ?? '',
    reviewerModel: config.reviewerModel ?? '',
    reviewerReasoningEffort: config.reviewerReasoningEffort ?? '',
    reviewerMaxTokens: positive('reviewerMaxTokens', config.reviewerMaxTokens ?? DEFAULT_MAX_TOKENS),
    reviewerTimeoutMs: positive('reviewerTimeoutMs', config.reviewerTimeoutMs ?? DEFAULT_TIMEOUT_MS),
    allowCrossProviderReview: config.allowCrossProviderReview ?? false,
    maxCandidateBytes: positive('maxCandidateBytes', config.maxCandidateBytes ?? DEFAULT_CANDIDATE_BYTES),
    maxTurnStagingBytes: positive('maxTurnStagingBytes', config.maxTurnStagingBytes ?? DEFAULT_TURN_BYTES),
    maxSessionStagingBytes: positive('maxSessionStagingBytes', config.maxSessionStagingBytes ?? DEFAULT_SESSION_BYTES),
    maxCandidatesPerTurn: positive('maxCandidatesPerTurn', config.maxCandidatesPerTurn ?? DEFAULT_CANDIDATES_PER_TURN),
    maxReviewOutputBytes: positive('maxReviewOutputBytes', config.maxReviewOutputBytes ?? DEFAULT_REVIEW_BYTES),
    maxEvidenceRefs: positive('maxEvidenceRefs', config.maxEvidenceRefs ?? DEFAULT_EVIDENCE_REFS),
    maxEvidenceLookupRounds: positive('maxEvidenceLookupRounds', config.maxEvidenceLookupRounds ?? DEFAULT_EVIDENCE_LOOKUP_ROUNDS),
    maxReviewInputBytes: positive('maxReviewInputBytes', config.maxReviewInputBytes ?? 262_144),
  }
}

function requiresFinalReview(message: AssistantMessage, finish: AssistantCandidateFinish): boolean {
  return finish === 'max-tokens' || !message.content.some(block => block.type === 'tool-call')
}

function candidateChunkBytes(chunk: StreamChunk, streamedBlocks: Set<number>): number {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      streamedBlocks.add(chunk.index)
      return Buffer.byteLength(chunk.text)
    case 'tool-call-delta':
      streamedBlocks.add(chunk.index)
      return Buffer.byteLength(chunk.argumentsDelta)
    case 'block-end':
      if (streamedBlocks.has(chunk.index)) return 0
      streamedBlocks.add(chunk.index)
      return Buffer.byteLength(JSON.stringify(chunk.block))
    case 'block-start':
    case 'usage':
    case 'finish': return 0
    default: {
      const unexpected: never = chunk
      throw new Error(`unsupported final candidate chunk: ${JSON.stringify(unexpected)}`)
    }
  }
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  return value
}

function key(turn: number, step: number): string { return `${turn}:${step}` }

function isInteractiveRoot(agent: Agent): boolean {
  return agent.session.header.purpose === 'interactive' && agent.ctx.agents.roots().includes(agent)
}

function isExecutionControlNotice(session: Session, turn: number, step: number): boolean {
  const start = session.events.findLast(event => event.type === 'step/start'
    && event.data.turn === turn && event.data.step === step)
  if (start === undefined) return false
  return session.events.slice(start.seq + 1).some(event => event.type === 'user/message'
    && event.data.source.kind === 'plugin' && event.data.source.plugin === 'task-execution-control'
    && event.data.source.form === 'notice')
}

function sameSeqs(left: readonly number[] | undefined, right: readonly number[]): boolean {
  return left !== undefined && left.length === right.length && left.every((seq, index) => seq === right[index])
}

function stripFence(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')
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

function correction(candidateId: CandidateId, result: FinalReviewResult, action: import('./types.ts').ReviewDeliveryAction): string {
  const missing = result.requirements.filter(requirement => requirement.answer === 'missing'
    || (requirement.work !== 'verified' && requirement.work !== 'not-needed'))
  return [
    `<final-review candidate="${candidateId}" action="${action}">`,
    `Unmet requirements: ${missing.map(requirement => requirement.requirementId).join(', ') || '(none)'}`,
    `Gaps: ${missing.map(requirement => `${requirement.requirementId}: ${requirement.gap}`).join('; ') || '(none)'}`,
    `Missing plan items: ${result.missingPlanQuotes.join('; ') || '(none)'}`,
    `Unsupported paragraphs: ${result.unsupportedParagraphIds.join(', ') || '(none)'}`,
    'Do not repeat completed side effects or rerun tools whose valid evidence already exists.',
    '</final-review>',
  ].join('\n')
}

export default FinalCompletenessGate

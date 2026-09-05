/** Event-sourced requirement ledger and before-step change parser. */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zz } from 'zod'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, errorChain, MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { AuditedLlmCallId, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-plan-mode'
import { auditedReviewStream, recordAuxiliaryApplication, recordAuxiliaryAssessment } from './audit.ts'
import { ExtractionCapture } from './extraction-capture.ts'
import { foldTaskContract, validateTaskUpdates } from './fold.ts'
import { auxiliaryPrompt, AuxiliaryValidationError, projectRequirementParserInput, validateAuxiliary } from './model-input.ts'
import type { RequirementParserInput } from './model-input.ts'
import { requirementChangeRules } from './prompt.ts'
import { parsedInputIds } from './input-state.ts'
import { RequirementId } from './types.ts'
import type {
  Config,
  RequirementRecord,
  RequirementChange,
  RequirementChangeProposal,
  RequirementInputRecord,
  RequirementUpdate,
  TaskContractSnapshot,
} from './types.ts'

export * from './types.ts'
export { foldTaskContract } from './fold.ts'
export { parsedInputIds } from './input-state.ts'
export { auditedReviewStream, recordAuxiliaryAssessment, recordAuxiliaryApplication, StreamChunkBatcher } from './audit.ts'
export { ExtractionCapture } from './extraction-capture.ts'
export { auxiliaryPrompt, projectTask, projectRequirementParserInput, projectStepEvidence, deliveredContent, AuxiliaryValidationError, validateAuxiliary } from './model-input.ts'
export type { AuxiliaryRequestMetadata, AuxiliaryPurpose, AuxiliaryTraceLocation, RequirementParserInput, RequirementParserItem } from './model-input.ts'
export {
  executeFrozenSessionEvidenceTool, frozenSessionEvidence, frozenSessionEvidenceIndex,
  taskToolResultSuccess,
  frozenSessionEvidenceTools,
} from './session-evidence.ts'
export type {
  FrozenSessionEvidence, FrozenSessionEvidenceIndex, FrozenSessionEvidenceToolResult,
} from './session-evidence.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { taskContract: TaskContractService }
}

const DEFAULT_MAX_TOKENS = 4_096
const DEFAULT_MAX_INPUT_BYTES = 65_536
const DEFAULT_MAX_REQUIREMENTS = 128
const SNAPSHOT_SOURCE = '@deepseek-ai/dsh-experimental-task-contract'
const SNAPSHOT_SECTION = 'task-contract'

const changeSchema = zz.discriminatedUnion('op', [
  zz.object({ op: zz.literal('add'), text: zz.string().min(1), verification: zz.enum(['answer', 'execution']) }).strict(),
  zz.object({ op: zz.literal('revise'), targetId: zz.string().min(1).transform(RequirementId), text: zz.string().min(1), verification: zz.enum(['answer', 'execution']) }).strict(),
  zz.object({ op: zz.literal('cancel'), targetId: zz.string().min(1).transform(RequirementId) }).strict(),
])
const proposalSchema = zz.object({ changes: zz.array(changeSchema) }).strict()

/** Durable owner of the Session requirement ledger. */
export class TaskContractService extends Service {
  static inject = ['agents', 'llm', 'sessions']
  static Config: z<Config> = z.object({
    mode: z.union(['shadow', 'enforce'] as const).default('shadow'),
    injectWorkerContext: z.boolean().default(false),
    parserProvider: z.string().default(''),
    parserModel: z.string().default(''),
    parserReasoningEffort: z.string().default(''),
    parserTimeoutMs: z.number().step(1).min(1).default(30_000),
    parserMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
    maxInputBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INPUT_BYTES),
    maxRequirements: z.number().step(1).min(1).default(DEFAULT_MAX_REQUIREMENTS),
  })

  private readonly config: Required<Config>
  private readonly shutdown = new AbortController()
  private readonly pending = new Set<Promise<void>>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'taskContract')
    this.config = {
      mode: config.mode ?? 'shadow',
      injectWorkerContext: config.injectWorkerContext ?? false,
      parserProvider: config.parserProvider ?? '',
      parserModel: config.parserModel ?? '',
      parserReasoningEffort: config.parserReasoningEffort ?? '',
      parserTimeoutMs: positive('parserTimeoutMs', config.parserTimeoutMs ?? 30_000),
      parserMaxTokens: positive('parserMaxTokens', config.parserMaxTokens ?? DEFAULT_MAX_TOKENS),
      maxInputBytes: positive('maxInputBytes', config.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES),
      maxRequirements: positive('maxRequirements', config.maxRequirements ?? DEFAULT_MAX_REQUIREMENTS),
    }

    ctx.on('agent/request-starting', ({ agent, turn }) => {
      const session = agent.session
      const admitted = new Set(session.events.flatMap(event => event.type === 'task-contract/input-admitted'
        ? event.data.messageIds : []))
      const received = new Set(session.events.flatMap(event => event.type === 'user/message'
        && event.data.source.kind === 'user' ? [event.data.id] : []))
      const messageIds = [...new Set(session.events.flatMap(event => event.type === 'task-contract/input'
        && event.data.turn === turn ? event.data.messages.map(message => message.id) : []))]
        .filter(id => received.has(id) && !admitted.has(id))
      if (messageIds.length > 0) session.append('task-contract/input-admitted', { turn, messageIds })
    })

    ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next): Promise<PreStepDecision> => {
      if (agent.session.events.some(event => event.type === 'task-review/test-case' && event.data.kind === 'reviewer')) return { kind: 'reject' }
      const decision = await next()
      if (decision.kind === 'reject' || agent.session.header.purpose !== 'interactive' || !ctx.agents.roots().includes(agent)) return decision
      this.shutdown.signal.throwIfAborted()
      const parsed = parsedInputIds(agent.session)
      const incoming = messages.filter(message => message.source.kind === 'user')
      const unresolved = incoming.length === 0 ? [] : agent.session.events.flatMap(event =>
        event.type === 'task-contract/input' ? event.data.messages : [])
        .filter(message => !parsed.has(message.id))
        .map((message): UserMessage => ({ role: 'user', id: message.id, content: [...message.content], source: { kind: 'user' } }))
      const users = [...new Map([...unresolved, ...incoming].filter(message => !parsed.has(message.id))
        .map(message => [message.id, message])).values()]
      if (users.length > 0) {
        const receipt = agent.session.append('task-contract/input', {
          turn,
          messages: users.map(message => ({ id: message.id, content: message.content })),
        })
        const pending = this.admitSequentially(
          agent, users, { turn, step, triggerSeq: receipt.seq }, AbortSignal.any([signal, this.shutdown.signal]),
        )
        this.pending.add(pending)
        try { await pending } finally { this.pending.delete(pending) }
      }
      if (!this.config.injectWorkerContext) return decision
      const text = renderWorkerSnapshot(this.snapshot(agent.session))
      if (text === undefined || retainedSnapshotText(agent.session) === text) return decision
      return {
        kind: 'enter',
        messages: [...decision.messages, createUserMessage({
          content: [{ type: 'text', text }],
          source: {
            kind: 'plugin', plugin: SNAPSHOT_SOURCE, form: 'snapshot',
            sections: [{ name: SNAPSHOT_SECTION, text }],
          },
        })],
      }
    })

    ctx.effect(() => async () => {
      this.shutdown.abort(new Error('task contract disposed'))
      await Promise.allSettled([...this.pending])
    }, 'taskContract.drain')
  }

  /**
   * Read current requirements and the latest formal plan approval.
   * @param session Session whose append-only events are projected.
   * @returns Current requirement ledger projection.
   */
  snapshot(session: Session): TaskContractSnapshot { return foldTaskContract(session) }

  /**
   * Select source messages for uncancelled requirements plus newly received input in a delivery Turn.
   * @param snapshot Current requirement ledger projection.
   * @param turn Delivery Turn whose newly received input remains relevant.
   * @returns Relevant immutable user-input records.
   */
  originalInputs(snapshot: TaskContractSnapshot, turn: number): readonly RequirementInputRecord[] {
    const relevant = new Set(snapshot.requirements.filter(item => item.state !== 'cancelled').map(item => item.source.messageId))
    return snapshot.inputs.filter(input => input.turn === turn || relevant.has(input.messageId))
  }

  /**
   * Read the latest next-step steering sequence; next-turn queue entries are excluded.
   * @param session Session containing steering events.
   * @returns Sequence number, or -1 when no next-step steering exists.
   */
  nextStepRevision(session: Session): number {
    return session.events.findLast(event => event.type === 'agent/inbox/spliced' && event.data.target === 'next-step')?.seq ?? -1
  }

  /**
   * Append one validated update batch with compare-and-swap revision semantics.
   * @param session Session that owns the requirement ledger.
   * @param baseRevision Revision captured before model dispatch.
   * @param sourceMessageIds User messages the parser was allowed to cite.
   * @param updates Validated requirement changes to append.
   * @returns Resulting ledger revision.
   */
  update(session: Session, baseRevision: number, sourceMessageIds: readonly MessageId[], updates: readonly RequirementUpdate[]): number {
    const current = this.snapshot(session)
    if (current.revision !== baseRevision) throw new Error(`requirement ledger stale revision ${baseRevision}; current ${current.revision}`)
    validateTaskUpdates(session, updates, sourceMessageIds, this.config.maxRequirements)
    if (updates.length === 0) return baseRevision
    const revision = baseRevision + 1
    session.append('task-contract/update', { formatVersion: 3, baseRevision, revision, sourceMessageIds, updates })
    return revision
  }

  private async admitSequentially(
    agent: Agent, messages: UserMessage[], location: { turn: number; step: number; triggerSeq: number }, signal: AbortSignal,
  ): Promise<void> {
    for (const message of messages) await this.admit(agent, message, location, signal)
  }

  private async admit(
    agent: Agent,
    message: UserMessage,
    location: { turn: number; step: number; triggerSeq: number },
    signal: AbortSignal,
  ): Promise<void> {
    const route = this.route(agent)
    const base = this.snapshot(agent.session)
    const input = projectRequirementParserInput(base, messageText(message))
    let lastError: unknown
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      signal.throwIfAborted()
      const callId = AuditedLlmCallId(`requirement-change-${randomUUID()}-${attempt}`)
      let proposal: RequirementChangeProposal | undefined
      let stale = false
      try {
        const currentProposal = await this.parse(agent, input, message.id, route, signal, callId, attempt, location,
          lastError instanceof AuxiliaryValidationError ? lastError.message : undefined)
        proposal = currentProposal
        if (this.snapshot(agent.session).revision !== base.revision) {
          stale = true
          throw new Error('requirement parser result became stale')
        }
        const updates = validateAuxiliary(() => this.materialize(base, message, currentProposal.changes))
        const resultingRevision = this.update(agent.session, base.revision, [message.id], updates)
        const updateEvent = updates.length === 0 ? undefined : agent.session.events.at(-1)
        if (updateEvent?.type === 'task-contract/update') recordAuxiliaryApplication(agent.session, callId, updateEvent)
        recordAuxiliaryAssessment(agent.session, callId, { status: 'validated', result: {
          modelProposal: proposal,
          sourceBinding: { messageId: message.id, start: 0, end: messageText(message).length, quote: messageText(message) },
          appliedUpdates: updates,
          resultingRevision,
        } })
        return
      } catch (error: unknown) {
        lastError = error
        recordAuxiliaryAssessment(agent.session, callId, {
          status: stale ? 'stale' : 'failed',
          ...(proposal === undefined ? {} : { result: proposal }),
          error: errorChain(error),
        })
        if (signal.aborted || stale || !(error instanceof AuxiliaryValidationError)) break
      }
    }
    if (this.config.mode === 'enforce') throw lastError
    this.ctx.logger.warn(`requirement change parsing failed: ${errorChain(lastError)}`)
  }

  private async parse(
    agent: Agent,
    input: RequirementParserInput, subjectId: MessageId,
    route: { provider: string; model: string }, signal: AbortSignal, callId: AuditedLlmCallId,
    attempt: number, location: { turn: number; step: number; triggerSeq: number }, diagnostic?: string,
  ): Promise<RequirementChangeProposal> {
    const prompt = auxiliaryPrompt('requirement-change-parsing', requirementChangeRules,
      zz.toJSONSchema(proposalSchema, { io: 'input' }), input, attempt, diagnostic)
    if (prompt.bytes > this.config.maxInputBytes) throw new Error('requirement parser input exceeds maxInputBytes; user input was not truncated')
    const capture = new ExtractionCapture()
    capture.timeoutSignal = AbortSignal.timeout(this.config.parserTimeoutMs)
    const context = {
      triggerSeq: location.triggerSeq,
      requirementRevision: this.snapshot(agent.session).revision,
      location: {
        scope: 'conversation' as const,
        turn: location.turn,
        step: location.step,
        phase: 'before-step' as const,
        subjectId,
      },
    }
    for await (const chunk of auditedReviewStream(this.ctx, agent.session, callId, {
      ...route,
      ...prompt.options,
      ...(this.config.parserReasoningEffort === '' ? {} : { reasoningEffort: ReasoningEffortId(this.config.parserReasoningEffort) }),
      maxTokens: this.config.parserMaxTokens,
      sessionId: agent.session.id,
      signal: AbortSignal.any([signal, capture.timeoutSignal]),
    }, { ...prompt.metadata, context })) capture.push(chunk)
    signal.throwIfAborted()
    capture.timeoutSignal.throwIfAborted()
    if (capture.assembler.finish.kind !== 'stop') throw new Error(`requirement parser ended with ${capture.assembler.finish.kind}`)
    const body = capture.assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    return validateAuxiliary(() => proposalSchema.parse(JSON.parse(stripFence(body))))
  }

  private materialize(base: TaskContractSnapshot, message: UserMessage, changes: readonly RequirementChange[]): RequirementUpdate[] {
    const body = messageText(message)
    const source = { messageId: message.id, start: 0, end: body.length, quote: body }
    return changes.map((change): RequirementUpdate => {
      if (change.op === 'add') return {
        kind: 'add',
        requirement: {
          id: RequirementId(`requirement-${randomUUID()}`), revision: 1, text: change.text,
          verification: change.verification, source, state: 'open', evidenceEventIds: [],
        },
      }
      const current = base.requirements.find(item => item.id === change.targetId)
      if (current === undefined || current.state === 'cancelled') throw new Error(`unknown active requirement ${change.targetId}`)
      return change.op === 'revise'
        ? { kind: 'revise', id: current.id, source, text: change.text, verification: change.verification }
        : { kind: 'cancel', id: current.id, source }
    })
  }

  private route(agent: Agent): { provider: string; model: string } {
    const header = agent.session.requestHeader()?.config
    const provider = this.config.parserProvider || header?.provider || agent.options.provider || ''
    const model = this.config.parserModel || header?.model || agent.options.model || ''
    if (!provider || !model) throw new Error('requirement parser has no provider/model')
    return { provider, model }
  }
}

/**
 * Render only current requirement state and the exact approved plan for the Worker.
 * @param snapshot Current authoritative requirement projection.
 * @returns Compact model context, or `undefined` when no task state exists.
 */
export function renderWorkerSnapshot(snapshot: TaskContractSnapshot): string | undefined {
  if (snapshot.requirements.length === 0 && snapshot.approvedPlan === undefined) return undefined
  const groups: Array<{ title: string; state: RequirementRecord['state'] }> = [
    { title: '待完成：', state: 'open' },
    { title: '已完成，请勿重复：', state: 'fulfilled' },
    { title: '已取消，请勿恢复：', state: 'cancelled' },
  ]
  const lines = ['当前任务状态。本快照替代更早的任务状态快照。']
  for (const group of groups) {
    const requirements = snapshot.requirements.filter(item => item.state === group.state)
    if (requirements.length === 0) continue
    lines.push('', group.title, ...requirements.map(item => `- R${snapshot.requirements.indexOf(item) + 1}：${item.text}`))
  }
  if (snapshot.approvedPlan !== undefined) {
    if (snapshot.approvedPlan.applicability !== 'current') lines.push('', '计划需结合后续需求变更核对；最新用户纠正优先，不恢复取消项。')
    lines.push('', '用户批准的当前计划：', snapshot.approvedPlan.text)
  }
  return lines.join('\n')
}

function retainedSnapshotText(session: Session): string | undefined {
  const retained = new Set(session.surface.nodes)
  const event = session.events.findLast(candidate => candidate.type === 'user/message'
    && retained.has(candidate.seq)
    && candidate.data.source.kind === 'plugin'
    && candidate.data.source.plugin === SNAPSHOT_SOURCE)
  if (event?.type !== 'user/message') return undefined
  const [block] = event.data.content
  return event.data.content.length === 1 && block?.type === 'text' ? block.text : undefined
}

function messageText(message: Pick<UserMessage, 'content'>): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n\n')
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  return value
}

function stripFence(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('```') ? trimmed.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '') : trimmed
}

export default TaskContractService

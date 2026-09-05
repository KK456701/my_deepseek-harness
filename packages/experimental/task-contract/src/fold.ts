/** Replay and validate the append-only Session requirement ledger. */

import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-plan-mode'
import {
  RequirementId,
  type ApprovedPlanRecord,
  type EventRef,
  type RequirementInputRecord,
  type RequirementRecord,
  type RequirementUpdate,
  type TaskContractSnapshot,
  type UserSourceRef,
} from './types.ts'

interface Ledger {
  revision: number
  inputRevision: number
  inputs: Map<MessageId, RequirementInputRecord>
  requirements: Map<RequirementId, RequirementRecord>
  approvedPlan?: ApprovedPlanRecord
}

function text(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n\n')
}

function eventSource(source: UserSourceRef, messageSeqs: ReadonlyMap<MessageId, number>): UserSourceRef {
  if (source.event !== undefined) return source
  const seq = messageSeqs.get(source.messageId)
  return seq === undefined ? source : { ...source, event: { kind: 'local', seq } }
}

function applyUpdate(state: Ledger, update: RequirementUpdate): void {
  switch (update.kind) {
    case 'add': {
      if (state.requirements.has(update.requirement.id)) throw new Error(`duplicate requirement ${update.requirement.id}`)
      if (update.requirement.revision !== 1 || update.requirement.state !== 'open'
        || update.requirement.verifiedRevision !== undefined || update.requirement.evidenceEventIds.length !== 0) {
        throw new Error('new requirement must start open and unverified at revision 1')
      }
      state.requirements.set(update.requirement.id, update.requirement)
      return
    }
    case 'revise': {
      const current = state.requirements.get(update.id)
      if (current === undefined || current.state === 'cancelled') throw new Error(`cannot revise missing or cancelled requirement ${update.id}`)
      const { verifiedRevision: _verifiedRevision, ...rest } = current
      state.requirements.set(update.id, {
        ...rest,
        revision: current.revision + 1,
        text: update.text,
        verification: update.verification,
        source: update.source,
        state: 'open',
        evidenceEventIds: [],
      })
      return
    }
    case 'cancel': {
      const current = state.requirements.get(update.id)
      if (current === undefined || current.state === 'cancelled') throw new Error(`cannot cancel missing or cancelled requirement ${update.id}`)
      const { verifiedRevision: _verifiedRevision, ...rest } = current
      state.requirements.set(update.id, {
        ...rest,
        source: update.source,
        state: 'cancelled',
        evidenceEventIds: [],
      })
      return
    }
    case 'fulfill': {
      const current = state.requirements.get(update.id)
      if (current === undefined || current.state === 'cancelled') throw new Error(`cannot fulfill missing or cancelled requirement ${update.id}`)
      if (current.revision !== update.requirementRevision) throw new Error(`stale fulfillment for requirement ${update.id}`)
      state.requirements.set(update.id, {
        ...current,
        state: 'fulfilled',
        verifiedRevision: current.revision,
        evidenceEventIds: [...update.evidenceEventIds],
      })
    }
  }
}

function legacyRequirement(value: unknown, state: Ledger): RequirementRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string' || typeof item.text !== 'string') return undefined
  const source = legacySource(item.source, state)
  if (source === undefined) return undefined
  const disposition = item.disposition
  const stateValue = disposition === 'fulfilled' ? 'fulfilled' : disposition === 'waived' || disposition === 'superseded' ? 'cancelled' : 'open'
  const evidence = Array.isArray(item.evidence) ? item.evidence.filter(isEventRef) : []
  return {
    id: RequirementId(item.id),
    revision: typeof item.revision === 'number' ? item.revision : 1,
    text: item.text,
    verification: item.verification === 'execution' ? 'execution' : 'answer',
    source,
    state: stateValue,
    ...(typeof item.verifiedRevision === 'number' ? { verifiedRevision: item.verifiedRevision } : {}),
    evidenceEventIds: evidence,
  }
}

function legacySource(value: unknown, state: Ledger): UserSourceRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const source = value as Record<string, unknown>
  if (typeof source.messageId !== 'string') return undefined
  const input = state.inputs.get(source.messageId as MessageId)
  const body = input === undefined ? '' : text(input.content)
  const span = typeof source.span === 'object' && source.span !== null ? source.span as Record<string, unknown> : undefined
  const quote = typeof span?.text === 'string' ? span.text : body
  const start = typeof span?.start === 'number' ? span.start : 0
  const end = typeof span?.end === 'number' ? span.end : start + quote.length
  return {
    messageId: source.messageId as MessageId,
    start,
    end,
    quote,
    ...(isEventRef(source.event) ? { event: source.event } : {}),
  }
}

function isEventRef(value: unknown): value is EventRef {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return Number.isSafeInteger(record.seq) && (record.kind === 'local'
    || (record.kind === 'external' && typeof record.sessionId === 'string'))
}

function applyLegacy(state: Ledger, update: unknown): void {
  if (typeof update !== 'object' || update === null) return
  const value = update as Record<string, unknown>
  switch (value.kind) {
    case 'add_requirement':
    case 'add_question': {
      const requirement = legacyRequirement(value.requirement, state)
      if (requirement !== undefined) state.requirements.set(requirement.id, requirement)
      return
    }
    case 'revise_requirement': {
      if (typeof value.id !== 'string' || typeof value.text !== 'string') return
      const current = state.requirements.get(RequirementId(value.id))
      if (current === undefined || current.state === 'cancelled') return
      const source = legacySource(value.source, state) ?? current.source
      const { verifiedRevision: _verifiedRevision, ...rest } = current
      state.requirements.set(current.id, {
        ...rest,
        revision: current.revision + 1,
        text: value.text,
        verification: value.verification === 'execution' ? 'execution' : current.verification,
        source,
        state: 'open',
        evidenceEventIds: [],
      })
      return
    }
    case 'waive_requirement':
    case 'supersede_requirement': {
      if (typeof value.id !== 'string') return
      const current = state.requirements.get(RequirementId(value.id))
      if (current !== undefined) {
        const { verifiedRevision: _verifiedRevision, ...rest } = current
        state.requirements.set(current.id, { ...rest, state: 'cancelled', evidenceEventIds: [] })
      }
      return
    }
    case 'split_requirement': {
      if (typeof value.id === 'string') {
        const current = state.requirements.get(RequirementId(value.id))
        if (current !== undefined) {
          const { verifiedRevision: _verifiedRevision, ...rest } = current
          state.requirements.set(current.id, { ...rest, state: 'cancelled', evidenceEventIds: [] })
        }
      }
      if (Array.isArray(value.replacements)) {
        for (const replacement of value.replacements) {
          const requirement = legacyRequirement(replacement, state)
          if (requirement !== undefined) state.requirements.set(requirement.id, requirement)
        }
      }
      return
    }
    case 'set_disposition': {
      if (typeof value.id !== 'string') return
      const current = state.requirements.get(RequirementId(value.id))
      if (current === undefined || current.state === 'cancelled') return
      if (value.disposition !== 'fulfilled' || value.requirementRevision !== current.revision) return
      const evidenceEventIds = Array.isArray(value.evidence) ? value.evidence.filter(isEventRef) : []
      state.requirements.set(current.id, { ...current, state: 'fulfilled', verifiedRevision: current.revision, evidenceEventIds })
    }
  }
}

function replay(session: Pick<Session, 'events'>): Ledger {
  const state: Ledger = { revision: 0, inputRevision: -1, inputs: new Map(), requirements: new Map() }
  let turn = 0
  const messageSeqs = new Map<MessageId, number>()
  for (const event of session.events) {
    if (event.type === 'turn/start') turn = event.data.turn
    if (event.type === 'task-contract/input') {
      state.inputRevision = event.seq
      for (const message of event.data.messages) {
        if (!state.inputs.has(message.id)) state.inputs.set(message.id, {
          messageId: message.id,
          content: message.content,
          inputSeq: event.seq,
          turn: event.data.turn,
        })
      }
    }
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      messageSeqs.set(event.data.id, event.seq)
      if (!state.inputs.has(event.data.id)) state.inputs.set(event.data.id, {
        messageId: event.data.id,
        content: event.data.content,
        inputSeq: event.seq,
        turn,
      })
      state.inputRevision = Math.max(state.inputRevision, event.seq)
    }
    if (event.type === 'plan/review-approved') {
      const review = session.events.find(candidate => candidate.seq === event.data.reviewSeq)
      if (review?.type === 'plan/review-start') state.approvedPlan = {
        callId: event.data.callId,
        text: review.data.plan,
        review: { kind: 'local', seq: review.seq },
        approval: { kind: 'local', seq: event.seq },
        requirementRevisions: [...state.requirements.values()].filter(item => item.state !== 'cancelled')
          .map(({ id, revision }) => ({ id, revision })),
      }
    }
    if (event.type !== 'task-contract/update') continue
    if (event.data.baseRevision !== state.revision || event.data.revision !== state.revision + 1) {
      throw new Error(`task contract revision ${event.data.revision} does not follow ${state.revision}`)
    }
    if (event.data.formatVersion === 3) {
      for (const update of event.data.updates) applyUpdate(state, update)
    } else {
      for (const update of event.data.updates as readonly unknown[]) applyLegacy(state, update)
    }
    state.revision = event.data.revision
  }
  for (const [id, requirement] of state.requirements) {
    state.requirements.set(id, { ...requirement, source: eventSource(requirement.source, messageSeqs) })
  }
  return state
}

function validateSource(state: Ledger, source: UserSourceRef, sources: ReadonlySet<MessageId>): void {
  if (!sources.has(source.messageId)) throw new Error(`requirement change names unclaimed source message ${source.messageId}`)
  const input = state.inputs.get(source.messageId)
  if (input === undefined) throw new Error(`missing requirement source message ${source.messageId}`)
  const body = text(input.content)
  if (!Number.isSafeInteger(source.start) || !Number.isSafeInteger(source.end) || source.start < 0 || source.end <= source.start
    || source.end > body.length || body.slice(source.start, source.end) !== source.quote) {
    throw new Error(`requirement source range does not match message ${source.messageId}`)
  }
}

/**
 * Validate a complete update batch without publishing partial state.
 * @param session Session prefix containing the current ledger.
 * @param updates Runtime-owned changes proposed for one atomic append.
 * @param sourceMessageIds Direct user messages allowed as sources for this batch.
 * @param maxRequirements Optional live-requirement capacity.
 */
export function validateTaskUpdates(session: Pick<Session, 'events'>, updates: readonly RequirementUpdate[],
  sourceMessageIds: readonly MessageId[], maxRequirements?: number): void {
  const state = replay(session)
  const sources = new Set(sourceMessageIds)
  for (const update of updates) {
    if (update.kind === 'add') validateSource(state, update.requirement.source, sources)
    if (update.kind === 'revise' || update.kind === 'cancel') validateSource(state, update.source, sources)
    applyUpdate(state, update)
  }
  if (maxRequirements !== undefined && [...state.requirements.values()].filter(item => item.state !== 'cancelled').length > maxRequirements) {
    throw new Error(`requirement batch exceeds limit ${maxRequirements}`)
  }
}

/**
 * Replay the current requirement ledger independently of conversation compaction.
 * @param session Session events containing inputs, updates, and plan approvals.
 * @returns Current requirements, original inputs, revisions, and approved plan.
 */
export function foldTaskContract(session: Pick<Session, 'events'>): TaskContractSnapshot {
  const state = replay(session)
  if (state.approvedPlan !== undefined) {
    const baseline = new Map(state.approvedPlan.requirementRevisions?.map(item => [item.id, item.revision]))
    const changed = [...state.requirements.values()].filter(item =>
      item.state === 'cancelled' ? baseline.has(item.id) : baseline.get(item.id) !== item.revision).map(item => item.id)
    state.approvedPlan = { ...state.approvedPlan, changedRequirementIds: changed,
      applicability: baseline.size > 0 && changed.length === 0 ? 'current' : 'needs-reconciliation' }
  }
  return {
    revision: state.revision,
    requirements: [...state.requirements.values()],
    inputs: [...state.inputs.values()],
    inputRevision: state.inputRevision,
    ...(state.approvedPlan === undefined ? {} : { approvedPlan: state.approvedPlan }),
  }
}

/** Final Reviewer aliases over the shared frozen Session-event query adapter. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  executeFrozenSessionEvidenceTool, frozenSessionEvidence, frozenSessionEvidenceIndex,
  frozenSessionEvidenceTools,
} from '@deepseek-ai/dsh-experimental-task-contract'
import type { FrozenSessionEvidenceIndex, FrozenSessionEvidenceToolResult } from '@deepseek-ai/dsh-experimental-task-contract'
import type { FrozenReviewInput } from './types.ts'

/** Exact tool-result evidence accepted by final-review validation. */
export interface ReviewEvidence {
  readonly eventId: { readonly kind: 'local'; readonly seq: number }
  readonly time: number
  readonly success?: boolean
  readonly content: string
}

/** Compact tool-result locator included in the initial Reviewer request. */
export type ReviewEvidenceIndex = Omit<FrozenSessionEvidenceIndex, 'type'>

/** Shared read-only Session tools scoped to the frozen review input. */
export const reviewEvidenceTools = frozenSessionEvidenceTools

/**
 * Select the persisted events that one frozen review may inspect on demand.
 * @param events Current append-only Session log.
 * @param input Frozen review input and candidate position.
 * @returns Tool results admitted as evidence plus exact user and plan source events already named by the input.
 */
export function reviewLookupEvents(events: readonly SessionEvent[], input: FrozenReviewInput): readonly SessionEvent[] {
  const selected = new Map(input.evidence.map(event => [event.seq, event]))
  const sourceSeqs = new Set(input.contract.requirements.flatMap((requirement) => {
    const event = requirement.source.event
    return event?.kind === 'local' ? [event.seq] : []
  }))
  const inputMessageIds = new Set(input.originalInputs.map(item => item.messageId))
  const planRefs = [input.contract.approvedPlan?.review, input.contract.approvedPlan?.approval]
  for (const ref of planRefs) if (ref?.kind === 'local') sourceSeqs.add(ref.seq)
  for (const event of events) {
    if (event.seq >= input.candidateSeq) continue
    if (sourceSeqs.has(event.seq)
      || (event.type === 'user/message' && inputMessageIds.has(event.data.id))) selected.set(event.seq, event)
  }
  return [...selected.values()].sort((left, right) => left.seq - right.seq)
}

/**
 * Project an admitted result for final-review reference validation.
 * @param event Tool-result event from the frozen candidate prefix.
 * @param events Frozen events containing matching invocations.
 * @returns Final-review result representation.
 */
export function reviewEvidence(event: SessionEvent, events: readonly SessionEvent[]): ReviewEvidence {
  if (event.type !== 'tool/result') throw new Error('final review evidence must be a tool result')
  const projected = frozenSessionEvidence(event, events)
  return { eventId: projected.eventId, time: projected.time,
    ...(projected.success === undefined ? {} : { success: projected.success }), content: projected.content }
}

/**
 * Project a compact result locator for the initial review request.
 * @param event Tool-result event.
 * @param events Frozen events containing matching invocations.
 * @returns Stable identity, outcome, and invocation locator.
 */
export function reviewEvidenceIndex(event: SessionEvent, events: readonly SessionEvent[]): ReviewEvidenceIndex {
  const compact = frozenSessionEvidenceIndex(event, events)
  return { eventId: compact.eventId, ...(compact.success === undefined ? {} : { success: compact.success }),
    ...(compact.invocation === undefined ? {} : { invocation: compact.invocation }),
    ...(compact.target === undefined ? {} : { target: compact.target }) }
}

/**
 * Execute one Reviewer lookup against its immutable event set.
 * @param events Frozen Session events authorized for this review.
 * @param name Allowed query tool.
 * @param rawArguments Model-authored arguments.
 * @param maxSearchResults Maximum search matches.
 * @returns JSON result and fully read event identities.
 */
export function executeReviewEvidenceTool(events: readonly SessionEvent[], name: string, rawArguments: string,
  maxSearchResults: number): FrozenSessionEvidenceToolResult {
  return executeFrozenSessionEvidenceTool(events, name, rawArguments, maxSearchResults)
}

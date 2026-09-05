/** Validate simplified final-review references and derive fixed runtime actions. */

import { z } from 'zod'
import type { AssistantMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { RequirementId } from '@deepseek-ai/dsh-experimental-task-contract'
import type { EventRef, RequirementInputRecord, TaskContractSnapshot } from '@deepseek-ai/dsh-experimental-task-contract'
import { reviewEvidence, reviewEvidenceIndex } from './evidence.ts'
import type { FinalReviewResult, FrozenReviewInput, RequirementReview, ReviewDeliveryAction } from './types.ts'

const eventRefSchema = z.object({ kind: z.literal('local'), seq: z.number().int().nonnegative() }).strict()
/** JSON response accepted from the Final Reviewer. */
export const reviewSchema = z.object({
  reply: z.enum(['complete', 'interim', 'blocked', 'continue']),
  requirements: z.array(z.object({
    requirementId: z.string().min(1),
    requirementRevision: z.number().int().positive(),
    answer: z.enum(['covered', 'pending-disclosed', 'missing']),
    work: z.enum(['verified', 'needs-verification', 'not-done', 'incorrect', 'not-needed']),
    answerEvidence: z.array(z.object({ paragraphId: z.string().min(1), quote: z.string().min(1) }).strict()),
    evidenceEventIds: z.array(eventRefSchema),
    gap: z.string(),
  }).strict()),
  missingPlanQuotes: z.array(z.string().min(1)),
  unsupportedParagraphIds: z.array(z.string().min(1)),
  reason: z.string(),
}).strict()

/**
 * Capture uncancelled requirements, related original input, result evidence, and answer paragraphs once.
 * @param session Session event prefix visible to this candidate.
 * @param contract Requirement ledger frozen for review.
 * @param originalInputs User messages related to the effective requirements.
 * @param candidate Candidate answer before delivery.
 * @param candidateSeq Session position that closes the evidence prefix.
 * @returns Immutable input reused by every review attempt for this candidate.
 */
export function freezeReviewInput(session: Pick<Session, 'events'>, contract: TaskContractSnapshot,
  originalInputs: readonly RequirementInputRecord[], candidate: AssistantMessage, candidateSeq: number): FrozenReviewInput {
  const turnStart = session.events.findLast(event => event.seq < candidateSeq && event.type === 'turn/start')?.seq ?? 0
  const selected = new Set<number>()
  for (const event of session.events) {
    if (event.type === 'tool/result' && event.seq >= turnStart && event.seq < candidateSeq) selected.add(event.seq)
  }
  for (const requirement of contract.requirements.filter(item => item.state !== 'cancelled')) {
    for (const ref of requirement.evidenceEventIds) if (ref.kind === 'local') selected.add(ref.seq)
  }
  const results = session.events.filter(event => event.type === 'tool/result'
    && selected.has(event.seq) && event.seq < candidateSeq)
  const callIds = new Set(results.flatMap(event => event.type === 'tool/result' ? [event.data.message.source.callId] : []))
  const evidence = session.events.filter(event => event.seq < candidateSeq
    && ((event.type === 'tool/result' && selected.has(event.seq))
      || (event.type === 'tool/call' && callIds.has(event.data.callId))))
  const text = candidate.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n\n')
  const paragraphs: FrozenReviewInput['paragraphs'][number][] = []
  for (const match of text.matchAll(/\S[\s\S]*?(?=\r?\n\s*\r?\n|$)/gu)) {
    paragraphs.push({ id: `p${paragraphs.length + 1}`, start: match.index, end: match.index + match[0].length, text: match[0] })
  }
  return { version: 8, candidateSeq, contract, originalInputs, evidence, candidate, paragraphs }
}

/**
 * Project each dynamic body exactly once; ids carry all cross-references.
 * @param input Frozen review material.
 * @returns JSON-serializable Reviewer input without private reasoning or duplicate bodies.
 */
export function projectReviewInput(input: FrozenReviewInput): Readonly<Record<string, unknown>> {
  return {
    version: input.version,
    originalUserMessages: input.originalInputs.map(item => ({ messageId: item.messageId, content: item.content })),
    requirements: input.contract.requirements.filter(item => item.state !== 'cancelled')
      .map(({ id, revision, text, verification, state }) => ({ id, revision, text, verification, state })),
    ...(input.contract.approvedPlan === undefined ? {} : { approvedPlan: {
      text: input.contract.approvedPlan.text,
      applicability: input.contract.approvedPlan.applicability ?? 'needs-reconciliation',
      changedRequirementIds: input.contract.approvedPlan.changedRequirementIds ?? [],
    } }),
    evidenceIndex: input.evidence.filter(event => event.type === 'tool/result')
      .map(event => ({ ...reviewEvidenceIndex(event, input.evidence),
        freshness: input.freshness?.[event.seq] ?? { status: 'unknown', reason: '未记录受测状态，需重新核验。' } })),
    candidateParagraphs: input.paragraphs.map(({ id, text }) => ({ id, text })),
  }
}

/**
 * Validate the complete itemized result against the frozen request.
 * @param value Parsed JSON returned by the Reviewer.
 * @param input Frozen requirements, paragraphs, plan, and evidence.
 * @param maxEvidenceRefs Maximum accepted result-event citations.
 * @param readEvidenceIds Frozen result events whose complete bodies the Reviewer read.
 * @returns Validated review with branded requirement identities.
 */
export function validateReview(
  value: unknown,
  input: FrozenReviewInput,
  maxEvidenceRefs: number,
  readEvidenceIds: ReadonlySet<number> = new Set(),
): FinalReviewResult {
  if (input.version !== 8) throw new Error('historical review input must be reviewed again under version 8')
  const parsed = reviewSchema.parse(value)
  const expected = new Map(input.contract.requirements.filter(item => item.state !== 'cancelled').map(item => [item.id, item]))
  if (parsed.requirements.length !== expected.size) throw new Error('review must cover every uncancelled requirement exactly once')
  const paragraphs = new Map(input.paragraphs.map(item => [item.id, item.text]))
  const evidence = new Map(input.evidence.filter(event => event.type === 'tool/result')
    .map(event => [event.seq, reviewEvidence(event, input.evidence)]))
  const seen = new Set<string>()
  let refs = 0
  const requirements: RequirementReview[] = parsed.requirements.map((item) => {
    const requirementId = RequirementId(item.requirementId)
    const current = expected.get(requirementId)
    if (current === undefined || seen.has(item.requirementId)) throw new Error('review names an unknown or duplicate requirement')
    seen.add(item.requirementId)
    if (current.revision !== item.requirementRevision) throw new Error('review names a stale requirement revision')
    for (const ref of item.answerEvidence) {
      const paragraph = paragraphs.get(ref.paragraphId)
      if (paragraph === undefined) throw new Error('review names an unknown candidate paragraph')
      if (ref.quote.trim().length === 0 || !paragraph.includes(ref.quote)) throw new Error('answer evidence must exactly quote the candidate paragraph')
    }
    if (item.answer !== 'missing' && item.answerEvidence.length === 0) throw new Error('covered or disclosed answer requires a candidate paragraph quote')
    if (current.verification === 'answer' && item.work !== 'not-needed') throw new Error('answer-only requirement must use work=not-needed')
    if (current.verification === 'execution' && item.work === 'not-needed') throw new Error('execution requirement cannot use work=not-needed')
    let successful = false
    for (const ref of item.evidenceEventIds) {
      refs += 1
      const selected = evidence.get(ref.seq)
      if (selected === undefined) throw new Error('review names evidence outside the frozen result set')
      successful ||= selected.success === true
    }
    if (item.work === 'verified' && !successful) throw new Error('verified work requires a successful result event')
    if (item.evidenceEventIds.some(ref => !readEvidenceIds.has(ref.seq))) {
      throw new Error('work assessment requires session_event_read for every cited result event')
    }
    if (item.work === 'verified' && item.evidenceEventIds.some(ref => input.freshness?.[ref.seq]?.status !== 'current')) {
      throw new Error('verified work requires evidence applicable to the current state')
    }
    if ((item.work === 'not-done' || item.work === 'incorrect')
      && !item.evidenceEventIds.some(ref => input.freshness?.[ref.seq]?.status === 'current')) {
      return { ...item, requirementId, work: 'needs-verification' }
    }
    return { ...item, requirementId }
  })
  if (refs > maxEvidenceRefs) throw new Error(`review exceeds ${maxEvidenceRefs} evidence references`)
  for (const id of parsed.unsupportedParagraphIds) if (!paragraphs.has(id)) throw new Error('unsupported claim names an unknown paragraph')
  if (input.contract.approvedPlan === undefined && parsed.missingPlanQuotes.length > 0) throw new Error('review invented an approved plan')
  for (const quote of parsed.missingPlanQuotes) {
    if (!input.contract.approvedPlan?.text.includes(quote)) throw new Error('missing plan quote is not present in the approved plan')
  }
  if (parsed.reply === 'complete' && (requirements.some(item => item.answer !== 'covered' || !workComplete(item))
    || parsed.missingPlanQuotes.length > 0 || parsed.unsupportedParagraphIds.length > 0)) {
    throw new Error('reply=complete conflicts with an itemized gap')
  }
  if (parsed.reply !== 'complete' && requirements.every(item => item.answer === 'covered' && workComplete(item))
    && parsed.missingPlanQuotes.length === 0 && parsed.unsupportedParagraphIds.length === 0) {
    throw new Error('interim or blocked reply requires an itemized gap')
  }
  return { ...parsed, requirements }
}

/**
 * Derive the only allowed next action from a validated review.
 * @param result Validated itemized review.
 * @returns Deterministic delivery or remediation action.
 */
export function reviewAction(result: FinalReviewResult): ReviewDeliveryAction {
  const missingAnswer = result.requirements.some(item => item.answer === 'missing')
  const incomplete = result.requirements.filter(item => !workComplete(item))
  const disclosed = incomplete.every(item => item.answer === 'pending-disclosed')
  const workAction = incomplete.some(item => item.work === 'needs-verification') ? 'verify' : 'continue_work'
  if (incomplete.length > 0 && (!disclosed || result.reply === 'continue')) return workAction
  if (result.reply === 'continue') return 'rewrite'
  if (result.unsupportedParagraphIds.length > 0) return 'rewrite'
  if (result.missingPlanQuotes.length > 0) return 'verify'
  if (missingAnswer) return 'rewrite'
  return 'commit'
}

function workComplete(item: RequirementReview): boolean { return item.work === 'verified' || item.work === 'not-needed' }

/**
 * Select current requirement versions that delivery may mark fulfilled.
 * @param result Validated itemized review.
 * @returns Reviews whose answer and work checks are complete.
 */
export function fulfilledReviews(result: FinalReviewResult): RequirementReview[] {
  return result.requirements.filter(item => item.answer === 'covered' && workComplete(item))
}

/**
 * Check whether this delivery closes every open requirement.
 * @param result Validated itemized review.
 * @returns Whether the reply is complete and every item can be fulfilled.
 */
export function reviewCompletesTask(result: FinalReviewResult): boolean {
  return result.reply === 'complete' && fulfilledReviews(result).length === result.requirements.length
}

/**
 * Return the evidence bound to one completed requirement review.
 * @param review Validated requirement review.
 * @returns Event references admitted into the requirement ledger.
 */
export function reviewEvidenceRefs(review: RequirementReview): readonly EventRef[] { return review.evidenceEventIds }

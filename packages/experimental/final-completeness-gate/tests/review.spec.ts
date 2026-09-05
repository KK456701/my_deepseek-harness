import { describe, expect, it } from 'vitest'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { RequirementId, foldTaskContract } from '@deepseek-ai/dsh-experimental-task-contract'
import type { RequirementUpdate } from '@deepseek-ai/dsh-experimental-task-contract'
import { executeReviewEvidenceTool, reviewLookupEvents } from '../src/evidence.ts'
import { freezeReviewInput, fulfilledReviews, projectReviewInput, reviewAction, reviewCompletesTask, validateReview } from '../src/review.ts'
import { completeAssessment } from './assessment-fixture.ts'

function fixture(verification: 'answer' | 'execution' = 'answer') {
  const session = Session.create(SessionId(`frozen-review-${verification}`))
  const body = '说明结果和限制。'
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: body }] })
  session.append('turn/start', { turn: 1 })
  session.append('task-contract/input', { turn: 1, messages: [{ id: message.id, content: message.content }] })
  const userEvent = session.append('user/message', message, { surfaceOp: 'append' })
  const source = { messageId: message.id, start: 0, end: body.length, quote: body,
    event: { kind: 'local' as const, seq: userEvent.seq } }
  const updates: RequirementUpdate[] = ['result', 'limitations'].map(id => ({
    kind: 'add', requirement: {
      id: RequirementId(id), revision: 1, text: id, verification, source, state: 'open', evidenceEventIds: [],
    },
  }))
  session.append('task-contract/update', { formatVersion: 3, baseRevision: 0, revision: 1, sourceMessageIds: [message.id], updates })
  const call = session.append('tool/call', { turn: 1, step: 1, callId: CallId('inspect'), name: 'inspect', arguments: '{}' })
  const result = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
    callId: CallId('inspect'), isError: false, content: [{ type: 'text', text: '已完成两项检查，第三项不可用。' }],
  }) }, { surfaceOp: 'append' })
  const contract = foldTaskContract(session)
  const candidate = createAssistantMessage({
    content: [{ type: 'text', text: '已说明结果。\n\n第三项报告缺失，因此相关限制仍未验证。' }],
    source: { provider: 'mock', model: 'mock' },
  })
  const input = { ...freezeReviewInput(session, contract, contract.inputs, candidate, session.seq + 1),
    freshness: { [result.seq]: { status: 'current' as const, reason: 'Program freshness fixture; semantic support is tested separately.' } } }
  return { input, call, result, session, userEvent }
}

describe('simplified final review', () => {
  it.each(['stale', 'unknown'] as const)('rejects %s evidence as proof of current completion', (status) => {
    const { input, result } = fixture('execution')
    const assessment = completeAssessment(input)
    assessment.requirements.forEach((item) => { item.work = 'verified'; item.evidenceEventIds = [{ kind: 'local', seq: result.seq }] })
    expect(() => validateReview(assessment, { ...input, freshness: { [result.seq]: { status, reason: 'version not current' } } },
      64, new Set([result.seq]))).toThrow(/current state/)
  })

  it.each(['not-done', 'incorrect'] as const)('downgrades unsupported %s to verification, not repetition', (work) => {
    const { input } = fixture('execution')
    const assessment = completeAssessment(input)
    assessment.reply = 'continue'
    assessment.requirements.forEach((item) => { item.work = work })
    const result = validateReview(assessment, input, 64)
    expect(result.requirements.every(item => item.work === 'needs-verification')).toBe(true)
    expect(reviewAction(result)).toBe('verify')
    expect(fulfilledReviews(result)).toEqual([])
  })

  it('accepts concrete defect evidence for targeted correction', () => {
    const { input, result } = fixture('execution')
    const assessment = completeAssessment(input)
    assessment.reply = 'continue'
    assessment.requirements.forEach((item) => { item.work = 'incorrect'; item.evidenceEventIds = [{ kind: 'local', seq: result.seq }] })
    expect(reviewAction(validateReview(assessment, input, 64, new Set([result.seq])))).toBe('continue_work')
  })

  it('rejects invented answer excerpts even when the paragraph identity exists', () => {
    const { input } = fixture()
    const assessment = completeAssessment(input)
    assessment.requirements[0]!.answerEvidence[0]!.quote = '实际段落中没有这个说法'
    expect(() => validateReview(assessment, input, 64)).toThrow(/exactly quote/)
  })
  it('requires coverage of fulfilled requirements while reusing their earlier result evidence', () => {
    const { session, input: old, result } = fixture('execution')
    session.append('task-contract/update', { formatVersion: 3, baseRevision: 1, revision: 2, sourceMessageIds: [], updates: [
      { kind: 'fulfill', id: RequirementId('result'), requirementRevision: 1, evidenceEventIds: [{ kind: 'local', seq: result.seq }] },
    ] })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    const contract = foldTaskContract(session)
    const input = freezeReviewInput(session, contract, contract.inputs, old.candidate, session.seq + 1)
    const review = completeAssessment(input)
    expect(review.requirements.map(item => item.requirementId)).toEqual(['result', 'limitations'])
    const projected = projectReviewInput(input) as { evidenceIndex: Array<{ eventId: { seq: number } }> }
    expect(projected.evidenceIndex.map(item => item.eventId.seq)).toContain(result.seq)
    review.requirements.shift()
    expect(() => validateReview(review, input, 64)).toThrow(/every uncancelled requirement/)
  })

  it('does not upgrade historical reviews to the all-effective-requirements standard', () => {
    const { input } = fixture()
    expect(() => validateReview(completeAssessment(input), { ...input, version: 6 }, 64)).toThrow(/version 8/)
  })

  it('projects each body once and excludes tool calls from completion evidence', () => {
    const { input, call, result } = fixture()
    const projected = projectReviewInput(input) as { evidenceIndex: Array<{ eventId: { seq: number } }> }
    expect(projected).not.toHaveProperty('candidate')
    expect(projected).not.toHaveProperty('evidence')
    expect(projected.evidenceIndex.map(item => item.eventId.seq)).toEqual([result.seq])
    expect(projected.evidenceIndex.map(item => item.eventId.seq)).not.toContain(call.seq)
    expect(projected.evidenceIndex[0]).toEqual({ eventId: { kind: 'local', seq: result.seq }, success: true,
      invocation: { seq: call.seq, name: 'inspect' }, freshness: input.freshness[result.seq] })
    expect(JSON.stringify(projected)).not.toContain('已完成两项检查')
    expect(JSON.stringify(projected).split(input.paragraphs[0]!.text)).toHaveLength(2)
    expect(JSON.stringify(projected).split('说明结果和限制。')).toHaveLength(2)
    expect(JSON.stringify(projected)).not.toContain('verifiedRevision')
  })

  it('returns only matched frozen event identities from search and exact content from read', () => {
    const { input, result, session, userEvent } = fixture('execution')
    const lookupEvents = reviewLookupEvents(session.events, input)
    const searched = executeReviewEvidenceTool(lookupEvents, 'session_event_search', JSON.stringify({ query: '第三项' }), 8)
    expect(searched.readEventIds).toEqual([])
    expect(searched.content).toContain('第三项不可用')
    const read = executeReviewEvidenceTool(lookupEvents, 'session_event_read', JSON.stringify({ seq: result.seq }), 8)
    expect(read.readEventIds).toEqual([result.seq])
    expect(read.content).toContain('已完成两项检查')
    const source = executeReviewEvidenceTool(lookupEvents, 'session_event_read',
      JSON.stringify({ seq: userEvent.seq }), 8)
    expect(source.content).toContain('说明结果和限制。')
    expect(() => executeReviewEvidenceTool(lookupEvents, 'session_event_read',
      JSON.stringify({ seq: input.candidateSeq + 1 }), 8)).toThrow(/outside the frozen Session event set/)
  })

  it('commits and fulfills every answer-only requirement only after itemized coverage', () => {
    const { input } = fixture()
    const review = validateReview(completeAssessment(input), input, 64)
    expect(reviewAction(review)).toBe('commit')
    expect(reviewCompletesTask(review)).toBe(true)
    expect(fulfilledReviews(review).map(item => item.requirementId)).toEqual(['result', 'limitations'])
  })

  it('rewrites a missing explanation without requesting more work', () => {
    const { input } = fixture()
    const assessment = completeAssessment(input)
    assessment.reply = 'interim'
    assessment.requirements[1]!.answer = 'missing'
    assessment.requirements[1]!.answerEvidence = []
    assessment.requirements[1]!.gap = '没有说明限制。'
    const review = validateReview(assessment, input, 64)
    expect(reviewAction(review)).toBe('rewrite')
    expect(reviewCompletesTask(review)).toBe(false)
  })

  it('requires a successful result event before execution work is verified', () => {
    const { input, result } = fixture('execution')
    const assessment = completeAssessment(input)
    for (const item of assessment.requirements) {
      item.work = 'verified'
      item.evidenceEventIds = [{ kind: 'local', seq: result.seq }]
      item.gap = ''
    }
    const review = validateReview(assessment, input, 64, new Set([result.seq]))
    expect(reviewAction(review)).toBe('commit')

    assessment.requirements[0]!.evidenceEventIds = [{ kind: 'local', seq: result.seq - 1 }]
    expect(() => validateReview(assessment, input, 64, new Set([result.seq]))).toThrow(/outside the frozen result set/)

    assessment.requirements[0]!.evidenceEventIds = [{ kind: 'local', seq: result.seq }]
    expect(() => validateReview(assessment, input, 64)).toThrow(/session_event_read/)
  })

  it('rejects nonzero Shell exits even when the tool protocol reports no error', () => {
    const { input: previous, session } = fixture('execution')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    const call = session.append('tool/call', { turn: 2, step: 1, callId: CallId('shell-test'), name: 'pwsh',
      arguments: '{"command":"npm test"}' })
    const result = session.append('tool/result', { turn: 2, step: 1, message: createToolResultMessage({
      callId: call.data.callId, isError: false, content: [{ type: 'text', text: 'spawn EPERM\n[exit code: 1]' }],
    }) }, { surfaceOp: 'append' })
    const input = freezeReviewInput(session, previous.contract, previous.originalInputs, previous.candidate, session.seq + 1)
    expect(input.evidence.map(event => event.seq)).toEqual([call.seq, result.seq])
    expect(projectReviewInput(input)).toMatchObject({ evidenceIndex: [{ success: false }] })
    const read = executeReviewEvidenceTool(input.evidence, 'session_event_read', JSON.stringify({ seq: result.seq }), 4)
    expect(JSON.parse(read.content)).toMatchObject({ event: { success: false } })
    const assessment = completeAssessment(input)
    for (const item of assessment.requirements) {
      item.work = 'verified'; item.gap = ''; item.evidenceEventIds = [{ kind: 'local', seq: result.seq }]
    }
    expect(() => validateReview(assessment, input, 64, new Set([result.seq]))).toThrow(/successful result/)
  })

  it('allows an honest blocked reply without closing unverified work', () => {
    const { input } = fixture('execution')
    const assessment = completeAssessment(input)
    assessment.reply = 'blocked'
    for (const item of assessment.requirements) {
      item.answer = 'pending-disclosed'
      item.work = 'needs-verification'
      item.gap = '缺少所需报告。'
    }
    const review = validateReview(assessment, input, 64)
    expect(reviewAction(review)).toBe('commit')
    expect(fulfilledReviews(review)).toEqual([])
    expect(reviewCompletesTask(review)).toBe(false)
  })

  it('verifies uncertain artifact work before repeating an operation', () => {
    const { input } = fixture('execution')
    const assessment = completeAssessment(input)
    assessment.reply = 'interim'
    expect(reviewAction(validateReview(assessment, input, 64))).toBe('verify')
    assessment.unsupportedParagraphIds = [input.paragraphs[0]!.id]
    expect(reviewAction(validateReview(assessment, input, 64))).toBe('verify')
  })

  it('rewrites an overclaim when no artifact work remains', () => {
    const { input } = fixture()
    const assessment = completeAssessment(input)
    assessment.reply = 'interim'
    assessment.unsupportedParagraphIds = [input.paragraphs[0]!.id]
    expect(reviewAction(validateReview(assessment, input, 64))).toBe('rewrite')
  })

  it('continues work when an unrequested progress summary tries to end the Turn', () => {
    const { input } = fixture('execution')
    const assessment = completeAssessment(input)
    assessment.reply = 'continue'
    for (const item of assessment.requirements) {
      item.answer = 'pending-disclosed'
      item.work = 'needs-verification'
      item.gap = '用户要求完整交付，候选仅说明阶段性进度。'
    }
    const review = validateReview(assessment, input, 64)
    expect(reviewAction(review)).toBe('verify')
    expect(reviewCompletesTask(review)).toBe(false)
  })

  it('rejects stale requirement revisions, unknown paragraphs, and invented plan quotes', () => {
    const { input } = fixture()
    const assessment = completeAssessment(input)
    assessment.requirements[0]!.requirementRevision = 2
    expect(() => validateReview(assessment, input, 64)).toThrow(/stale/)
    assessment.requirements[0]!.requirementRevision = 1
    assessment.requirements[0]!.answerEvidence = [{ paragraphId: 'missing', quote: 'missing' }]
    expect(() => validateReview(assessment, input, 64)).toThrow(/unknown candidate paragraph/)
    assessment.requirements[0]!.answerEvidence = [{ paragraphId: input.paragraphs[0]!.id, quote: input.paragraphs[0]!.text }]
    assessment.missingPlanQuotes = ['虚构计划']
    expect(() => validateReview(assessment, input, 64)).toThrow(/invented an approved plan/)
  })

  it('rejects an interim label when no itemized gap exists', () => {
    const { input } = fixture()
    const assessment = completeAssessment(input)
    assessment.reply = 'interim'
    expect(() => validateReview(assessment, input, 64)).toThrow(/requires an itemized gap/)
  })
})

import type { z } from 'zod'
import type { reviewSchema } from '../src/review.ts'
import type { FrozenReviewInput } from '../src/types.ts'

export function completeAssessment(input: Pick<FrozenReviewInput, 'contract' | 'paragraphs'>): z.infer<typeof reviewSchema> {
  return {
    reply: 'complete',
    requirements: input.contract.requirements.filter(item => item.state !== 'cancelled').map(item => ({
      requirementId: item.id,
      requirementRevision: item.revision,
      answer: 'covered' as const,
      work: item.verification === 'answer' ? 'not-needed' as const : 'needs-verification' as const,
      answerEvidence: [{ paragraphId: input.paragraphs[0]!.id, quote: input.paragraphs[0]!.text }],
      evidenceEventIds: [],
      gap: item.verification === 'answer' ? '' : '缺少执行证据。',
    })),
    missingPlanQuotes: [],
    unsupportedParagraphIds: [],
    reason: '候选回答逐项覆盖当前需求。',
  }
}

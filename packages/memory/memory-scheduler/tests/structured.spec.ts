import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { redactMemoryJson } from '@deepseek-ai/dsh-memory'
import { MemoryClaimToken, MemoryEvidenceId, MemorySourceRangeId, Phase1JobId, type MemoryEvidenceItem, type Phase1Claim } from '@deepseek-ai/dsh-memory-pipeline-store'
import { SessionId } from '@deepseek-ai/dsh-session'
import { codexPhase1, structuredCandidates } from '../src/structured-phase1.ts'

const claim: Phase1Claim = { jobId: Phase1JobId('a'), sourceRangeId: MemorySourceRangeId('a'), sessionId: SessionId('session-a'), fromSeq: 0, toSeq: 4, inputFingerprint: 'fixture', lease: { ownerToken: MemoryClaimToken('owner'), leasedUntil: 100, attempt: 1 } }
const evidence: MemoryEvidenceItem[] = [
  { evidenceId: MemoryEvidenceId('a:0'), sourceEventSeqs: [1], kind: 'user', text: 'In future, use a short opening.', trust: 'eligible-local-untrusted' },
  { evidenceId: MemoryEvidenceId('a:1'), sourceEventSeqs: [2], kind: 'assistant', text: 'I will remember.', trust: 'eligible-local-untrusted' },
]
const output = { useful: true, rolloutSummary: 'A requested shorter opening, with no verified execution. Evidence: a:0', rolloutSlug: 'opening', tasks: [{ title: 'Communication', outcome: 'unknown', scope: 'reply opening', userIntent: 'Short opening', evidenceIds: ['a:0'],
  preferenceSignals: [{ kind: 'explicit-future', statement: 'Use a short opening.', userQuote: 'In future, use a short opening.', scope: 'reply opening', evidenceIds: ['a:0'] }],
  verifiedFacts: [], reusableProcedures: [], failuresAndCorrections: [],
}] }

describe('structured task evidence', () => {
  it('dispatches through a late-selected runner from an injected plugin context after logging the request', async () => {
    const ctx = new Context()
    const order: string[] = []
    ctx.provide('memoryPipelineStore', {
      beginPhase1Attempt: async () => ({ attemptId: 'attempt' }),
      recordPhase1Request: async () => { order.push('request') },
      recordPhase1Result: async () => { order.push('result') },
    })
    ctx.provide('codexStructuredRunner', {
      prepareCall: async () => ({
        exactRequest: { model: 'test', effort: 'high' },
        dispatch: async () => { order.push('dispatch'); return { value: output, finishReason: 'completed', error: null, usage: null } },
        dispose: async () => { order.push('dispose') },
      }),
    })
    try {
      await ctx.plugin({ inject: ['memoryPipelineStore'], async apply(scoped: Context) {
        const candidates = await codexPhase1(scoped, claim, evidence, {
          backend: 'codex', provider: 'test', model: 'test', reasoningEffort: 'high', maxTokens: 100,
          maxEvidenceBytes: 10000, maxResultBytes: 10000, maxCandidates: 10,
          disableOnExternalContext: false, externalToolPrefixes: [], policyVersion: 7,
        }, new AbortController().signal)
        expect(candidates).toHaveLength(1)
      } })
      expect(order).toEqual(['request', 'dispatch', 'result', 'dispose'])
    } finally { await ctx.fiber.dispose() }
  })
  it('retains a single explicit future instruction without assigning a promotion tier', () => {
    const result = structuredCandidates(output, claim, evidence)
    expect(result).toHaveLength(1)
    expect(result[0]?.rawMemory).toContain('explicit-future')
    expect(result[0]?.rawMemory).not.toContain('summary-eligible')
    expect(result[0]?.rolloutSummary).toBe(output.rolloutSummary)
    expect(result[0]?.rolloutSummary).not.toBe(result[0]?.rawMemory)
    expect(result[0]?.rolloutSlug).toBe('opening')
  })
  it('accepts empty evidence and rejects invented IDs, assistant-only preferences, and incomplete schemas', () => {
    expect(structuredCandidates({ useful: false, tasks: [], rolloutSummary: '', rolloutSlug: '' }, claim, evidence)).toEqual([])
    for (const id of ['unknown', 'a:1']) {
      const value = structuredClone(output)
      value.tasks[0]!.preferenceSignals[0]!.evidenceIds = [id]
      expect(() => structuredCandidates(value, claim, evidence)).toThrow('invalid-model-output')
    }
    expect(() => structuredCandidates({ useful: true }, claim, evidence)).toThrow('invalid-model-output')
  })
  it('redacts individual JSON strings without corrupting the surrounding fields', () => {
    expect(redactMemoryJson({ secret: 'token=private', safe: 'Short opening', nested: ['password=private'] })).toEqual({ secret: 'token=[REDACTED]', safe: 'Short opening', nested: ['password=[REDACTED]'] })
  })
  it('reads an old result only with its explicitly recorded output version', () => {
    const { rolloutSummary: _summary,rolloutSlug: _slug,...legacy } = output
    expect(() => structuredCandidates(legacy,claim,evidence)).toThrow('invalid-model-output')
    const prior = structuredCandidates(legacy,claim,evidence,1)[0]!
    expect(prior.rolloutSummary).toBe(prior.rawMemory)
  })
})

/** External-context policy uses the ordinary audited extraction pipeline. */
import { Context } from '@deepseek-ai/cordis'
import { CallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { DEFAULT_MEMORY_RUNTIME_SETTINGS } from '@deepseek-ai/dsh-memory'
import { MemoryClaimToken, MemorySourceRangeId, Phase1JobId, type Phase1Claim } from '@deepseek-ai/dsh-memory-pipeline-store'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { Config } from '../src/index.ts'
import { projectEvidence, runPhase1 } from '../src/phase1.ts'

const claim: Phase1Claim = {
  jobId: Phase1JobId('mixed-job'), sourceRangeId: MemorySourceRangeId('mixed-source'), sessionId: SessionId('mixed-session'),
  fromSeq: 0, toSeq: 4, inputFingerprint: 'mixed-input',
  lease: { ownerToken: MemoryClaimToken('owner'), leasedUntil: Date.now() + 60_000, attempt: 1 },
}
const callId = CallId('external-call')
const events: SessionEvent[] = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 2, surfaceOp: 'append', data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'For future replies use a brief sign-off. token=private-value' }] }) },
  { type: 'tool/call', seq: 2, time: 3, data: { turn: 1, step: 1, callId, name: 'web_search', arguments: '{}' } },
  { type: 'tool/result', seq: 3, time: 4, surfaceOp: 'append', data: { turn: 1, step: 1, message: createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: 'Quoted article: I prefer long greetings.' }] }) } },
  { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
]

describe('external context admission', () => {
  it('defaults to admitting mixed ranges without changing evidence authority', () => {
    expect(Config({ extractionProvider: 'test', extractionModel: 'test', consolidationProvider: 'test', consolidationModel: 'test' }).disableOnExternalContext).toBe(false)
    expect(DEFAULT_MEMORY_RUNTIME_SETTINGS.disableOnExternalContext).toBe(false)
    const evidence = projectEvidence(claim, events, 10_000, ['web'])
    expect(evidence).toHaveLength(2)
    expect(evidence[0]).toMatchObject({ kind: 'user', sourceEventSeqs: [1], trust: 'eligible-local-untrusted' })
    expect(evidence[0]?.text).toContain('token=[REDACTED]')
    expect(evidence[1]).toMatchObject({ kind: 'tool-result', sourceEventSeqs: [2, 3], trust: 'external-untrusted' })
  })

  it.each([false, true])('applies the explicit guard before dispatch when enabled=%s', async (disableOnExternalContext) => {
    const ctx = new Context()
    const order: string[] = []
    const prepareCall = vi.fn(async () => ({
      exactRequest: { model: 'test' },
      dispatch: async () => { order.push('dispatch'); return { value: { useful: false, tasks: [], rolloutSummary: '', rolloutSlug: '' }, finishReason: 'completed', error: null, usage: null } },
      dispose: async () => {},
    }))
    ctx.provide('memoryPipelineStore', {
      beginPhase1Attempt: async () => ({ attemptId: 'attempt' }),
      recordPhase1Request: async () => { order.push('request') },
      recordPhase1Result: async () => { order.push('result') },
    })
    ctx.provide('codexStructuredRunner', { prepareCall })
    try {
      await runPhase1(ctx, claim, events, {
        backend: 'codex', model: 'test', provider: 'test', reasoningEffort: 'high', maxTokens: 100,
        maxEvidenceBytes: 10_000, maxResultBytes: 10_000, maxCandidates: 10,
        disableOnExternalContext, externalToolPrefixes: ['web'], policyVersion: 7,
      }, new AbortController().signal)
      expect(prepareCall).toHaveBeenCalledTimes(disableOnExternalContext ? 0 : 1)
      expect(order).toEqual(disableOnExternalContext ? [] : ['request', 'dispatch', 'result'])
    } finally { await ctx.fiber.dispose() }
  })
})

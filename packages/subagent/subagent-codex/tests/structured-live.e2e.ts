/** Explicitly authorized account-backed smoke; no private user evidence. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { CodexStructuredProvider } from '../src/structured.ts'

describe.skipIf(process.env.DSH_CODEX_MEMORY_E2E !== '1')('account-backed structured Codex', () => {
  it.each(['high', 'max'])('returns zero-tool JSON using per-call %s', async (effort) => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(CodexStructuredProvider, { env: {}, disposeGraceMs: 3000, spawn: spec => ctx.subprocess.spawn(spec) })
    try {
      const call = await ctx.codexStructuredRunner.prepareCall({
        purpose: 'memory-phase1', model: 'gpt-5.6-sol', reasoningEffort: effort,
        prompt: 'The evidence is empty. Return useful=false. Do not call tools.',
        maxResultBytes: 4096, outputSchema: { type: 'object', properties: { useful: { type: 'boolean' } }, required: ['useful'], additionalProperties: false },
      }, AbortSignal.timeout(120_000))
      try {
        const result = await call.dispatch(AbortSignal.timeout(120_000))
        expect(result).toMatchObject({ finishReason: 'completed', value: { useful: false } })
      } finally { await call.dispose() }
    } finally { await ctx.fiber.dispose() }
  }, 150_000)
})

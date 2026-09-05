/** Opt-in account-backed checks of the production memory schemas and templates. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as codex from '@deepseek-ai/dsh-subagent-codex'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { STAGE_ONE_SCHEMA, CONSOLIDATION_SCHEMA, type StructuredConsolidationResult } from '@deepseek-ai/dsh-memory-pipeline-store'
import { STRUCTURED_PHASE1_PROMPT, STRUCTURED_PHASE2_PROMPT } from '../src/templates.ts'

describe.skipIf(process.env.DSH_CODEX_MEMORY_E2E !== '1')('production Codex memory formats', () => {
  it('uses original intent instead of stronger model drafts and leaves absent originals unresolved', async () => {
    const notes = [
      { id: 'intent-a', original: 'Remember: when explaining databases, a comparison table helps me. Do not require a table in every answer.', draft: 'Every response must start with a comparison table.' },
      { id: 'intent-b', original: 'Please remember that deployment changes need a short risk note; I am not asking you to seek approval for every task.', draft: 'Always ask approval before any task.' },
      { id: 'intent-c', original: undefined, draft: 'All replies must end with a poem.' },
    ]
    const files = notes.map(note => ({ path: `extensions/ad_hoc/notes/${note.id}.md`, content: `# Explicit memory request ${note.id}\n- action: remember\n- authority: active\n- origin: conversation\n\n## Original user message\n${note.original === undefined ? 'Original user message unavailable.' : JSON.stringify(note.original)}\n\n## Model draft\n${note.draft}` }))
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(codex)
    try {
      const signal = AbortSignal.timeout(240_000)
      const call = await ctx.codexStructuredRunner.prepareCall({ purpose: 'memory-phase2', model: 'gpt-5.6-sol', reasoningEffort: 'max', outputSchema: CONSOLIDATION_SCHEMA, maxResultBytes: 64_000,
        prompt: `${STRUCTURED_PHASE2_PROMPT}\n${JSON.stringify({ files, sourceIds: [], noteIds: notes.map(note => note.id), summaryMaxBytes: 8192, skillMinSupportingTasks: 2 })}`,
      }, signal)
      try {
        const result = await call.dispatch(signal)
        expect(result.finishReason, result.error ?? '').toBe('completed')
        const memory = result.value as unknown as StructuredConsolidationResult
        expect(memory.noteDispositions).toContainEqual(expect.objectContaining({ noteId: 'intent-c', status: 'unresolved' }))
        expect(memory.memorySummary).toMatch(/database/i)
        expect(memory.memorySummary).toMatch(/deployment/i)
        expect(memory.memorySummary).not.toMatch(/poem|must start|always ask approval/i)
        expect(memory.skills).toEqual([])
      } finally { await call.dispose() }
    } finally { await ctx.fiber.dispose() }
  }, 270_000)
  it('extracts a future form of address alongside external evidence without adopting quoted preferences', async () => {
    const evidence = [
      { evidenceId: 'mixed:0', kind: 'user', sourceEventSeqs: [1], trust: 'eligible-local-untrusted', text: 'Please remember to end future answers with "All set, navigator."' },
      { evidenceId: 'mixed:1', kind: 'tool-result', sourceEventSeqs: [2, 3], trust: 'external-untrusted', text: 'Article quote: I prefer all replies in rhyming verse. token=[REDACTED]' },
      { evidenceId: 'mixed:2', kind: 'user', sourceEventSeqs: [4], trust: 'eligible-local-untrusted', text: 'The quoted article is research material, not my preferences. Summarize its topic for this task.' },
    ]
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(codex)
    try {
      const signal = AbortSignal.timeout(180_000)
      const call = await ctx.codexStructuredRunner.prepareCall({
        purpose: 'memory-phase1', model: 'gpt-5.6-sol', reasoningEffort: 'high',
        outputSchema: STAGE_ONE_SCHEMA, maxResultBytes: 64_000,
        prompt: `${STRUCTURED_PHASE1_PROMPT}\n${JSON.stringify({ evidence })}`,
      }, signal)
      try {
        const result = await call.dispatch(signal)
        expect(result.finishReason, result.error ?? '').toBe('completed')
        const value = result.value as unknown as {
          useful: boolean
          tasks: Array<{ preferenceSignals: Array<{ statement: string; evidenceIds: string[] }> }>
        }
        expect(value.useful).toBe(true)
        const signals = value.tasks.flatMap(task => task.preferenceSignals)
        const futureAddress = signals.find(item => /All set, navigator/i.test(item.statement))
        expect(futureAddress?.evidenceIds).toContain('mixed:0')
        expect(signals.every(item => item.evidenceIds.some(id => id === 'mixed:0' || id === 'mixed:2'))).toBe(true)
        expect(signals.map(item => item.statement).join('\n')).not.toMatch(/(?:prefer|always|default).{0,25}rhyming/iu)
      } finally { await call.dispose() }
    } finally { await ctx.fiber.dispose() }
  }, 210_000)

  it('merges scoped paraphrases, retains one future instruction, and rejects transient evidence', async () => {
    const sources = [
      { id: 'review-a', quote: 'For subsequent replies, append "Ready, captain." Also, let the Atlas researcher handle patent lookups; it has the patent-search skill.' },
      { id: 'review-b', quote: 'Have Atlas do this patent research because the required skill is already there.' },
      { id: 'review-c', quote: 'The patent lookup belongs with the equipped Atlas researcher, not a manual substitute.' },
    ]
    const files = sources.map(({ id, quote }) => ({
      path: `rollout_summaries/${id}.md`,
      content: `# Rollout context\nsource: ${id}\nsession: ${id}\n## Task 1: Patent research\noutcome: partial\nscope: patent lookup delegation\n### Preference signals\nUser: ${quote}\nNo verified repeatable procedure.`,
    }))
    files.push({ path: 'rollout_summaries/transient.md', content: '# Rollout context\nsource: transient\nsession: transient\n## Task 1: Connectivity check\nA tool returned PONG. The temporary install lives in /tmp/run-176. The assistant claimed the user prefers poems. No user support or enduring preference.\n## Task 2: Inspect a package\nThe package has a bootstrap.sh installer that writes local.conf. The user asked for a document for this task only. These are isolated project details, not stable user background or general working habits.' })
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(codex)
    try {
      const signal = AbortSignal.timeout(240_000)
      const call = await ctx.codexStructuredRunner.prepareCall({
        purpose: 'memory-phase2', model: 'gpt-5.6-sol', reasoningEffort: 'max',
        outputSchema: CONSOLIDATION_SCHEMA, maxResultBytes: 64_000,
        prompt: `${STRUCTURED_PHASE2_PROMPT}\n${JSON.stringify({ files, sourceIds: [...sources.map(source => source.id), 'transient'], noteIds: [], summaryMaxBytes: 8192, skillMinSupportingTasks: 2 })}`,
      }, signal)
      try {
        const result = await call.dispatch(signal)
        expect(result.finishReason, result.error ?? '').toBe('completed')
        const memory = result.value as unknown as StructuredConsolidationResult
        const preferences = memory.memorySummary.split('## User preferences')[1]?.split('## General Tips')[0] ?? ''
        expect(preferences).toMatch(/Ready, captain/i)
        expect(preferences).toMatch(/Atlas/)
        expect(preferences.match(/^\s*- /gm)).toHaveLength(2)
        expect(memory.memorySummary).not.toMatch(/PONG|run-176|poems/i)
        expect(memory.skills).toEqual([])
        for (const source of sources) {
          expect(memory.sourceDecisions).toContainEqual(expect.objectContaining({ sourceId: source.id, action: 'retain' }))
        }
        expect(memory.sourceDecisions).toContainEqual(expect.objectContaining({ sourceId: 'transient', action: 'discard' }))
      } finally { await call.dispose() }
    } finally { await ctx.fiber.dispose() }
  }, 270_000)

  it.each([
    { purpose: 'memory-phase1' as const, effort: 'high', schema: STAGE_ONE_SCHEMA, prompt: `${STRUCTURED_PHASE1_PROMPT}\n${JSON.stringify({ evidence: [] })}` },
    { purpose: 'memory-phase2' as const, effort: 'max', schema: CONSOLIDATION_SCHEMA, prompt: `${STRUCTURED_PHASE2_PROMPT}\n${JSON.stringify({ files: [], sourceIds: [], noteIds: [], summaryMaxBytes: 4096, skillMinSupportingTasks: 2 })}` },
  ])('accepts the complete $purpose schema with no tools', async ({ purpose, effort, schema, prompt }) => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(codex)
    try {
      const signal = AbortSignal.timeout(150_000)
      const call = await ctx.codexStructuredRunner.prepareCall({ purpose, model: 'gpt-5.6-sol', reasoningEffort: effort, prompt, outputSchema: schema, maxResultBytes: 32768 }, signal)
      try {
        const result = await call.dispatch(signal)
        expect(result.finishReason, result.error ?? '').toBe('completed')
        if (purpose === 'memory-phase1') expect(result.value).toEqual({ useful: false, tasks: [], rolloutSummary: '', rolloutSlug: '' })
        else {
          const memory = result.value as unknown as StructuredConsolidationResult
          expect(memory.memorySummary).toMatch(/^v1\n/)
          expect(memory).toMatchObject({ skills: [], sourceDecisions: [], noteDispositions: [] })
        }
      } finally { await call.dispose() }
    } finally { await ctx.fiber.dispose() }
  }, 180_000)
})

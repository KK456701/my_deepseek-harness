/** Publish one real local-memory generation before the snapshot agent runs. */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import {
  MemoryCandidateId,
  MemoryEvidenceId,
  MemorySourceRangeId,
} from '@deepseek-ai/dsh-memory-pipeline-store'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MEMORY_POLICY_VERSION } from '@deepseek-ai/dsh-memory'

export const name = 'memory-snapshot-seed'
export const inject = ['memoryPipelineStore', 'memory', 'sessions']

/** Seed a source, consolidate it into the file workspace, and publish it. */
export async function apply(ctx: Context): Promise<void> {
  await ctx.memoryPipelineStore.registerSourceRanges([{
    sourceRangeId: MemorySourceRangeId('snapshot-source'),
    sessionId: SessionId('snapshot-source-session'),
    fromSeq: 0,
    toSeq: 2,
    completedAt: Date.now(),
    sessionPurpose: 'interactive',
    policyVersion: MEMORY_POLICY_VERSION,
  }])
  const phase1 = await ctx.memoryPipelineStore.claimPhase1({ now: Date.now(), leaseMs: 60_000, maxAttempts: 1 })
  if (phase1 === undefined) throw new Error('memory snapshot seed could not claim Phase 1')
  const attempt = await ctx.memoryPipelineStore.beginPhase1Attempt(phase1)
  await ctx.memoryPipelineStore.recordPhase1Request({
    attemptId: attempt.attemptId,
    requestFingerprint: 'memory-snapshot-request',
    request: { fixture: true },
    bytes: 16,
    recordedAt: Date.now(),
  })
  await ctx.memoryPipelineStore.recordPhase1Result({
    attemptId: attempt.attemptId,
    result: { fixture: true },
    bytes: 16,
    chunkCount: 1,
    termination: 'complete',
    recordedAt: Date.now(),
  })
  await ctx.memoryPipelineStore.commitPhase1Outcome(phase1, {
    kind: 'applied',
    candidates: [{
      candidateId: MemoryCandidateId(`${phase1.jobId}:0`),
      rawMemory: '# Rollout context\nsource: snapshot-source\n\n## Task 1: Publish memory\noutcome: success\nscope: memory pipeline\n\n### Reusable knowledge\nMemory generations are immutable and published through a fenced pointer.\n',
      rolloutSummary: 'Published one immutable memory generation through the fenced pointer.',
      rolloutSlug: 'snapshot-source',
      evidenceIds: [MemoryEvidenceId('snapshot-evidence-0')],
    }],
  })

  const phase2 = await ctx.memoryPipelineStore.claimPhase2({
    now: Date.now(),
    leaseMs: 120_000,
    maxSources: 8,
    maxAttempts: 1,
    maxUnusedDays: 30,
  })
  if (phase2 === undefined) throw new Error('memory snapshot seed could not claim Phase 2')
  const workspace = await ctx.memoryPipelineStore.createPhase2Workspace(phase2)
  const binding = await ctx.memoryPipelineStore.openMaintenanceSession(phase2)
  const transcript = await ctx.plugin(Object.assign((inner: Context) => {
    const session = inner.sessions.create(binding.sessionId, { meta: { purpose: 'maintenance', cwd: workspace.stagingRoot } })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { header: { config: { provider: 'snapshot', model: 'snapshot' } }, reason: 'initial' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '{"noteDispositions":[]}' }],
        source: { provider: 'snapshot', model: 'snapshot' },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }, { inject: ['sessions'] }))
  await binding.persistence.flush()
  await transcript.dispose()
  await binding.persistence.flush()
  await writeFile(join(workspace.stagingRoot, 'memory_summary.md'), 'v1\n## User Profile\n\n## User preferences\n\n## General Tips\n- [Use immutable memory generations](MEMORY.md) for crash-safe publication.\n\n## What\'s in Memory\n- [Memory publication](MEMORY.md)\n')
  await writeFile(join(workspace.stagingRoot, 'MEMORY.md'), '# Memory\n\n# Task Group: Memory publication\nscope: memory pipeline\napplies_to: immutable generation publication\n\n## Task 1: Publish a generation\n### rollout_summary_files\n- [Snapshot source](rollout_summaries/snapshot-source.md)\n\n### keywords\n- immutable generation, fenced pointer\n\n### Reusable knowledge\n- Publish an immutable generation through its fenced pointer.\n')
  const materializing = await ctx.memoryPipelineStore.allocateGeneration(phase2)
  const prepared = await ctx.memoryPipelineStore.validateAndPrepareGeneration({
    claim: phase2,
    workspace,
    materializing,
    maintenanceSessionId: binding.sessionId,
  })
  await ctx.memoryPipelineStore.publishGeneration({ claim: phase2, prepared })
  const page = await ctx.memory.listMemoryItems({})
  await writeFile(join(process.cwd(), 'memory-items.actual.json'), JSON.stringify({ items: page.items.length, sourceUsage: page.sourceUsage }))
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { BlockAssembler, CallId, createAssistantMessage, createToolResultMessage, createUserMessage, LlmAdapter, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { DEFAULT_MEMORY_RUNTIME_SETTINGS, type MemoryRuntimeSettings, type MemoryRuntimeSettingsValues } from '@deepseek-ai/dsh-memory'
import MemoryPipelineStore, {
  MemoryAttemptId,
  MemoryClaimToken,
  MemorySourceRangeId,
  Phase1JobId,
  type MaterializingGeneration,
  type MaintenanceSessionBinding,
  type MemoryFailureDisposition,
  type MemoryFailureRecord,
  type MemoryLease,
  type MemoryPruneRequest,
  type MemoryPruneResult,
  type MemoryRecoveryResult,
  type Phase1Attempt,
  type Phase1Claim,
  type Phase1ClaimRequest,
  type Phase1Outcome,
  type Phase2Claim,
  type Phase2ClaimRequest,
  type Phase2Workspace,
  type PrepareGenerationRequest,
  type PreparedGeneration,
  type PublishGenerationRequest,
  type PublishedGeneration,
  type RecordedPhase1Request,
  type RecordedPhase1Result,
  type RegisterSourceRange,
  type RegisterSourceRangeResult,
  type RenewMemoryLeaseRequest,
} from '@deepseek-ai/dsh-memory-pipeline-store'
import { SessionId, SessionStore, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import SessionPersistence, { SessionPersistenceRevision, type SessionInspection, type SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as memoryLocal from '@deepseek-ai/dsh-memory-local'
import MemoryScheduler, { classifyMemoryFailure, rolloutRange } from '../src/index.ts'
import { parsePhase1Candidates, projectEvidence } from '../src/phase1.ts'

const now = Date.now()
const sessionId = SessionId('memory-source')
const rangeId = MemorySourceRangeId(createHash('sha256').update([sessionId, 0, 3, DEFAULT_MEMORY_RUNTIME_SETTINGS.policyVersion].join('\0')).digest('hex'))

const header: SessionHeader = { version: 0, id: sessionId, createdAt: now - 20_000, purpose: 'interactive' }
const events: SessionEvent[] = [
  { type: 'turn/start', seq: 0, time: now - 10_000, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: now - 9_000, data: createUserMessage({ content: [{ type: 'text', text: 'Remember that memory generations are immutable and use a fenced publication pointer.' }], source: { kind: 'user' } }), surfaceOp: 'append' },
  { type: 'assistant/message', seq: 2, time: now - 8_000, data: { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: 'Generations are immutable.' }], source: { provider: 'test', model: 'test' } }) }, surfaceOp: 'append' },
  { type: 'turn/end', seq: 3, time: now - 7_000, data: { turn: 1, reason: { kind: 'completed' } } },
]

class TestPersistence extends SessionPersistence {
  override readonly supportsRawArtifacts = false
  readonly created: SessionHeader[] = []
  listSnapshotsCalls = 0
  locate(): undefined { return undefined }
  create(meta: SessionHeader): Promise<void> { this.created.push(meta); return Promise.resolve() }
  append(): Promise<void> { return Promise.resolve() }
  load(): Promise<SessionInspection> { return Promise.resolve({ meta: header, events }) }
  inspect(): Promise<SessionInspection> { return Promise.resolve({ meta: header, events }) }
  readFrom(): Promise<{ meta: SessionHeader; events: SessionEvent[] }> { return Promise.resolve({ meta: header, events }) }
  list(): Promise<SessionHeader[]> { return Promise.resolve([header]) }
  listSnapshots(): Promise<SessionPersistenceSnapshot[]> {
    this.listSnapshotsCalls += 1
    return Promise.resolve([{ header, revision: SessionPersistenceRevision('test:1') }])
  }
}

class RecordingAdapter extends LlmAdapter {
  constructor(private readonly order: string[]) { super() }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.order.push('dispatch')
    const args = JSON.stringify({
      useful: true,
      rawMemory: '# Rollout context\n\n## Task 1: Publish memory\noutcome: success\nscope: memory pipeline\n\n### Reusable knowledge\nUse immutable generations.\n',
      rolloutSummary: 'Use immutable generations for publication.',
      rolloutSlug: 'immutable-generations',
      evidenceIds: [`${rangeId}:0`],
    })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: CallId('memory-call'), name: 'submit_memory_rollout', argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('memory-call'), name: 'submit_memory_rollout', arguments: args } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

class OverflowAdapter extends LlmAdapter {
  constructor(private readonly order: string[]) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.order.push('dispatch')
    try {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'x'.repeat(2_048) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      this.order.push(options.signal?.aborted === true ? 'aborted' : 'closed')
    }
  }
}

function callChunks(calls: readonly { id: string; name: string; args: object }[]): StreamChunk[] {
  const chunks: StreamChunk[] = []
  calls.forEach((call, index) => {
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'block-end', index, block: { type: 'tool-call', id: CallId(call.id), name: call.name, arguments: JSON.stringify(call.args) } },
    )
  })
  chunks.push({ type: 'finish', reason: { kind: 'tool-calls' } })
  return chunks
}

class PipelineAdapter extends LlmAdapter {
  private consolidationCalls = 0

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose === 'memory-extraction') {
      const args = JSON.stringify({
        useful: true,
        rawMemory: '# Rollout context\n\n## Task 1: Publish memory\noutcome: success\nscope: memory pipeline\n\n### Reusable knowledge\nUse immutable memory generations.\n',
        rolloutSummary: 'Use immutable memory generations for publication.',
        rolloutSlug: 'immutable-generations',
        evidenceIds: [`${rangeId}:0`],
      })
      yield* [
        { type: 'block-start', index: 0, blockType: 'tool-call' } as const,
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('extract'), name: 'submit_memory_rollout', arguments: args } } as const,
        { type: 'finish', reason: { kind: 'tool-calls' } } as const,
      ]
      return
    }
    this.consolidationCalls += 1
    if (this.consolidationCalls === 1) {
      yield* callChunks([
        { id: 'summary', name: 'write', args: { file_path: 'memory_summary.md', content: 'v1\n## User Profile\n\n## User preferences\n\n## General Tips\n- [Immutable generations](MEMORY.md)\n\n## What\'s in Memory\n- [Memory publication](MEMORY.md)\n' } },
        { id: 'catalog', name: 'write', args: { file_path: 'MEMORY.md', content: `# Memory\n\n# Task Group: Memory publication\nscope: test\napplies_to: scheduler integration\n\n## Task 1: publish a generation\n\n### rollout_summary_files\n- [Generation decision](rollout_summaries/${rangeId}.md)\n\n### keywords\n- generation, publication\n` } },
      ])
      return
    }
    yield* [
      { type: 'block-start', index: 0, blockType: 'text' } as const,
      { type: 'block-end', index: 0, block: { type: 'text', text: '{"noteDispositions":[]}' } } as const,
      { type: 'finish', reason: { kind: 'stop' } } as const,
    ]
  }
}

class HangingConsolidationAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose === 'memory-extraction') {
      const args = JSON.stringify({
        useful: true,
        rawMemory: '# Rollout context\n\n## Task 1: Publish memory\noutcome: success\nscope: memory pipeline\n\n### Reusable knowledge\nUse immutable memory generations.\n',
        rolloutSummary: 'Use immutable memory generations for publication.',
        rolloutSlug: 'immutable-generations',
        evidenceIds: [`${rangeId}:0`],
      })
      yield* callChunks([{ id: 'extract-hanging', name: 'submit_memory_rollout', args: JSON.parse(args) as object }])
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted === true) resolve()
      else options.signal?.addEventListener('abort', () => { resolve() }, { once: true })
    })
  }
}

class FakeStore extends MemoryPipelineStore {
  readonly order: string[] = []
  pruneCalls = 0
  private claim: Phase1Claim | undefined
  private settings: MemoryRuntimeSettings = { revision: 0, ...DEFAULT_MEMORY_RUNTIME_SETTINGS }
  override initializeRuntimeSettings(defaults: MemoryRuntimeSettingsValues): Promise<MemoryRuntimeSettings> {
    this.settings = { revision: 0, ...defaults }
    return Promise.resolve(this.settings)
  }
  override getRuntimeSettings(): Promise<MemoryRuntimeSettings> { return Promise.resolve(this.settings) }
  setRuntimeSettings(patch: Partial<MemoryRuntimeSettingsValues>): void {
    this.settings = { ...this.settings, ...patch, revision: this.settings.revision + 1 }
  }
  override recover(): Promise<MemoryRecoveryResult> {
    return Promise.resolve({
      recoveredJobs: 0,
      finalizedGenerations: 0,
      discardedStagingDirectories: 0,
      workAvailable: true,
    })
  }
  override getActiveCleanRebuild(): Promise<undefined> { return Promise.resolve(undefined) }
  override reportCleanRebuildDiscovery(): Promise<void> { return Promise.resolve() }
  override registerSourceRanges(ranges: readonly RegisterSourceRange[]): Promise<RegisterSourceRangeResult> {
    const range = ranges[0]
    if (range === undefined) return Promise.resolve({ inserted: 0, existing: 0 })
    this.claim = { jobId: Phase1JobId(range.sourceRangeId), sourceRangeId: range.sourceRangeId, sessionId: range.sessionId, fromSeq: range.fromSeq, toSeq: range.toSeq, inputFingerprint: 'fingerprint', lease: { ownerToken: MemoryClaimToken('owner'), leasedUntil: Date.now() + 60_000, attempt: 1 } }
    return Promise.resolve({ inserted: 1, existing: 0 })
  }
  override claimPhase1(_request: Phase1ClaimRequest): Promise<Phase1Claim | undefined> {
    const claim = this.claim
    this.claim = undefined
    return Promise.resolve(claim)
  }
  override beginPhase1Attempt(claim: Phase1Claim): Promise<Phase1Attempt> { return Promise.resolve({ attemptId: MemoryAttemptId('attempt'), jobId: claim.jobId, lease: claim.lease }) }
  override recordPhase1Request(_request: RecordedPhase1Request): Promise<void> { this.order.push('request'); return Promise.resolve() }
  override recordPhase1Result(_result: RecordedPhase1Result): Promise<void> { this.order.push('result'); return Promise.resolve() }
  override commitPhase1Outcome(_claim: Phase1Claim, outcome: Phase1Outcome): Promise<void> { this.order.push(`commit:${outcome.kind}`); return Promise.resolve() }
  override claimPhase2(_request: Phase2ClaimRequest): Promise<Phase2Claim | undefined> { return Promise.resolve(undefined) }
  override createPhase2Workspace(): Promise<Phase2Workspace> { return Promise.reject(new Error('not used')) }
  override readConsolidationInput(): never { throw new Error('not used') }
  override recordPhase2Request(): never { throw new Error('not used') }
  override recordPhase2Result(): never { throw new Error('not used') }
  override applyConsolidationResult(): never { throw new Error('not used') }
  override openMaintenanceSession(): Promise<MaintenanceSessionBinding> { return Promise.reject(new Error('not used')) }
  override allocateGeneration(): Promise<MaterializingGeneration> { return Promise.reject(new Error('not used')) }
  override validateAndPrepareGeneration(_request: PrepareGenerationRequest): Promise<PreparedGeneration> { return Promise.reject(new Error('not used')) }
  override publishGeneration(_request: PublishGenerationRequest): Promise<PublishedGeneration> { return Promise.reject(new Error('not used')) }
  override renewLease(_request: RenewMemoryLeaseRequest): Promise<MemoryLease> { return Promise.resolve({ ownerToken: MemoryClaimToken('owner'), leasedUntil: Date.now() + 60_000, attempt: 1 }) }
  override recordFailure(request: MemoryFailureRecord): Promise<MemoryFailureDisposition> {
    this.order.push(`failure:${request.category}`)
    return Promise.resolve({ kind: 'quarantined', quarantineId: 'q' as never })
  }
  override prune(_request: MemoryPruneRequest): Promise<MemoryPruneResult> {
    this.pruneCalls += 1
    return Promise.resolve({ auditAttempts: 0, sourceSnapshots: 0, generations: 0, bytes: 0 })
  }
}

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('memory scheduler', () => {
  it('runs two frozen sources concurrently and waits for a failed peer before consolidation', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('workspaceRegistry', { archivedSessionIds: [] } as never)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 10 })
    await ctx.plugin(TestPersistence)
    await ctx.plugin(FakeStore)
    const store = ctx.memoryPipelineStore as FakeStore
    vi.spyOn(ctx.sessionPersistence, 'inspect').mockImplementation(async id => ({ meta: { ...header,id },events }))
    const jobs = ['parallel-a','parallel-b'].map(id => ({
      jobId: Phase1JobId(id),sourceRangeId: MemorySourceRangeId(id),sessionId: SessionId(id),
      fromSeq: 0,toSeq: 3,inputFingerprint: id,
      lease: { ownerToken: MemoryClaimToken(id),leasedUntil: Date.now()+60_000,attempt: 1 },
    }))
    vi.spyOn(store,'claimPhase1').mockImplementation(async () => jobs.shift())
    const phase2 = vi.spyOn(store,'claimPhase2')
    let entered = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {release=resolve})
    class ParallelAdapter extends LlmAdapter {
      async * stream(): AsyncIterable<StreamChunk> {
        const owner = ++entered
        if (entered === 2) release()
        await barrier
        expect(phase2).not.toHaveBeenCalled()
        if (owner === 1) throw new Error('one provider call failed')
        yield* callChunks([{ id: 'empty',name: 'submit_memory_rollout',args: { useful: false,rawMemory: '',rolloutSummary: '',rolloutSlug: '',evidenceIds: [] } }])
      }
    }
    ctx.llm.registerAdapter(['test'],new ParallelAdapter())
    await ctx.plugin(MemoryScheduler, {
      extractionProvider: 'test',extractionModel: 'test',consolidationProvider: 'test',consolidationModel: 'test',enabled: true,
      maxPhase1ClaimsPerRun: 2,phase1Concurrency: 2,providerTimeoutMs: 3000,
    })
    const result = await ctx.memoryMaintenance.runDue(new AbortController().signal)
    expect(entered).toBe(2)
    expect(result).toMatchObject({ phase1Completed: 1,quarantined: 1 })
    expect(phase2).toHaveBeenCalledOnce()
    expect(store.order).toContain('commit:empty')
  })

  it('extracts one complete multi-turn Session rollout without a character threshold', () => {
    const shortEvents: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: createUserMessage({ content: [{ type: 'text', text: '记住这个' }], source: { kind: 'user' } }), surfaceOp: 'append' },
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 3, time: 4, data: { turn: 2 } },
      { type: 'user/message', seq: 4, time: 5, data: createUserMessage({ content: [{ type: 'text', text: '还是这样' }], source: { kind: 'user' } }), surfaceOp: 'append' },
      { type: 'turn/end', seq: 5, time: 6, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    expect(rolloutRange(shortEvents, 0)).toEqual({ fromSeq: 0, toSeq: 5, completedAt: 6 })
    expect(rolloutRange(shortEvents, 0, 4)).toEqual({ fromSeq: 3, toSeq: 5, completedAt: 6 })
    expect(rolloutRange(shortEvents, 0, 7)).toBeUndefined()
  })

  it('normalizes a useful=false explanation to an empty successful result', () => {
    const assembler = new BlockAssembler()
    for (const chunk of callChunks([{
      id: 'no-op',
      name: 'submit_memory_rollout',
      args: {
        useful: false,
        rawMemory: '',
        rolloutSummary: 'One-off connectivity check with no durable value.',
        rolloutSlug: 'connectivity-check',
        evidenceIds: [`${rangeId}:0`],
      },
    }])) assembler.push(chunk)
    expect(parsePhase1Candidates({
      jobId: Phase1JobId('no-op-job'),
      sourceRangeId: rangeId,
      sessionId,
      fromSeq: 0,
      toSeq: 3,
      inputFingerprint: 'no-op',
      lease: { ownerToken: MemoryClaimToken('no-op-owner'), leasedUntil: Date.now() + 60_000, attempt: 1 },
    }, assembler.blocks(), new Set([`${rangeId}:0`]))).toEqual([])
  })

  it('classifies a token-limited consolidation as output budget exhaustion', () => {
    expect(classifyMemoryFailure(new Error('output-budget-exhausted: Phase 2 reached max-tokens at 32768 tokens')))
      .toBe('output-budget-exhausted')
  })

  it('classifies generation source-link rejection as validation', () => {
    expect(classifyMemoryFailure(new Error('every memory_summary.md list item must contain a source link')))
      .toBe('validation')
  })

  it('classifies an invalid Phase 2 disposition as model output rejection', () => {
    expect(classifyMemoryFailure(new Error('Phase 2 note dispositions are not valid JSON')))
      .toBe('invalid-model-output')
  })

  it('projects only effective paired tool evidence and retains both source sequences', () => {
    const toolCallId = CallId('paired-tool')
    const claim: Phase1Claim = {
      jobId: Phase1JobId('projection-job'), sourceRangeId: MemorySourceRangeId('projection-range'), sessionId,
      fromSeq: 0, toSeq: 4, inputFingerprint: 'projection',
      lease: { ownerToken: MemoryClaimToken('projection-owner'), leasedUntil: Date.now() + 60_000, attempt: 1 },
    }
    const projected = projectEvidence(claim, [
      { type: 'turn/start', seq: 0, time: now, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: now, data: createUserMessage({ content: [{ type: 'text', text: 'Inspect it.' }], source: { kind: 'user' } }), surfaceOp: 'append' },
      { type: 'tool/call', seq: 2, time: now, data: { turn: 1, step: 1, callId: toolCallId, name: 'read', arguments: '{"file_path":"notes.md"}' } },
      { type: 'tool/result', seq: 3, time: now, data: { turn: 1, step: 1, message: createToolResultMessage({ callId: toolCallId, content: [{ type: 'text', text: 'generation=immutable' }], isError: false }) }, surfaceOp: 'append' },
      { type: 'turn/end', seq: 4, time: now, data: { turn: 1, reason: { kind: 'completed' } } },
    ], 64_000, ['web'])

    expect(projected).toEqual([
      expect.objectContaining({ kind: 'user', sourceEventSeqs: [1], text: 'Inspect it.' }),
      expect.objectContaining({ kind: 'tool-result', sourceEventSeqs: [2, 3] }),
    ])
    expect(projected[1]?.text).toContain('generation=immutable')
  })

  it('records the request before dispatch and the result before candidate apply', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { archivedSessionIds: [] } as never)
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 10 })
    await ctx.plugin(TestPersistence)
    await ctx.plugin(FakeStore)
    const store = ctx.memoryPipelineStore as FakeStore
    ctx.llm.registerAdapter(['test'], new RecordingAdapter(store.order))
    await ctx.plugin(MemoryScheduler, {
      extractionProvider: 'test', extractionModel: 'test', consolidationProvider: 'test', consolidationModel: 'test', enabled: true,
      idleMs: 60_000, maxSourceAgeMs: 60_000, scanSessionsPerRun: 1, maxRangesPerRun: 1, maxPhase1ClaimsPerRun: 1,
      phase1LeaseMs: 60_000, phase2LeaseMs: 60_000, providerTimeoutMs: 10_000, maxAttempts: 3, retryBaseMs: 1,
      maxCandidatesPerRange: 8, maxPhase2Sources: 8, maxEvidenceBytes: 64_000, maxResultBytes: 64_000,
      extractionMaxTokens: 1_000, consolidationMaxTokens: 1_000, phase2MaxFileBytes: 64_000,
      phase2SearchMaxFiles: 32, phase2SearchMaxMatches: 32, externalToolPrefixes: ['web'], policyVersion: DEFAULT_MEMORY_RUNTIME_SETTINGS.policyVersion,
      pruneRowsPerRun: 10, pruneBytesPerRun: 64_000, fallbackWakeMs: 60_000,
    })
    store.setRuntimeSettings({ idleMs: 1 })
    const result = await ctx.memoryMaintenance.runDue(new AbortController().signal)
    expect(result.phase1Completed).toBe(1)
    expect(store.order).toEqual(['request', 'dispatch', 'result', 'commit:applied'])
  })

  it('lets an explicit manual scan ignore the idle delay', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { archivedSessionIds: [] } as never)
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 10 })
    await ctx.plugin(TestPersistence)
    await ctx.plugin(FakeStore)
    const store = ctx.memoryPipelineStore as FakeStore
    ctx.llm.registerAdapter(['test'], new RecordingAdapter(store.order))
    await ctx.plugin(MemoryScheduler, {
      extractionProvider: 'test', extractionModel: 'test', consolidationProvider: 'test', consolidationModel: 'test', enabled: true,
      idleMs: 60_000, maxSourceAgeMs: 120_000, scanSessionsPerRun: 1, maxRangesPerRun: 1, maxPhase1ClaimsPerRun: 1,
      phase1LeaseMs: 60_000, phase2LeaseMs: 60_000, providerTimeoutMs: 10_000, maxAttempts: 3, retryBaseMs: 1,
      maxCandidatesPerRange: 8, maxPhase2Sources: 8, maxEvidenceBytes: 64_000, maxResultBytes: 64_000,
      extractionMaxTokens: 1_000, consolidationMaxTokens: 1_000, phase2MaxFileBytes: 64_000,
      phase2SearchMaxFiles: 32, phase2SearchMaxMatches: 32, externalToolPrefixes: ['web'], policyVersion: DEFAULT_MEMORY_RUNTIME_SETTINGS.policyVersion,
      pruneRowsPerRun: 10, pruneBytesPerRun: 64_000, fallbackWakeMs: 60_000,
    })
    store.setRuntimeSettings({ idleMs: 60_000, maxSourceAgeMs: 120_000 })

    ctx.memoryMaintenance.wake('manual-scan')

    await vi.waitFor(() => { expect(store.order).toEqual(['request', 'dispatch', 'result', 'commit:applied']) })
  })

  it('consolidates pending work without discovering new source ranges', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { archivedSessionIds: [] } as never)
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 10 })
    await ctx.plugin(TestPersistence)
    await ctx.plugin(FakeStore)
    const persistence = ctx.sessionPersistence as TestPersistence
    const store = ctx.memoryPipelineStore as FakeStore
    await ctx.plugin(MemoryScheduler, {
      extractionProvider: 'test', extractionModel: 'test', consolidationProvider: 'test', consolidationModel: 'test', enabled: true,
      idleMs: 60_000, maxSourceAgeMs: 120_000, scanSessionsPerRun: 1, maxRangesPerRun: 1, maxPhase1ClaimsPerRun: 1,
      phase1LeaseMs: 60_000, phase2LeaseMs: 60_000, providerTimeoutMs: 10_000, maxAttempts: 3, retryBaseMs: 1,
      maxCandidatesPerRange: 8, maxPhase2Sources: 8, maxEvidenceBytes: 64_000, maxResultBytes: 64_000,
      extractionMaxTokens: 1_000, consolidationMaxTokens: 1_000, phase2MaxFileBytes: 64_000,
      phase2SearchMaxFiles: 32, phase2SearchMaxMatches: 32, externalToolPrefixes: ['web'], policyVersion: DEFAULT_MEMORY_RUNTIME_SETTINGS.policyVersion,
      pruneRowsPerRun: 10, pruneBytesPerRun: 64_000, fallbackWakeMs: 60_000,
    })

    ctx.memoryMaintenance.wake('manual-consolidation')

    await vi.waitFor(() => { expect(store.pruneCalls).toBe(1) })
    expect(persistence.listSnapshotsCalls).toBe(0)
    expect(store.order).toEqual([])
  })

  it('keeps older turns out of normal discovery after a bounded rebuild', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { archivedSessionIds: [] } as never)
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 10 })
    await ctx.plugin(TestPersistence)
    await ctx.plugin(FakeStore)
    const recent = events.map(event => ({ ...event, seq: event.seq + 4 })) as SessionEvent[]
    const old = events.map(event => ({ ...event, time: event.time - 10 * 86_400_000 })) as SessionEvent[]
    vi.spyOn(ctx.sessionPersistence, 'inspect').mockResolvedValue({ meta: header, events: [...old, ...recent] })
    const register = vi.spyOn(ctx.memoryPipelineStore, 'registerSourceRanges')
    ctx.on('memory/quota-remaining', () => 0)
    await ctx.plugin(MemoryScheduler, {
      extractionProvider: 'test', extractionModel: 'test', consolidationProvider: 'test', consolidationModel: 'test',
      enabled: true, idleMs: 1, maxSourceAgeMs: 5 * 86_400_000,
    })

    await ctx.memoryMaintenance.runDue(new AbortController().signal)

    expect(register).toHaveBeenCalledWith([expect.objectContaining({ fromSeq: 4, toSeq: 7 })])
  })

  it('does not claim background model work below a reported remaining-quota threshold', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { archivedSessionIds: [] } as never)
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 10 })
    await ctx.plugin(TestPersistence)
    await ctx.plugin(FakeStore)
    ctx.on('memory/quota-remaining', () => 24)
    const store = ctx.memoryPipelineStore as FakeStore
    ctx.llm.registerAdapter(['test'], new RecordingAdapter(store.order))
    await ctx.plugin(MemoryScheduler, {
      extractionProvider: 'test', extractionModel: 'test', consolidationProvider: 'test', consolidationModel: 'test', enabled: true,
      idleMs: 1, maxSourceAgeMs: 60_000, scanSessionsPerRun: 1, maxRangesPerRun: 1, maxPhase1ClaimsPerRun: 1,
      phase1LeaseMs: 60_000, phase2LeaseMs: 60_000, providerTimeoutMs: 10_000, maxAttempts: 3, retryBaseMs: 1,
      maxCandidatesPerRange: 8, maxPhase2Sources: 8, maxEvidenceBytes: 64_000, maxResultBytes: 64_000,
      extractionMaxTokens: 1_000, consolidationMaxTokens: 1_000, phase2MaxFileBytes: 64_000,
      phase2SearchMaxFiles: 32, phase2SearchMaxMatches: 32, externalToolPrefixes: ['web'], policyVersion: DEFAULT_MEMORY_RUNTIME_SETTINGS.policyVersion,
      pruneRowsPerRun: 10, pruneBytesPerRun: 64_000, fallbackWakeMs: 60_000, minRemainingQuotaPercent: 25,
    })
    const result = await ctx.memoryMaintenance.runDue(new AbortController().signal)
    expect(result).toMatchObject({ discovered: 1, phase1Completed: 0, phase2Completed: 0 })
    expect(store.order).toEqual([])
  })

  it('aborts an overflowing provider stream, audits the prefix, and does not retry it', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { archivedSessionIds: [] } as never)
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 10 })
    await ctx.plugin(TestPersistence)
    await ctx.plugin(FakeStore)
    const store = ctx.memoryPipelineStore as FakeStore
    ctx.llm.registerAdapter(['overflow'], new OverflowAdapter(store.order))
    await ctx.plugin(MemoryScheduler, {
      extractionProvider: 'overflow', extractionModel: 'test', consolidationProvider: 'overflow', consolidationModel: 'test', enabled: true,
      idleMs: 1, maxSourceAgeMs: 60_000, scanSessionsPerRun: 1, maxRangesPerRun: 1, maxPhase1ClaimsPerRun: 1,
      phase1LeaseMs: 60_000, phase2LeaseMs: 60_000, providerTimeoutMs: 10_000, maxAttempts: 3, retryBaseMs: 1,
      maxCandidatesPerRange: 8, maxPhase2Sources: 8, maxEvidenceBytes: 64_000, maxResultBytes: 1_024,
      extractionMaxTokens: 1_000, consolidationMaxTokens: 1_000, phase2MaxFileBytes: 64_000,
      phase2SearchMaxFiles: 32, phase2SearchMaxMatches: 32, externalToolPrefixes: ['web'], policyVersion: DEFAULT_MEMORY_RUNTIME_SETTINGS.policyVersion,
      pruneRowsPerRun: 10, pruneBytesPerRun: 64_000, fallbackWakeMs: 60_000,
    })
    const result = await ctx.memoryMaintenance.runDue(new AbortController().signal)
    expect(result).toMatchObject({ retried: 0, quarantined: 1 })
    expect(store.order).toEqual(['request', 'dispatch', 'aborted', 'result', 'failure:result-overflow'])
  })

  it('publishes through the real Store and a rooted five-tool maintenance Agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-scheduler-'))
    roots.push(root)
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { archivedSessionIds: [] } as never)
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 10 })
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TestPersistence)
    await ctx.plugin(memoryLocal, {
      root, enabled: true, useByDefault: true, contributeByDefault: true,
      readLeaseMs: 60_000, maxPromptSummaryBytes: 32_000, maxAdHocNoteBytes: 64_000,
      maxAuditRequestBytes: 2_000_000, maxAuditResultBytes: 2_000_000,
      maxAuditAttempts: 100, maxAuditTotalBytes: 16_000_000, auditRetentionMs: 86_400_000,
      changePollMs: 1_000, maxFiles: 100, maxFileBytes: 2_000_000,
      maxTotalBytes: 16_000_000, maxSummaryBytes: 32_000,
    })
    const failures: MemoryFailureRecord[] = []
    const store = ctx.memoryPipelineStore
    const recordFailure = store.recordFailure.bind(store)
    store.recordFailure = (request) => {
      failures.push(request)
      return recordFailure(request)
    }
    ctx.llm.registerAdapter(['pipeline'], new PipelineAdapter())
    await ctx.plugin(MemoryScheduler, {
      extractionProvider: 'pipeline', extractionModel: 'test', consolidationProvider: 'pipeline', consolidationModel: 'test', enabled: true,
      idleMs: 1, maxSourceAgeMs: 60_000, scanSessionsPerRun: 1, maxRangesPerRun: 1, maxPhase1ClaimsPerRun: 1,
      phase1LeaseMs: 60_000, phase2LeaseMs: 60_000, providerTimeoutMs: 10_000, maxAttempts: 3, retryBaseMs: 1,
      maxCandidatesPerRange: 8, maxPhase2Sources: 8, maxEvidenceBytes: 64_000, maxResultBytes: 64_000,
      extractionMaxTokens: 1_000, consolidationMaxTokens: 1_000, phase2MaxFileBytes: 64_000,
      phase2SearchMaxFiles: 32, phase2SearchMaxMatches: 32, externalToolPrefixes: ['web'], policyVersion: DEFAULT_MEMORY_RUNTIME_SETTINGS.policyVersion,
      pruneRowsPerRun: 10, pruneBytesPerRun: 64_000, fallbackWakeMs: 60_000,
    })

    const result = await ctx.memoryMaintenance.runDue(new AbortController().signal)
    expect(result, failures.map(failure => `${failure.phase}:${failure.category}:${failure.message}`).join('\n'))
      .toMatchObject({ phase1Completed: 1, phase2Completed: 1 })
    expect(failures).toEqual([])
    const state = await ctx.memory.getProfileState()
    expect(state.currentGenerationId).toBeDefined()
    expect((await ctx.memory.listGenerationTree({})).items.map(item => item.path)).toEqual(expect.arrayContaining([
      'memory_summary.md', 'MEMORY.md', `rollout_summaries/${rangeId}.md`,
    ]))
    expect(ctx.jobs.list()).toEqual([])
    expect((ctx.sessionPersistence as TestPersistence).created).toEqual([])
    const db = new DatabaseSync(join(root, 'state', 'memory.db'))
    try {
      expect(db.prepare('SELECT status,event_count FROM maintenance_sessions').get()).toMatchObject({ status: 'completed' })
      expect((db.prepare('SELECT type FROM maintenance_session_events').all() as Array<{ type: string }>).map(row => row.type))
        .toEqual(expect.arrayContaining(['request/header', 'turn/end']))
    } finally {
      db.close()
    }
  })

  it('propagates the operation timeout into a running Phase 2 Agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-scheduler-timeout-'))
    roots.push(root)
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { archivedSessionIds: [] } as never)
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner: 10 })
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TestPersistence)
    await ctx.plugin(memoryLocal, {
      root, enabled: true, useByDefault: true, contributeByDefault: true,
      readLeaseMs: 60_000, maxPromptSummaryBytes: 32_000, maxAdHocNoteBytes: 64_000,
      maxAuditRequestBytes: 2_000_000, maxAuditResultBytes: 2_000_000,
      maxAuditAttempts: 100, maxAuditTotalBytes: 16_000_000, auditRetentionMs: 86_400_000,
      changePollMs: 1_000, maxFiles: 100, maxFileBytes: 2_000_000,
      maxTotalBytes: 16_000_000, maxSummaryBytes: 32_000,
    })
    ctx.llm.registerAdapter(['hanging-pipeline'], new HangingConsolidationAdapter())
    await ctx.plugin(MemoryScheduler, {
      extractionProvider: 'hanging-pipeline', extractionModel: 'test', consolidationProvider: 'hanging-pipeline', consolidationModel: 'test', enabled: true,
      idleMs: 1, maxSourceAgeMs: 60_000, scanSessionsPerRun: 1, maxRangesPerRun: 1, maxPhase1ClaimsPerRun: 1,
      phase1LeaseMs: 60_000, phase2LeaseMs: 60_000, providerTimeoutMs: 1_000, maxAttempts: 2, retryBaseMs: 60_000,
      maxCandidatesPerRange: 8, maxPhase2Sources: 8, maxEvidenceBytes: 64_000, maxResultBytes: 64_000,
      extractionMaxTokens: 1_000, consolidationMaxTokens: 1_000, phase2MaxFileBytes: 64_000,
      phase2SearchMaxFiles: 32, phase2SearchMaxMatches: 32, externalToolPrefixes: ['web'], policyVersion: DEFAULT_MEMORY_RUNTIME_SETTINGS.policyVersion,
      pruneRowsPerRun: 10, pruneBytesPerRun: 64_000, fallbackWakeMs: 60_000,
    })

    const started = Date.now()
    const result = await ctx.memoryMaintenance.runDue(new AbortController().signal)

    expect(Date.now() - started).toBeLessThan(5_000)
    expect(result).toMatchObject({ phase1Completed: 1, phase2Completed: 0, retried: 1 })
    const db = new DatabaseSync(join(root, 'state', 'memory.db'))
    try {
      expect(db.prepare('SELECT category FROM failures WHERE phase=?').get('phase2'))
        .toMatchObject({ category: 'provider-timeout' })
      expect(db.prepare('SELECT status FROM maintenance_sessions').get())
        .toMatchObject({ status: 'failed' })
    } finally {
      db.close()
    }
  })
})

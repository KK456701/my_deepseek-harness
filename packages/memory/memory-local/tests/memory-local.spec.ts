import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import {
  MemoryCandidateId,
  MemoryAttemptId,
  MemoryEvidenceId,
  MemorySourceRangeId,
  type MaintenanceSessionBinding,
  type Phase2ClaimRequest,
} from '@deepseek-ai/dsh-memory-pipeline-store'
import { SessionId, SessionStore, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import * as memoryLocal from '../src/index.ts'
import { MEMORY_POLICY_VERSION, DEFAULT_MEMORY_RUNTIME_SETTINGS } from '@deepseek-ai/dsh-memory'

class TestPersistence extends SessionPersistence {
  override readonly supportsRawArtifacts = false
  readonly headers: SessionHeader[] = []
  locate(_meta: SessionHeader): undefined { return undefined }
  create(meta: SessionHeader): Promise<void> { this.headers.push(meta); return Promise.resolve() }
  append(_id: SessionId, _events: readonly SessionEvent[]): Promise<void> { return Promise.resolve() }
  load(_id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> { return Promise.reject(new Error('not used')) }
  inspect(_id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> { return Promise.reject(new Error('not used')) }
  readFrom(_id: SessionId, _fromSeq: number): Promise<{ meta: SessionHeader; events: SessionEvent[] }> { return Promise.reject(new Error('not used')) }
  list(): Promise<SessionHeader[]> { return Promise.resolve([]) }
  listSnapshots(): Promise<never[]> { return Promise.resolve([]) }
}

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(
  options: { root?: string; config?: Partial<memoryLocal.Config> } = {},
): Promise<{ ctx: Context; root: string; persistence: TestPersistence }> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-memory-local-'))
  if (options.root === undefined) roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(TestPersistence)
  await ctx.plugin(memoryLocal, {
    root,
    enabled: true,
    useByDefault: true,
    contributeByDefault: true,
    readLeaseMs: 60_000,
    maxPromptSummaryBytes: 32 * 1024,
    maxAdHocNoteBytes: 64 * 1024,
    maxAuditRequestBytes: 2 * 1024 * 1024,
    maxAuditResultBytes: 2 * 1024 * 1024,
    maxAuditAttempts: 100,
    maxAuditTotalBytes: 16 * 1024 * 1024,
    auditRetentionMs: 30 * 24 * 60 * 60_000,
    changePollMs: 100,
    maxFiles: 100,
    maxFileBytes: 2 * 1024 * 1024,
    maxTotalBytes: 16 * 1024 * 1024,
    maxSummaryBytes: 32 * 1024,
    ...options.config,
  })
  return { ctx, root, persistence: ctx.sessionPersistence as TestPersistence }
}

async function disposeContext(ctx: Context): Promise<void> {
  const index = contexts.indexOf(ctx)
  if (index >= 0) contexts.splice(index, 1)
  await ctx.fiber.dispose()
}

async function phase1(ctx: Context, options: { id?: string; session?: string; toSeq?: number; completedAt?: number } = {}): Promise<void> {
  const registered = await ctx.memoryPipelineStore.registerSourceRanges([{
    sourceRangeId: MemorySourceRangeId(options.id ?? 'source-1'),
    sessionId: SessionId(options.session ?? 'interactive-1'),
    fromSeq: 0,
    toSeq: options.toSeq ?? 3,
    completedAt: options.completedAt ?? Date.now(),
    sessionPurpose: 'interactive',
    policyVersion: MEMORY_POLICY_VERSION,
  }])
  expect(registered).toEqual({ inserted: 1, existing: 0 })
  const claim = await ctx.memoryPipelineStore.claimPhase1({ now: Date.now(), leaseMs: 60_000, maxAttempts: 3 })
  if (claim === undefined) throw new Error('expected Phase 1 claim')
  const attempt = await ctx.memoryPipelineStore.beginPhase1Attempt(claim)
  await ctx.memoryPipelineStore.recordPhase1Request({ attemptId: attempt.attemptId, requestFingerprint: 'request-1', request: {}, bytes: 2, recordedAt: Date.now() })
  await ctx.memoryPipelineStore.recordPhase1Result({ attemptId: attempt.attemptId, result: {}, bytes: 2, chunkCount: 1, termination: 'complete', recordedAt: Date.now() })
  await ctx.memoryPipelineStore.commitPhase1Outcome(claim, { kind: 'applied', candidates: [{
    candidateId: MemoryCandidateId(`${claim.jobId}:0`),
    rawMemory: '# Rollout context\nsource: source-1\n\n## Task 1: Publish memory\noutcome: success\nscope: memory pipeline\n\n### Reusable knowledge\nThe project uses immutable memory generations.\n',
    rolloutSummary: 'The project uses immutable memory generations.',
    rolloutSlug: 'source-1',
    evidenceIds: [MemoryEvidenceId('evidence-0')],
  }] })
}

async function completeMaintenanceAudit(
  ctx: Context,
  binding: MaintenanceSessionBinding,
  cwd: string,
  noteIds: readonly string[] = [],
  dispositionFormat: 'fenced' | 'trailing' = 'fenced',
): Promise<void> {
  let session!: ReturnType<Context['sessions']['create']>
  const owner = await ctx.plugin(Object.assign((inner: Context) => {
    session = inner.sessions.create(binding.sessionId, { meta: { purpose: 'maintenance', cwd } })
    session.append('turn/start', { turn: 1 })
    session.append('request/header', { header: { config: { provider: 'test', model: 'test' } }, reason: 'initial' })
    if (noteIds.length > 0) {
      const payload = JSON.stringify({
        noteDispositions: noteIds.map(noteId => ({ noteId, status: 'applied', detail: 'generation-published' })),
      })
      session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [{
            type: 'text',
            text: dispositionFormat === 'fenced'
              ? `Files are consistent.\n\n\`\`\`json\n${payload}\n\`\`\``
              : `Files are consistent.\n\n${payload}`,
          }],
          source: { provider: 'test', model: 'test' },
        }),
      }, { surfaceOp: 'append' })
    }
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }, { inject: ['sessions'] }))
  await binding.persistence.flush()
  await owner.dispose()
  await binding.persistence.flush()
}

async function preparePhase2(ctx: Context, claim: NonNullable<Awaited<ReturnType<Context['memoryPipelineStore']['claimPhase2']>>>): Promise<{
  workspace: Awaited<ReturnType<Context['memoryPipelineStore']['createPhase2Workspace']>>
  prepared: Awaited<ReturnType<Context['memoryPipelineStore']['validateAndPrepareGeneration']>>
}> {
  const workspace = await ctx.memoryPipelineStore.createPhase2Workspace(claim)
  const binding = await ctx.memoryPipelineStore.openMaintenanceSession(claim)
  await completeMaintenanceAudit(ctx, binding, workspace.stagingRoot)
  await writeFile(join(workspace.stagingRoot, 'memory_summary.md'), 'v1\n## User Profile\n\n## User preferences\n\n## General Tips\n- [Profile decisions](MEMORY.md)\n\n## What\'s in Memory\n- [Memory decisions](MEMORY.md)\n')
  await writeFile(join(workspace.stagingRoot, 'MEMORY.md'), '# Memory\n\n# Task Group: Memory generation\nscope: test\napplies_to: memory tests\n\n## Task 1: publish a generation\n\n### rollout_summary_files\n- [Generation decision](rollout_summaries/source-1.md)\n\n### keywords\n- generation, publish\n\n## Reusable knowledge\n- [Task 1](MEMORY.md#task-group-memory-generation) records generation publication.\n')
  const materializing = await ctx.memoryPipelineStore.allocateGeneration(claim)
  const prepared = await ctx.memoryPipelineStore.validateAndPrepareGeneration({
    claim,
    workspace,
    materializing,
    maintenanceSessionId: binding.sessionId,
  })
  return { workspace, prepared }
}

function claimPhase2(
  ctx: Context,
  patch: Partial<Phase2ClaimRequest> = {},
): ReturnType<Context['memoryPipelineStore']['claimPhase2']> {
  return ctx.memoryPipelineStore.claimPhase2({
    now: Date.now(),
    leaseMs: 120_000,
    maxSources: 32,
    maxAttempts: 3,
    maxUnusedDays: 30,
    ...patch,
  })
}

describe('local memory pipeline', () => {
  it('backs up and incrementally upgrades v9 without changing current files or relearning a registered rollout', async () => {
    const { ctx,root } = await setup()
    await phase1(ctx)
    const first = (await claimPhase2(ctx))!
    const { prepared } = await preparePhase2(ctx,first)
    const generation = await ctx.memoryPipelineStore.publishGeneration({ claim: first,prepared })
    const note = await ctx.memory.rememberMemory({ content: 'Remember to attach verification results.' })
    const items = (await ctx.memory.listMemoryItems({})).items
    const path = join(root,'state','memory.db')
    const summaryPath = join(root,'generations',generation.generationId,'memory_summary.md')
    const summary = await readFile(summaryPath)
    await disposeContext(ctx)
    const old = new DatabaseSync(path)
    let completedAt: number
    try {
      completedAt = (old.prepare('SELECT completed_at FROM source_ranges').get() as { completed_at: number }).completed_at
      old.prepare('INSERT INTO source_usage VALUES (?,?,?)').run('source:source-1',3,1234)
      old.exec('DROP TABLE session_source_usage; DROP TABLE phase2_selected_sources; ALTER TABLE phase2_jobs DROP COLUMN selection_fingerprint; ALTER TABLE phase1_attempts DROP COLUMN output_format_version; PRAGMA user_version=9')
      const { phase1Concurrency: _concurrency,maxPhase2Sources: _max,...values } = DEFAULT_MEMORY_RUNTIME_SETTINGS
      old.prepare('INSERT OR REPLACE INTO runtime_settings VALUES (1,14,?,?)').run(JSON.stringify({ ...values,maxPhase2Candidates: 11 }),Date.now())
    } finally {old.close()}
    const restored = await setup({ root })
    const settings = await restored.ctx.memory.getRuntimeSettings()
    expect(settings).toMatchObject({ revision: 14,maxPhase2Sources: 11,phase1Concurrency: 2,policyVersion: MEMORY_POLICY_VERSION })
    expect((await restored.ctx.memory.getProfileState()).currentGenerationId).toBe(generation.generationId)
    expect((await restored.ctx.memory.listMemoryItems({})).items).toEqual(items)
    expect((await restored.ctx.memory.listMemoryItems({})).sourceUsage).toEqual([{ sourceId: 'source:source-1',adoptedCount: 3,lastAdoptedAt: 1234 }])
    expect((await restored.ctx.memory.listAdHocNotes({})).items.map(value => value.id)).toContain(note.id)
    expect(await readFile(summaryPath)).toEqual(summary)
    expect((await readdir(join(root,'state'))).some(name => name.includes('.before-v10-') && name.endsWith('.bak'))).toBe(true)
    expect(await restored.ctx.memoryPipelineStore.registerSourceRanges([{ sourceRangeId: MemorySourceRangeId('new-template-id'),sessionId: SessionId('interactive-1'),fromSeq: 0,toSeq: 3,completedAt,sessionPurpose: 'interactive',policyVersion: MEMORY_POLICY_VERSION }])).toEqual({ inserted: 0,existing: 1 })
    expect(await restored.ctx.memoryPipelineStore.claimPhase1({ now: Date.now(),leaseMs: 60_000,maxAttempts: 3 })).toBeUndefined()
  })
  it('does not reconsolidate legacy inputs omitted from a later adopted-only retained list', async () => {
    const { ctx,root } = await setup()
    await phase1(ctx)
    await phase1(ctx, { id: 'source-2', session: 'interactive-2' })
    const first = (await claimPhase2(ctx))!
    const one = await preparePhase2(ctx,first)
    await ctx.memoryPipelineStore.publishGeneration({ claim: first,prepared: one.prepared })
    await phase1(ctx, { id: 'source-3', session: 'interactive-3' })
    const second = (await claimPhase2(ctx))!
    const two = await preparePhase2(ctx,second)
    const generation = await ctx.memoryPipelineStore.publishGeneration({ claim: second,prepared: two.prepared })
    await disposeContext(ctx)
    const old = new DatabaseSync(join(root,'state','memory.db'))
    try {
      old.prepare('UPDATE phase2_jobs SET source_diff_json=? WHERE id=?')
        .run(JSON.stringify({ added: ['source-3'],retained: ['source-1'],removed: [] }),second.jobId)
      old.exec('DROP TABLE session_source_usage; DROP TABLE phase2_selected_sources; ALTER TABLE phase2_jobs DROP COLUMN selection_fingerprint; ALTER TABLE phase1_attempts DROP COLUMN output_format_version; PRAGMA user_version=9')
    } finally { old.close() }
    const reopened = await setup({ root })
    expect(await claimPhase2(reopened.ctx)).toBeUndefined()
    expect((await reopened.ctx.memory.getProfileState()).currentGenerationId).toBe(generation.generationId)
  })

  it('selects consumed high-use sources, skips identical input sets, and carries feedback to a newer range', async () => {
    const { ctx, root } = await setup()
    await phase1(ctx)
    const first = (await claimPhase2(ctx))!
    const { prepared } = await preparePhase2(ctx, first)
    await ctx.memoryPipelineStore.publishGeneration({ claim: first, prepared })
    const db = new DatabaseSync(join(root, 'state', 'memory.db'))
    try {
      db.prepare('INSERT INTO session_source_usage VALUES (?,?,?)').run('interactive-1', 4, Date.now())
      await phase1(ctx, { id: 'source-2', session: 'interactive-2' })
      expect(await claimPhase2(ctx, { maxSources: 1 })).toBeUndefined()
      db.prepare('UPDATE session_source_usage SET adopted_count=adopted_count+1').run()
      expect(await claimPhase2(ctx, { maxSources: 1 })).toBeUndefined()
      const note = await ctx.memory.rememberMemory({ content: 'Remember to verify release artifacts.' })
      const withNote = (await claimPhase2(ctx, { maxSources: 1 }))!
      expect(withNote.sourceSelectionDiff.retained).toEqual(['source-1'])
      expect(withNote.adHocNoteIds).toContain(note.id)
      await ctx.memoryPipelineStore.recordFailure({ phase: 'phase2', jobId: withNote.jobId, ownerToken: withNote.lease.ownerToken,
        category: 'cancelled', message: 'test owner cancelled', now: Date.now() })
      await phase1(ctx, { id: 'source-1-new', toSeq: 8 })
      const updated = (await claimPhase2(ctx, { maxSources: 1 }))!
      expect(updated.sourceSelectionDiff.updated).toEqual(['source-1-new'])
      expect(updated.sourceSelectionDiff.removed).toEqual(['source-1'])
      expect(updated.sourceSelectionDiff.added).toEqual([])
    } finally { db.close() }
  })

  it('prunes expired output only after publication and read-lease release', async () => {
    const { ctx, root } = await setup()
    await phase1(ctx)
    const first = (await claimPhase2(ctx))!
    const { prepared } = await preparePhase2(ctx, first)
    const published = await ctx.memoryPipelineStore.publishGeneration({ claim: first, prepared })
    const lease = await ctx.memory.acquirePromptSnapshot({ sessionId: SessionId('reader'), maxSummaryBytes: 4096, leaseOwner: 'test' })
    const db = new DatabaseSync(join(root, 'state', 'memory.db'))
    try {
      const past = Date.now() - 31 * 24 * 60 * 60_000
      const original = db.prepare('SELECT completed_at FROM source_ranges WHERE id=?').get('source-1') as { completed_at: number }
      db.prepare('UPDATE source_ranges SET completed_at=?').run(past)
      const removal = (await claimPhase2(ctx))!
      expect(removal.sourceSelectionDiff.removed).toEqual(['source-1'])
      expect((await ctx.memoryPipelineStore.prune({ now: Date.now(), maxRows: 100, maxBytes: 1_000_000 })).sourceSnapshots).toBe(0)
      const workspace = await ctx.memoryPipelineStore.createPhase2Workspace(removal)
      const binding = await ctx.memoryPipelineStore.openMaintenanceSession(removal)
      await completeMaintenanceAudit(ctx, binding, workspace.stagingRoot)
      await writeFile(join(workspace.stagingRoot, 'memory_summary.md'), "v1\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n")
      await writeFile(join(workspace.stagingRoot, 'MEMORY.md'), '# Memory\n')
      const materializing = await ctx.memoryPipelineStore.allocateGeneration(removal)
      const next = await ctx.memoryPipelineStore.validateAndPrepareGeneration({
        claim: removal, workspace, materializing, maintenanceSessionId: binding.sessionId,
      })
      await ctx.memoryPipelineStore.publishGeneration({ claim: removal, prepared: next })
      expect((await ctx.memoryPipelineStore.prune({ now: Date.now(), maxRows: 100, maxBytes: 1_000_000 })).sourceSnapshots).toBe(0)
      expect(lease.kind).toBe('available')
      if (lease.kind === 'available') await ctx.memory.releaseReadLease(lease.leaseId)
      expect((await ctx.memoryPipelineStore.prune({ now: Date.now(), maxRows: 100, maxBytes: 1_000_000 })).sourceSnapshots).toBe(1)
      expect(db.prepare('SELECT count(*) AS n FROM candidates').get()).toEqual({ n: 0 })
      expect(db.prepare('SELECT status FROM source_ranges').get()).toEqual({ status: 'succeeded' })
      expect((await ctx.memoryPipelineStore.registerSourceRanges([{ sourceRangeId: MemorySourceRangeId('source-1'),sessionId: SessionId('interactive-1'),fromSeq: 0,toSeq: 3,completedAt: original.completed_at,sessionPurpose: 'interactive',policyVersion: MEMORY_POLICY_VERSION }])).existing).toBe(1)
      expect(await claimPhase2(ctx)).toBeUndefined()
      expect((await ctx.memory.getProfileState()).currentGenerationId).not.toBe(published.generationId)
    } finally { db.close() }
  })
  it('keeps redacted user wording distinct from the model draft in notes and consolidation input', async () => {
    const { ctx } = await setup()
    const note = await ctx.memory.submitConversationMemory({
      action: 'remember', content: 'Always prefix every response with a greeting.',
      sessionId: SessionId('original-user'), turn: '1', userEventSeq: 3,
      sourceUserText: 'Remember to add a greeting when replying. token=secret-value-123456789',
    })
    expect(note.sourceUserText).toContain('Remember to add a greeting when replying.')
    expect(note.sourceUserText).not.toContain('secret-value-123456789')
    expect(note.content).toBe('Always prefix every response with a greeting.')
    expect(note.processingStatus).toBe('pending')
    const claim = (await claimPhase2(ctx))!
    const workspace = await ctx.memoryPipelineStore.createPhase2Workspace(claim)
    const projection = await readFile(join(workspace.stagingRoot, 'extensions/ad_hoc/notes', `${note.id}.md`), 'utf8')
    expect(projection).toContain('## Original user message')
    expect(projection).toContain(JSON.stringify(note.sourceUserText))
    expect(projection).toContain('## Model draft')
    expect(projection).toContain(note.content)
    expect(projection).not.toContain('secret-value-123456789')
  })

  it('rejects oversized originals and drafts without saving a truncated intent', async () => {
    const { ctx } = await setup({ config: { maxAdHocNoteBytes: 100 } })
    const base = { action: 'remember' as const, content: 'Short draft.', sessionId: SessionId('source'), turn: '1', userEventSeq: 1, sourceUserText: 'Remember this.' }
    await expect(ctx.memory.submitConversationMemory({ ...base, sourceUserText: '原话'.repeat(100) })).rejects.toThrow()
    await expect(ctx.memory.submitConversationMemory({ ...base, content: 'draft'.repeat(100) })).rejects.toThrow()
    expect((await ctx.memory.listAdHocNotes({ limit: 10 })).items).toEqual([])
  })

  it('keeps format-compatible generations readable after a generation-template update', async () => {
    const { ctx, root } = await setup()
    await phase1(ctx)
    const claim = (await claimPhase2(ctx))!
    const { prepared } = await preparePhase2(ctx, claim)
    await ctx.memoryPipelineStore.publishGeneration({ claim, prepared })
    await disposeContext(ctx)
    const pointerPath = join(root, 'current.json')
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8')) as { generationId: string; manifestSha256: string }
    const manifestPath = join(root, 'generations', pointer.generationId, 'generation-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { templateVersion: string }
    manifest.templateVersion = 'previous-writing-template'
    const serialized = JSON.stringify(manifest)
    pointer.manifestSha256 = createHash('sha256').update(serialized).digest('hex')
    await writeFile(manifestPath, serialized)
    await writeFile(pointerPath, JSON.stringify(pointer))
    const db = new DatabaseSync(join(root, 'state/memory.db'))
    db.prepare('UPDATE generations SET manifest_sha256=? WHERE id=?').run(pointer.manifestSha256, pointer.generationId)
    db.close()
    const reopened = await setup({ root })
    const snapshot = await reopened.ctx.memory.acquirePromptSnapshot({ sessionId: SessionId('read'), maxSummaryBytes: 4096, leaseOwner: 'test' })
    expect(snapshot.kind).toBe('available')
    if (snapshot.kind === 'available') await reopened.ctx.memory.releaseReadLease(snapshot.leaseId)
    await rm(manifestPath)
    await expect(reopened.ctx.memory.acquirePromptSnapshot({ sessionId: SessionId('read'), maxSummaryBytes: 4096, leaseOwner: 'test' })).rejects.toThrow('cannot be read')
  })

  it('requires durable structured audits and removes discarded evidence before publication', async () => {
    const { ctx, root } = await setup()
    await phase1(ctx)
    const claim = (await claimPhase2(ctx))!
    const store = ctx.memoryPipelineStore
    const workspace = await store.createPhase2Workspace(claim)
    const input = await store.readConsolidationInput(claim, workspace)
    expect(input.sourceIds).toEqual(['source-1'])
    await expect(store.applyConsolidationResult(claim, workspace, MemoryAttemptId('missing'))).rejects.toThrow('not durable')
    const attemptId = await store.recordPhase2Request({ claim, request: { model: 'fixture', effort: 'max' }, bytes: 34 })
    const envelope = { finishReason: 'completed', value: {
      memorySummary: "v1\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n",
      memoryManual: '# Memory\n', skills: [], noteDispositions: [],
      sourceDecisions: [{ sourceId: 'source-1', action: 'discard', reason: 'No reusable evidence' }],
    } }
    await store.recordPhase2Result({
      claim, attemptId, result: envelope, bytes: Buffer.byteLength(JSON.stringify(envelope)), completed: true,
    })
    await store.applyConsolidationResult(claim, workspace, attemptId)
    await expect(readFile(join(workspace.stagingRoot, 'rollout_summaries/source-1.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    const materializing = await store.allocateGeneration(claim)
    const prepared = await store.validateAndPrepareGeneration({ claim, workspace, materializing, structuredAttemptId: attemptId })
    await store.publishGeneration({ claim, prepared })
    const db = new DatabaseSync(join(root, 'state/memory.db'))
    expect(db.prepare('SELECT COUNT(*) AS n FROM maintenance_sessions').get()).toMatchObject({ n: 0 })
    expect(db.prepare('SELECT status FROM phase2_structured_attempts').get()).toMatchObject({ status: 'applied' })
    db.close()
    expect(await claimPhase2(ctx)).toBeUndefined()
  })

  it('keeps raw and rollout artifacts distinct when applying a retained source from a legacy job', async () => {
    const { ctx,root } = await setup()
    await phase1(ctx)
    const claim = (await claimPhase2(ctx))!
    const store = ctx.memoryPipelineStore
    const workspace = await store.createPhase2Workspace(claim)
    const rawBefore = await readFile(join(workspace.stagingRoot,'raw_memories.md'),'utf8')
    const rolloutBefore = await readFile(join(workspace.stagingRoot,'rollout_summaries/source-1.md'),'utf8')
    expect(rawBefore).toContain('# Rollout context')
    expect(rolloutBefore).not.toContain('# Rollout context')
    const db = new DatabaseSync(join(root,'state/memory.db'))
    try {
      db.prepare('DELETE FROM phase2_job_candidates WHERE job_id=?').run(claim.jobId)
      db.prepare('UPDATE phase2_jobs SET selection_fingerprint=NULL WHERE id=?').run(claim.jobId)
    } finally {db.close()}
    const attemptId = await store.recordPhase2Request({ claim,request: {},bytes: 2 })
    const envelope = { finishReason: 'completed',value: {
      memorySummary: "v1\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n",
      memoryManual: '# Memory\n',skills: [],noteDispositions: [],
      sourceDecisions: [{ sourceId: 'source-1',action: 'retain',reason: 'Preserve task evidence' }],
    } }
    await store.recordPhase2Result({ claim,attemptId,result: envelope,bytes: Buffer.byteLength(JSON.stringify(envelope)),completed: true })
    await store.applyConsolidationResult(claim,workspace,attemptId)
    expect(await readFile(join(workspace.stagingRoot,'raw_memories.md'),'utf8')).toBe(rawBefore)
    expect(await readFile(join(workspace.stagingRoot,'rollout_summaries/source-1.md'),'utf8')).toBe(rolloutBefore)
  })

  it('purges explicit intent only when requested and persists the frozen rebuild cutoff', async () => {
    const { ctx, root } = await setup()
    await phase1(ctx)
    await ctx.memory.submitAdHocNote({ action: 'remember', content: 'A prior explicit request.' })
    const startedBefore = Date.now()
    const rebuild = await ctx.memory.startCleanPolicyRebuild({ confirmation: 'clean-policy-rebuild', sourceLookbackMs: 432_000_000, explicitNotePolicy: 'purge-all' })
    expect(rebuild.sourceCompletedAfter).toBeGreaterThanOrEqual(startedBefore - 432_000_000)
    await expect(ctx.memory.listAdHocNotes({ limit: 10 })).resolves.toEqual({ items: [] })
    await disposeContext(ctx)
    const reopened = await setup({ root })
    expect((await reopened.ctx.memory.getProfileState()).rebuild).toMatchObject({ sourceCompletedAfter: rebuild.sourceCompletedAfter, explicitNotePolicy: 'purge-all' })
  })
  it('leaves representation and promotion decisions to Phase 2', async () => {
    const { ctx } = await setup()
    await phase1(ctx)
    const claim = await claimPhase2(ctx)
    if (claim === undefined) throw new Error('expected Phase 2 claim')
    const workspace = await ctx.memoryPipelineStore.createPhase2Workspace(claim)
    const binding = await ctx.memoryPipelineStore.openMaintenanceSession(claim)
    await completeMaintenanceAudit(ctx, binding, workspace.stagingRoot)
    await writeFile(join(workspace.stagingRoot, 'memory_summary.md'), 'v1\n## User Profile\n\n## User preferences\n\n## General Tips\n- [Promoted rollout](MEMORY.md)\n\n## What\'s in Memory\n')
    await writeFile(join(workspace.stagingRoot, 'MEMORY.md'), '# Memory\n\n# Task Group: Wrong promotion\nscope: test\napplies_to: promotion tests\n\n## Task 1: preserve evidence\n\n### rollout_summary_files\n- [Rollout](rollout_summaries/source-1.md)\n\n### keywords\n- promotion, evidence\n')
    const materializing = await ctx.memoryPipelineStore.allocateGeneration(claim)
    await expect(ctx.memoryPipelineStore.validateAndPrepareGeneration({
      claim,
      workspace,
      materializing,
      maintenanceSessionId: binding.sessionId,
    })).resolves.toMatchObject({ publishSequence: 1 })
  })

  it('rejects a non-canonical MEMORY.md Task Group structure', async () => {
    const { ctx } = await setup()
    await phase1(ctx)
    const claim = await claimPhase2(ctx)
    if (claim === undefined) throw new Error('expected Phase 2 claim')
    const workspace = await ctx.memoryPipelineStore.createPhase2Workspace(claim)
    const binding = await ctx.memoryPipelineStore.openMaintenanceSession(claim)
    await completeMaintenanceAudit(ctx, binding, workspace.stagingRoot)
    await writeFile(join(workspace.stagingRoot, 'memory_summary.md'), "v1\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n- [Memory decisions](MEMORY.md)\n")
    await writeFile(join(workspace.stagingRoot, 'MEMORY.md'), '# Memory\n\n## Task Group: Invalid nesting\n- [Source](rollout_summaries/source-1.md)\n')
    const materializing = await ctx.memoryPipelineStore.allocateGeneration(claim)

    await expect(ctx.memoryPipelineStore.validateAndPrepareGeneration({
      claim,
      workspace,
      materializing,
      maintenanceSessionId: binding.sessionId,
    })).rejects.toThrow('top-level # Task Group:')
  })

  it('publishes one verified generation and serves a leased prompt snapshot', async () => {
    const { ctx, persistence } = await setup()
    await phase1(ctx)
    const claim = await claimPhase2(ctx)
    if (claim === undefined) throw new Error('expected Phase 2 claim')
    const workspace = await ctx.memoryPipelineStore.createPhase2Workspace(claim)
    const binding = await ctx.memoryPipelineStore.openMaintenanceSession(claim)
    await completeMaintenanceAudit(ctx, binding, workspace.stagingRoot)
    expect(persistence.headers).toEqual([])
    await writeFile(join(workspace.stagingRoot, 'memory_summary.md'), 'v1\n## User Profile\n\n## User preferences\n\n## General Tips\n- [Immutable generations](MEMORY.md)\n\n## What\'s in Memory\n- [Memory generations](MEMORY.md)\n')
    await writeFile(join(workspace.stagingRoot, 'MEMORY.md'), '# Memory\n\n# Task Group: Memory generation\nscope: test\napplies_to: memory tests\n\n## Task 1: publish a generation\n\n### rollout_summary_files\n- [Generation decision](rollout_summaries/source-1.md)\n\n### keywords\n- generation, publish\n')
    const materializing = await ctx.memoryPipelineStore.allocateGeneration(claim)
    const prepared = await ctx.memoryPipelineStore.validateAndPrepareGeneration({
      claim,
      workspace,
      materializing,
      maintenanceSessionId: binding.sessionId,
    })
    const published = await ctx.memoryPipelineStore.publishGeneration({ claim, prepared })
    expect((await ctx.memory.getProfileState()).currentGenerationId).toBe(published.generationId)
    const snapshot = await ctx.memory.acquirePromptSnapshot({ sessionId: SessionId('interactive-1'), maxSummaryBytes: 4096, leaseOwner: 'test' })
    if (snapshot.kind !== 'available') throw new Error('expected available memory')
    expect(snapshot.summary).toContain('Immutable generations')
    expect((await ctx.memory.listGenerationTree({})).items.map(item => item.path)).toContain('rollout_summaries/source-1.md')
    await ctx.memory.releaseReadLease(snapshot.leaseId)
  })

  it('derives semantic items and suppresses a revision-safe deletion before consolidation', async () => {
    const { ctx } = await setup()
    await phase1(ctx)
    const claim = await claimPhase2(ctx)
    if (claim === undefined) throw new Error('expected Phase 2 claim')
    const { prepared } = await preparePhase2(ctx, claim)
    await ctx.memoryPipelineStore.publishGeneration({ claim, prepared })

    const page = await ctx.memory.listMemoryItems({ limit: 20 })
    const taskGroup = page.items.find(item => item.kind === 'task-group')
    if (taskGroup === undefined) throw new Error('expected task-group memory item')
    expect(taskGroup).toMatchObject({ title: 'Memory generation', status: 'active', origin: 'automatic' })

    const deletion = await ctx.memory.deleteMemoryItem({ target: taskGroup.target })
    const afterDelete = await ctx.memory.listMemoryItems({ limit: 20 })
    expect(afterDelete.items).toContainEqual(expect.objectContaining({
      id: taskGroup.id,
      status: 'pending-delete',
    }))
    const read = await ctx.memory.readMemory({ sessionId: SessionId('interactive-1'), path: 'MEMORY.md' })
    expect(read.text).not.toContain('Memory generation')
    await expect(ctx.memory.updateMemoryItem({ target: taskGroup.target, content: 'replacement' }))
      .rejects.toMatchObject({ code: 'conflict' })

    const deletionClaim = await claimPhase2(ctx)
    if (deletionClaim === undefined) throw new Error('expected deletion Phase 2 claim')
    const deletionWorkspace = await ctx.memoryPipelineStore.createPhase2Workspace(deletionClaim)
    const note = await readFile(join(
      deletionWorkspace.stagingRoot,
      'extensions',
      'ad_hoc',
      'notes',
      `${deletion.id}.md`,
    ), 'utf8')
    expect(note).toContain('\n```json\n')
    expect(note).toContain('"priorContent":"# Task Group: Memory generation')
    const binding = await ctx.memoryPipelineStore.openMaintenanceSession(deletionClaim)
    await completeMaintenanceAudit(ctx, binding, deletionWorkspace.stagingRoot, [deletion.id], 'trailing')
    await writeFile(join(deletionWorkspace.stagingRoot, 'memory_summary.md'), "v1\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n")
    await writeFile(join(deletionWorkspace.stagingRoot, 'MEMORY.md'), '# Memory\n')
    const materializing = await ctx.memoryPipelineStore.allocateGeneration(deletionClaim)
    await expect(ctx.memoryPipelineStore.validateAndPrepareGeneration({
      claim: deletionClaim,
      workspace: deletionWorkspace,
      materializing,
      maintenanceSessionId: binding.sessionId,
    })).resolves.toBeDefined()
  })

  it('allows an explicit retry after a Phase 2 job exhausts automatic attempts', async () => {
    const { ctx } = await setup()
    await phase1(ctx)
    const claim = await claimPhase2(ctx, { maxAttempts: 1 })
    if (claim === undefined) throw new Error('expected Phase 2 claim')
    await expect(ctx.memoryPipelineStore.recordFailure({
      phase: 'phase2',
      jobId: claim.jobId,
      ownerToken: claim.lease.ownerToken,
      category: 'validation',
      message: 'manual retry test',
      now: Date.now(),
    })).resolves.toMatchObject({ kind: 'quarantined' })
    const quarantine = (await ctx.memory.listQuarantines({ limit: 20 })).items.find(item => item.phase === 'phase2')
    if (quarantine === undefined) throw new Error('expected Phase 2 quarantine')
    await ctx.memory.retryQuarantine(quarantine.id)
    const retried = await claimPhase2(ctx, { maxAttempts: 1, now: Date.now() + 1 })
    expect(retried?.jobId).toBe(claim.jobId)
    expect(retried?.lease.attempt).toBe(2)
  })

  it('does not create a second Phase 2 job while an existing job waits to retry', async () => {
    const { ctx, root } = await setup()
    await phase1(ctx)
    const claim = await claimPhase2(ctx)
    if (claim === undefined) throw new Error('expected Phase 2 claim')
    const now = Date.now()
    const retryAt = now + 60_000
    await expect(ctx.memoryPipelineStore.recordFailure({
      phase: 'phase2',
      jobId: claim.jobId,
      ownerToken: claim.lease.ownerToken,
      category: 'validation',
      message: 'summary source links need correction',
      now,
      retryAt,
    })).resolves.toEqual({ kind: 'retry', nextAttemptAt: retryAt })

    await expect(claimPhase2(ctx, { now: retryAt - 1 })).resolves.toBeUndefined()
    const database = new DatabaseSync(join(root, 'state', 'memory.db'))
    try {
      expect(database.prepare('SELECT COUNT(*) AS count FROM phase2_jobs').get()).toEqual({ count: 1 })
    } finally {
      database.close()
    }
    const retried = await claimPhase2(ctx, { now: retryAt })
    expect(retried?.jobId).toBe(claim.jobId)
    expect(retried?.lease.attempt).toBe(2)
  })

  it('abandons an unpublished generation when its Phase 2 attempt fails', async () => {
    const { ctx, root } = await setup()
    await phase1(ctx)
    const claim = await claimPhase2(ctx)
    if (claim === undefined) throw new Error('expected Phase 2 claim')
    await ctx.memoryPipelineStore.createPhase2Workspace(claim)
    const materializing = await ctx.memoryPipelineStore.allocateGeneration(claim)

    await expect(ctx.memoryPipelineStore.recordFailure({
      phase: 'phase2',
      jobId: claim.jobId,
      ownerToken: claim.lease.ownerToken,
      category: 'validation',
      message: 'generation validation failed',
      now: Date.now(),
      retryAt: Date.now() + 60_000,
    })).resolves.toMatchObject({ kind: 'retry' })

    const database = new DatabaseSync(join(root, 'state', 'memory.db'))
    try {
      expect(database.prepare('SELECT status FROM generations WHERE id=?').get(materializing.generationId))
        .toEqual({ status: 'abandoned' })
    } finally {
      database.close()
    }
  })

  it('requeues claimed inputs instead of replaying a quarantined Phase 2 job on a stale baseline', async () => {
    const { ctx, root } = await setup()
    await phase1(ctx)
    const claim = await claimPhase2(ctx)
    if (claim === undefined) throw new Error('expected Phase 2 claim')
    await ctx.memoryPipelineStore.recordFailure({
      phase: 'phase2',
      jobId: claim.jobId,
      ownerToken: claim.lease.ownerToken,
      category: 'validation',
      message: 'stale retry test',
      now: Date.now(),
    })
    const quarantine = (await ctx.memory.listQuarantines({ limit: 20 })).items.find(item => item.phase === 'phase2')
    if (quarantine === undefined) throw new Error('expected Phase 2 quarantine')
    const database = new DatabaseSync(join(root, 'state', 'memory.db'))
    database.prepare('UPDATE profile_state SET current_generation_id=? WHERE singleton=1').run('new-baseline')
    database.close()

    await ctx.memory.retryQuarantine(quarantine.id)
    const retried = await claimPhase2(ctx)
    expect(retried?.jobId).not.toBe(claim.jobId)
    expect(retried?.candidateIds).toEqual(claim.candidateIds)
  })

  it('maps an adopted summary citation through line provenance to source usage', async () => {
    const { ctx, root } = await setup()
    await phase1(ctx)
    const claim = await claimPhase2(ctx)
    if (claim === undefined) throw new Error('expected Phase 2 claim')
    const { prepared } = await preparePhase2(ctx, claim)
    const published = await ctx.memoryPipelineStore.publishGeneration({ claim, prepared })
    const second = await setup({ root })
    let observed = 0
    let wakes = 0
    second.ctx.on('memory/changed', () => { observed += 1 })
    ctx.on('memory/pipeline-work-available', () => { wakes += 1 })
    const before = await ctx.memory.getProfileState()
    expect((await ctx.memory.listMemoryItems({})).sourceUsage).toEqual([{ sourceId: 'source:source-1',adoptedCount: 0 }])
    const session = ctx.sessions.create(SessionId('citation-session'), { meta: { purpose: 'interactive' } })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `Use the prior decision. dsh-memory://${published.generationId}/memory_summary.md#L1` }],
        source: { provider: 'test', model: 'test' },
      }),
    }, { surfaceOp: 'append' })

    await vi.waitFor(() => {
      const db = new DatabaseSync(join(root, 'state', 'memory.db'))
      try {
        expect(db.prepare('SELECT adopted_count FROM source_usage WHERE source_id=?').get('source:source-1'))
          .toEqual({ adopted_count: 1 })
      } finally {
        db.close()
      }
    })
    await vi.waitFor(() => { expect(observed).toBeGreaterThan(0) })
    const page = await second.ctx.memory.listMemoryItems({})
    expect(page.sourceUsage).toMatchObject([{ sourceId: 'source:source-1', adoptedCount: 1 }])
    expect(page.sourceUsage[0]?.lastAdoptedAt).toEqual(expect.any(Number))
    await ctx.memory.readGenerationFile({ generationId: published.generationId,path: 'memory_summary.md',offset: 0,maxBytes: 4096 })
    expect((await ctx.memory.listMemoryItems({})).sourceUsage).toEqual(page.sourceUsage)
    expect((await ctx.memory.getProfileState()).changeSequence).toBeGreaterThan(before.changeSequence)
    expect((await ctx.memory.getProfileState()).currentGenerationId).toBe(before.currentGenerationId)
    expect(wakes).toBe(0)
  })

  it('claims a provenance removal when the final automatic source expires', async () => {
    const { ctx } = await setup()
    await phase1(ctx)
    const firstClaim = await claimPhase2(ctx)
    if (firstClaim === undefined) throw new Error('expected first Phase 2 claim')
    const { prepared } = await preparePhase2(ctx, firstClaim)
    await ctx.memoryPipelineStore.publishGeneration({ claim: firstClaim, prepared })

    const forgettingClaim = await ctx.memoryPipelineStore.claimPhase2({
      now: Date.now() + 31 * 24 * 60 * 60_000,
      leaseMs: 120_000,
      maxSources: 32,
      maxAttempts: 3,
      maxUnusedDays: 30,
    })
    expect(forgettingClaim?.sourceSelectionDiff).toEqual({
      added: [],
      updated: [],
      retained: [],
      removed: [MemorySourceRangeId('source-1')],
    })
  })

  it('rejects Phase 2 publication after read-only evidence changes', async () => {
    const { ctx } = await setup()
    await phase1(ctx)
    const claim = await claimPhase2(ctx)
    if (claim === undefined) throw new Error('expected Phase 2 claim')
    const workspace = await ctx.memoryPipelineStore.createPhase2Workspace(claim)
    await writeFile(join(workspace.stagingRoot, 'raw_memories.md'), 'tampered')
    await expect(ctx.memoryPipelineStore.allocateGeneration(claim)).rejects.toThrow('read-only evidence')
    expect(await readFile(join(workspace.stagingRoot, 'raw_memories.md'), 'utf8')).toBe('tampered')
  })

  it('uses optimistic revisions for session controls', async () => {
    const { ctx } = await setup()
    const id = SessionId('controls')
    await expect(ctx.memory.setSessionControls(id, 0, { use: 'deny' })).resolves.toMatchObject({ revision: 1, use: 'deny' })
    await expect(ctx.memory.setSessionControls(id, 0, { use: 'allow' })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('blocks recall with use deny without blocking explicit management', async () => {
    const { ctx } = await setup()
    await phase1(ctx)
    const claim = await claimPhase2(ctx)
    if (claim === undefined) throw new Error('expected Phase 2 claim')
    const { prepared } = await preparePhase2(ctx, claim)
    await ctx.memoryPipelineStore.publishGeneration({ claim, prepared })
    const sessionId = SessionId('recall-denied')
    await ctx.memory.setSessionControls(sessionId, 0, { use: 'deny', contribute: 'deny' })

    await expect(ctx.memory.acquirePromptSnapshot({ sessionId, maxSummaryBytes: 4_096, leaseOwner: 'test' })).resolves.toMatchObject({ kind: 'skipped' })
    await expect(ctx.memory.searchMemory({ sessionId, query: 'generation' })).rejects.toMatchObject({ code: 'disabled' })
    await expect(ctx.memory.submitConversationMemory({
      sessionId,
      turn: '1',
      userEventSeq: 7,
      sourceUserText: 'Forget the old generation preference.',
      action: 'forget',
      content: 'Forget the old generation preference.',
      target: 'generation preference',
    })).resolves.toMatchObject({ action: 'forget', origin: 'conversation', authorityStatus: 'active' })
  })

  it('redacts secrets without discarding the safe part of an explicit request', async () => {
    const { ctx } = await setup()
    const note = await ctx.memory.submitAdHocNote({
      action: 'remember',
      content: 'token=super-secret; Always explain security-sensitive changes before editing.',
    })
    expect(note.content).toContain('[REDACTED]')
    expect(note.content).not.toContain('super-secret')
    expect(note.content).toContain('Always explain security-sensitive changes before editing.')
  })

  it('keeps manual scanning separate from pending-work consolidation', async () => {
    const { ctx } = await setup()
    const work: string[] = []
    ctx.on('memory/pipeline-work-available', (reason) => { work.push(reason.kind) })

    await ctx.memory.requestScanAndConsolidation()
    expect(work).toEqual(['manual-scan'])

    await ctx.memory.rememberMemory({ content: 'Address me as 老大 in future replies.' })
    expect(work).toEqual(['manual-scan', 'ad-hoc'])
    await expect(ctx.memory.getProfileState()).resolves.toMatchObject({ pendingPhase2: true })
    await expect(ctx.memoryPipelineStore.claimPhase2({
      now: Date.now(),
      leaseMs: 120_000,
      maxSources: 32,
      maxAttempts: 3,
      maxUnusedDays: 30,
      includeAdHocNotes: false,
    })).resolves.toBeUndefined()

    await ctx.memory.requestConsolidation()
    expect(work).toEqual(['manual-scan', 'ad-hoc', 'manual-consolidation'])
    await expect(claimPhase2(ctx)).resolves.toMatchObject({ adHocNoteIds: [expect.any(String)] })
  })

  it('resets learned state and prevents rediscovery of pre-reset ranges', async () => {
    const { ctx } = await setup()
    await phase1(ctx)
    await ctx.memory.submitAdHocNote({ action: 'remember', content: 'Remember this until reset.' })
    await ctx.memory.resetMemory({ confirmation: 'reset-memory' })

    await expect(ctx.memory.getProfileState()).resolves.toMatchObject({ pendingPhase1: 0, pendingPhase2: false })
    await expect(ctx.memory.listAdHocNotes({ limit: 10 })).resolves.toEqual({ items: [] })
    await expect(ctx.memoryPipelineStore.registerSourceRanges([{
      sourceRangeId: MemorySourceRangeId('source-1'),
      sessionId: SessionId('interactive-1'),
      fromSeq: 0,
      toSeq: 3,
      completedAt: 1,
      sessionPurpose: 'interactive',
      policyVersion: 1,
    }])).resolves.toEqual({ inserted: 0, existing: 1 })
    await expect(ctx.memoryPipelineStore.registerSourceRanges([{
      sourceRangeId: MemorySourceRangeId('source-after-reset'),
      sessionId: SessionId('interactive-1'),
      fromSeq: 0,
      toSeq: 7,
      completedAt: 2,
      sessionPurpose: 'interactive',
      policyVersion: 1,
    }])).resolves.toEqual({ inserted: 1, existing: 0 })
    await expect(ctx.memoryPipelineStore.claimPhase1({ now: Date.now(), leaseMs: 60_000, maxAttempts: 3 }))
      .resolves.toMatchObject({ fromSeq: 4, toSeq: 7 })
  })

  it('cleanly rebuilds derived state while preserving active explicit intent and relearning old Sessions', async () => {
    const { ctx, root } = await setup()
    await phase1(ctx)
    const note = await ctx.memory.submitAdHocNote({ action: 'remember', content: 'Address me consistently in later replies.' })

    const rebuild = await ctx.memory.startCleanPolicyRebuild({ confirmation: 'clean-policy-rebuild', sourceLookbackMs: 432_000_000, explicitNotePolicy: 'preserve-active' })

    expect(rebuild).toMatchObject({ status: 'scanning', totalSessions: 0, extractedSessions: 0 })
    await expect(ctx.memory.getProfileState()).resolves.toMatchObject({
      generationStatus: 'none',
      pendingPhase1: 0,
      rebuild: { id: rebuild.id, status: 'scanning' },
    })
    await expect(ctx.memory.listAdHocNotes({ limit: 10 })).resolves.toMatchObject({
      items: [{ id: note.id, authorityStatus: 'active', processingStatus: 'pending' }],
    })
    await expect(ctx.memoryPipelineStore.registerSourceRanges([{
      sourceRangeId: MemorySourceRangeId('source-relearned'),
      sessionId: SessionId('interactive-1'),
      fromSeq: 0,
      toSeq: 3,
      completedAt: 1,
      sessionPurpose: 'interactive',
      policyVersion: 5,
    }])).resolves.toEqual({ inserted: 1, existing: 0 })

    await expect(claimPhase2(ctx)).resolves.toBeUndefined()

    await ctx.memoryPipelineStore.reportCleanRebuildDiscovery({
      rebuildId: rebuild.id,
      totalSessions: 40,
      scannedSessions: 16,
      scanCursor: 16,
      waitingSessions: 1,
      scanComplete: false,
    })
    await expect(claimPhase2(ctx)).resolves.toBeUndefined()
    await ctx.memoryPipelineStore.reportCleanRebuildDiscovery({
      rebuildId: rebuild.id,
      totalSessions: 40,
      scannedSessions: 40,
      scanCursor: 0,
      waitingSessions: 0,
      scanComplete: true,
    })
    await expect(claimPhase2(ctx)).resolves.toBeUndefined()

    const phase1Claim = await ctx.memoryPipelineStore.claimPhase1({ now: Date.now(), leaseMs: 60_000, maxAttempts: 3 })
    if (phase1Claim === undefined) throw new Error('expected rebuilt Phase 1 claim')
    await ctx.memoryPipelineStore.commitPhase1Outcome(phase1Claim, { kind: 'empty' })
    await expect(claimPhase2(ctx, { includeAdHocNotes: false })).resolves.toMatchObject({ adHocNoteIds: [note.id] })

    await disposeContext(ctx)
    const reopened = await setup({ root })
    await expect(reopened.ctx.memoryPipelineStore.getActiveCleanRebuild()).resolves.toMatchObject({ id: rebuild.id })
  })

  it('does not record a failure reported by a stale pre-rebuild worker', async () => {
    const { ctx, root } = await setup()
    await ctx.memoryPipelineStore.registerSourceRanges([{
      sourceRangeId: MemorySourceRangeId('source-before-clean-rebuild'),
      sessionId: SessionId('interactive-1'),
      fromSeq: 0,
      toSeq: 3,
      completedAt: 1,
      sessionPurpose: 'interactive',
      policyVersion: 1,
    }])
    const claim = await ctx.memoryPipelineStore.claimPhase1({ now: Date.now(), leaseMs: 60_000, maxAttempts: 3 })
    if (claim === undefined) throw new Error('expected Phase 1 claim')
    await ctx.memory.startCleanPolicyRebuild({ confirmation: 'clean-policy-rebuild', sourceLookbackMs: 432_000_000, explicitNotePolicy: 'preserve-active' })

    await expect(ctx.memoryPipelineStore.recordFailure({
      phase: 'phase1',
      jobId: claim.jobId,
      ownerToken: claim.lease.ownerToken,
      category: 'provider-failure',
      message: 'old worker completed after the epoch changed',
      now: Date.now(),
    })).resolves.toEqual({ kind: 'stale' })

    const database = new DatabaseSync(join(root, 'state', 'memory.db'))
    try {
      expect(database.prepare('SELECT COUNT(*) AS count FROM failures').get()).toEqual({ count: 0 })
    } finally {
      database.close()
    }
  })

  it('rejects a Phase 2 result that omits a claimed note disposition', async () => {
    const { ctx } = await setup()
    await ctx.memory.submitAdHocNote({ action: 'remember', content: 'Prefer concise release notes.' })
    const claim = await claimPhase2(ctx)
    if (claim === undefined) throw new Error('expected Phase 2 claim')
    const workspace = await ctx.memoryPipelineStore.createPhase2Workspace(claim)
    const binding = await ctx.memoryPipelineStore.openMaintenanceSession(claim)
    await completeMaintenanceAudit(ctx, binding, workspace.stagingRoot)
    const materializing = await ctx.memoryPipelineStore.allocateGeneration(claim)
    await expect(ctx.memoryPipelineStore.validateAndPrepareGeneration({
      claim,
      workspace,
      materializing,
      maintenanceSessionId: binding.sessionId,
    })).rejects.toThrow('note dispositions')
  })

  it('persists optimistic runtime settings and exposes them without a restart', async () => {
    const first = await setup()
    const initial = await first.ctx.memory.getRuntimeSettings()
    expect(initial.idleMs).toBe(6 * 60 * 60_000)
    expect(initial.disableOnExternalContext).toBe(false)
    await expect(first.ctx.memory.updateRuntimeSettings(initial.revision, {
      disableOnExternalContext: 'false' as never,
    })).rejects.toMatchObject({ code: 'invalid-request' })
    const updated = await first.ctx.memory.updateRuntimeSettings(initial.revision, {
      idleMs: 2 * 60 * 60_000, disableOnExternalContext: true,
    })
    expect(updated).toMatchObject({ revision: initial.revision + 1, idleMs: 2 * 60 * 60_000, disableOnExternalContext: true })
    await expect(first.ctx.memory.updateRuntimeSettings(initial.revision, { idleMs: 1 })).rejects.toMatchObject({ code: 'conflict' })
    await disposeContext(first.ctx)

    const reopened = await setup({ root: first.root })
    await expect(reopened.ctx.memory.getRuntimeSettings()).resolves.toMatchObject({
      revision: updated.revision,
      idleMs: 2 * 60 * 60_000,
      disableOnExternalContext: true,
    })
  })

  it('turns a policy version change into a rebuild fence without clearing explicit intent', async () => {
    const { ctx } = await setup()
    await ctx.memoryPipelineStore.registerSourceRanges([{
      sourceRangeId: MemorySourceRangeId('policy-source-v1'),
      sessionId: SessionId('policy-session'),
      fromSeq: 0,
      toSeq: 3,
      completedAt: 1,
      sessionPurpose: 'interactive',
      policyVersion: 1,
    }])
    const phase1Claim = await ctx.memoryPipelineStore.claimPhase1({ now: Date.now(), leaseMs: 60_000, maxAttempts: 3 })
    if (phase1Claim === undefined) throw new Error('expected Phase 1 claim')
    const note = await ctx.memory.submitAdHocNote({ action: 'remember', content: 'Keep this explicit preference during rebuild.' })
    const phase2Claim = await claimPhase2(ctx, { leaseMs: 60_000, maxSources: 8 })
    if (phase2Claim === undefined) throw new Error('expected Phase 2 claim')
    const settings = await ctx.memory.getRuntimeSettings()

    await ctx.memory.updateRuntimeSettings(settings.revision, { policyVersion: settings.policyVersion + 1 })

    await expect(ctx.memoryPipelineStore.commitPhase1Outcome(phase1Claim, { kind: 'empty' })).rejects.toThrow('stale')
    await expect(ctx.memoryPipelineStore.createPhase2Workspace(phase2Claim)).rejects.toThrow('stale')
    await expect(ctx.memory.listAdHocNotes({ limit: 10 })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: note.id, processingStatus: 'pending', authorityStatus: 'active' })],
    })
    await expect(ctx.memoryPipelineStore.registerSourceRanges([{
      sourceRangeId: MemorySourceRangeId('policy-source-v2'),
      sessionId: SessionId('policy-session'),
      fromSeq: 0,
      toSeq: 3,
      completedAt: 1,
      sessionPurpose: 'interactive',
      policyVersion: settings.policyVersion + 1,
    }])).resolves.toEqual({ inserted: 1, existing: 0 })
  })

  it('excludes a legacy generation and starts its rebuild from blank canonical files', async () => {
    const { ctx } = await setup()
    await phase1(ctx)
    const initialClaim = await claimPhase2(ctx)
    if (initialClaim === undefined) throw new Error('expected initial Phase 2 claim')
    const { prepared } = await preparePhase2(ctx, initialClaim)
    await ctx.memoryPipelineStore.publishGeneration({ claim: initialClaim, prepared })
    await expect(ctx.memory.getProfileState()).resolves.toMatchObject({ generationStatus: 'ready' })

    await ctx.memory.submitAdHocNote({ action: 'remember', content: 'Keep this explicit request during the clean rebuild.' })
    const settings = await ctx.memory.getRuntimeSettings()
    await ctx.memory.updateRuntimeSettings(settings.revision, { policyVersion: settings.policyVersion + 1 })

    await expect(ctx.memory.getProfileState()).resolves.toMatchObject({ generationStatus: 'rebuild-required' })
    await expect(ctx.memory.acquirePromptSnapshot({ sessionId: SessionId('interactive-1'), maxSummaryBytes: 4_096, leaseOwner: 'test' }))
      .resolves.toEqual({ kind: 'skipped', reason: 'incompatible-generation' })
    await expect(ctx.memory.listMemoryItems({ limit: 20 })).resolves.toMatchObject({ items: [] })

    const rebuildClaim = await claimPhase2(ctx)
    if (rebuildClaim === undefined) throw new Error('expected rebuild Phase 2 claim')
    const workspace = await ctx.memoryPipelineStore.createPhase2Workspace(rebuildClaim)
    await expect(readFile(join(workspace.stagingRoot, 'memory_summary.md'), 'utf8')).resolves.toBe(
      'v1\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What\'s in Memory\n',
    )
    await expect(readFile(join(workspace.stagingRoot, 'MEMORY.md'), 'utf8')).resolves.toBe('# Memory\n')
  })

  it('migrates a schema v3 profile by adding runtime settings without losing profile state', async () => {
    const first = await setup()
    await first.ctx.memory.submitAdHocNote({ action: 'remember', content: 'Retain this state through migration.' })
    await phase1(first.ctx)
    await disposeContext(first.ctx)
    const path = join(first.root, 'state', 'memory.db')
    const legacy = new DatabaseSync(path)
    legacy.exec('DROP TABLE runtime_settings')
    legacy.exec('PRAGMA user_version = 3')
    legacy.close()

    const reopened = await setup({ root: first.root })
    await expect(reopened.ctx.memory.listAdHocNotes({ limit: 10 })).resolves.toMatchObject({
      items: [expect.objectContaining({ content: 'Retain this state through migration.', processingStatus: 'pending', authorityStatus: 'active' })],
    })
    await expect(reopened.ctx.memory.getRuntimeSettings()).resolves.toMatchObject({ revision: 0 })
    await expect(claimPhase2(reopened.ctx, { leaseMs: 60_000, maxSources: 8 })).resolves.toBeDefined()
    const migrated = new DatabaseSync(path)
    try {
      expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10 })
    } finally {
      migrated.close()
    }
  })

  it('rejects a consolidation result produced against an older published baseline', async () => {
    const { ctx, root } = await setup()
    await phase1(ctx)
    const oldClaim = await claimPhase2(ctx)
    if (oldClaim === undefined) throw new Error('expected old Phase 2 claim')
    await ctx.memoryPipelineStore.createPhase2Workspace(oldClaim)

    const database = new DatabaseSync(join(root, 'state', 'memory.db'))
    try {
      database.prepare('UPDATE profile_state SET current_generation_id=? WHERE singleton=1').run('new-baseline')
    } finally {
      database.close()
    }

    await expect(ctx.memoryPipelineStore.allocateGeneration(oldClaim)).rejects.toThrow('baseline is stale')
  })

  it('finalizes a durable pointer before expiring its former owner', async () => {
    const first = await setup()
    await phase1(first.ctx)
    const claim = await claimPhase2(first.ctx)
    if (claim === undefined) throw new Error('expected Phase 2 claim')
    const { prepared } = await preparePhase2(first.ctx, claim)
    await writeFile(join(first.root, 'current.json'), `${JSON.stringify({
      formatVersion: 1,
      generationId: prepared.generationId,
      publishSequence: prepared.publishSequence,
      manifestSha256: prepared.manifestSha256,
    })}\n`)
    await disposeContext(first.ctx)

    const db = new DatabaseSync(join(first.root, 'state', 'memory.db'))
    db.prepare('UPDATE phase2_jobs SET leased_until=0').run()
    db.close()

    const reopened = await setup({ root: first.root })
    const recovery = await reopened.ctx.memoryPipelineStore.recover(new AbortController().signal)
    expect(recovery.finalizedGenerations).toBe(1)
    const state = await reopened.ctx.memory.getProfileState()
    expect(state.currentGenerationId).toBe(prepared.generationId)
    expect(state.pendingPhase2).toBe(false)
  })

  it('notifies one process when another connection changes public memory data', async () => {
    const first = await setup({ config: { changePollMs: 100 } })
    const second = await setup({ root: first.root, config: { changePollMs: 100 } })
    const changed = Promise.withResolvers<undefined>()
    first.ctx.on('memory/changed', () => { changed.resolve(undefined) })
    await second.ctx.memory.submitAdHocNote({ action: 'remember', content: 'Remember this cross-process request.' })
    await expect(Promise.race([
      changed.promise.then(() => 'changed'),
      new Promise<string>(resolve => setTimeout(() => { resolve('timeout') }, 2_000)),
    ])).resolves.toBe('changed')
  })

  it('reserves bounded audit capacity before a second provider dispatch', async () => {
    const { ctx } = await setup({ config: {
      maxAuditRequestBytes: 100,
      maxAuditResultBytes: 1_024,
      maxAuditAttempts: 10,
      maxAuditTotalBytes: 1_029,
    } })
    await phase1(ctx)
    await ctx.memoryPipelineStore.registerSourceRanges([{
      sourceRangeId: MemorySourceRangeId('source-2'),
      sessionId: SessionId('interactive-2'),
      fromSeq: 4,
      toSeq: 7,
      completedAt: 2,
      sessionPurpose: 'interactive',
      policyVersion: 1,
    }])
    const claim = await ctx.memoryPipelineStore.claimPhase1({ now: Date.now(), leaseMs: 60_000, maxAttempts: 3 })
    if (claim === undefined) throw new Error('expected second Phase 1 claim')
    const attempt = await ctx.memoryPipelineStore.beginPhase1Attempt(claim)
    await expect(ctx.memoryPipelineStore.recordPhase1Request({
      attemptId: attempt.attemptId,
      requestFingerprint: 'request-2',
      request: {},
      bytes: 2,
      recordedAt: Date.now(),
    })).rejects.toThrow('audit capacity')
  })
})

/** Local providers for the public memory service and private pipeline store. @module @deepseek-ai/dsh-memory-local */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import MemoryService, {
  type AdHocNote,
  type AdHocNoteListRequest,
  type AdHocNotePage,
  type MemoryFileReadRequest,
  type MemoryFileReadResult,
  type MemoryProfileState,
  type MemoryRebuild,
  type MemoryProfileControlPatch,
  type MemoryListRequest,
  type MemoryItemListRequest,
  type MemoryItemPage,
  type RememberMemoryRequest,
  type UpdateMemoryItemRequest,
  type DeleteMemoryItemRequest,
  type MemoryReadRequest,
  type MemorySearchHit,
  type MemorySearchRequest,
  type MemoryRuntimeSettings,
  type MemoryRuntimeSettingsPatch,
  type MemoryRuntimeSettingsValues,
  type MemoryPromptSnapshotResult,
  type MemoryPromptSnapshotRequest,
  type MemoryQuarantineListRequest,
  type MemoryQuarantinePage,
  type MemoryReadLeaseId,
  type MemoryTreePage,
  type MemoryTreeRequest,
  type QuarantineRangeId,
  type SessionMemoryControls,
  type SessionMemoryControlsPatch,
  type SubmitConversationMemoryRequest,
  type SubmitAdHocNoteRequest,
  type ResetMemoryRequest,
  type StartCleanPolicyRebuildRequest,
} from '@deepseek-ai/dsh-memory'
import MemoryPipelineStore, {
  type MaterializingGeneration,
  type MaintenanceSessionBinding,
  type MemoryFailureDisposition,
  type MemoryFailureRecord,
  type MemoryLease,
  type MemoryPruneRequest,
  type MemoryPruneResult,
  type MemoryRecoveryResult,
  type CleanRebuildDiscoveryProgress,
  type Phase1Attempt,
  type Phase1Claim,
  type Phase1ClaimRequest,
  type Phase1Outcome,
  type Phase2Claim,
  type Phase2ClaimRequest,
  type Phase2Workspace,
  type Phase2StructuredRequest,
  type Phase2StructuredResult,
  type MemoryAttemptId,
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
import type { SessionId } from '@deepseek-ai/dsh-session'
import { openLocalMemoryRuntime, type LocalMemoryConfig, type LocalMemoryRuntimeHandle } from './runtime.ts'

/** Local memory plugin configuration. */
export interface Config extends LocalMemoryConfig {}

/** Validated deployment configuration. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
  enabled: z.boolean().default(false),
  useByDefault: z.boolean().default(true),
  contributeByDefault: z.boolean().default(true),
  readLeaseMs: z.number().step(1).min(1).default(10 * 60_000),
  maxPromptSummaryBytes: z.number().step(1).min(1).default(32 * 1024),
  maxAdHocNoteBytes: z.number().step(1).min(1).default(64 * 1024),
  maxAuditRequestBytes: z.number().step(1).min(1).default(2 * 1024 * 1024),
  maxAuditResultBytes: z.number().step(1).min(1_024).default(2 * 1024 * 1024),
  maxAuditAttempts: z.number().step(1).min(1).default(20_000),
  maxAuditTotalBytes: z.number().step(1).min(1).default(2 * 1024 * 1024 * 1024),
  auditRetentionMs: z.number().step(1).min(1).default(30 * 24 * 60 * 60_000),
  changePollMs: z.number().step(1).min(100).default(1_000),
  maxFiles: z.number().step(1).min(3).default(2_000),
  maxFileBytes: z.number().step(1).min(1).default(2 * 1024 * 1024),
  maxTotalBytes: z.number().step(1).min(1).default(512 * 1024 * 1024),
  maxSummaryBytes: z.number().step(1).min(1).default(32 * 1024),
})

interface RuntimeConfig { readonly runtime: LocalMemoryRuntimeHandle }

/** Public facade over one shared local memory runtime. */
export class LocalMemoryService extends MemoryService {
  private readonly runtime: LocalMemoryRuntimeHandle

  constructor(ctx: Context, config: RuntimeConfig) {
    super(ctx)
    this.runtime = config.runtime
  }

  override getProfileState(): Promise<MemoryProfileState> { return this.runtime.getProfileState() }
  override updateProfileControls(expectedRevision: number, patch: MemoryProfileControlPatch): Promise<MemoryProfileState> {
    return this.runtime.updateProfileControls(expectedRevision, patch)
  }
  override getRuntimeSettings(): Promise<MemoryRuntimeSettings> { return this.runtime.getRuntimeSettings() }
  override updateRuntimeSettings(
    expectedRevision: number,
    patch: MemoryRuntimeSettingsPatch,
  ): Promise<MemoryRuntimeSettings> {
    return this.runtime.updateRuntimeSettings(expectedRevision, patch)
  }
  override getSessionControls(sessionId: SessionId): Promise<SessionMemoryControls> { return this.runtime.getSessionControls(sessionId) }
  override setSessionControls(
    sessionId: SessionId,
    expectedRevision: number,
    patch: SessionMemoryControlsPatch,
  ): Promise<SessionMemoryControls> {
    return this.runtime.setSessionControls(sessionId, expectedRevision, patch)
  }
  override acquirePromptSnapshot(
    request: MemoryPromptSnapshotRequest,
  ): Promise<MemoryPromptSnapshotResult> {
    return this.runtime.acquirePromptSnapshot(request)
  }
  override releaseReadLease(leaseId: MemoryReadLeaseId): Promise<void> { return this.runtime.releaseReadLease(leaseId) }
  override listGenerationTree(request: MemoryTreeRequest): Promise<MemoryTreePage> { return this.runtime.listGenerationTree(request) }
  override readGenerationFile(request: MemoryFileReadRequest): Promise<MemoryFileReadResult> {
    return this.runtime.readGenerationFile(request)
  }
  override listMemoryItems(request: MemoryItemListRequest): Promise<MemoryItemPage> { return this.runtime.listMemoryItems(request) }
  override rememberMemory(request: RememberMemoryRequest): Promise<AdHocNote> { return this.runtime.rememberMemory(request) }
  override updateMemoryItem(request: UpdateMemoryItemRequest): Promise<AdHocNote> { return this.runtime.updateMemoryItem(request) }
  override deleteMemoryItem(request: DeleteMemoryItemRequest): Promise<AdHocNote> { return this.runtime.deleteMemoryItem(request) }
  override listMemory(request: MemoryListRequest): Promise<readonly MemorySearchHit[]> { return this.runtime.listMemory(request) }
  override searchMemory(request: MemorySearchRequest): Promise<readonly MemorySearchHit[]> { return this.runtime.searchMemory(request) }
  override readMemory(request: MemoryReadRequest): Promise<MemoryFileReadResult> { return this.runtime.readMemory(request) }
  override listAdHocNotes(request: AdHocNoteListRequest): Promise<AdHocNotePage> { return this.runtime.listAdHocNotes(request) }
  override submitAdHocNote(request: SubmitAdHocNoteRequest): Promise<AdHocNote> { return this.runtime.submitAdHocNote(request) }
  override submitConversationMemory(request: SubmitConversationMemoryRequest): Promise<AdHocNote> {
    return this.runtime.submitConversationMemory(request)
  }
  override requestScanAndConsolidation(): Promise<void> { return this.runtime.requestScanAndConsolidation() }
  override requestConsolidation(): Promise<void> { return this.runtime.requestConsolidation() }
  override startCleanPolicyRebuild(request: StartCleanPolicyRebuildRequest): Promise<MemoryRebuild> {
    return this.runtime.startCleanPolicyRebuild(request)
  }
  override listQuarantines(request: MemoryQuarantineListRequest): Promise<MemoryQuarantinePage> {
    return this.runtime.listQuarantines(request)
  }
  override retryQuarantine(id: QuarantineRangeId): Promise<void> { return this.runtime.retryQuarantine(id) }
  override resetMemory(request: ResetMemoryRequest): Promise<void> { return this.runtime.resetMemory(request) }
}

/** Private pipeline facade over the same local runtime. */
export class LocalMemoryPipelineStore extends MemoryPipelineStore {
  private readonly runtime: LocalMemoryRuntimeHandle

  constructor(ctx: Context, config: RuntimeConfig) {
    super(ctx)
    this.runtime = config.runtime
  }

  override initializeRuntimeSettings(defaults: MemoryRuntimeSettingsValues): Promise<MemoryRuntimeSettings> {
    return this.runtime.initializeRuntimeSettings(defaults)
  }
  override getRuntimeSettings(): Promise<MemoryRuntimeSettings> { return this.runtime.getRuntimeSettings() }
  override readConsolidationInput(claim: Phase2Claim, workspace: Phase2Workspace) {
    return this.runtime.readConsolidationInput(claim, workspace)
  }
  override recordPhase2Request(request: Phase2StructuredRequest) { return this.runtime.recordPhase2Request(request) }
  override recordPhase2Result(result: Phase2StructuredResult) { return this.runtime.recordPhase2Result(result) }
  override applyConsolidationResult(claim: Phase2Claim, workspace: Phase2Workspace, attemptId: MemoryAttemptId) {
    return this.runtime.applyConsolidationResult(claim, workspace, attemptId)
  }

  override recover(signal: AbortSignal): Promise<MemoryRecoveryResult> { return this.runtime.recover(signal) }
  override getActiveCleanRebuild(): Promise<MemoryRebuild | undefined> { return this.runtime.getActiveCleanRebuild() }
  override reportCleanRebuildDiscovery(progress: CleanRebuildDiscoveryProgress): Promise<void> {
    return this.runtime.reportCleanRebuildDiscovery(progress)
  }
  override registerSourceRanges(
    ranges: readonly RegisterSourceRange[],
  ): Promise<RegisterSourceRangeResult> {
    return this.runtime.registerSourceRanges(ranges)
  }
  override claimPhase1(request: Phase1ClaimRequest): Promise<Phase1Claim | undefined> { return this.runtime.claimPhase1(request) }
  override beginPhase1Attempt(claim: Phase1Claim): Promise<Phase1Attempt> { return this.runtime.beginPhase1Attempt(claim) }
  override recordPhase1Request(request: RecordedPhase1Request): Promise<void> { return this.runtime.recordPhase1Request(request) }
  override recordPhase1Result(result: RecordedPhase1Result): Promise<void> { return this.runtime.recordPhase1Result(result) }
  override commitPhase1Outcome(claim: Phase1Claim, outcome: Phase1Outcome): Promise<void> {
    return this.runtime.commitPhase1Outcome(claim, outcome)
  }
  override claimPhase2(request: Phase2ClaimRequest): Promise<Phase2Claim | undefined> { return this.runtime.claimPhase2(request) }
  override createPhase2Workspace(claim: Phase2Claim): Promise<Phase2Workspace> { return this.runtime.createPhase2Workspace(claim) }
  override openMaintenanceSession(claim: Phase2Claim): Promise<MaintenanceSessionBinding> {
    return this.runtime.openMaintenanceSession(claim)
  }
  override allocateGeneration(claim: Phase2Claim): Promise<MaterializingGeneration> { return this.runtime.allocateGeneration(claim) }
  override validateAndPrepareGeneration(request: PrepareGenerationRequest): Promise<PreparedGeneration> {
    return this.runtime.validateAndPrepareGeneration(request)
  }
  override publishGeneration(request: PublishGenerationRequest): Promise<PublishedGeneration> {
    return this.runtime.publishGeneration(request)
  }
  override renewLease(request: RenewMemoryLeaseRequest): Promise<MemoryLease> { return this.runtime.renewLease(request) }
  override recordFailure(request: MemoryFailureRecord): Promise<MemoryFailureDisposition> { return this.runtime.recordFailure(request) }
  override prune(request: MemoryPruneRequest): Promise<MemoryPruneResult> { return this.runtime.prune(request) }
}

/** Install both services over one state handle and close it after both facades detach. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.effect(async function* () {
    const runtime = await openLocalMemoryRuntime(ctx, config)
    yield () => runtime.close()
    const observeAuditFailure = (operation: Promise<void>, sessionId: SessionId): void => {
      void operation.catch((error: unknown) => {
        ctx.logger.warn(`memory-local: private maintenance audit for "${sessionId}" failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    ctx.on('session/created', (session) => {
      if (session.header.purpose === 'maintenance') observeAuditFailure(runtime.registerMaintenanceSession(session), session.id)
    }, { global: true })
    ctx.on('session/event', (session, event) => {
      if (session.header.purpose === 'maintenance') observeAuditFailure(runtime.recordMaintenanceSessionEvent(session, event), session.id)
    }, { global: true })
    ctx.on('session/flush', session => session.header.purpose === 'maintenance'
      ? runtime.flushMaintenanceSession(session.id)
      : undefined, { global: true })
    ctx.on('session/disposed', (session) => {
      if (session.header.purpose === 'maintenance') observeAuditFailure(runtime.completeMaintenanceSession(session), session.id)
    }, { global: true })
    ctx.on('session/event', (session, event) => {
      if (session.header.purpose !== 'interactive' || event.type !== 'assistant/message') return
      const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      if (text.length === 0) return
      void runtime.recordCitations(text).catch((error: unknown) => {
        ctx.logger.warn(`memory-local: failed to record a memory citation: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, { global: true })
    const publicService = ctx.plugin(LocalMemoryService, { runtime })
    await publicService
    yield publicService.dispose
    const pipelineStore = ctx.plugin(LocalMemoryPipelineStore, { runtime })
    await pipelineStore
    yield pipelineStore.dispose
  }, 'memory-local.services')
}

export { MEMORY_APPLICATION_ID, MEMORY_SCHEMA_VERSION } from './schema.ts'
export type { GenerationManifest, GenerationManifestFile, GenerationManifestSourceAnchor } from './manifest.ts'

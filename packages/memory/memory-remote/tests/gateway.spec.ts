import { Context } from '@deepseek-ai/cordis'
import MemoryService, {
  type AdHocNote,
  type AdHocNoteListRequest,
  type AdHocNotePage,
  type MemoryFileReadRequest,
  type MemoryFileReadResult,
  type MemoryListRequest,
  type MemoryItemListRequest,
  type MemoryItemPage,
  type RememberMemoryRequest,
  type UpdateMemoryItemRequest,
  type DeleteMemoryItemRequest,
  type MemoryProfileControlPatch,
  type MemoryProfileState,
  type MemoryReadRequest,
  type MemorySearchHit,
  type MemorySearchRequest,
  type MemoryRuntimeSettings,
  type MemoryRuntimeSettingsPatch,
  type MemoryPromptSnapshotResult,
  type MemoryPromptSnapshotRequest,
  type MemoryQuarantineListRequest,
  type MemoryQuarantinePage,
  type MemoryReadLeaseId,
  type MemoryTreePage,
  type MemoryTreeRequest,
  type QuarantineRangeId,
  type ResetMemoryRequest,
  type StartCleanPolicyRebuildRequest,
  type MemoryRebuild,
  type SessionMemoryControls,
  type SessionMemoryControlsPatch,
  type SubmitAdHocNoteRequest,
  type SubmitConversationMemoryRequest,
} from '@deepseek-ai/dsh-memory'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import MemoryRemoteGateway from '../src/index.ts'

class FakeMemoryService extends MemoryService {
  override getProfileState(): Promise<MemoryProfileState> { return Promise.reject(new Error('unused')) }
  override updateProfileControls(_revision: number, _patch: MemoryProfileControlPatch): Promise<MemoryProfileState> { return Promise.reject(new Error('unused')) }
  override getRuntimeSettings(): Promise<MemoryRuntimeSettings> { return Promise.reject(new Error('unused')) }
  override updateRuntimeSettings(_revision: number, _patch: MemoryRuntimeSettingsPatch): Promise<MemoryRuntimeSettings> { return Promise.reject(new Error('unused')) }
  override getSessionControls(_sessionId: SessionId): Promise<SessionMemoryControls> { return Promise.reject(new Error('unused')) }
  override setSessionControls(_sessionId: SessionId, _expectedRevision: number, _patch: SessionMemoryControlsPatch): Promise<SessionMemoryControls> { return Promise.reject(new Error('unused')) }
  override acquirePromptSnapshot(_request: MemoryPromptSnapshotRequest): Promise<MemoryPromptSnapshotResult> { return Promise.reject(new Error('unused')) }
  override releaseReadLease(_leaseId: MemoryReadLeaseId): Promise<void> { return Promise.reject(new Error('unused')) }
  override listGenerationTree(_request: MemoryTreeRequest): Promise<MemoryTreePage> { return Promise.reject(new Error('unused')) }
  override readGenerationFile(_request: MemoryFileReadRequest): Promise<MemoryFileReadResult> { return Promise.reject(new Error('unused')) }
  override listMemoryItems(_request: MemoryItemListRequest): Promise<MemoryItemPage> {
    return Promise.resolve({ items: [], sourceUsage: [] })
  }
  override rememberMemory(_request: RememberMemoryRequest): Promise<AdHocNote> { return Promise.reject(new Error('unused')) }
  override updateMemoryItem(_request: UpdateMemoryItemRequest): Promise<AdHocNote> { return Promise.reject(new Error('unused')) }
  override deleteMemoryItem(_request: DeleteMemoryItemRequest): Promise<AdHocNote> { return Promise.reject(new Error('unused')) }
  override listMemory(_request: MemoryListRequest): Promise<readonly MemorySearchHit[]> { return Promise.reject(new Error('unused')) }
  override searchMemory(_request: MemorySearchRequest): Promise<readonly MemorySearchHit[]> { return Promise.reject(new Error('unused')) }
  override readMemory(_request: MemoryReadRequest): Promise<MemoryFileReadResult> { return Promise.reject(new Error('unused')) }
  override listAdHocNotes(_request: AdHocNoteListRequest): Promise<AdHocNotePage> { return Promise.reject(new Error('unused')) }
  override submitAdHocNote(_request: SubmitAdHocNoteRequest): Promise<AdHocNote> { return Promise.reject(new Error('unused')) }
  override submitConversationMemory(_request: SubmitConversationMemoryRequest): Promise<AdHocNote> { return Promise.reject(new Error('unused')) }
  override requestScanAndConsolidation(): Promise<void> { return Promise.resolve() }
  override requestConsolidation(): Promise<void> { return Promise.resolve() }
  override listQuarantines(_request: MemoryQuarantineListRequest): Promise<MemoryQuarantinePage> { return Promise.reject(new Error('unused')) }
  override retryQuarantine(_id: QuarantineRangeId): Promise<void> { return Promise.reject(new Error('unused')) }
  override resetMemory(_request: ResetMemoryRequest): Promise<void> { return Promise.reject(new Error('unused')) }
  override startCleanPolicyRebuild(_request: StartCleanPolicyRebuildRequest): Promise<MemoryRebuild> { return Promise.reject(new Error('unused')) }
}

describe('MemoryRemoteGateway', () => {
  const contexts: Context[] = []
  afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.fiber.dispose())) })

  it('uses a distinct Cordis service key while exporting the memory wire namespace', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(FakeMemoryService)
    const gateway = ctx.plugin(MemoryRemoteGateway)
    await gateway

    expect(ctx.memory).toBeInstanceOf(FakeMemoryService)
    const registered = ctx.get('memoryRemote') as MemoryRemoteGateway
    expect(registered).toBeInstanceOf(MemoryRemoteGateway)
    expect(registered.typertRemote).toMatchObject({ serviceKey: 'memoryRemote', namespace: 'memory' })
  })
})

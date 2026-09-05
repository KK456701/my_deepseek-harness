/** Trusted Host Remote adapter for public profile-memory operations. @module @deepseek-ai/dsh-memory-remote */

import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-memory'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  AdHocNote,
  AdHocNoteListRequest,
  AdHocNotePage,
  MemoryFileReadRequest,
  MemoryFileReadResult,
  MemoryProfileState,
  MemoryRebuild,
  MemoryItemListRequest,
  MemoryItemPage,
  RememberMemoryRequest,
  UpdateMemoryItemRequest,
  DeleteMemoryItemRequest,
  MemoryProfileControlPatch,
  MemoryRuntimeSettings,
  MemoryRuntimeSettingsPatch,
  MemoryQuarantineListRequest,
  MemoryQuarantinePage,
  MemoryTreePage,
  MemoryTreeRequest,
  ResetMemoryRequest,
  StartCleanPolicyRebuildRequest,
  QuarantineRangeId,
  SessionMemoryControls,
  SessionMemoryControlsPatch,
  SubmitAdHocNoteRequest,
} from '@deepseek-ai/dsh-memory/types'

/** Remote Consumer that delegates every operation to the public MemoryService. */
export class MemoryRemoteGateway extends TypertRemoteService {
  static inject = ['memory']

  constructor(ctx: Context) {
    super(ctx, 'memoryRemote', { namespace: 'memory' })
  }

  /**
   * Read profile-level memory status and counters.
   * @returns Current public state.
   */
  @Remote('getProfileState')
  getProfileState(): Promise<MemoryProfileState> {
    return this.ctx.memory.getProfileState()
  }

  /**
   * Apply live profile enable/use/contribute defaults.
   * @param expectedRevision - Control revision observed by the caller.
   * @param patch - Switches to replace.
   * @returns Complete committed profile state.
   */
  @Remote('updateProfileControls')
  updateProfileControls(expectedRevision: number, patch: MemoryProfileControlPatch): Promise<MemoryProfileState> {
    return this.ctx.memory.updateProfileControls(expectedRevision, patch)
  }

  /**
   * Read effective live scheduler settings.
   * @returns Revisioned profile settings.
   */
  @Remote('getRuntimeSettings')
  getRuntimeSettings(): Promise<MemoryRuntimeSettings> {
    return this.ctx.memory.getRuntimeSettings()
  }

  /**
   * Apply one optimistic live scheduler-settings update.
   * @param expectedRevision - Revision observed by the caller.
   * @param patch - Values to replace.
   * @returns Complete committed settings.
   */
  @Remote('updateRuntimeSettings')
  updateRuntimeSettings(
    expectedRevision: number,
    patch: MemoryRuntimeSettingsPatch,
  ): Promise<MemoryRuntimeSettings> {
    return this.ctx.memory.updateRuntimeSettings(expectedRevision, patch)
  }

  /**
   * Read explicit controls for one interactive Session.
   * @param sessionId - Session whose controls are requested.
   * @returns Current revisioned controls.
   */
  @Remote('getSessionControls')
  getSessionControls(sessionId: SessionId): Promise<SessionMemoryControls> {
    return this.ctx.memory.getSessionControls(sessionId)
  }

  /**
   * Apply one optimistic Session-control update.
   * @param sessionId - Interactive Session whose controls change.
   * @param expectedRevision - Revision observed by the caller.
   * @param patch - Explicit control values to replace.
   * @returns Committed control state.
   */
  @Remote('setSessionControls')
  setSessionControls(sessionId: SessionId, expectedRevision: number, patch: SessionMemoryControlsPatch): Promise<SessionMemoryControls> {
    return this.ctx.memory.setSessionControls(sessionId, expectedRevision, patch)
  }

  /**
   * List one verified generation-tree page.
   * @param request - Generation and cursor selection.
   * @returns The selected page.
   */
  @Remote('listGenerationTree')
  listGenerationTree(request: MemoryTreeRequest): Promise<MemoryTreePage> {
    return this.ctx.memory.listGenerationTree(request)
  }

  /**
   * Read one verified generation file range.
   * @param request - Generation file byte range.
   * @returns One bounded UTF-8 segment.
   */
  @Remote('readGenerationFile')
  readGenerationFile(request: MemoryFileReadRequest): Promise<MemoryFileReadResult> {
    return this.ctx.memory.readGenerationFile(request)
  }

  /**
   * List semantic memory items available to the management UI.
   * @param request - Generation and pagination selection.
   * @returns Current semantic cards.
   */
  @Remote('listMemoryItems')
  listMemoryItems(request: MemoryItemListRequest): Promise<MemoryItemPage> {
    return this.ctx.memory.listMemoryItems(request)
  }

  /**
   * Submit an explicit new memory.
   * @param request - User-authored body.
   * @returns Persisted pending note.
   */
  @Remote('rememberMemory')
  rememberMemory(request: RememberMemoryRequest): Promise<AdHocNote> {
    return this.ctx.memory.rememberMemory(request)
  }

  /**
   * Submit a revision-safe memory replacement.
   * @param request - Current target hash and replacement text.
   * @returns Persisted update note.
   */
  @Remote('updateMemoryItem')
  updateMemoryItem(request: UpdateMemoryItemRequest): Promise<AdHocNote> {
    return this.ctx.memory.updateMemoryItem(request)
  }

  /**
   * Submit a revision-safe memory deletion.
   * @param request - Current target hash.
   * @returns Persisted forget note.
   */
  @Remote('deleteMemoryItem')
  deleteMemoryItem(request: DeleteMemoryItemRequest): Promise<AdHocNote> {
    return this.ctx.memory.deleteMemoryItem(request)
  }

  /**
   * List one deterministic ad-hoc-note page.
   * @param request - Note status and cursor selection.
   * @returns The selected page.
   */
  @Remote('listAdHocNotes')
  listAdHocNotes(request: AdHocNoteListRequest): Promise<AdHocNotePage> {
    return this.ctx.memory.listAdHocNotes(request)
  }

  /**
   * Submit an explicit user-authored consolidation instruction.
   * @param request - Note body and replacement relation.
   * @returns Persisted note.
   */
  @Remote('submitAdHocNote')
  submitAdHocNote(request: SubmitAdHocNoteRequest): Promise<AdHocNote> {
    return this.ctx.memory.submitAdHocNote(request)
  }

  /** Wake a bounded history scan and its later consolidation without waiting for publication. */
  @Remote('requestScanAndConsolidation')
  requestScanAndConsolidation(): Promise<void> {
    return this.ctx.memory.requestScanAndConsolidation()
  }

  /** Wake consolidation for already durable work without waiting for publication. */
  @Remote('requestConsolidation')
  requestConsolidation(): Promise<void> {
    return this.ctx.memory.requestConsolidation()
  }

  /**
   * Delete derived state and relearn eligible turns inside a frozen time window.
   * @param request - Confirmation, lookback duration, and explicit-request policy.
   * @returns Durable rebuild progress.
   */
  @Remote('startCleanPolicyRebuild')
  startCleanPolicyRebuild(request: StartCleanPolicyRebuildRequest): Promise<MemoryRebuild> {
    return this.ctx.memory.startCleanPolicyRebuild(request)
  }

  /**
   * List quarantined source and consolidation ranges.
   * @param request - Cursor selection.
   * @returns Ranges awaiting retry.
   */
  @Remote('listQuarantines')
  listQuarantines(request: MemoryQuarantineListRequest): Promise<MemoryQuarantinePage> {
    return this.ctx.memory.listQuarantines(request)
  }

  /**
   * Requeue a quarantined source or Phase 2 range.
   * @param id - Range selected by the user.
   */
  @Remote('retryQuarantine')
  retryQuarantine(id: QuarantineRangeId): Promise<void> {
    return this.ctx.memory.retryQuarantine(id)
  }

  /**
   * Clear learned memory after an explicit management confirmation.
   * @param request - Exact reset confirmation.
   */
  @Remote('resetMemory')
  resetMemory(request: ResetMemoryRequest): Promise<void> {
    return this.ctx.memory.resetMemory(request)
  }
}

export default MemoryRemoteGateway

/** Public long-term-memory Service Definition. @module @deepseek-ai/dsh-memory */

import { Context, Service } from '@deepseek-ai/cordis'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  AdHocNote,
  AdHocNoteId as AdHocNoteIdType,
  AdHocNoteListRequest,
  AdHocNotePage,
  MemoryErrorCode,
  MemoryFileReadRequest,
  MemoryFileReadResult,
  MemoryGenerationId as MemoryGenerationIdType,
  MemoryItemId as MemoryItemIdType,
  MemoryRebuild,
  MemoryRebuildId as MemoryRebuildIdType,
  MemoryItemPage,
  MemoryItemListRequest,
  RememberMemoryRequest,
  UpdateMemoryItemRequest,
  DeleteMemoryItemRequest,
  MemoryProfileState,
  MemoryProfileControlPatch,
  MemoryListRequest,
  MemoryReadRequest,
  MemorySearchHit,
  MemorySearchRequest,
  MemoryRuntimeSettings,
  MemoryRuntimeSettingsPatch,
  MemoryPromptSnapshotResult,
  MemoryPromptSnapshotRequest,
  MemoryQuarantineListRequest,
  MemoryQuarantinePage,
  MemoryReadLeaseId as MemoryReadLeaseIdType,
  MemoryTreePage,
  MemoryTreeRequest,
  QuarantineRangeId as QuarantineRangeIdType,
  SessionMemoryControls,
  SessionMemoryControlsPatch,
  SubmitConversationMemoryRequest,
  SubmitAdHocNoteRequest,
  ResetMemoryRequest,
  StartCleanPolicyRebuildRequest,
} from './types.ts'

export type {
  AdHocNote,
  AdHocNoteListRequest,
  AdHocNotePage,
  MemoryUpdateAction,
  NoteAuthorityStatus,
  NoteProcessingStatus,
  MemoryErrorCode,
  MemoryFileReadRequest,
  MemoryFileReadResult,
  MemoryGenerationFileRole,
  MemoryItem,
  MemoryItemTarget,
  MemoryItemPage,
  MemorySourceUsage,
  MemoryItemListRequest,
  MemoryRebuild,
  MemoryRebuildStatus,
  RememberMemoryRequest,
  UpdateMemoryItemRequest,
  DeleteMemoryItemRequest,
  MemoryProfileState,
  MemoryProfileControlPatch,
  MemoryListRequest,
  MemoryReadRequest,
  MemorySearchHit,
  MemorySearchRequest,
  MemoryRuntimeSettings,
  MemoryRuntimeSettingsPatch,
  MemoryRuntimeSettingsValues,
  MemoryPromptSnapshot,
  MemoryPromptSnapshotResult,
  MemoryPromptSkipReason,
  MemoryRequestContext,
  MemoryPromptSnapshotRequest,
  MemoryQuarantineItem,
  MemoryQuarantineListRequest,
  MemoryQuarantinePage,
  MemoryTreeEntry,
  MemoryTreePage,
  MemoryTreeRequest,
  SessionMemoryControls,
  SessionMemoryControlsPatch,
  SubmitConversationMemoryRequest,
  SubmitAdHocNoteRequest,
  ResetMemoryRequest,
  StartCleanPolicyRebuildRequest,
} from './types.ts'

/** Identity of one immutable published memory generation. */
export type MemoryGenerationId = MemoryGenerationIdType
/** Identity of one expiring generation read lease. */
export type MemoryReadLeaseId = MemoryReadLeaseIdType
/** Identity of one quarantined source range. */
export type QuarantineRangeId = QuarantineRangeIdType
/** Identity of one user-authored consolidation request. */
export type AdHocNoteId = AdHocNoteIdType

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Memory selection observed at a dispatched interactive request; contains no model input. */
    'memory/context': import('./types.ts').MemoryRequestContext
  }
}
/** Identity of one semantic memory item. */
export type MemoryItemId = MemoryItemIdType
/** Identity of one durable clean policy rebuild. */
export type MemoryRebuildId = MemoryRebuildIdType

/**
 * Brand a published memory generation identity.
 * @param value - Persisted opaque id.
 * @returns Branded generation id.
 */
export const MemoryGenerationId = (value: string): MemoryGenerationId => value as MemoryGenerationId
/**
 * Brand a memory read lease identity.
 * @param value - Persisted opaque id.
 * @returns Branded read-lease id.
 */
export const MemoryReadLeaseId = (value: string): MemoryReadLeaseId => value as MemoryReadLeaseId
/**
 * Brand a quarantine range identity.
 * @param value - Persisted opaque id.
 * @returns Branded quarantine id.
 */
export const QuarantineRangeId = (value: string): QuarantineRangeId => value as QuarantineRangeId
/**
 * Brand an ad-hoc note identity.
 * @param value - Persisted opaque id.
 * @returns Branded note id.
 */
export const AdHocNoteId = (value: string): AdHocNoteId => value as AdHocNoteId
/**
 * Brand one derived semantic memory identity.
 * @param value - Deterministic opaque item id.
 * @returns Branded semantic memory id.
 */
export const MemoryItemId = (value: string): MemoryItemId => value as MemoryItemId
/**
 * Brand one durable rebuild identity.
 * @param value - Opaque rebuild id.
 * @returns Branded rebuild id.
 */
export const MemoryRebuildId = (value: string): MemoryRebuildIdType => value as MemoryRebuildIdType

/** Policy shared by versioned extraction, consolidation, manifest, and read-path checks. */
export const MEMORY_POLICY_VERSION = 7
/** SHA-256 identity of the canonical extraction and consolidation template bytes. */
export const MEMORY_TEMPLATE_VERSION = 'sha256-5224bc6b0bcec4d3a52b3e6d71ebc24aea5089510533ca569907582891828d48'
/** Existing extraction identity, independent of consolidation-only wording changes. */
export const MEMORY_EXTRACTION_TEMPLATE_VERSION = 'sha256-895c36283c9cd254b1123ac1ca99761d5d034f8e831b381024e224878030b257'

const MEMORY_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/giu,
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\b(\s*[:=]\s*)([^\s,;]+)/giu,
]

/**
 * Replace high-confidence credential fields before memory text becomes model-visible or durable memory state.
 * @param text - Untrusted Session, note, or generated text.
 * @returns Deterministically redacted text.
 */
export function redactMemoryText(text: string): string {
  return MEMORY_SECRET_PATTERNS.reduce(
    (value, pattern, index) => value.replace(pattern, index === 0 ? '[REDACTED PRIVATE KEY]' : '$1$2[REDACTED]'),
    text,
  )
}

/**
 * Redact string fields without changing JSON syntax.
 * @param value - Model result or evidence.
 * @returns A redacted JSON value.
 */
export function redactMemoryJson(value: JsonValue): JsonValue {
  if (typeof value === 'string') return redactMemoryText(value)
  if (Array.isArray(value)) return value.map(redactMemoryJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactMemoryJson(item)]))
  }
  return value
}

/**
 * Detect whether a generated field still contains a high-confidence credential after redaction.
 * @param text - Generated memory or model-visible audit text.
 * @returns Whether publication must fail closed.
 */
export function containsMemorySecret(text: string): boolean {
  return redactMemoryText(text) !== text
}

/** Built-in scheduler defaults used until a configured scheduler initializes a profile. */
export const DEFAULT_MEMORY_RUNTIME_SETTINGS: import('./types.ts').MemoryRuntimeSettingsValues = {
  extractionBackend: 'llm',
  consolidationBackend: 'llm',
  extractionReasoningEffort: 'high',
  rebuildLookbackMs: 5 * 24 * 60 * 60_000,
  idleMs: 6 * 60 * 60_000,
  maxSourceAgeMs: 10 * 24 * 60 * 60_000,
  maxUnusedDays: 30,
  minRemainingQuotaPercent: 25,
  scanSessionsPerRun: 64,
  maxRangesPerRun: 128,
  maxPhase1ClaimsPerRun: 2,
  phase1Concurrency: 2,
  phase1LeaseMs: 60 * 60_000,
  phase2LeaseMs: 20 * 60_000,
  providerTimeoutMs: 10 * 60_000,
  maxAttempts: 3,
  retryBaseMs: 60_000,
  maxCandidatesPerRange: 64,
  maxPhase2Sources: 256,
  maxEvidenceBytes: 512 * 1024,
  maxResultBytes: 2 * 1024 * 1024,
  extractionProvider: 'deepseek-official',
  extractionModel: 'deepseek-v4-flash',
  extractionMaxTokens: 8_192,
  consolidationProvider: 'deepseek-official',
  consolidationModel: 'deepseek-v4-flash',
  consolidationReasoningEffort: 'inherit',
  consolidationMaxTokens: 32_768,
  promptSummaryMaxBytes: 32 * 1024,
  recallMaxPasses: 2,
  recallMaxToolCalls: 6,
  recallMaxDetailFiles: 2,
  phase2MaxFileBytes: 2 * 1024 * 1024,
  phase2SearchMaxFiles: 512,
  phase2SearchMaxMatches: 256,
  skillMinSupportingTasks: 2,
  disableOnExternalContext: false,
  externalToolPrefixes: ['web', 'mcp', 'tool_search'],
  policyVersion: MEMORY_POLICY_VERSION,
  pruneRowsPerRun: 100,
  pruneBytesPerRun: 64 * 1024 * 1024,
  fallbackWakeMs: 15 * 60_000,
}

/** Classified public memory-service failure. */
export class MemoryError extends Error {
  override readonly name = 'MemoryError'

  /** Construct one public memory failure. */
  constructor(readonly code: MemoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }

  interface Events {
    /**
     * A public memory baseline changed; listeners may refresh a previously read generation or profile state.
     * @mode parallel
     * @param change - Committed change sequence and current generation identity.
     */
    'memory/changed'(change: { changeSequence: number; generationId?: MemoryGenerationId }): void
    /**
     * Explicit controls for one Session committed; listeners may refresh prompt or scheduling policy.
     * @mode parallel
     * @param change - Session identity and complete committed controls.
     */
    'memory/session-controls-changed'(change: { sessionId: SessionId; controls: SessionMemoryControls }): void
    /**
     * Profile-wide live scheduler settings committed; schedulers and management consumers must refresh.
     * @mode parallel
     * @param settings - Complete committed settings and optimistic revision.
     */
    'memory/runtime-settings-changed'(settings: MemoryRuntimeSettings): void
  }
}

/** Public memory operations available to prompt, Remote, and UI consumers. */
export abstract class MemoryService extends Service {
  constructor(ctx: Context) {
    if (new.target === MemoryService) {
      throw new Error('@deepseek-ai/dsh-memory is an abstract service; load a provider such as @deepseek-ai/dsh-memory-local')
    }
    super(ctx, 'memory')
  }

  /**
   * Read the current profile-level memory state.
   * @returns Current profile-level state.
   */
  abstract getProfileState(): Promise<MemoryProfileState>
  /**
   * Apply revision-checked profile enable and default-control switches.
   * @param expectedRevision - Profile control revision observed by the caller.
   * @param patch - Switches to replace.
   * @returns Complete committed profile state.
   */
  abstract updateProfileControls(expectedRevision: number, patch: MemoryProfileControlPatch): Promise<MemoryProfileState>
  /**
   * Read the effective profile-wide scheduler settings.
   * @returns Complete settings and their optimistic revision.
   */
  abstract getRuntimeSettings(): Promise<MemoryRuntimeSettings>
  /**
   * Apply an optimistic live scheduler-settings update.
   * @param expectedRevision - Revision observed by the caller.
   * @param patch - Values to replace; omitted values remain unchanged.
   * @returns Complete committed settings.
   */
  abstract updateRuntimeSettings(
    expectedRevision: number,
    patch: MemoryRuntimeSettingsPatch,
  ): Promise<MemoryRuntimeSettings>
  /**
   * Return explicit controls and their revision for one Session.
   * @param sessionId - Interactive Session to inspect.
   * @returns Current revisioned controls.
   */
  abstract getSessionControls(sessionId: SessionId): Promise<SessionMemoryControls>
  /**
   * Apply an optimistic Session-control update.
   * @param sessionId - Interactive Session to update.
   * @param expectedRevision - Revision observed by the caller.
   * @param patch - Explicit control values to replace.
   * @returns Complete committed controls.
   */
  abstract setSessionControls(
    sessionId: SessionId,
    expectedRevision: number,
    patch: SessionMemoryControlsPatch,
  ): Promise<SessionMemoryControls>
  /**
   * Pin the current prompt summary when injection is enabled and a generation exists.
   * @param request - Session identity, byte limit, and lease owner.
   * @returns Leased complete-item summary with byte/item counts, or a reasoned skip. Read and integrity failures reject.
   */
  abstract acquirePromptSnapshot(request: MemoryPromptSnapshotRequest): Promise<MemoryPromptSnapshotResult>
  /**
   * Release an acquired generation read lease; repeated release is harmless.
   * @param leaseId - Lease returned with a prompt snapshot.
   */
  abstract releaseReadLease(leaseId: MemoryReadLeaseId): Promise<void>
  /**
   * List files from one immutable generation.
   * @param request - Generation, cursor, and page limit.
   * @returns Stable bounded file page.
   */
  abstract listGenerationTree(request: MemoryTreeRequest): Promise<MemoryTreePage>
  /**
   * Read a bounded UTF-8 range from one generation file.
   * @param request - Generation, verified relative path, offset, and byte limit.
   * @returns Verified file segment and continuation offset.
   */
  abstract readGenerationFile(request: MemoryFileReadRequest): Promise<MemoryFileReadResult>
  /**
   * List semantic items derived from verified summary and catalog Markdown.
   * @param request - Generation, cursor, and bounded page selection.
   * @returns Stable item page and deduplicated per-source citation feedback; legacy generations return no editable items.
   */
  abstract listMemoryItems(request: MemoryItemListRequest): Promise<MemoryItemPage>
  /**
   * Submit one explicit new memory without editing an immutable generation.
   * @param request - Exact user-authored memory text.
   * @returns Durable pending consolidation note.
   */
  abstract rememberMemory(request: RememberMemoryRequest): Promise<AdHocNote>
  /**
   * Submit a revision-safe replacement for one semantic memory item.
   * @param request - Verified item target and replacement text.
   * @returns Durable pending consolidation note.
   */
  abstract updateMemoryItem(request: UpdateMemoryItemRequest): Promise<AdHocNote>
  /**
   * Submit a revision-safe deletion for one semantic memory item.
   * @param request - Verified current item target.
   * @returns Durable active forget note.
   */
  abstract deleteMemoryItem(request: DeleteMemoryItemRequest): Promise<AdHocNote>
  /**
   * List the current memory catalog for a Session whose `use` control allows recall.
   * @param request - Calling Session and result limit.
   * @returns Stable catalog hits with citations.
   */
  abstract listMemory(request: MemoryListRequest): Promise<readonly MemorySearchHit[]>
  /**
   * Search the current generation with deterministic lexical matching.
   * @param request - Calling Session, query, and result limit.
   * @returns Authorized ranked hits.
   */
  abstract searchMemory(request: MemorySearchRequest): Promise<readonly MemorySearchHit[]>
  /**
   * Read one current-generation memory file for an authorized Session.
   * @param request - Calling Session, verified path, and byte limit.
   * @returns Verified bounded file content.
   */
  abstract readMemory(request: MemoryReadRequest): Promise<MemoryFileReadResult>
  /**
   * List user-authored consolidation requests.
   * @param request - Status, cursor, and page limit.
   * @returns Stable bounded note page.
   */
  abstract listAdHocNotes(request: AdHocNoteListRequest): Promise<AdHocNotePage>
  /**
   * Persist a user-authored consolidation request.
   * @param request - Exact user text and optional superseded note.
   * @returns Persisted revisioned note.
   */
  abstract submitAdHocNote(request: SubmitAdHocNoteRequest): Promise<AdHocNote>
  /**
   * Persist one explicitly requested conversation change with runtime-bound source identity.
   * @param request - User-authorized operation and trusted current-turn binding.
   * @returns Persisted dual-state note.
   */
  abstract submitConversationMemory(request: SubmitConversationMemoryRequest): Promise<AdHocNote>
  /**
   * Wake a bounded history scan that ignores only the configured idle delay.
   * Active, unsafe, ineligible, or out-of-age Sessions remain excluded. Discovered
   * ranges continue through Phase 1 and Phase 2 asynchronously.
   * @returns After the manual scan wake has been delivered; pipeline completion remains asynchronous.
   */
  abstract requestScanAndConsolidation(): Promise<void>
  /**
   * Delete derived state and rebuild eligible completed turns inside a frozen time window.
   * @param request - Destructive confirmation, lookback duration, and explicit-note retention policy.
   * @returns Durable rebuild state created before filesystem cleanup begins.
   */
  abstract startCleanPolicyRebuild(request: StartCleanPolicyRebuildRequest): Promise<MemoryRebuild>
  /**
   * Wake consolidation for already durable candidates and explicit notes.
   * @returns After the manual wake has been delivered; publication remains asynchronous.
   */
  abstract requestConsolidation(): Promise<void>
  /**
   * List source and consolidation ranges awaiting an explicit retry.
   * @param request - Cursor and page limit.
   * @returns Stable bounded quarantine page.
   */
  abstract listQuarantines(request: MemoryQuarantineListRequest): Promise<MemoryQuarantinePage>
  /**
   * Requeue one bounded quarantined source or consolidation range.
   * @param id - Quarantine identity returned by {@link listQuarantines}.
   */
  abstract retryQuarantine(id: QuarantineRangeId): Promise<void>
  /**
   * Clear generated memory and prevent automatic relearning from pre-reset Session history.
   * @param request - Exact destructive confirmation.
   */
  abstract resetMemory(request: ResetMemoryRequest): Promise<void>
}

export default MemoryService

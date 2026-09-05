/** Client-safe public type vocabulary for profile memory. @module @deepseek-ai/dsh-memory/types */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Identity of one immutable published memory generation. */
export type MemoryGenerationId = Branded<'MemoryGenerationId'>
/** Identity of one expiring generation read lease. */
export type MemoryReadLeaseId = Branded<'MemoryReadLeaseId'>
/** Identity of one quarantined source range. */
export type QuarantineRangeId = Branded<'QuarantineRangeId'>
/** Identity of one user-authored consolidation request. */
export type AdHocNoteId = Branded<'AdHocNoteId'>
/** Identity of one semantic memory item derived from a verified generation. */
export type MemoryItemId = Branded<'MemoryItemId'>
/** Identity of one durable clean policy rebuild. */
export type MemoryRebuildId = Branded<'MemoryRebuildId'>

/** Durable progress state of a clean policy rebuild. */
export type MemoryRebuildStatus
  = | 'queued'
    | 'purging-old-state'
    | 'scanning'
    | 'extracting'
    | 'waiting-for-idle'
    | 'consolidating'
    | 'validating'
    | 'published'
    | 'failed'
    | 'cancelled'

/** Observable progress for one clean policy rebuild. */
export interface MemoryRebuild {
  readonly sourceCompletedAfter: number
  readonly explicitNotePolicy: 'preserve-active' | 'purge-all'
  readonly id: MemoryRebuildId
  readonly status: MemoryRebuildStatus
  readonly totalSessions: number
  readonly scannedSessions: number
  readonly scanCursor: number
  readonly extractedSessions: number
  readonly emptySessions: number
  readonly failedSessions: number
  readonly waitingSessions: number
  readonly modelCalls: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly finishedAt?: number
  readonly error?: string
}

/** Per-session memory controls; profile defaults apply to `inherit`. */
export interface SessionMemoryControls {
  readonly revision: number
  readonly use: 'inherit' | 'allow' | 'deny'
  readonly contribute: 'inherit' | 'allow' | 'deny'
}

/** Optimistic update of one or both session controls. */
export interface SessionMemoryControlsPatch {
  readonly use?: SessionMemoryControls['use']
  readonly contribute?: SessionMemoryControls['contribute']
}

/** Current profile-level memory state shown to management consumers. */
export interface MemoryProfileState {
  readonly controlRevision: number
  readonly enabled: boolean
  readonly useByDefault: boolean
  readonly contributeByDefault: boolean
  readonly changeSequence: number
  readonly currentGenerationId?: MemoryGenerationId
  readonly currentPublishSequence?: number
  readonly generationStatus: 'none' | 'ready' | 'rebuild-required'
  readonly pendingPhase1: number
  readonly pendingPhase2: boolean
  readonly quarantineCount: number
  readonly totalBytes: number
  readonly rebuild?: MemoryRebuild
}

/** Immutable location and content identity of one editable semantic memory item. */
export interface MemoryItemTarget {
  readonly generationId: MemoryGenerationId
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly contentSha256: string
}

/** One user-manageable semantic item derived from summary or catalog Markdown. */
export interface MemoryItem {
  readonly id: MemoryItemId
  readonly kind: 'profile' | 'preference' | 'general-tip' | 'task-group'
  readonly title: string
  readonly content: string
  readonly target: MemoryItemTarget
  readonly sourceIds: readonly string[]
  readonly status: 'active' | 'pending-update' | 'pending-delete'
  readonly pendingNoteId?: AdHocNoteId
  readonly origin: 'automatic' | 'explicit' | 'mixed'
}

/** Stable semantic-memory listing request. */
export interface MemoryItemListRequest {
  readonly generationId?: MemoryGenerationId
  readonly cursor?: string
  readonly limit?: number
}

/** One bounded semantic-memory page. */
export interface MemoryItemPage {
  readonly generationId?: MemoryGenerationId
  readonly items: readonly MemoryItem[]
  readonly sourceUsage: readonly MemorySourceUsage[]
  readonly nextCursor?: string
}

/** Citation feedback for a source, not an exact per-item use count. Automatic range versions share their Session's counters. */
export interface MemorySourceUsage {
  readonly sourceId: string
  readonly adoptedCount: number
  readonly lastAdoptedAt?: number
}

/** Explicit creation of a new memory through the consolidation pipeline. */
export interface RememberMemoryRequest {
  readonly content: string
}

/** Revision-safe semantic replacement request. */
export interface UpdateMemoryItemRequest {
  readonly target: MemoryItemTarget
  readonly content: string
}

/** Revision-safe semantic deletion request. */
export interface DeleteMemoryItemRequest {
  readonly target: MemoryItemTarget
}

/** Live profile switches edited by the memory management UI. */
export interface MemoryProfileControlPatch {
  readonly enabled?: boolean
  readonly useByDefault?: boolean
  readonly contributeByDefault?: boolean
}

/** Profile-wide scheduler values that can change without restarting the Host. */
export interface MemoryRuntimeSettingsValues {
  readonly extractionBackend: 'llm' | 'codex'
  readonly consolidationBackend: 'llm' | 'codex'
  readonly extractionReasoningEffort: string
  readonly rebuildLookbackMs: number
  readonly idleMs: number
  readonly maxSourceAgeMs: number
  readonly maxUnusedDays: number
  readonly minRemainingQuotaPercent: number
  readonly scanSessionsPerRun: number
  readonly maxRangesPerRun: number
  readonly maxPhase1ClaimsPerRun: number
  readonly phase1Concurrency: number
  readonly phase1LeaseMs: number
  readonly phase2LeaseMs: number
  readonly providerTimeoutMs: number
  readonly maxAttempts: number
  readonly retryBaseMs: number
  readonly maxCandidatesPerRange: number
  readonly maxPhase2Sources: number
  readonly maxEvidenceBytes: number
  readonly maxResultBytes: number
  readonly extractionProvider: string
  readonly extractionModel: string
  readonly extractionMaxTokens: number
  readonly consolidationProvider: string
  readonly consolidationModel: string
  /** Adapter-owned reasoning effort for Phase 2, or `inherit` to keep the model route default. */
  readonly consolidationReasoningEffort: string
  readonly consolidationMaxTokens: number
  readonly promptSummaryMaxBytes: number
  readonly recallMaxPasses: number
  readonly recallMaxToolCalls: number
  readonly recallMaxDetailFiles: number
  readonly phase2MaxFileBytes: number
  readonly phase2SearchMaxFiles: number
  readonly phase2SearchMaxMatches: number
  readonly skillMinSupportingTasks: number
  /** Exclude ranges containing classified external calls from automatic extraction; defaults to false. */
  readonly disableOnExternalContext: boolean
  readonly externalToolPrefixes: readonly string[]
  readonly policyVersion: number
  readonly pruneRowsPerRun: number
  readonly pruneBytesPerRun: number
  readonly fallbackWakeMs: number
}

/** Revisioned effective scheduler values shown to management consumers. */
export interface MemoryRuntimeSettings extends MemoryRuntimeSettingsValues {
  readonly revision: number
}

/** Optimistic partial update of profile-wide scheduler values. */
export type MemoryRuntimeSettingsPatch = Partial<MemoryRuntimeSettingsValues>

/** Request for one replayable prompt summary snapshot. */
export interface MemoryPromptSnapshotRequest {
  readonly sessionId: SessionId
  readonly maxSummaryBytes: number
  readonly leaseOwner: string
}

/** Immutable prompt material pinned by a read lease. */
export interface MemoryPromptSnapshot {
  readonly kind: 'available'
  readonly generationId: MemoryGenerationId
  readonly generationRoot: string
  readonly summary: string
  readonly summarySha256: string
  readonly leaseId: MemoryReadLeaseId
  readonly leaseExpiresAt: number
  readonly bytes: number
  readonly retainedItems: number
  readonly omittedItems: number
}

/** Reasons a request has no automatic memory summary; I/O failures are not skips. */
export type MemoryPromptSkipReason = 'disabled' | 'session-denied' | 'no-generation' | 'incompatible-generation' | 'budget-too-small' | 'assembly-excluded'

/** A leased snapshot or an explicit non-error omission. */
export type MemoryPromptSnapshotResult = MemoryPromptSnapshot | { readonly kind: 'skipped'; readonly reason: MemoryPromptSkipReason }

/** Non-model-visible observation of the memory context in an actual request. */
export interface MemoryRequestContext {
  readonly turn: number
  readonly step: number
  readonly headerSeq: number
  readonly selection: { readonly kind: 'skipped'; readonly reason: MemoryPromptSkipReason } | {
    readonly kind: 'available'
    readonly generationId: MemoryGenerationId
    readonly summarySha256: string
    /** UTF-16 offsets of the exact summary in the referenced header's system text. */
    readonly summaryStart: number
    readonly summaryEnd: number
    readonly bytes: number
    readonly retainedItems: number
    readonly omittedItems: number
  }
}

/** Roles assigned to files in a generation. */
export type MemoryGenerationFileRole =
  | 'summary'
  | 'catalog'
  | 'raw'
  | 'rollout'
  | 'skill'
  | 'ad-hoc-note'
  | 'manifest'

/** Stable file row for the memory browser. */
export interface MemoryTreeEntry {
  readonly path: string
  readonly role: MemoryGenerationFileRole
  readonly bytes: number
  readonly sha256: string
}

/** Paginated generation-tree request. */
export interface MemoryTreeRequest {
  readonly generationId?: MemoryGenerationId
  readonly cursor?: string
  readonly limit?: number
}

/** One deterministic generation-tree page. */
export interface MemoryTreePage {
  readonly generationId: MemoryGenerationId
  readonly items: readonly MemoryTreeEntry[]
  readonly nextCursor?: string
}

/** Bounded read of one generation file. */
export interface MemoryFileReadRequest {
  readonly generationId?: MemoryGenerationId
  readonly path: string
  readonly offset?: number
  readonly maxBytes?: number
}

/** File bytes decoded as UTF-8 with a continuation offset. */
export interface MemoryFileReadResult {
  readonly generationId: MemoryGenerationId
  readonly path: string
  readonly text: string
  readonly offset: number
  readonly nextOffset?: number
  readonly totalBytes: number
  readonly sha256: string
}

/** Lifecycle state of a user-authored consolidation request. */
export type NoteProcessingStatus = 'pending' | 'claimed' | 'applied' | 'partial' | 'unresolved' | 'failed'

/** Continuing authority of one explicit remember, update, or forget request. */
export type NoteAuthorityStatus = 'active' | 'superseded' | 'cleared'

/** User-authorized semantic operation carried by an explicit note. */
export type MemoryUpdateAction = 'remember' | 'update' | 'forget'

/** User-authored request consumed as read-only Phase 2 input. */
export interface AdHocNote {
  readonly id: AdHocNoteId
  readonly revision: number
  readonly action: MemoryUpdateAction
  readonly processingStatus: NoteProcessingStatus
  readonly authorityStatus: NoteAuthorityStatus
  readonly content: string
  /** Redacted text of the bound user event, never reconstructed from the model draft. */
  readonly sourceUserText?: string
  readonly target?: string
  readonly origin: 'ui' | 'conversation'
  readonly sourceSessionId?: SessionId
  readonly sourceTurn?: string
  readonly sourceUserEventSeq?: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly appliedGenerationId?: MemoryGenerationId
  readonly disposition?: string
}

/** Paginated ad-hoc-note listing. */
export interface AdHocNoteListRequest {
  readonly cursor?: string
  readonly limit?: number
  readonly processingStatuses?: readonly NoteProcessingStatus[]
  readonly authorityStatuses?: readonly NoteAuthorityStatus[]
}

/** One deterministic ad-hoc-note page. */
export interface AdHocNotePage {
  readonly items: readonly AdHocNote[]
  readonly nextCursor?: string
}

/** Add a new note or supersede one pending note. */
export interface SubmitAdHocNoteRequest {
  readonly action: MemoryUpdateAction
  readonly content: string
  readonly target?: string
  readonly supersedes?: AdHocNoteId
}

/** Trusted runtime binding for a model-requested explicit memory change. */
export interface SubmitConversationMemoryRequest extends SubmitAdHocNoteRequest {
  readonly sessionId: SessionId
  readonly turn: string
  readonly userEventSeq: number
  /** Actual current user message supplied by the trusted tool executor. */
  readonly sourceUserText: string
}

/** Session-authorized quick catalog listing used by the model tools. */
export interface MemoryListRequest {
  readonly sessionId: SessionId
  readonly limit?: number
}

/** One catalog or skill hit returned by deterministic lexical search. */
export interface MemorySearchHit {
  readonly generationId: MemoryGenerationId
  readonly path: string
  readonly line: number
  readonly heading?: string
  readonly snippet: string
  readonly citation: string
  readonly score: number
}

/** Session-authorized deterministic lexical query. */
export interface MemorySearchRequest extends MemoryListRequest {
  readonly query: string
}

/** Session-authorized bounded file read for model recall. */
export interface MemoryReadRequest {
  readonly sessionId: SessionId
  readonly path: string
  readonly maxBytes?: number
}

/** Confirmed destructive reset request from a management surface. */
export interface ResetMemoryRequest {
  readonly confirmation: 'reset-memory'
}

/** Confirmed destructive cleanup of derived memory followed by relearning retained Sessions. */
export interface StartCleanPolicyRebuildRequest {
  readonly sourceLookbackMs: number
  readonly explicitNotePolicy: 'preserve-active' | 'purge-all'
  readonly confirmation: 'clean-policy-rebuild'
}

/** One terminal pipeline range awaiting an explicit user retry decision. */
export interface MemoryQuarantineItem {
  readonly id: QuarantineRangeId
  readonly phase: 'phase1' | 'phase2'
  readonly reason: string
  readonly attempts: number
  readonly updatedAt: number
  readonly sessionId?: SessionId
  readonly fromSeq?: number
  readonly toSeq?: number
}

/** Cursor request for quarantined ranges. */
export interface MemoryQuarantineListRequest {
  readonly cursor?: string
  readonly limit?: number
}

/** One stable quarantined-range page. */
export interface MemoryQuarantinePage {
  readonly items: readonly MemoryQuarantineItem[]
  readonly nextCursor?: string
}

/** Stable public failure classes used by RPC and UI consumers. */
export type MemoryErrorCode =
  | 'disabled'
  | 'not-found'
  | 'conflict'
  | 'invalid-path'
  | 'invalid-request'
  | 'capacity'
  | 'unavailable'

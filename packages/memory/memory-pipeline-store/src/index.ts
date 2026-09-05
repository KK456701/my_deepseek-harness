/** Private durable memory-pipeline Store Definition. @module @deepseek-ai/dsh-memory-pipeline-store */

import { Context, Service } from '@deepseek-ai/cordis'
export * from './structured.ts'
import type { StructuredConsolidationInput } from './structured.ts'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session'
import type {
  AdHocNoteId,
  MemoryGenerationId,
  MemoryRebuild,
  MemoryRebuildId,
  MemoryRuntimeSettings,
  MemoryRuntimeSettingsValues,
  QuarantineRangeId,
} from '@deepseek-ai/dsh-memory'

/** Identity of one immutable source-event range. */
export type MemorySourceRangeId = Branded<'MemorySourceRangeId'>
/**
 * Brand a source-range identity.
 * @param value - Persisted opaque id.
 * @returns Branded source-range id.
 */
export const MemorySourceRangeId = (value: string): MemorySourceRangeId => value as MemorySourceRangeId
/** Identity of one Phase 1 job. */
export type Phase1JobId = Branded<'Phase1JobId'>
/**
 * Brand a Phase 1 job identity.
 * @param value - Persisted opaque id.
 * @returns Branded Phase 1 job id.
 */
export const Phase1JobId = (value: string): Phase1JobId => value as Phase1JobId
/** Identity of one Phase 2 job. */
export type Phase2JobId = Branded<'Phase2JobId'>
/**
 * Brand a Phase 2 job identity.
 * @param value - Persisted opaque id.
 * @returns Branded Phase 2 job id.
 */
export const Phase2JobId = (value: string): Phase2JobId => value as Phase2JobId
/** Opaque fencing identity for one claimed job. */
export type MemoryClaimToken = Branded<'MemoryClaimToken'>
/**
 * Brand a claim token.
 * @param value - Persisted opaque token.
 * @returns Branded fencing token.
 */
export const MemoryClaimToken = (value: string): MemoryClaimToken => value as MemoryClaimToken
/** Identity of one model-call attempt. */
export type MemoryAttemptId = Branded<'MemoryAttemptId'>
/**
 * Brand a model-call attempt identity.
 * @param value - Persisted opaque id.
 * @returns Branded attempt id.
 */
export const MemoryAttemptId = (value: string): MemoryAttemptId => value as MemoryAttemptId
/** Identity of one deterministic evidence projection item. */
export type MemoryEvidenceId = Branded<'MemoryEvidenceId'>
/**
 * Brand an evidence identity.
 * @param value - Deterministic snapshot item id.
 * @returns Branded evidence id.
 */
export const MemoryEvidenceId = (value: string): MemoryEvidenceId => value as MemoryEvidenceId
/** Identity of one extracted Phase 1 candidate. */
export type MemoryCandidateId = Branded<'MemoryCandidateId'>
/**
 * Brand a candidate identity.
 * @param value - Deterministic extraction output id.
 * @returns Branded candidate id.
 */
export const MemoryCandidateId = (value: string): MemoryCandidateId => value as MemoryCandidateId
/** Opaque handle for one Phase 2 staging directory. */
export type Phase2WorkspaceId = Branded<'Phase2WorkspaceId'>
/**
 * Brand a Phase 2 workspace identity.
 * @param value - Persisted opaque id.
 * @returns Branded workspace handle.
 */
export const Phase2WorkspaceId = (value: string): Phase2WorkspaceId => value as Phase2WorkspaceId
/** Opaque handle for one materializing generation. */
export type MaterializingGenerationId = Branded<'MaterializingGenerationId'>
/**
 * Brand a materializing-generation identity.
 * @param value - Persisted opaque id.
 * @returns Branded materialization handle.
 */
export const MaterializingGenerationId = (value: string): MaterializingGenerationId => value as MaterializingGenerationId

/** Lease fields shared by both phases. */
export interface MemoryLease {
  readonly ownerToken: MemoryClaimToken
  readonly leasedUntil: number
  readonly attempt: number
}

/** Lightweight durable source assignment captured at turn completion. */
export interface RegisterSourceRange {
  readonly sourceRangeId: MemorySourceRangeId
  readonly sessionId: SessionId
  readonly fromSeq: number
  readonly toSeq: number
  readonly completedAt: number
  readonly sessionPurpose: 'interactive'
  readonly workspaceIdAtEvidence?: string
  readonly workspacePathAtEvidence?: string
  readonly policyVersion: number
}

/** Registration summary; existing identical ranges are idempotent. */
export interface RegisterSourceRangeResult {
  readonly inserted: number
  readonly existing: number
}

/** Phase 1 admission limits supplied by the scheduler. */
export interface Phase1ClaimRequest {
  readonly now: number
  readonly leaseMs: number
  readonly maxAttempts: number
}

/** Frozen identity and watermarks for one Phase 1 claim. */
export interface Phase1Claim {
  readonly jobId: Phase1JobId
  readonly sourceRangeId: MemorySourceRangeId
  readonly sessionId: SessionId
  readonly fromSeq: number
  readonly toSeq: number
  readonly inputFingerprint: string
  readonly lease: MemoryLease
}

/** Durable Phase 1 attempt opened before request serialization. */
export interface Phase1Attempt {
  readonly attemptId: MemoryAttemptId
  readonly jobId: Phase1JobId
  readonly lease: MemoryLease
}

/** Exact provider-neutral request recorded before dispatch. */
export interface RecordedPhase1Request {
  readonly attemptId: MemoryAttemptId
  /** Absent only for persisted/test callers using output format 1. */
  readonly outputFormatVersion?: 1 | 2
  readonly requestFingerprint: string
  readonly request: JsonValue
  readonly bytes: number
  readonly recordedAt: number
}

/** Complete observed result or a bounded overflow prefix. */
export interface RecordedPhase1Result {
  readonly attemptId: MemoryAttemptId
  readonly result: JsonValue
  readonly bytes: number
  readonly chunkCount: number
  readonly termination: 'complete' | 'provider-error' | 'timeout' | 'cancelled' | 'result-overflow'
  readonly recordedAt: number
}

/** Validated evidence item exposed to the extraction model. */
export interface MemoryEvidenceItem {
  readonly evidenceId: MemoryEvidenceId
  readonly sourceEventSeqs: readonly number[]
  readonly kind: 'user' | 'assistant' | 'tool-call' | 'tool-result' | 'environment'
  readonly text: string
  readonly trust: 'eligible-local-untrusted' | 'external-untrusted'
}

/** One validated Phase 1 candidate retained for consolidation. */
export interface MemoryCandidate {
  readonly candidateId: MemoryCandidateId
  readonly rawMemory: string
  readonly rolloutSummary: string
  readonly rolloutSlug?: string
  readonly evidenceIds: readonly MemoryEvidenceId[]
}

/** Terminal or retrying outcome for one claimed source range. */
export type Phase1Outcome =
  | { readonly kind: 'applied'; readonly candidates: readonly MemoryCandidate[] }
  | { readonly kind: 'empty' }
  | { readonly kind: 'cancelled'; readonly reason: string }
  | { readonly kind: 'retry'; readonly nextAttemptAt: number; readonly reason: MemoryFailureCategory }
  | { readonly kind: 'quarantined'; readonly quarantineId: QuarantineRangeId; readonly reason: MemoryFailureCategory }

/** Phase 2 admission limits supplied by the scheduler. */
export interface Phase2ClaimRequest {
  readonly now: number
  readonly leaseMs: number
  /** Capacity of the complete automatic source set, not the number of new candidate rows. */
  readonly maxSources: number
  readonly maxAttempts: number
  readonly maxUnusedDays: number
  /** Whether a new job may claim pending explicit notes; retries retain their original batch. */
  readonly includeAdHocNotes?: boolean
}

/** Automatic evidence membership change supplied to source-aware consolidation. */
export interface SourceSelectionDiff {
  readonly added: readonly MemorySourceRangeId[]
  /** New range versions replacing previously selected Sessions. */
  readonly updated: readonly MemorySourceRangeId[]
  readonly retained: readonly MemorySourceRangeId[]
  readonly removed: readonly MemorySourceRangeId[]
}

/** Candidate and baseline identity for one consolidation claim. */
export interface Phase2Claim {
  readonly jobId: Phase2JobId
  readonly candidateIds: readonly MemoryCandidateId[]
  readonly adHocNoteIds: readonly AdHocNoteId[]
  readonly baselineGenerationId?: MemoryGenerationId
  readonly inputFingerprint: string
  readonly sourceSelectionDiff: SourceSelectionDiff
  readonly lease: MemoryLease
}

/** Role-based access returned for an isolated consolidation workspace. */
export interface Phase2Workspace {
  readonly workspaceId: Phase2WorkspaceId
  readonly stagingRoot: string
  readonly inputFingerprint: string
  readonly readable: readonly string[]
  readonly writable: readonly string[]
  readonly backendOwned: readonly string[]
}

/** Bound durability barrier for one capability-private maintenance transcript. */
export interface MaintenanceSessionPersistence {
  /** Wait until every admitted event for this maintenance Session is durable. */
  flush(): Promise<void>
}

/** Private durable Session binding for the Phase 2 agent transcript. */
export interface MaintenanceSessionBinding {
  readonly sessionId: SessionId
  readonly persistence: MaintenanceSessionPersistence
}

/** Allocated sequence and handle for one immutable generation. */
export interface MaterializingGeneration {
  readonly id: MaterializingGenerationId
  readonly generationId: MemoryGenerationId
  readonly publishSequence: number
  readonly parentGenerationId?: MemoryGenerationId
}

/** Validation and materialization request after the Phase 2 session settles. */
export interface PrepareGenerationRequest {
  readonly claim: Phase2Claim
  readonly workspace: Phase2Workspace
  readonly materializing: MaterializingGeneration
  readonly maintenanceSessionId?: SessionId
  readonly structuredAttemptId?: MemoryAttemptId
}

/** Audited structured Phase 2 dispatch, tied to an owned frozen batch. */
export interface Phase2StructuredRequest {
  readonly claim: Phase2Claim
  readonly request: JsonValue
  readonly bytes: number
}

/** Audited final Phase 2 JSON; never contains reasoning or tool payloads. */
export interface Phase2StructuredResult {
  readonly claim: Phase2Claim
  readonly attemptId: MemoryAttemptId
  readonly result: JsonValue
  readonly bytes: number
  readonly completed: boolean
}

/** Fully persisted immutable generation awaiting pointer publication. */
export interface PreparedGeneration {
  readonly generationId: MemoryGenerationId
  readonly publishSequence: number
  readonly manifestSha256: string
  readonly claimToken: MemoryClaimToken
}

/** Fenced pointer publication request. */
export interface PublishGenerationRequest {
  readonly claim: Phase2Claim
  readonly prepared: PreparedGeneration
}

/** Published and finalized generation baseline. */
export interface PublishedGeneration {
  readonly generationId: MemoryGenerationId
  readonly publishSequence: number
  readonly changeSequence: number
}

/** Lease renewal request for one currently owned job. */
export interface RenewMemoryLeaseRequest {
  readonly phase: 'phase1' | 'phase2'
  readonly jobId: Phase1JobId | Phase2JobId
  readonly ownerToken: MemoryClaimToken
  readonly now: number
  readonly leaseMs: number
}

/** Failure classes persisted for scheduler policy and diagnostics. */
export type MemoryFailureCategory =
  | 'cancelled'
  | 'storage-busy'
  | 'storage-failure'
  | 'provider-timeout'
  | 'provider-rate-limit'
  | 'provider-failure'
  | 'output-budget-exhausted'
  | 'invalid-model-output'
  | 'result-overflow'
  | 'unexpected-tool-use'
  | 'stale'
  | 'validation'
  | 'capacity'

/** Durable failure record for one job or attempt. */
export interface MemoryFailureRecord {
  readonly phase: 'phase1' | 'phase2'
  readonly jobId: Phase1JobId | Phase2JobId
  readonly attemptId?: MemoryAttemptId
  readonly ownerToken: MemoryClaimToken
  readonly category: MemoryFailureCategory
  readonly message: string
  readonly now: number
  readonly retryAt?: number
}

/** Store-decided failure disposition after persistent policy checks. */
export type MemoryFailureDisposition =
  | { readonly kind: 'retry'; readonly nextAttemptAt: number }
  | { readonly kind: 'stale' }
  | { readonly kind: 'quarantined'; readonly quarantineId: QuarantineRangeId }
  | { readonly kind: 'cancelled' }

/** Bounded cleanup request. */
export interface MemoryPruneRequest {
  readonly now: number
  readonly maxRows: number
  readonly maxBytes: number
}

/** Cleanup counters returned to scheduler telemetry. */
export interface MemoryPruneResult {
  readonly auditAttempts: number
  readonly sourceSnapshots: number
  readonly generations: number
  readonly bytes: number
}

/** Recovery summary produced before the scheduler starts claiming work. */
export interface MemoryRecoveryResult {
  readonly recoveredJobs: number
  readonly finalizedGenerations: number
  readonly discardedStagingDirectories: number
  readonly workAvailable: boolean
}

/** Discovery progress committed for the current clean rebuild. */
export interface CleanRebuildDiscoveryProgress {
  readonly rebuildId: MemoryRebuildId
  readonly totalSessions: number
  readonly scannedSessions: number
  readonly scanCursor: number
  readonly waitingSessions: number
  readonly scanComplete: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memoryPipelineStore: MemoryPipelineStore
  }

  interface Events {
    /**
     * Durable pipeline work became eligible; maintenance triggers may coalesce a scheduler wake.
     * @mode parallel
     * @param reason - Durable work category that became eligible.
     */
    'memory/pipeline-work-available'(reason: { kind: 'source' | 'retry' | 'phase2' | 'ad-hoc' | 'manual-scan' | 'manual-consolidation' | 'clean-rebuild' | 'quarantine' | 'recovery' }): void
  }
}

/** Private persistence and publication operations consumed only by the scheduler. */
export abstract class MemoryPipelineStore extends Service {
  constructor(ctx: Context) {
    if (new.target === MemoryPipelineStore) {
      throw new Error('@deepseek-ai/dsh-memory-pipeline-store is an abstract service; load a local or remote provider')
    }
    super(ctx, 'memoryPipelineStore')
  }

  /**
   * Persist deployment defaults only when the profile has no scheduler settings yet.
   * @param defaults - Scheduler defaults resolved by the provider configuration.
   * @returns Effective durable settings, preserving any user-authored revision.
   */
  abstract initializeRuntimeSettings(defaults: MemoryRuntimeSettingsValues): Promise<MemoryRuntimeSettings>
  /**
   * Read the latest durable scheduler settings for one maintenance pass.
   * @returns Complete settings and revision.
   */
  abstract getRuntimeSettings(): Promise<MemoryRuntimeSettings>

  /**
   * Read frozen one-shot input.
   * @param claim - Owned claim.
   * @param workspace - Backend workspace handle.
   * @returns Bounded files and allowed source/note IDs.
   */
  abstract readConsolidationInput(claim: Phase2Claim, workspace: Phase2Workspace): Promise<StructuredConsolidationInput>
  /**
   * Persist dispatch request.
   * @param request - Owned claim and exact request.
   * @returns New audit identity.
   */
  abstract recordPhase2Request(request: Phase2StructuredRequest): Promise<MemoryAttemptId>
  /**
   * Persist final result before applying files.
   * @param result - Bounded final result and current owner.
   */
  abstract recordPhase2Result(result: Phase2StructuredResult): Promise<void>
  /**
   * Materialize validated files from the persisted result.
   * @param claim - Owned claim.
   * @param workspace - Current staging handle.
   * @param attemptId - Completed audit.
   */
  abstract applyConsolidationResult(claim: Phase2Claim, workspace: Phase2Workspace, attemptId: MemoryAttemptId): Promise<void>

  /**
   * Recover interrupted durable operations and pointer state.
   * @param signal - Cancellation for bounded recovery I/O.
   * @returns Recovery counts and whether due work remains.
   */
  abstract recover(signal: AbortSignal): Promise<MemoryRecoveryResult>
  /**
   * Read the unfinished clean rebuild, if one exists.
   * @returns Durable progress used to bypass ordinary age and idle discovery limits.
   */
  abstract getActiveCleanRebuild(): Promise<MemoryRebuild | undefined>
  /**
   * Commit one bounded all-retained discovery pass.
   * @param progress - Absolute progress counters for the currently active rebuild.
   */
  abstract reportCleanRebuildDiscovery(progress: CleanRebuildDiscoveryProgress): Promise<void>
  /**
   * Idempotently register completed interactive source ranges.
   * @param ranges - Frozen Session ranges discovered by the scheduler.
   * @returns Inserted and already-known counts.
   */
  abstract registerSourceRanges(ranges: readonly RegisterSourceRange[]): Promise<RegisterSourceRangeResult>
  /**
   * Claim one due Phase 1 job.
   * @param request - Current time, lease duration, and attempt limit.
   * @returns Owned claim, or `undefined` when none is due.
   */
  abstract claimPhase1(request: Phase1ClaimRequest): Promise<Phase1Claim | undefined>
  /**
   * Open one durable Phase 1 attempt.
   * @param claim - Current owned source claim.
   * @returns Durable attempt identity.
   */
  abstract beginPhase1Attempt(claim: Phase1Claim): Promise<Phase1Attempt>
  /**
   * Persist the exact request before network dispatch.
   * @param request - Frozen request audit and byte count.
   */
  abstract recordPhase1Request(request: RecordedPhase1Request): Promise<void>
  /**
   * Persist the observed result before applying candidates.
   * @param result - Complete observed result or bounded overflow prefix.
   */
  abstract recordPhase1Result(result: RecordedPhase1Result): Promise<void>
  /**
   * Atomically apply a validated Phase 1 outcome and source watermarks.
   * @param claim - Current owned source claim.
   * @param outcome - Validated candidates or terminal range outcome.
   */
  abstract commitPhase1Outcome(claim: Phase1Claim, outcome: Phase1Outcome): Promise<void>
  /**
   * Claim a frozen complete source selection or retry a due Phase 2 job.
   * @param request - Current time, lease, whole-source capacity, and attempt limits.
   * @returns Owned consolidation claim, or `undefined` when none is due.
   */
  abstract claimPhase2(request: Phase2ClaimRequest): Promise<Phase2Claim | undefined>
  /**
   * Create one isolated staging workspace.
   * @param claim - Current owned consolidation claim.
   * @returns Opaque rooted workspace handle and role policy.
   */
  abstract createPhase2Workspace(claim: Phase2Claim): Promise<Phase2Workspace>
  /**
   * Create or resume the private maintenance transcript.
   * @param claim - Current owned consolidation claim with a workspace.
   * @returns Private Session binding without its disk location.
   */
  abstract openMaintenanceSession(claim: Phase2Claim): Promise<MaintenanceSessionBinding>
  /**
   * Allocate a generation identity and monotonic publish sequence.
   * @param claim - Current owned consolidation claim after the Agent settles.
   * @returns Materializing generation handle.
   */
  abstract allocateGeneration(claim: Phase2Claim): Promise<MaterializingGeneration>
  /**
   * Validate staging output and persist an immutable prepared generation.
   * @param request - Claim, workspace, allocated generation, and transcript identity.
   * @returns Prepared immutable generation handle.
   */
  abstract validateAndPrepareGeneration(request: PrepareGenerationRequest): Promise<PreparedGeneration>
  /**
   * Publish and finalize one prepared generation behind a fencing check.
   * @param request - Current claim and prepared generation handle.
   * @returns Published generation identity and sequence.
   */
  abstract publishGeneration(request: PublishGenerationRequest): Promise<PublishedGeneration>
  /**
   * Renew a currently owned lease.
   * @param request - Phase, job, owner, current time, and lease duration.
   * @returns Renewed lease.
   */
  abstract renewLease(request: RenewMemoryLeaseRequest): Promise<MemoryLease>
  /**
   * Persist and classify one operational failure.
   * @param request - Owned failure identity, category, message, and optional retry deadline.
   * @returns Retry or terminal disposition committed by the Store.
   */
  abstract recordFailure(request: MemoryFailureRecord): Promise<MemoryFailureDisposition>
  /**
   * Perform bounded retention cleanup.
   * @param request - Current time plus row and byte limits.
   * @returns Removed audit, snapshot, generation, and byte counts.
   */
  abstract prune(request: MemoryPruneRequest): Promise<MemoryPruneResult>
}

export default MemoryPipelineStore

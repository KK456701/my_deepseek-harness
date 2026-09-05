/** Shared local-memory runtime behind the public and private Service providers. @module @deepseek-ai/dsh-memory-local/runtime */

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { budgetSummary } from './summary-budget.ts'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { CONSOLIDATION_SCHEMA, type StructuredConsolidationInput, type StructuredConsolidationResult, type Phase2StructuredRequest, type Phase2StructuredResult } from '@deepseek-ai/dsh-memory-pipeline-store'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  AdHocNoteId,
  DEFAULT_MEMORY_RUNTIME_SETTINGS,
  MEMORY_POLICY_VERSION,
  MEMORY_TEMPLATE_VERSION,
  MemoryError,
  MemoryGenerationId,
  MemoryItemId,
  MemoryReadLeaseId,
  MemoryRebuildId,
  redactMemoryText,
  type AdHocNote,
  type AdHocNoteListRequest,
  type AdHocNotePage,
  type MemoryFileReadRequest,
  type MemoryFileReadResult,
  type MemoryProfileState,
  type MemoryRebuild,
  type MemoryProfileControlPatch,
  type MemoryListRequest,
  type MemoryItem,
  type MemoryItemListRequest,
  type MemoryItemPage,
  type MemoryItemTarget,
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
  type MemoryTreePage,
  type MemoryTreeRequest,
  type SessionMemoryControls,
  type SessionMemoryControlsPatch,
  type SubmitConversationMemoryRequest,
  type SubmitAdHocNoteRequest,
  type ResetMemoryRequest,
  type StartCleanPolicyRebuildRequest,
  QuarantineRangeId,
} from '@deepseek-ai/dsh-memory'
import {
  MaterializingGenerationId,
  MemoryAttemptId,
  MemoryCandidateId,
  MemoryClaimToken,
  MemorySourceRangeId,
  Phase1JobId,
  Phase2JobId,
  Phase2WorkspaceId,
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
import { deriveEventMessage, SESSION_FORMAT_VERSION, SessionId, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { buildGenerationManifest, memorySha256, type GenerationManifest, type GenerationValidationLimits } from './manifest.ts'
import { openMemoryDatabase } from './schema.ts'
import { selectAutomaticSources, previousAutomaticSources } from './source-selection.ts'

const execFileAsync = promisify(execFile)

/** Validated local-provider deployment settings. */
export interface LocalMemoryConfig extends GenerationValidationLimits {
  /** Absolute profile-owned memory root. */
  readonly root: string
  /** Whether recall and background generation are enabled initially. */
  readonly enabled: boolean
  /** Default recall control for Sessions without an override. */
  readonly useByDefault: boolean
  /** Default automatic-contribution control for Sessions without an override. */
  readonly contributeByDefault: boolean
  /** Duration of a generation read lease in milliseconds. */
  readonly readLeaseMs: number
  /** Maximum summary bytes returned for prompt injection. */
  readonly maxPromptSummaryBytes: number
  /** Maximum UTF-8 bytes accepted for one explicit note. */
  readonly maxAdHocNoteBytes: number
  /** Maximum serialized bytes for one Phase 1 audit request. */
  readonly maxAuditRequestBytes: number
  /** Maximum observed bytes retained for one model result. */
  readonly maxAuditResultBytes: number
  /** Maximum retained audit attempts before new dispatch is rejected. */
  readonly maxAuditAttempts: number
  /** Maximum aggregate retained audit bytes before new dispatch is rejected. */
  readonly maxAuditTotalBytes: number
  /** Retention duration for terminal audit attempts in milliseconds. */
  readonly auditRetentionMs: number
  /** Interval for detecting commits made by another process in milliseconds. */
  readonly changePollMs: number
}

interface ProfileRow {
  enabled: number
  inject_default: number
  contribute_default: number
  change_sequence: number
  publish_sequence: number
  current_generation_id: string | null
  current_publish_sequence: number | null
  memory_epoch: number
  control_revision: number
  configured: number
}

interface MemoryItemNoteTarget extends MemoryItemTarget {
  readonly kind: 'memory-item'
  readonly itemId: string
  readonly title: string
  readonly sourceIds: readonly string[]
  readonly priorContent: string
}

function parseMemoryItemNoteTarget(value: string | null): MemoryItemNoteTarget | undefined {
  if (value === null) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)
      || parsed.kind !== 'memory-item'
      || typeof parsed.generationId !== 'string'
      || typeof parsed.path !== 'string'
      || !Number.isSafeInteger(parsed.startLine)
      || !Number.isSafeInteger(parsed.endLine)
      || typeof parsed.contentSha256 !== 'string'
      || typeof parsed.itemId !== 'string'
      || typeof parsed.title !== 'string'
      || !isStringArray(parsed.sourceIds)
      || typeof parsed.priorContent !== 'string') return undefined
    return parsed as unknown as MemoryItemNoteTarget
  } catch {
    return undefined
  }
}

interface RuntimeSettingsRow {
  revision: number
  values_json: string
}

interface GenerationRow {
  id: string
  materializing_id: string
  publish_sequence: number
  parent_generation_id: string | null
  phase2_job_id: string
  status: string
  root: string
  manifest_sha256: string | null
  total_bytes: number | null
  created_at: number
  published_at: number | null
}

interface SourceRow {
  id: string
  session_id: string
  from_seq: number
  to_seq: number
  input_fingerprint: string
  status: string
  owner_token: string | null
  leased_until: number | null
  attempt: number
}

interface RebuildRow {
  source_completed_after: number
  explicit_note_policy: 'preserve-active' | 'purge-all'
  id: string
  status: MemoryRebuild['status']
  total_sessions: number
  scanned_sessions: number
  scan_cursor: number
  extracted_sessions: number
  empty_sessions: number
  failed_sessions: number
  waiting_sessions: number
  model_calls: number
  error: string | null
  created_at: number
  updated_at: number
  finished_at: number | null
}

function rebuildFromRow(row: RebuildRow): MemoryRebuild {
  return {
    sourceCompletedAfter: row.source_completed_after,
    explicitNotePolicy: row.explicit_note_policy,
    id: MemoryRebuildId(row.id),
    status: row.status,
    totalSessions: row.total_sessions,
    scannedSessions: row.scanned_sessions,
    scanCursor: row.scan_cursor,
    extractedSessions: row.extracted_sessions,
    emptySessions: row.empty_sessions,
    failedSessions: row.failed_sessions,
    waitingSessions: row.waiting_sessions,
    modelCalls: row.model_calls,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...row.finished_at === null ? {} : { finishedAt: row.finished_at },
    ...row.error === null ? {} : { error: row.error },
  }
}

interface Phase2Row {
  id: string
  status: string
  owner_token: string
  leased_until: number
  attempt: number
  input_fingerprint: string
  baseline_generation_id: string | null
  source_diff_json: string
  workspace_id: string | null
  maintenance_session_id: string | null
}

interface WorkspaceRow {
  id: string
  job_id: string
  root: string
  input_fingerprint: string
  readonly_hash: string
}

interface AdHocNoteRow {
  source_user_text: string | null
  id: string
  revision: number
  action: AdHocNote['action']
  processing_status: AdHocNote['processingStatus']
  authority_status: AdHocNote['authorityStatus']
  content: string
  target: string | null
  origin: AdHocNote['origin']
  source_session_id: string | null
  source_turn: string | null
  source_user_event_seq: number | null
  created_at: number
  updated_at: number
  participated_generation_id: string | null
  disposition: string | null
}

type TerminalNoteProcessingStatus = Extract<AdHocNote['processingStatus'], 'applied' | 'partial' | 'unresolved' | 'failed'>

interface NoteDisposition {
  readonly noteId: string
  readonly status: TerminalNoteProcessingStatus
  readonly detail: string
}

interface MemoryPointer {
  readonly generationId: string
  readonly publishSequence: number
  readonly manifestSha256: string
}

function parseSourceSelectionDiff(value: string): Phase2Claim['sourceSelectionDiff'] {
  const parsed: unknown = JSON.parse(value)
  if (!isRecord(parsed) || !isStringArray(parsed.added) || !isStringArray(parsed.retained) || !isStringArray(parsed.removed)) {
    throw new Error('Phase 2 source selection diff is invalid')
  }
  return {
    added: parsed.added.map(MemorySourceRangeId),
    updated: isStringArray(parsed.updated) ? parsed.updated.map(MemorySourceRangeId) : [],
    retained: parsed.retained.map(MemorySourceRangeId),
    removed: parsed.removed.map(MemorySourceRangeId),
  }
}

function asNumber(value: number | bigint): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new Error('SQLite returned an unsafe integer')
  return result
}

function formatRawMemorySection(candidate: {
  id: string
  source_range_id: string
  raw_memory: string | null
  rollout_slug: string | null
  body: string
}): string {
  return `\n## Rollout ${candidate.id}\n\n- Source: [${candidate.source_range_id}](rollout_summaries/${candidate.source_range_id}.md)\n`
    + `${candidate.rollout_slug === null ? '' : `- Slug: ${candidate.rollout_slug}\n`}\n${candidate.raw_memory ?? candidate.body}\n`
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function parseStringArrayJson(value: string, label: string): string[] {
  const parsed: unknown = JSON.parse(value)
  if (!isStringArray(parsed)) throw new Error(`${label} is not a string array`)
  return parsed
}

function contained(root: string, candidate: string): boolean {
  const offset = relative(root, candidate)
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
}

async function createPrivateFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

function begin(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
}

function rollback(db: DatabaseSync): void {
  try { db.exec('ROLLBACK') } catch { /* Preserve the transaction failure. */ }
}

function currentProfile(db: DatabaseSync): ProfileRow {
  const row = db.prepare('SELECT * FROM profile_state WHERE singleton = 1').get() as ProfileRow | undefined
  if (row === undefined) throw new Error('memory profile state is missing')
  return row
}

const RUNTIME_SETTING_KEYS = [
  'extractionBackend', 'consolidationBackend', 'extractionReasoningEffort', 'rebuildLookbackMs',
  'idleMs', 'maxSourceAgeMs', 'maxUnusedDays', 'minRemainingQuotaPercent',
  'scanSessionsPerRun', 'maxRangesPerRun', 'maxPhase1ClaimsPerRun',
  'phase1LeaseMs', 'phase2LeaseMs', 'providerTimeoutMs', 'maxAttempts', 'retryBaseMs',
  'maxCandidatesPerRange', 'maxPhase2Sources', 'maxEvidenceBytes', 'maxResultBytes',
  'phase1Concurrency',
  'extractionProvider', 'extractionModel', 'extractionMaxTokens', 'consolidationProvider',
  'consolidationModel', 'consolidationReasoningEffort', 'consolidationMaxTokens', 'promptSummaryMaxBytes', 'recallMaxPasses',
  'recallMaxToolCalls', 'recallMaxDetailFiles', 'phase2MaxFileBytes', 'phase2SearchMaxFiles',
  'phase2SearchMaxMatches', 'skillMinSupportingTasks', 'disableOnExternalContext', 'externalToolPrefixes', 'policyVersion', 'pruneRowsPerRun',
  'pruneBytesPerRun', 'fallbackWakeMs',
] as const satisfies readonly (keyof MemoryRuntimeSettingsValues)[]

const RUNTIME_STRING_KEYS = [
  'extractionBackend', 'consolidationBackend', 'extractionReasoningEffort',
  'extractionProvider', 'extractionModel', 'consolidationProvider', 'consolidationModel',
  'consolidationReasoningEffort',
] as const satisfies readonly (keyof MemoryRuntimeSettingsValues)[]

const RUNTIME_NUMBER_LIMITS = {
  rebuildLookbackMs: [1, 365 * 24 * 60 * 60_000],
  idleMs: [1, 365 * 24 * 60 * 60_000],
  maxSourceAgeMs: [1, 365 * 24 * 60 * 60_000],
  maxUnusedDays: [1, 3650],
  minRemainingQuotaPercent: [0, 100],
  scanSessionsPerRun: [1, 10_000],
  maxRangesPerRun: [1, 10_000],
  maxPhase1ClaimsPerRun: [1, 100],
  phase1LeaseMs: [1_000, 24 * 60 * 60_000],
  phase2LeaseMs: [1_000, 24 * 60 * 60_000],
  providerTimeoutMs: [1_000, 24 * 60 * 60_000],
  maxAttempts: [1, 20],
  retryBaseMs: [1, 24 * 60 * 60_000],
  maxCandidatesPerRange: [1, 10_000],
  maxPhase2Sources: [1, 10_000],
  phase1Concurrency: [1, 8],
  maxEvidenceBytes: [1_024, 64 * 1024 * 1024],
  maxResultBytes: [1_024, 64 * 1024 * 1024],
  extractionMaxTokens: [1, 1_000_000],
  consolidationMaxTokens: [1, 1_000_000],
  promptSummaryMaxBytes: [1_024, 2 * 1024 * 1024],
  recallMaxPasses: [1, 8],
  recallMaxToolCalls: [1, 64],
  recallMaxDetailFiles: [1, 16],
  phase2MaxFileBytes: [1_024, 64 * 1024 * 1024],
  phase2SearchMaxFiles: [1, 10_000],
  phase2SearchMaxMatches: [1, 100_000],
  skillMinSupportingTasks: [1, 100],
  policyVersion: [1, 2_147_483_647],
  pruneRowsPerRun: [1, 100_000],
  pruneBytesPerRun: [1_024, 1024 * 1024 * 1024],
  fallbackWakeMs: [1_000, 7 * 24 * 60 * 60_000],
} as const satisfies Partial<Record<keyof MemoryRuntimeSettingsValues, readonly [number, number]>>

function validateRuntimeSettings(value: unknown): MemoryRuntimeSettingsValues {
  if (!isRecord(value)) throw new MemoryError('invalid-request', 'runtime settings must be an object')
  if (!['llm', 'codex'].includes(String(value.extractionBackend)) || !['llm', 'codex'].includes(String(value.consolidationBackend))) {
    throw new MemoryError('invalid-request', 'memory backend must be llm or codex')
  }
  const unknown = Object.keys(value).find(key => !(RUNTIME_SETTING_KEYS as readonly string[]).includes(key))
  if (unknown !== undefined) throw new MemoryError('invalid-request', `unknown runtime setting "${unknown}"`)
  for (const key of RUNTIME_STRING_KEYS) {
    const field = value[key]
    if (typeof field !== 'string' || field.trim().length === 0 || field.length > 256) {
      throw new MemoryError('invalid-request', `${key} must be a non-empty string no longer than 256 characters`)
    }
  }
  for (const [key, limits] of Object.entries(RUNTIME_NUMBER_LIMITS)) {
    const field = value[key]
    if (!Number.isSafeInteger(field) || Number(field) < limits[0] || Number(field) > limits[1]) {
      throw new MemoryError('invalid-request', `${key} must be an integer from ${limits[0]} through ${limits[1]}`)
    }
  }
  if (typeof value.disableOnExternalContext !== 'boolean') {
    throw new MemoryError('invalid-request', 'disableOnExternalContext must be a boolean')
  }
  if (!isStringArray(value.externalToolPrefixes)
    || value.externalToolPrefixes.length > 64
    || value.externalToolPrefixes.some(item => item.length === 0 || item.length > 64)) {
    throw new MemoryError('invalid-request', 'externalToolPrefixes must contain at most 64 non-empty strings of at most 64 characters')
  }
  if (Number(value.maxSourceAgeMs) < Number(value.idleMs)) {
    throw new MemoryError('invalid-request', 'maxSourceAgeMs must be greater than or equal to idleMs')
  }
  return Object.fromEntries(RUNTIME_SETTING_KEYS.map(key => [key, value[key]])) as unknown as MemoryRuntimeSettingsValues
}

function runtimeSettings(db: DatabaseSync): MemoryRuntimeSettings {
  const row = db.prepare('SELECT revision, values_json FROM runtime_settings WHERE singleton = 1').get() as RuntimeSettingsRow | undefined
  if (row === undefined) return { revision: 0, ...DEFAULT_MEMORY_RUNTIME_SETTINGS }
  const stored = JSON.parse(row.values_json) as unknown
  if (!isRecord(stored)) throw new MemoryError('invalid-request', 'stored runtime settings must be an object')
  const normalized = { ...stored }
  delete normalized.minSourceUserChars
  return { revision: row.revision, ...validateRuntimeSettings({ ...DEFAULT_MEMORY_RUNTIME_SETTINGS, ...normalized }) }
}

function parseManifest(text: string): GenerationManifest {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)
    || (value.formatVersion !== 1 && value.formatVersion !== 2)
    || typeof value.generationId !== 'string'
    || !Number.isSafeInteger(value.publishSequence)
    || !Number.isSafeInteger(value.createdAt)
    || !Array.isArray(value.files)) {
    throw new Error('memory generation manifest is invalid')
  }
  if (value.formatVersion === 2
    && (!Number.isSafeInteger(value.policyVersion) || typeof value.templateVersion !== 'string')) {
    throw new Error('versioned memory generation manifest is invalid')
  }
  for (const file of value.files) {
    if (!isRecord(file)
      || typeof file.path !== 'string'
      || !isStringArray(file.sourceIds)
      || !Array.isArray(file.anchors)) {
      throw new Error('memory generation manifest file is invalid')
    }
    for (const anchor of file.anchors) {
      if (!isRecord(anchor)
        || !Number.isSafeInteger(anchor.startLine) || Number(anchor.startLine) < 1
        || !Number.isSafeInteger(anchor.endLine) || Number(anchor.endLine) < Number(anchor.startLine)
        || !Array.isArray(anchor.sourceIds)) {
        throw new Error('memory generation manifest source anchor is invalid')
      }
    }
  }
  return value as unknown as GenerationManifest
}

function parsePointer(text: string): MemoryPointer {
  const value = JSON.parse(text) as Partial<MemoryPointer> & { formatVersion?: unknown }
  if (value.formatVersion !== 1 || typeof value.generationId !== 'string'
    || !Number.isSafeInteger(value.publishSequence) || (value.publishSequence ?? 0) < 1
    || typeof value.manifestSha256 !== 'string') {
    throw new Error('memory generation pointer is invalid')
  }
  return value as MemoryPointer
}

function boundedUtf8(bytes: Buffer, offset: number, maxBytes: number): { text: string; end: number } {
  let end = Math.min(bytes.length, offset + maxBytes)
  while (end > offset) {
    const text = bytes.subarray(offset, end).toString('utf8')
    if (Buffer.byteLength(text, 'utf8') <= end - offset && !text.endsWith('\uFFFD')) return { text, end }
    end -= 1
  }
  return { text: '', end: offset }
}

/** Process-local coordinator for one profile memory root. */
class LocalMemoryRuntime {
  readonly stateRoot: string
  readonly stagingRoot: string
  readonly generationsRoot: string
  readonly pointerPath: string
  readonly publishLockPath: string
  readonly db: DatabaseSync
  private tail: Promise<void> = Promise.resolve()
  private readonly maintenanceFailures = new Map<SessionId, unknown>()
  private changeTimer?: ReturnType<typeof setInterval>
  private dataVersion: number
  private settingsRevision: number

  private constructor(
    readonly ctx: Context,
    readonly config: LocalMemoryConfig,
    readonly root: string,
    db: DatabaseSync,
  ) {
    this.stateRoot = join(root, 'state')
    this.stagingRoot = join(root, 'staging')
    this.generationsRoot = join(root, 'generations')
    this.pointerPath = join(root, 'current.json')
    this.publishLockPath = join(root, 'publish')
    this.db = db
    this.dataVersion = asNumber((db.prepare('PRAGMA data_version').get() as { data_version: number | bigint }).data_version)
    this.settingsRevision = runtimeSettings(db).revision
  }

  /** Create private directories, validate SQLite ownership, and apply configured profile defaults. */
  static async open(ctx: Context, config: LocalMemoryConfig): Promise<LocalMemoryRuntime> {
    if (!isAbsolute(config.root)) throw new Error('memory-local: root must be absolute')
    const root = resolve(config.root)
    await mkdir(join(root, 'state'), { recursive: true, mode: 0o700 })
    await mkdir(join(root, 'staging'), { recursive: true, mode: 0o700 })
    await mkdir(join(root, 'generations'), { recursive: true, mode: 0o700 })
    const dbPath = join(root, 'state', 'memory.db')
    await createPrivateFile(dbPath)
    const db = openMemoryDatabase(dbPath)
    db.prepare(`UPDATE profile_state SET enabled=?,inject_default=?,contribute_default=?,configured=1
      WHERE singleton=1 AND configured=0`)
      .run(config.enabled ? 1 : 0, config.useByDefault ? 1 : 0, config.contributeByDefault ? 1 : 0)
    const runtime = new LocalMemoryRuntime(ctx, config, root, db)
    runtime.startChangePoll()
    return runtime
  }

  /** Wait for prior owned operations and close the SQLite handle. */
  async close(): Promise<void> {
    if (this.changeTimer !== undefined) clearInterval(this.changeTimer)
    await this.tail
    this.db.close()
  }

  private startChangePoll(): void {
    this.changeTimer = setInterval(() => {
      void this.exclusive(() => {
        const next = asNumber((this.db.prepare('PRAGMA data_version').get() as { data_version: number | bigint }).data_version)
        if (next === this.dataVersion) return
        this.dataVersion = next
        const profile = currentProfile(this.db)
        const settings = runtimeSettings(this.db)
        this.ctx.emit('memory/changed', {
          changeSequence: profile.change_sequence,
          ...profile.current_generation_id === null ? {} : { generationId: MemoryGenerationId(profile.current_generation_id) },
        })
        if (settings.revision !== this.settingsRevision) {
          this.settingsRevision = settings.revision
          this.ctx.emit('memory/runtime-settings-changed', settings)
        }
      })
    }, this.config.changePollMs)
    this.changeTimer.unref()
  }

  private exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private emitMemoryChanged(): void {
    const profile = currentProfile(this.db)
    this.ctx.emit('memory/changed', {
      changeSequence: profile.change_sequence,
      ...profile.current_generation_id === null
        ? {}
        : { generationId: MemoryGenerationId(profile.current_generation_id) },
    })
  }

  private transaction<T>(operation: () => T): T {
    begin(this.db)
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error: unknown) {
      rollback(this.db)
      throw error
    }
  }

  /** Bind an owned live maintenance Session to its private audit row. */
  registerMaintenanceSession(session: Session): Promise<void> {
    if (session.header.purpose !== 'maintenance') return Promise.resolve()
    return this.exclusive(() =>{  this.transaction(() => {
      const row = this.db.prepare('SELECT header_json,status FROM maintenance_sessions WHERE id=?').get(session.id) as
        { header_json: string; status: string } | undefined
      if (row === undefined) throw new Error(`maintenance Session "${session.id}" is not owned by memory-local`)
      const expected = JSON.parse(row.header_json) as SessionHeader
      if (expected.id !== session.id || expected.cwd !== session.header.cwd || expected.purpose !== 'maintenance') {
        throw new Error(`maintenance Session "${session.id}" does not match its private audit binding`)
      }
      if (row.status === 'allocated') {
        this.db.prepare("UPDATE maintenance_sessions SET status='live' WHERE id=? AND status='allocated'").run(session.id)
      } else if (row.status !== 'live') {
        throw new Error(`maintenance Session "${session.id}" is not writable`)
      }
    }) }).catch((error: unknown) => {
      this.maintenanceFailures.set(session.id, error)
      throw error
    })
  }

  /** Append one frozen maintenance event to the capability-private audit log. */
  recordMaintenanceSessionEvent(session: Session, event: SessionEvent): Promise<void> {
    if (session.header.purpose !== 'maintenance') return Promise.resolve()
    return this.exclusive(() =>{  this.transaction(() => {
      const row = this.db.prepare('SELECT status,event_count,total_bytes FROM maintenance_sessions WHERE id=?').get(session.id) as
        { status: string; event_count: number; total_bytes: number } | undefined
      if (row === undefined || !['allocated', 'live'].includes(row.status)) {
        throw new Error(`maintenance Session "${session.id}" has no writable private audit`)
      }
      if (event.seq !== row.event_count) {
        throw new Error(`maintenance Session "${session.id}" audit expected seq ${row.event_count}, got ${event.seq}`)
      }
      const json = JSON.stringify(event)
      const bytes = Buffer.byteLength(json, 'utf8')
      const eventLimit = event.type === 'request/header' ? this.config.maxAuditRequestBytes : this.config.maxAuditResultBytes
      if (bytes > eventLimit) throw new Error(`maintenance Session "${session.id}" audit event exceeds its byte limit`)
      const usage = this.db.prepare(`SELECT
        COALESCE((SELECT SUM(COALESCE(request_bytes,0)+COALESCE(result_bytes,0)) FROM phase1_attempts),0)
        + COALESCE((SELECT SUM(total_bytes) FROM maintenance_sessions WHERE status!='pruned'),0) AS bytes`)
        .get() as { bytes: number | bigint }
      if (asNumber(usage.bytes) + bytes > this.config.maxAuditTotalBytes) {
        throw new Error('memory audit capacity is exhausted')
      }
      this.db.prepare(`INSERT INTO maintenance_session_events
        (session_id,seq,type,event_json,bytes,created_at) VALUES (?,?,?,?,?,?)`)
        .run(session.id, event.seq, event.type, json, bytes, event.time)
      this.db.prepare("UPDATE maintenance_sessions SET status='live',event_count=event_count+1,total_bytes=total_bytes+? WHERE id=?")
        .run(bytes, session.id)
    }) }).catch((error: unknown) => {
      this.maintenanceFailures.set(session.id, error)
      throw error
    })
  }

  /** Wait for all admitted events and surface any private-audit failure. */
  flushMaintenanceSession(sessionId: SessionId): Promise<void> {
    return this.exclusive(() => {
      const failure = this.maintenanceFailures.get(sessionId)
      if (failure instanceof Error) throw failure
      if (failure !== undefined) throw new Error('private maintenance audit failed', { cause: failure })
      const row = this.db.prepare(`SELECT s.status,s.event_count,COUNT(e.seq) AS stored_count,
        COALESCE(MAX(e.seq),-1) AS max_seq FROM maintenance_sessions s
        LEFT JOIN maintenance_session_events e ON e.session_id=s.id WHERE s.id=? GROUP BY s.id`)
        .get(sessionId) as { status: string; event_count: number; stored_count: number | bigint; max_seq: number | bigint } | undefined
      if (row === undefined || row.status === 'allocated') throw new Error(`maintenance Session "${sessionId}" has no durable transcript`)
      const stored = asNumber(row.stored_count)
      const maxSeq = asNumber(row.max_seq)
      if (stored !== row.event_count || (stored > 0 && maxSeq !== stored - 1)) {
        throw new Error(`maintenance Session "${sessionId}" audit is not contiguous`)
      }
    })
  }

  /** Seal a disposed maintenance Session after its final private-audit drain. */
  completeMaintenanceSession(session: Session): Promise<void> {
    if (session.header.purpose !== 'maintenance') return Promise.resolve()
    return this.exclusive(() =>{  this.transaction(() => {
      const failure = this.maintenanceFailures.get(session.id)
      const row = this.db.prepare("SELECT event_json FROM maintenance_session_events WHERE session_id=? AND type='turn/end' ORDER BY seq DESC LIMIT 1")
        .get(session.id) as { event_json: string } | undefined
      const ended = row === undefined ? undefined : JSON.parse(row.event_json) as SessionEvent
      const completed = failure === undefined && ended?.type === 'turn/end' && ended.data.reason.kind === 'completed'
      this.db.prepare("UPDATE maintenance_sessions SET status=?,finished_at=? WHERE id=? AND status IN ('allocated','live')")
        .run(completed ? 'completed' : 'failed', Date.now(), session.id)
    }) })
  }

  private requireMaintenanceTranscript(sessionId: SessionId, jobId: string): void {
    const row = this.db.prepare(`SELECT status,event_count FROM maintenance_sessions
      WHERE id=? AND phase2_job_id=?`).get(sessionId, jobId) as { status: string; event_count: number } | undefined
    if (row === undefined || row.status !== 'completed' || row.event_count === 0) {
      throw new Error('Phase 2 maintenance transcript is not durably complete')
    }
    const types = new Set((this.db.prepare('SELECT type FROM maintenance_session_events WHERE session_id=?').all(sessionId) as Array<{ type: string }>).map(item => item.type))
    if (!types.has('request/header') || !types.has('turn/end')) {
      throw new Error('Phase 2 maintenance transcript is missing its request or terminal event')
    }
  }

  private noteDispositions(sessionId: SessionId, jobId: string): readonly NoteDisposition[] {
    const expected = (this.db.prepare('SELECT note_id FROM phase2_job_notes WHERE job_id=? ORDER BY note_id').all(jobId) as Array<{ note_id: string }>)
      .map(row => row.note_id)
    if (expected.length === 0) return []
    const rows = this.db.prepare("SELECT event_json FROM maintenance_session_events WHERE session_id=? AND type='assistant/message' ORDER BY seq DESC")
      .all(sessionId) as Array<{ event_json: string }>
    const text = rows.map((row) => {
      const event = JSON.parse(row.event_json) as SessionEvent
      const message = deriveEventMessage(event)
      return message?.role === 'assistant'
        ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
        : ''
    }).find(value => value.trim() !== '')
    if (text === undefined) throw new Error('Phase 2 did not report explicit note dispositions')
    const trimmed = text.trim()
    const fenced = [...trimmed.matchAll(/```json\s*\r?\n([\s\S]*?)\r?\n```/gu)]
    const trailingObjects = [...trimmed.matchAll(/\{\s*"noteDispositions"\s*:/gu)]
    const trailingObjectStart = trailingObjects.at(-1)?.index
    const payload = trimmed.startsWith('{')
      ? trimmed
      : fenced.length === 1 && fenced[0]?.[1] !== undefined && trimmed.endsWith(fenced[0][0])
        ? fenced[0][1].trim()
        : trailingObjectStart === undefined ? trimmed : trimmed.slice(trailingObjectStart)
    let value: unknown
    try {
      value = JSON.parse(payload)
    } catch (error: unknown) {
      throw new Error('Phase 2 note dispositions are not valid JSON', { cause: error })
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.keys(value).length !== 1 || !('noteDispositions' in value) || !Array.isArray(value.noteDispositions)) {
      throw new Error('Phase 2 note disposition result must contain only noteDispositions')
    }
    const allowed = new Set<TerminalNoteProcessingStatus>(['applied', 'partial', 'unresolved', 'failed'])
    const seen = new Set<string>()
    const dispositions = value.noteDispositions.map((entry: unknown): NoteDisposition => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('Phase 2 note disposition must be an object')
      const fields = Object.keys(entry)
      if (fields.some(field => !['noteId', 'status', 'detail'].includes(field))) throw new Error('Phase 2 note disposition contains an unknown field')
      const noteId = 'noteId' in entry ? entry.noteId : undefined
      const status = 'status' in entry ? entry.status : undefined
      const detail = 'detail' in entry ? entry.detail : undefined
      if (typeof noteId !== 'string' || typeof status !== 'string' || !allowed.has(status as TerminalNoteProcessingStatus) || typeof detail !== 'string') {
        throw new Error('Phase 2 note disposition has invalid fields')
      }
      if (seen.has(noteId)) throw new Error(`Phase 2 reported note ${noteId} more than once`)
      seen.add(noteId)
      return { noteId, status: status as TerminalNoteProcessingStatus, detail: redactMemoryText(detail) }
    })
    if (seen.size !== expected.length || expected.some(noteId => !seen.has(noteId))) {
      throw new Error('Phase 2 must report every claimed note exactly once')
    }
    if (dispositions.some(disposition => !expected.includes(disposition.noteId))) {
      throw new Error('Phase 2 reported a note outside its claimed batch')
    }
    return dispositions
  }

  /** Read aggregate public profile state. */
  getProfileState(): Promise<MemoryProfileState> {
    return this.exclusive(() => this.getProfileStateDirect())
  }

  /** Apply live profile switches without restarting the Host. */
  updateProfileControls(expectedRevision: number, patch: MemoryProfileControlPatch): Promise<MemoryProfileState> {
    return this.exclusive(() => {
      this.transaction(() => {
        const row = currentProfile(this.db)
        if (row.control_revision !== expectedRevision) throw new MemoryError('conflict', 'memory profile controls changed; reload before retrying')
        const enabled = patch.enabled ?? row.enabled === 1
        const useByDefault = patch.useByDefault ?? row.inject_default === 1
        const contributeByDefault = patch.contributeByDefault ?? row.contribute_default === 1
        this.db.prepare(`UPDATE profile_state SET enabled=?,inject_default=?,contribute_default=?,control_revision=control_revision+1
          WHERE singleton=1 AND control_revision=?`).run(enabled ? 1 : 0, useByDefault ? 1 : 0, contributeByDefault ? 1 : 0, expectedRevision)
      })
      const state = this.getProfileStateDirect()
      this.ctx.emit('memory/changed', { changeSequence: state.changeSequence, ...state.currentGenerationId === undefined ? {} : { generationId: state.currentGenerationId } })
      this.ctx.emit('memory/pipeline-work-available', { kind: 'source' })
      return state
    })
  }

  private getProfileStateDirect(): MemoryProfileState {
    const row = currentProfile(this.db)
    const current = row.current_generation_id === null
      ? undefined
      : this.db.prepare("SELECT * FROM generations WHERE id=? AND status IN ('published','finalized')").get(row.current_generation_id) as GenerationRow | undefined
    const pendingPhase1 = asNumber((this.db.prepare("SELECT COUNT(*) AS count FROM source_ranges WHERE status IN ('queued','leased','retry_wait')").get() as { count: number | bigint }).count)
    const quarantineCount = asNumber((this.db.prepare("SELECT COUNT(*) AS count FROM source_ranges WHERE status='quarantined'").get() as { count: number | bigint }).count)
    const pendingPhase2 = (this.db.prepare("SELECT 1 AS value WHERE EXISTS(SELECT 1 FROM candidates WHERE status IN ('pending','claimed')) OR EXISTS(SELECT 1 FROM ad_hoc_notes WHERE processing_status IN ('pending','claimed'))").get() as { value: number } | undefined) !== undefined
    const totalBytes = asNumber((this.db.prepare("SELECT COALESCE(SUM(total_bytes),0) AS total FROM generations WHERE status IN ('published','finalized')").get() as { total: number | bigint }).total)
    const rebuild = this.db.prepare('SELECT * FROM memory_rebuilds ORDER BY created_at DESC LIMIT 1').get() as RebuildRow | undefined
    return {
      controlRevision: row.control_revision,
      enabled: row.enabled === 1,
      useByDefault: row.inject_default === 1,
      contributeByDefault: row.contribute_default === 1,
      changeSequence: row.change_sequence,
      ...row.current_generation_id === null ? {} : { currentGenerationId: MemoryGenerationId(row.current_generation_id) },
      ...row.current_publish_sequence === null ? {} : { currentPublishSequence: row.current_publish_sequence },
      generationStatus: current === undefined ? 'none' : this.generationIsReady(current) ? 'ready' : 'rebuild-required',
      pendingPhase1,
      pendingPhase2,
      quarantineCount,
      totalBytes,
      ...rebuild === undefined ? {} : { rebuild: rebuildFromRow(rebuild) },
    }
  }

  /** Initialize scheduler defaults without replacing a prior UI-authored value. */
  initializeRuntimeSettings(defaults: MemoryRuntimeSettingsValues): Promise<MemoryRuntimeSettings> {
    return this.exclusive(() => {
      const values = validateRuntimeSettings(defaults)
      this.db.prepare(`INSERT OR IGNORE INTO runtime_settings (singleton, revision, values_json, updated_at)
        VALUES (1, 0, ?, ?)`).run(JSON.stringify(values), Date.now())
      let settings = runtimeSettings(this.db)
      if (settings.policyVersion < MEMORY_POLICY_VERSION) {
        const { revision: _revision, ...stored } = settings
        const upgraded = validateRuntimeSettings({
          ...stored,
          policyVersion: MEMORY_POLICY_VERSION,
          consolidationMaxTokens: stored.consolidationMaxTokens === 16_384
            ? DEFAULT_MEMORY_RUNTIME_SETTINGS.consolidationMaxTokens
            : stored.consolidationMaxTokens,
        })
        this.transaction(() => {
          this.invalidatePolicyState(Date.now())
          this.db.prepare('UPDATE runtime_settings SET revision=revision+1,values_json=?,updated_at=? WHERE singleton=1')
            .run(JSON.stringify(upgraded), Date.now())
        })
        settings = runtimeSettings(this.db)
        this.ctx.emit('memory/runtime-settings-changed', settings)
        this.ctx.emit('memory/pipeline-work-available', { kind: 'source' })
      }
      this.settingsRevision = settings.revision
      return settings
    })
  }

  private invalidatePolicyState(now: number): void {
    this.db.prepare("UPDATE phase1_attempts SET status='failed',finished_at=COALESCE(finished_at,?) WHERE status IN ('opened','request_logged','result_logged')").run(now)
    this.db.prepare("UPDATE source_ranges SET status='cancelled',owner_token=NULL,leased_until=NULL,next_attempt_at=NULL,terminal_reason='policy-rebuild',updated_at=? WHERE status!='succeeded'").run(now)
    this.db.prepare("UPDATE maintenance_sessions SET status='failed',finished_at=COALESCE(finished_at,?) WHERE status IN ('allocated','live')").run(now)
    this.db.prepare("UPDATE phase2_jobs SET status='stale',updated_at=? WHERE status NOT IN ('finalized','stale','quarantined','cancelled')").run(now)
    this.db.prepare("UPDATE generations SET status='abandoned' WHERE status IN ('materializing','prepared')").run()
    this.db.prepare("UPDATE candidates SET status='consumed',phase2_job_id=NULL WHERE status IN ('pending','claimed')").run()
    this.db.prepare("UPDATE ad_hoc_notes SET status='pending',processing_status='pending',claimed_job_id=NULL,revision=revision+1,updated_at=? WHERE authority_status='active'").run(now)
    this.db.prepare('UPDATE profile_state SET memory_epoch=memory_epoch+1 WHERE singleton=1').run()
  }

  /** Read the current live scheduler settings. */
  getRuntimeSettings(): Promise<MemoryRuntimeSettings> {
    return this.exclusive(() => runtimeSettings(this.db))
  }

  /** Apply one revision-checked live scheduler update. */
  updateRuntimeSettings(
    expectedRevision: number,
    patch: MemoryRuntimeSettingsPatch,
  ): Promise<MemoryRuntimeSettings> {
    return this.exclusive(() => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new MemoryError('invalid-request', 'expectedRevision must be a non-negative safe integer')
      }
      const settings = this.transaction(() => {
        const current = runtimeSettings(this.db)
        if (current.revision !== expectedRevision) {
          throw new MemoryError('conflict', 'memory runtime settings changed; reload before retrying')
        }
        const { revision: _revision, ...currentValues } = current
        const values = validateRuntimeSettings({ ...currentValues, ...patch })
        const next: MemoryRuntimeSettings = { revision: current.revision + 1, ...values }
        if (values.policyVersion !== current.policyVersion) {
          this.invalidatePolicyState(Date.now())
        }
        this.db.prepare(`INSERT INTO runtime_settings (singleton, revision, values_json, updated_at) VALUES (1, ?, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision, values_json=excluded.values_json, updated_at=excluded.updated_at`)
          .run(next.revision, JSON.stringify(values), Date.now())
        return next
      })
      this.settingsRevision = settings.revision
      this.ctx.emit('memory/runtime-settings-changed', settings)
      this.ctx.emit('memory/pipeline-work-available', { kind: 'source' })
      return settings
    })
  }

  /** Return explicit session controls, defaulting to an unpersisted revision zero. */
  getSessionControls(sessionId: SessionId): Promise<SessionMemoryControls> {
    return this.exclusive(() => {
      const row = this.db.prepare('SELECT revision, inject, contribute FROM session_controls WHERE session_id = ?').get(sessionId) as
        { revision: number; inject: SessionMemoryControls['use']; contribute: SessionMemoryControls['contribute'] } | undefined
      return row === undefined ? { revision: 0, use: 'inherit', contribute: 'inherit' } : { revision: row.revision, use: row.inject, contribute: row.contribute }
    })
  }

  /** Apply a revision-checked control patch. */
  setSessionControls(sessionId: SessionId, expectedRevision: number, patch: SessionMemoryControlsPatch): Promise<SessionMemoryControls> {
    return this.exclusive(() => {
      const controls = this.transaction(() => {
        const row = this.db.prepare('SELECT revision, inject, contribute FROM session_controls WHERE session_id = ?').get(sessionId) as
          { revision: number; inject: SessionMemoryControls['use']; contribute: SessionMemoryControls['contribute'] } | undefined
        const current: SessionMemoryControls = row === undefined ? { revision: 0, use: 'inherit', contribute: 'inherit' } : { revision: row.revision, use: row.inject, contribute: row.contribute }
        if (current.revision !== expectedRevision) throw new MemoryError('conflict', 'session memory controls changed; reload before retrying')
        const next = {
          revision: current.revision + 1,
          use: patch.use ?? current.use,
          contribute: patch.contribute ?? current.contribute,
        }
        this.db.prepare(`INSERT INTO session_controls (session_id, revision, inject, contribute, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision, inject=excluded.inject, contribute=excluded.contribute, updated_at=excluded.updated_at`)
          .run(sessionId, next.revision, next.use, next.contribute, Date.now())
        return next
      })
      this.ctx.emit('memory/session-controls-changed', { sessionId, controls })
      this.ctx.emit('memory/pipeline-work-available', { kind: 'source' })
      return controls
    })
  }

  private currentGeneration(requested?: MemoryGenerationId): GenerationRow {
    const id = requested ?? (() => {
      const current = currentProfile(this.db).current_generation_id
      if (current === null) throw new MemoryError('not-found', 'no memory generation has been published')
      return MemoryGenerationId(current)
    })()
    const row = this.db.prepare("SELECT * FROM generations WHERE id = ? AND status IN ('published','finalized')").get(id) as GenerationRow | undefined
    if (row === undefined) throw new MemoryError('not-found', 'memory generation was not found')
    return row
  }

  private generationIsReady(row: GenerationRow): boolean {
    try {
      const manifest = parseManifest(readFileSync(join(row.root, 'generation-manifest.json'), 'utf8'))
      if (manifest.formatVersion !== 2
        || manifest.policyVersion !== runtimeSettings(this.db).policyVersion) return false
      return readFileSync(join(row.root, 'memory_summary.md'), 'utf8').split(/\r?\n/u, 1)[0] === 'v1'
    } catch (error: unknown) {
      throw new MemoryError('unavailable', `memory generation cannot be read: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async verifiedManifest(row: GenerationRow): Promise<GenerationManifest> {
    const path = join(row.root, 'generation-manifest.json')
    const content = await readFile(path, 'utf8')
    if (row.manifest_sha256 === null || memorySha256(content) !== row.manifest_sha256) throw new MemoryError('unavailable', 'memory generation manifest failed integrity validation')
    const manifest = parseManifest(content)
    if (manifest.generationId !== row.id || manifest.publishSequence !== row.publish_sequence) throw new MemoryError('unavailable', 'memory generation manifest identity does not match state')
    return manifest
  }

  /** Resolve verified memory citations and update file/source adoption counters. */
  recordCitations(text: string, adoptedAt = Date.now()): Promise<number> {
    return this.exclusive(async () => {
      const citations = new Map<string, { generationId: string; path: string; line: number }>()
      const pattern = /dsh-memory:\/\/([^/\s]+)\/([^#\s]+)#L([1-9]\d*)/gu
      for (const match of text.matchAll(pattern)) {
        const generationId = match[1]
        const encodedPath = match[2]
        const rawLine = match[3]
        if (generationId === undefined || encodedPath === undefined || rawLine === undefined) continue
        let path: string
        try { path = decodeURIComponent(encodedPath) } catch { continue }
        const line = Number(rawLine)
        if (!Number.isSafeInteger(line) || path.length === 0 || isAbsolute(path) || path.includes('\\') || path.split('/').includes('..')) continue
        citations.set(`${generationId}\0${path}\0${line}`, { generationId, path, line })
      }
      if (citations.size === 0) return 0
      const adopted: Array<{ generationId: string; path: string; sourceIds: readonly string[] }> = []
      const manifests = new Map<string, GenerationManifest>()
      for (const citation of citations.values()) {
        let manifest = manifests.get(citation.generationId)
        if (manifest === undefined) {
          const row = this.db.prepare("SELECT * FROM generations WHERE id=? AND status IN ('published','finalized')")
            .get(citation.generationId) as GenerationRow | undefined
          if (row === undefined) continue
          manifest = await this.verifiedManifest(row).catch(() => undefined)
          if (manifest === undefined) continue
          manifests.set(citation.generationId, manifest)
        }
        const file = manifest.files.find(candidate => candidate.path === citation.path)
        if (file === undefined) continue
        const anchor = file.anchors.find(candidate => citation.line >= candidate.startLine && citation.line <= candidate.endLine)
        adopted.push({ generationId: citation.generationId, path: citation.path, sourceIds: anchor?.sourceIds ?? file.sourceIds })
      }
      this.transaction(() => {
        for (const item of adopted) {
          this.db.prepare(`INSERT INTO generation_file_usage (generation_id,path,adopted_count,last_adopted_at) VALUES (?,?,1,?)
            ON CONFLICT(generation_id,path) DO UPDATE SET adopted_count=adopted_count+1,last_adopted_at=excluded.last_adopted_at`)
            .run(item.generationId, item.path, adoptedAt)
          for (const sourceId of item.sourceIds) {
            this.db.prepare(`INSERT INTO source_usage (source_id,adopted_count,last_adopted_at) VALUES (?,1,?)
              ON CONFLICT(source_id) DO UPDATE SET adopted_count=adopted_count+1,last_adopted_at=excluded.last_adopted_at`)
              .run(sourceId, adoptedAt)
            this.db.prepare(`INSERT INTO session_source_usage (session_id,adopted_count,last_adopted_at)
              SELECT session_id,1,? FROM source_ranges WHERE 'source:'||id=?
              ON CONFLICT(session_id) DO UPDATE SET adopted_count=adopted_count+1,
                last_adopted_at=MAX(last_adopted_at,excluded.last_adopted_at)`).run(adoptedAt, sourceId)
          }
        }
        if (adopted.length > 0) this.db.prepare('UPDATE profile_state SET change_sequence=change_sequence+1 WHERE singleton=1').run()
      })
      if (adopted.length > 0) {
        const profile = currentProfile(this.db)
        this.ctx.emit('memory/changed', { changeSequence: profile.change_sequence,
          ...profile.current_generation_id === null ? {} : { generationId: MemoryGenerationId(profile.current_generation_id) } })
      }
      return adopted.length
    })
  }

  /** Acquire one prompt snapshot and expiring generation read lease. */
  acquirePromptSnapshot(request: MemoryPromptSnapshotRequest): Promise<MemoryPromptSnapshotResult> {
    return this.exclusive(async () => {
      if (!Number.isSafeInteger(request.maxSummaryBytes) || request.maxSummaryBytes < 1) throw new MemoryError('invalid-request', 'maxSummaryBytes must be a positive safe integer')
      const profile = currentProfile(this.db)
      if (profile.enabled !== 1) return { kind: 'skipped', reason: 'disabled' }
      const controls = this.getSessionControlsDirect(request.sessionId)
      if (controls.use === 'deny' || (controls.use === 'inherit' && profile.inject_default !== 1)) return { kind: 'skipped', reason: 'session-denied' }
      if (profile.current_generation_id === null) return { kind: 'skipped', reason: 'no-generation' }
      const row = this.currentGeneration(MemoryGenerationId(profile.current_generation_id))
      if (!this.generationIsReady(row)) return { kind: 'skipped', reason: 'incompatible-generation' }
      const pointer = JSON.parse(await readFile(this.pointerPath, 'utf8')) as { generationId?: unknown; publishSequence?: unknown; manifestSha256?: unknown }
      if (pointer.generationId !== row.id
        || pointer.publishSequence !== row.publish_sequence
        || pointer.manifestSha256 !== row.manifest_sha256) {
        throw new MemoryError('unavailable', 'memory pointer does not match durable state')
      }
      const manifest = await this.verifiedManifest(row)
      const summaryFile = manifest.files.find(file => file.role === 'summary')
      if (summaryFile === undefined) throw new MemoryError('unavailable', 'memory manifest has no summary')
      const summaryBytes = await readFile(join(row.root, summaryFile.path))
      if (memorySha256(summaryBytes) !== summaryFile.sha256) throw new MemoryError('unavailable', 'memory summary failed integrity validation')
      const filteredSummary = await this.filterPendingMemoryText(row, manifest, summaryFile.path, summaryBytes.toString('utf8'))
      const limit = Math.min(request.maxSummaryBytes, this.config.maxPromptSummaryBytes)
      const selection = budgetSummary(filteredSummary, limit)
      const summary = selection.text
      if (summary.length === 0) return { kind: 'skipped', reason: 'budget-too-small' }
      const leaseId = MemoryReadLeaseId(randomUUID())
      const now = Date.now()
      const leaseExpiresAt = now + this.config.readLeaseMs
      this.db.prepare('INSERT INTO read_leases (id, generation_id, owner, leased_until, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(leaseId, row.id, request.leaseOwner, leaseExpiresAt, now)
      return {
        kind: 'available',
        generationId: MemoryGenerationId(row.id),
        generationRoot: row.root,
        summary,
        summarySha256: memorySha256(summary),
        leaseId,
        leaseExpiresAt,
        bytes: selection.bytes,
        retainedItems: selection.retainedItems,
        omittedItems: selection.omittedItems,
      }
    })
  }

  private getSessionControlsDirect(sessionId: SessionId): SessionMemoryControls {
    const row = this.db.prepare('SELECT revision, inject, contribute FROM session_controls WHERE session_id = ?').get(sessionId) as
      { revision: number; inject: SessionMemoryControls['use']; contribute: SessionMemoryControls['contribute'] } | undefined
    return row === undefined ? { revision: 0, use: 'inherit', contribute: 'inherit' } : { revision: row.revision, use: row.inject, contribute: row.contribute }
  }

  /** Idempotently release one generation read lease. */
  releaseReadLease(leaseId: MemoryReadLeaseId): Promise<void> {
    return this.exclusive(() => { this.db.prepare('DELETE FROM read_leases WHERE id = ?').run(leaseId) })
  }

  /** List a deterministic page from one verified manifest. */
  listGenerationTree(request: MemoryTreeRequest): Promise<MemoryTreePage> {
    return this.exclusive(async () => {
      const limit = request.limit ?? 100
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new MemoryError('invalid-request', 'generation tree limit must be between 1 and 500')
      const offset = request.cursor === undefined ? 0 : Number(request.cursor)
      if (!Number.isSafeInteger(offset) || offset < 0) throw new MemoryError('invalid-request', 'generation tree cursor is invalid')
      const row = this.currentGeneration(request.generationId)
      const manifest = await this.verifiedManifest(row)
      const items = manifest.files.slice(offset, offset + limit).map(file => ({
        path: file.path,
        role: file.role,
        bytes: file.bytes,
        sha256: file.sha256,
      }))
      const next = offset + items.length
      return { generationId: MemoryGenerationId(row.id), items, ...next < manifest.files.length ? { nextCursor: String(next) } : {} }
    })
  }

  /** Read one bounded verified generation file. */
  readGenerationFile(request: MemoryFileReadRequest): Promise<MemoryFileReadResult> {
    return this.exclusive(async () => {
      if (request.path.length === 0 || isAbsolute(request.path) || request.path.includes('\\') || request.path.split('/').includes('..')) {
        throw new MemoryError('invalid-path', 'memory generation paths must be normalized relative paths')
      }
      const offset = request.offset ?? 0
      const maxBytes = request.maxBytes ?? 64 * 1024
      if (!Number.isSafeInteger(offset)
        || offset < 0
        || !Number.isSafeInteger(maxBytes)
        || maxBytes < 1
        || maxBytes > this.config.maxFileBytes) {
        throw new MemoryError('invalid-request', 'memory file byte range is invalid')
      }
      const row = this.currentGeneration(request.generationId)
      const manifest = await this.verifiedManifest(row)
      const file = manifest.files.find(item => item.path === request.path)
      if (file === undefined) throw new MemoryError('not-found', 'memory generation file was not found')
      const absolute = resolve(row.root, request.path)
      if (!contained(row.root, absolute)) throw new MemoryError('invalid-path', 'memory generation path escaped its root')
      const bytes = await readFile(absolute)
      if (bytes.length !== file.bytes || memorySha256(bytes) !== file.sha256) throw new MemoryError('unavailable', 'memory generation file failed integrity validation')
      const { text, end } = boundedUtf8(bytes, Math.min(offset, bytes.length), maxBytes)
      return {
        generationId: MemoryGenerationId(row.id),
        path: request.path,
        text,
        offset,
        ...end < bytes.length ? { nextOffset: end } : {},
        totalBytes: bytes.length,
        sha256: file.sha256,
      }
    })
  }

  private sourceIdsForRange(
    manifest: GenerationManifest,
    path: string,
    startLine: number,
    endLine: number,
  ): readonly string[] {
    const file = manifest.files.find(item => item.path === path)
    if (file === undefined) return []
    return [...new Set(file.anchors
      .filter(anchor => anchor.endLine >= startLine && anchor.startLine <= endLine)
      .flatMap(anchor => anchor.sourceIds))].sort()
  }

  private itemOrigin(sourceIds: readonly string[]): MemoryItem['origin'] {
    const automatic = sourceIds.some(id => id.startsWith('source:'))
    const explicit = sourceIds.some(id => id.startsWith('ad-hoc:'))
    return automatic && explicit ? 'mixed' : explicit ? 'explicit' : 'automatic'
  }

  private itemFromRange(
    row: GenerationRow,
    manifest: GenerationManifest,
    path: string,
    kind: MemoryItem['kind'],
    title: string,
    lines: readonly string[],
    startIndex: number,
    endIndex: number,
  ): MemoryItem {
    const content = lines.slice(startIndex, endIndex + 1).join('\n').trim()
    const target: MemoryItemTarget = {
      generationId: MemoryGenerationId(row.id),
      path,
      startLine: startIndex + 1,
      endLine: endIndex + 1,
      contentSha256: memorySha256(content),
    }
    const sourceIds = this.sourceIdsForRange(manifest, path, target.startLine, target.endLine)
    const id = MemoryItemId(createHash('sha256').update([
      row.id, path, String(target.startLine), String(target.endLine), target.contentSha256,
    ].join('\0')).digest('hex'))
    return { id, kind, title, content, target, sourceIds, status: 'active', origin: this.itemOrigin(sourceIds) }
  }

  private async deriveMemoryItems(row: GenerationRow, manifest: GenerationManifest): Promise<MemoryItem[]> {
    if (!this.generationIsReady(row)) return []
    const items: MemoryItem[] = []
    const summary = await readFile(join(row.root, 'memory_summary.md'), 'utf8')
    const summaryLines = summary.split(/\r?\n/u)
    const sections = new Map<string, MemoryItem['kind']>([
      ['## User Profile', 'profile'],
      ['## User preferences', 'preference'],
      ['## General Tips', 'general-tip'],
    ])
    let section: MemoryItem['kind'] | undefined
    for (let index = 0; index < summaryLines.length; index += 1) {
      const line = summaryLines[index] ?? ''
      if (/^##\s+/u.test(line)) {
        section = sections.get(line)
        continue
      }
      if (section === undefined || !/^\s*[-*+]\s+/u.test(line)) continue
      let end = index
      while (end + 1 < summaryLines.length) {
        const next = summaryLines[end + 1] ?? ''
        if (/^##\s+/u.test(next) || /^\s*[-*+]\s+/u.test(next)) break
        end += 1
      }
      const title = line.replace(/^\s*[-*+]\s+/u, '').replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').slice(0, 120)
      items.push(this.itemFromRange(row, manifest, 'memory_summary.md', section, title, summaryLines, index, end))
      index = end
    }
    const catalog = await readFile(join(row.root, 'MEMORY.md'), 'utf8')
    const catalogLines = catalog.split(/\r?\n/u)
    for (let index = 0; index < catalogLines.length; index += 1) {
      const match = /^#\s+(.+?)\s*#*$/u.exec(catalogLines[index] ?? '')
      if (match?.[1] === undefined || match[1].trim().toLocaleLowerCase() === 'memory') continue
      let end = index
      while (end + 1 < catalogLines.length && !/^#\s+/u.test(catalogLines[end + 1] ?? '')) end += 1
      const title = match[1].replace(/^Task Group\s*:\s*/iu, '').trim().slice(0, 120)
      items.push(this.itemFromRange(row, manifest, 'MEMORY.md', 'task-group', title, catalogLines, index, end))
      index = end
    }
    const activeTargets = this.db.prepare(`SELECT id,action,target FROM ad_hoc_notes
      WHERE authority_status='active' AND action IN ('update','forget') AND target IS NOT NULL`)
      .all() as Array<{ id: string; action: 'update' | 'forget'; target: string }>
    const byTarget = new Map(activeTargets.flatMap((note) => {
      const target = parseMemoryItemNoteTarget(note.target)
      return target === undefined || target.generationId !== row.id
        ? []
        : [[`${target.path}\0${target.startLine}\0${target.endLine}\0${target.contentSha256}`, note] as const]
    }))
    return items.map((item) => {
      const pending = byTarget.get(`${item.target.path}\0${item.target.startLine}\0${item.target.endLine}\0${item.target.contentSha256}`)
      return pending === undefined ? item : {
        ...item,
        status: pending.action === 'forget' ? 'pending-delete' : 'pending-update',
        pendingNoteId: AdHocNoteId(pending.id),
      }
    })
  }

  /** List user-manageable semantic items from the current verified policy generation. */
  listMemoryItems(request: MemoryItemListRequest): Promise<MemoryItemPage> {
    return this.exclusive(async () => {
      const limit = request.limit ?? 100
      const offset = request.cursor === undefined ? 0 : Number(request.cursor)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0) {
        throw new MemoryError('invalid-request', 'memory item page is invalid')
      }
      const profile = currentProfile(this.db)
      if (request.generationId === undefined && profile.current_generation_id === null) return { items: [], sourceUsage: [] }
      const row = this.currentGeneration(request.generationId)
      if (!this.generationIsReady(row)) return { generationId: MemoryGenerationId(row.id), items: [], sourceUsage: [] }
      const manifest = await this.verifiedManifest(row)
      const items = await this.deriveMemoryItems(row, manifest)
      const page = items.slice(offset, offset + limit)
      return {
        generationId: MemoryGenerationId(row.id),
        items: page,
        sourceUsage: [...new Set(page.flatMap(item => item.sourceIds))].sort().map((sourceId) => {
          const usage = this.db.prepare(`SELECT COALESCE(s.adopted_count,u.adopted_count,0) AS count,
            COALESCE(s.last_adopted_at,u.last_adopted_at) AS last FROM (SELECT ? AS id) i
            LEFT JOIN source_ranges r ON i.id='source:'||r.id
            LEFT JOIN session_source_usage s ON s.session_id=r.session_id
            LEFT JOIN source_usage u ON u.source_id=i.id`).get(sourceId) as { count: number; last: number | null }
          return { sourceId, adoptedCount: usage.count, ...usage.last === null ? {} : { lastAdoptedAt: usage.last } }
        }),
        ...offset + page.length < items.length ? { nextCursor: String(offset + page.length) } : {},
      }
    })
  }

  private itemNoteTarget(item: MemoryItem): string {
    return JSON.stringify({
      kind: 'memory-item',
      itemId: item.id,
      title: item.title,
      sourceIds: item.sourceIds,
      priorContent: item.content,
      ...item.target,
    } satisfies MemoryItemNoteTarget)
  }

  private async requireCurrentMemoryItem(target: MemoryItemTarget): Promise<MemoryItem> {
    const profile = currentProfile(this.db)
    if (profile.current_generation_id !== target.generationId) {
      throw new MemoryError('conflict', 'the memory generation changed; reload before confirming this change')
    }
    const row = this.currentGeneration(target.generationId)
    const items = await this.deriveMemoryItems(row, await this.verifiedManifest(row))
    const item = items.find(candidate => candidate.target.path === target.path
      && candidate.target.startLine === target.startLine
      && candidate.target.endLine === target.endLine
      && candidate.target.contentSha256 === target.contentSha256)
    if (item === undefined) throw new MemoryError('conflict', 'the memory item changed; reload before confirming this change')
    if (item.status !== 'active') throw new MemoryError('conflict', 'the memory item already has a pending change')
    return item
  }

  private async filterPendingMemoryText(
    row: GenerationRow,
    manifest: GenerationManifest,
    path: string,
    content: string,
  ): Promise<string> {
    if (path !== 'memory_summary.md' && path !== 'MEMORY.md') return content
    const items = await this.deriveMemoryItems(row, manifest)
    const pending = items.filter(item => item.status !== 'active')
    if (pending.length === 0) return content
    const pendingSources = new Set(pending.flatMap(item => item.sourceIds))
    const removed = items.filter(item => item.target.path === path && (
      item.status !== 'active'
      || (path === 'memory_summary.md'
        && item.sourceIds.length > 0
        && item.sourceIds.some(sourceId => pendingSources.has(sourceId)))
    ))
    const lines = content.split(/\r?\n/u)
    for (const item of removed) {
      for (let line = item.target.startLine; line <= item.target.endLine; line += 1) lines[line - 1] = ''
    }
    return lines.join('\n')
  }

  private requireMemoryUse(sessionId: SessionId): ProfileRow {
    const profile = currentProfile(this.db)
    const controls = this.getSessionControlsDirect(sessionId)
    const allowed = controls.use === 'allow' || (controls.use === 'inherit' && profile.inject_default === 1)
    if (profile.enabled !== 1 || !allowed) throw new MemoryError('disabled', 'memory recall is disabled for this Session')
    return profile
  }

  private async lexicalHits(request: MemorySearchRequest, listOnly: boolean): Promise<readonly MemorySearchHit[]> {
    const profile = this.requireMemoryUse(request.sessionId)
    if (profile.current_generation_id === null) return []
    const query = request.query.normalize('NFKC').trim().toLocaleLowerCase()
    if (!listOnly && (query.length === 0 || query.length > 512)) throw new MemoryError('invalid-request', 'memory query must contain 1 through 512 characters')
    const limit = request.limit ?? 8
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new MemoryError('invalid-request', 'memory result limit must be between 1 and 20')
    const row = this.currentGeneration(MemoryGenerationId(profile.current_generation_id))
    if (!this.generationIsReady(row)) return []
    const manifest = await this.verifiedManifest(row)
    const searchable = manifest.files.filter(file => file.role === 'catalog' || file.role === 'skill' || file.role === 'rollout')
    const tokens = listOnly ? [] : [...new Set(query.split(/[\s\p{P}\p{S}]+/u).filter(token => token.length > 0))]
    const hits: MemorySearchHit[] = []
    for (const file of searchable) {
      const storedContent = await readFile(join(row.root, file.path), 'utf8')
      const content = await this.filterPendingMemoryText(row, manifest, file.path, storedContent)
      const lines = content.split(/\r?\n/u)
      let heading: string | undefined
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? ''
        const match = /^#{1,6}\s+(.+?)\s*#*$/u.exec(line)
        if (match?.[1] !== undefined) heading = match[1]
        const normalized = line.normalize('NFKC').toLocaleLowerCase()
        const score = listOnly
          ? match === null ? 0 : (file.role === 'catalog' ? 100 : 20)
          : (normalized.includes(query) ? 100 : 0)
            + tokens.reduce((sum, token) => sum + (normalized.includes(token) ? 10 : 0), 0)
            + (heading?.normalize('NFKC').toLocaleLowerCase().includes(query) === true ? 25 : 0)
        if (score === 0) continue
        const citation = `dsh-memory://${row.id}/${encodeURIComponent(file.path)}#L${index + 1}`
        hits.push({
          generationId: MemoryGenerationId(row.id),
          path: file.path,
          line: index + 1,
          ...heading === undefined ? {} : { heading },
          snippet: line.trim().slice(0, 600),
          citation,
          score,
        })
      }
    }
    return hits
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, 'en') || a.line - b.line)
      .slice(0, limit)
  }

  /** List current catalog headings for an authorized model Session. */
  listMemory(request: MemoryListRequest): Promise<readonly MemorySearchHit[]> {
    return this.exclusive(() => this.lexicalHits({ ...request, query: '' }, true))
  }

  /** Search current memory with deterministic Unicode-normalized lexical matching. */
  searchMemory(request: MemorySearchRequest): Promise<readonly MemorySearchHit[]> {
    return this.exclusive(() => this.lexicalHits(request, false))
  }

  /** Read one current-generation detail file for an authorized model Session. */
  readMemory(request: MemoryReadRequest): Promise<MemoryFileReadResult> {
    return this.exclusive(async () => {
      const profile = this.requireMemoryUse(request.sessionId)
      if (profile.current_generation_id === null) throw new MemoryError('not-found', 'no memory generation has been published')
      if (request.path === 'raw_memories.md' || request.path.startsWith('extensions/') || request.path === 'generation-manifest.json') {
        throw new MemoryError('not-found', 'memory file was not found')
      }
      const row = this.currentGeneration(MemoryGenerationId(profile.current_generation_id))
      if (!this.generationIsReady(row)) throw new MemoryError('unavailable', 'current memory generation requires a policy rebuild')
      const manifest = await this.verifiedManifest(row)
      const file = manifest.files.find(item => item.path === request.path && ['catalog', 'skill', 'rollout'].includes(item.role))
      if (file === undefined) throw new MemoryError('not-found', 'memory file was not found')
      const bytes = await readFile(join(row.root, file.path))
      if (bytes.length !== file.bytes || memorySha256(bytes) !== file.sha256) throw new MemoryError('unavailable', 'memory file failed integrity validation')
      const filtered = Buffer.from(await this.filterPendingMemoryText(row, manifest, file.path, bytes.toString('utf8')), 'utf8')
      const maxBytes = request.maxBytes ?? 64 * 1024
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > this.config.maxFileBytes) throw new MemoryError('invalid-request', 'memory file byte limit is invalid')
      const { text, end } = boundedUtf8(filtered, 0, maxBytes)
      return {
        generationId: MemoryGenerationId(row.id),
        path: file.path,
        text,
        offset: 0,
        ...end < filtered.length ? { nextOffset: end } : {},
        totalBytes: filtered.length,
        sha256: memorySha256(filtered),
      }
    })
  }

  /** List deterministic ad-hoc note pages. */
  listAdHocNotes(request: AdHocNoteListRequest): Promise<AdHocNotePage> {
    return this.exclusive(() => {
      const limit = request.limit ?? 100
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new MemoryError('invalid-request', 'ad-hoc note limit must be between 1 and 500')
      const cursor = request.cursor ?? ''
      const processing = request.processingStatuses ?? ['pending', 'claimed', 'applied', 'partial', 'unresolved', 'failed']
      const authority = request.authorityStatuses ?? ['active', 'superseded', 'cleared']
      if (processing.length === 0 || authority.length === 0) return { items: [] }
      const processingPlaceholders = processing.map(() => '?').join(',')
      const authorityPlaceholders = authority.map(() => '?').join(',')
      const rows = this.db.prepare(`SELECT * FROM ad_hoc_notes WHERE id > ? AND processing_status IN (${processingPlaceholders})
        AND authority_status IN (${authorityPlaceholders}) ORDER BY id LIMIT ?`)
        .all(cursor, ...processing, ...authority, limit + 1) as unknown as AdHocNoteRow[]
      const items = rows.slice(0, limit).map(row => this.adHocNote(row))
      const last = rows[limit - 1]
      return { items, ...rows.length > limit && last !== undefined ? { nextCursor: last.id } : {} }
    })
  }

  private adHocNote(row: AdHocNoteRow): AdHocNote {
    return {
      id: AdHocNoteId(row.id),
      revision: row.revision,
      action: row.action,
      processingStatus: row.processing_status,
      authorityStatus: row.authority_status,
      content: row.content,
      ...row.source_user_text === null ? {} : { sourceUserText: row.source_user_text },
      ...row.target === null ? {} : { target: row.target },
      origin: row.origin,
      ...row.source_session_id === null ? {} : { sourceSessionId: SessionId(row.source_session_id) },
      ...row.source_turn === null ? {} : { sourceTurn: row.source_turn },
      ...row.source_user_event_seq === null ? {} : { sourceUserEventSeq: row.source_user_event_seq },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...row.participated_generation_id === null
        ? {}
        : { appliedGenerationId: MemoryGenerationId(row.participated_generation_id) },
      ...row.disposition === null ? {} : { disposition: row.disposition },
    }
  }

  private createNoteDirect(
    request: SubmitAdHocNoteRequest,
    source?: Omit<SubmitConversationMemoryRequest, keyof SubmitAdHocNoteRequest>,
  ): AdHocNote {
    const content = redactMemoryText(request.content).trim()
    const bytes = Buffer.byteLength(content, 'utf8')
    const sourceUserText = source === undefined ? undefined : redactMemoryText(source.sourceUserText)
    if (sourceUserText !== undefined && (sourceUserText.trim().length === 0 || Buffer.byteLength(sourceUserText, 'utf8') > this.config.maxAdHocNoteBytes)) {
      throw new MemoryError('invalid-request', 'original user message is empty or exceeds the configured note limit')
    }
    if (content.length === 0 || bytes > this.config.maxAdHocNoteBytes) {
      throw new MemoryError('invalid-request', 'ad-hoc note is empty or exceeds the configured limit')
    }
    if ((request.action === 'update' || request.action === 'forget')
        && request.target !== undefined && request.target.trim().length === 0) {
      throw new MemoryError('invalid-request', 'memory update target must not be empty')
    }
    const now = Date.now()
    const id = AdHocNoteId(randomUUID())
    const committed = this.transaction(() => {
      if (request.supersedes !== undefined) {
        const changed = this.db.prepare("UPDATE ad_hoc_notes SET authority_status='superseded', revision=revision+1, updated_at=? WHERE id=? AND authority_status='active'").run(now, request.supersedes)
        if (changed.changes !== 1) throw new MemoryError('conflict', 'the superseded note is no longer active')
      }
      this.db.prepare(`INSERT INTO ad_hoc_notes
          (id,revision,status,text,action,processing_status,authority_status,content,target,origin,source_session_id,source_turn,source_user_event_seq,source_user_text,created_at,updated_at)
          VALUES (?,1,'pending',?,?,'pending','active',?,?,?,?,?,?,?,?,?)`)
        .run(id, content, request.action, content, request.target ?? null, source === undefined ? 'ui' : 'conversation', source?.sessionId ?? null, source?.turn ?? null, source?.userEventSeq ?? null, sourceUserText ?? null, now, now)
      const profile = currentProfile(this.db)
      const changeSequence = profile.change_sequence + 1
      this.db.prepare('UPDATE profile_state SET change_sequence=? WHERE singleton=1').run(changeSequence)
      return {
        note: this.adHocNote(this.db.prepare('SELECT * FROM ad_hoc_notes WHERE id=?').get(id) as unknown as AdHocNoteRow),
        changeSequence,
        generationId: profile.current_generation_id === null
          ? undefined
          : MemoryGenerationId(profile.current_generation_id),
      }
    })
    this.ctx.emit('memory/changed', {
      changeSequence: committed.changeSequence,
      ...committed.generationId === undefined ? {} : { generationId: committed.generationId },
    })
    this.ctx.emit('memory/pipeline-work-available', { kind: 'ad-hoc' })
    return committed.note
  }

  private submitNote(
    request: SubmitAdHocNoteRequest,
    source?: Omit<SubmitConversationMemoryRequest, keyof SubmitAdHocNoteRequest>,
  ): Promise<AdHocNote> {
    return this.exclusive(() => this.createNoteDirect(request, source))
  }

  /** Persist one explicit new memory request. */
  rememberMemory(request: RememberMemoryRequest): Promise<AdHocNote> {
    return this.submitNote({ action: 'remember', content: request.content })
  }

  /** Persist one revision-safe semantic replacement and suppress the stale item immediately. */
  updateMemoryItem(request: UpdateMemoryItemRequest): Promise<AdHocNote> {
    return this.exclusive(async () => {
      const item = await this.requireCurrentMemoryItem(request.target)
      return this.createNoteDirect({ action: 'update', content: request.content, target: this.itemNoteTarget(item) })
    })
  }

  /** Persist one revision-safe semantic deletion and suppress the stale item immediately. */
  deleteMemoryItem(request: DeleteMemoryItemRequest): Promise<AdHocNote> {
    return this.exclusive(async () => {
      const item = await this.requireCurrentMemoryItem(request.target)
      return this.createNoteDirect({
        action: 'forget',
        content: `Remove the semantic memory item titled "${item.title}" and all summary projections supported only by the same sources.`,
        target: this.itemNoteTarget(item),
      })
    })
  }

  /** Persist one user-authored management request. */
  submitAdHocNote(request: SubmitAdHocNoteRequest): Promise<AdHocNote> { return this.submitNote(request) }

  /** Persist one current-turn user-authorized request with trusted source identity. */
  submitConversationMemory(request: SubmitConversationMemoryRequest): Promise<AdHocNote> {
    const { sessionId, turn, userEventSeq, sourceUserText, ...note } = request
    return this.submitNote(note, { sessionId, turn, userEventSeq, sourceUserText })
  }

  /** Wake bounded discovery while bypassing only the configured idle delay. */
  requestScanAndConsolidation(): Promise<void> {
    return this.exclusive(() => {
      const state = this.getProfileStateDirect()
      if (!state.enabled) throw new MemoryError('disabled', 'long-term memory is disabled')
      this.ctx.emit('memory/pipeline-work-available', { kind: 'manual-scan' })
    })
  }

  /** Wake Phase 2 for already durable pending work without changing that work. */
  requestConsolidation(): Promise<void> {
    return this.exclusive(() => {
      const state = this.getProfileStateDirect()
      if (!state.enabled) throw new MemoryError('disabled', 'long-term memory is disabled')
      if (!state.pendingPhase2) return
      this.ctx.emit('memory/pipeline-work-available', { kind: 'manual-consolidation' })
    })
  }

  /** Delete derived memory state and freeze the requested completion-time window. */
  startCleanPolicyRebuild(request: StartCleanPolicyRebuildRequest): Promise<MemoryRebuild> {
    if (!Number.isSafeInteger(request.sourceLookbackMs) || request.sourceLookbackMs < 1 || request.sourceLookbackMs > 365 * 24 * 60 * 60_000
      || !['preserve-active', 'purge-all'].includes(request.explicitNotePolicy)) {
      return Promise.reject(new MemoryError('invalid-request', 'rebuild requires a valid lookback and explicit note policy'))
    }
    return this.exclusive(async () => {
      const rebuildId = MemoryRebuildId(randomUUID())
      const now = Date.now()
      const changeSequence = this.transaction(() => {
        this.db.exec(`
          DELETE FROM read_leases;
          DELETE FROM generation_file_usage;
          DELETE FROM generation_sources;
          DELETE FROM generations;
          DELETE FROM maintenance_session_events;
          DELETE FROM maintenance_sessions;
          DELETE FROM phase2_workspaces;
          DELETE FROM phase2_structured_attempts;
          DELETE FROM phase2_job_notes;
          DELETE FROM phase2_job_candidates;
          DELETE FROM phase2_jobs;
          DELETE FROM candidates;
          DELETE FROM phase1_attempts;
          DELETE FROM failures;
          DELETE FROM source_usage;
          DELETE FROM session_source_usage;
          DELETE FROM source_ranges;
          DELETE FROM memory_rebuilds;
          DELETE FROM ad_hoc_notes WHERE authority_status!='active';
        `)
        this.db.prepare(`UPDATE ad_hoc_notes SET status='pending',processing_status='pending',claimed_job_id=NULL,
          participated_generation_id=NULL,disposition=NULL,revision=revision+1,updated_at=? WHERE authority_status='active'`).run(now)
        if (request.explicitNotePolicy === 'purge-all') this.db.exec('DELETE FROM ad_hoc_notes')
        this.db.prepare(`INSERT INTO memory_rebuilds
          (id,status,target_policy_version,template_version,source_completed_after,explicit_note_policy,created_at,updated_at)
          VALUES (?,'purging-old-state',?,?,?,?,?,?)`).run(rebuildId, MEMORY_POLICY_VERSION, MEMORY_TEMPLATE_VERSION, Math.max(0, now - request.sourceLookbackMs), request.explicitNotePolicy, now, now)
        const profile = currentProfile(this.db)
        const next = profile.change_sequence + 1
        this.db.prepare(`UPDATE profile_state SET current_generation_id=NULL,current_publish_sequence=NULL,
          memory_epoch=memory_epoch+1,change_sequence=? WHERE singleton=1`).run(next)
        return next
      })
      try {
        await rm(this.pointerPath, { force: true })
        await rm(this.stagingRoot, { recursive: true, force: true })
        await rm(this.generationsRoot, { recursive: true, force: true })
        await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 })
        await mkdir(this.generationsRoot, { recursive: true, mode: 0o700 })
        this.db.prepare("UPDATE memory_rebuilds SET status='scanning',updated_at=? WHERE id=?").run(Date.now(), rebuildId)
      } catch (error: unknown) {
        this.db.prepare("UPDATE memory_rebuilds SET status='failed',error=?,updated_at=?,finished_at=? WHERE id=?")
          .run(error instanceof Error ? error.message : String(error), Date.now(), Date.now(), rebuildId)
        throw error
      } finally {
        this.ctx.emit('memory/changed', { changeSequence })
      }
      this.ctx.emit('memory/pipeline-work-available', { kind: 'clean-rebuild' })
      const row = this.db.prepare('SELECT * FROM memory_rebuilds WHERE id=?').get(rebuildId) as unknown as RebuildRow
      return rebuildFromRow(row)
    })
  }

  /** Read an unfinished clean rebuild for scheduler admission. */
  getActiveCleanRebuild(): Promise<MemoryRebuild | undefined> {
    return this.exclusive(() => {
      const row = this.db.prepare("SELECT * FROM memory_rebuilds WHERE status NOT IN ('published','failed','cancelled') ORDER BY created_at DESC LIMIT 1").get() as RebuildRow | undefined
      return row === undefined ? undefined : rebuildFromRow(row)
    })
  }

  /** Commit one all-retained discovery pass. */
  reportCleanRebuildDiscovery(progress: CleanRebuildDiscoveryProgress): Promise<void> {
    return this.exclusive(() => {
      const now = Date.now()
      const nextStatus = progress.waitingSessions > 0
        ? 'waiting-for-idle'
        : progress.scanComplete ? 'extracting' : 'scanning'
      const changed = this.db.prepare(`UPDATE memory_rebuilds SET status=?,total_sessions=?,scanned_sessions=?,scan_cursor=?,waiting_sessions=?,updated_at=?
        WHERE id=? AND status NOT IN ('published','failed','cancelled')`).run(
        nextStatus,
        progress.totalSessions,
        progress.scannedSessions,
        progress.scanCursor,
        progress.waitingSessions,
        now,
        progress.rebuildId,
      )
      if (changed.changes !== 1) throw new Error('clean rebuild is stale or no longer active')
      this.emitMemoryChanged()
    })
  }

  /** Clear all learned state while preserving controls and pre-reset source watermarks. */
  resetMemory(_request: ResetMemoryRequest): Promise<void> {
    return this.exclusive(async () => {
      const changeSequence = this.transaction(() => {
        const now = Date.now()
        const watermarks = this.db.prepare('SELECT session_id,MAX(to_seq) AS clear_through_seq FROM source_ranges GROUP BY session_id')
          .all() as Array<{ session_id: string; clear_through_seq: number }>
        for (const watermark of watermarks) {
          this.db.prepare(`INSERT INTO session_clear_watermarks (session_id,clear_through_seq,updated_at) VALUES (?,?,?)
            ON CONFLICT(session_id) DO UPDATE SET clear_through_seq=MAX(clear_through_seq,excluded.clear_through_seq),updated_at=excluded.updated_at`)
            .run(watermark.session_id, watermark.clear_through_seq, now)
        }
        this.db.exec(`
          DELETE FROM read_leases;
          DELETE FROM generation_file_usage;
          DELETE FROM generation_sources;
          DELETE FROM generations;
          DELETE FROM maintenance_session_events;
          DELETE FROM maintenance_sessions;
          DELETE FROM phase2_workspaces;
          DELETE FROM phase2_job_notes;
          DELETE FROM phase2_job_candidates;
          DELETE FROM phase2_jobs;
          DELETE FROM candidates;
          DELETE FROM phase1_attempts;
          DELETE FROM failures;
          DELETE FROM source_usage;
          DELETE FROM session_source_usage;
          DELETE FROM source_ranges;
          DELETE FROM ad_hoc_notes;
        `)
        const profile = currentProfile(this.db)
        const next = profile.change_sequence + 1
        this.db.prepare(`UPDATE profile_state SET current_generation_id=NULL,current_publish_sequence=NULL,
          memory_epoch=memory_epoch+1,change_sequence=? WHERE singleton=1`).run(next)
        return next
      })
      await rm(this.pointerPath, { force: true })
      await rm(this.stagingRoot, { recursive: true, force: true })
      await rm(this.generationsRoot, { recursive: true, force: true })
      await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 })
      await mkdir(this.generationsRoot, { recursive: true, mode: 0o700 })
      this.ctx.emit('memory/changed', { changeSequence })
    })
  }

  /** List bounded source and consolidation quarantines for explicit management. */
  listQuarantines(request: MemoryQuarantineListRequest): Promise<MemoryQuarantinePage> {
    return this.exclusive(() => {
      const limit = request.limit ?? 100
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new MemoryError('invalid-request', 'quarantine limit must be between 1 and 500')
      const cursor = request.cursor ?? ''
      const sources = this.db.prepare(`SELECT quarantine_id AS id,terminal_reason AS reason,attempt,updated_at,session_id,from_seq,to_seq
        FROM source_ranges WHERE status='quarantined' AND quarantine_id IS NOT NULL`).all() as Array<{
        id: string
        reason: string | null
        attempt: number
        updated_at: number
        session_id: string
        from_seq: number
        to_seq: number
      }>
      const phase2 = this.db.prepare(`SELECT job.id,job.attempt,job.updated_at,
        COALESCE((SELECT failure.category || ': ' || failure.message FROM failures AS failure
          WHERE failure.phase='phase2' AND failure.job_id=job.id ORDER BY failure.created_at DESC LIMIT 1),'consolidation-failed') AS reason
        FROM phase2_jobs AS job WHERE job.status='quarantined'`).all() as Array<{
        id: string
        attempt: number
        updated_at: number
        reason: string
      }>
      const items = [
        ...sources.map(row => ({
          id: QuarantineRangeId(row.id),
          phase: 'phase1' as const,
          reason: row.reason ?? 'unknown',
          attempts: row.attempt,
          updatedAt: row.updated_at,
          sessionId: SessionId(row.session_id),
          fromSeq: row.from_seq,
          toSeq: row.to_seq,
        })),
        ...phase2.map(row => ({
          id: QuarantineRangeId(`phase2-${row.id}`),
          phase: 'phase2' as const,
          reason: row.reason,
          attempts: row.attempt,
          updatedAt: row.updated_at,
        })),
      ].sort((left, right) => left.id.localeCompare(right.id, 'en'))
      const start = items.findIndex(item => item.id > cursor)
      if (start < 0) return { items: [] }
      const page = items.slice(start, start + limit)
      const last = page.at(-1)
      return { items: page, ...start + page.length < items.length && last !== undefined ? { nextCursor: last.id } : {} }
    })
  }

  /** Requeue one quarantined range without rebuilding its immutable identity. */
  retryQuarantine(id: QuarantineRangeId): Promise<void> {
    return this.exclusive(() => {
      const now = Date.now()
      this.transaction(() => {
        const source = this.db.prepare("UPDATE source_ranges SET status='queued', quarantine_id=NULL, terminal_reason=NULL, next_attempt_at=NULL, updated_at=? WHERE quarantine_id=? AND status='quarantined'").run(now, id)
        if (source.changes === 1) return
        if (!id.startsWith('phase2-')) throw new MemoryError('not-found', 'quarantined range was not found')
        const jobId = id.slice('phase2-'.length)
        const job = this.db.prepare("SELECT baseline_generation_id FROM phase2_jobs WHERE id=? AND status='quarantined'")
          .get(jobId) as { baseline_generation_id: string | null } | undefined
        if (job === undefined) throw new MemoryError('not-found', 'quarantined range was not found')
        if (job.baseline_generation_id !== currentProfile(this.db).current_generation_id) {
          this.db.prepare("UPDATE candidates SET status='pending',phase2_job_id=NULL WHERE phase2_job_id=? AND status='claimed'").run(jobId)
          this.db.prepare("UPDATE ad_hoc_notes SET status='pending',processing_status='pending',claimed_job_id=NULL,revision=revision+1,updated_at=? WHERE claimed_job_id=? AND processing_status='claimed' AND authority_status='active'")
            .run(now, jobId)
          this.db.prepare("UPDATE phase2_jobs SET status='stale',next_attempt_at=NULL,updated_at=? WHERE id=? AND status='quarantined'").run(now, jobId)
          return
        }
        this.db.prepare("UPDATE phase2_jobs SET status='retry_wait',next_attempt_at=?,updated_at=? WHERE id=? AND status='quarantined'").run(now, now, jobId)
      })
      this.ctx.emit('memory/pipeline-work-available', { kind: 'quarantine' })
    })
  }

  /** Register immutable completed ranges idempotently. */
  registerSourceRanges(ranges: readonly RegisterSourceRange[]): Promise<RegisterSourceRangeResult> {
    return this.exclusive(() => {
      let inserted = 0
      let existing = 0
      const now = Date.now()
      this.transaction(() => {
        const profile = currentProfile(this.db)
        for (const range of ranges) {
          if (!/^[A-Za-z0-9._-]+$/u.test(range.sourceRangeId)) throw new Error('sourceRangeId must be path-safe')
          if (range.fromSeq < 0 || range.toSeq < range.fromSeq) throw new Error('source range is invalid')
          const controls = this.getSessionControlsDirect(range.sessionId)
          const contributes = controls.contribute === 'allow' || (controls.contribute === 'inherit' && profile.contribute_default === 1)
          if (profile.enabled !== 1 || !contributes) { existing += 1; continue }
          const cleared = this.db.prepare('SELECT clear_through_seq FROM session_clear_watermarks WHERE session_id=?')
            .get(range.sessionId) as { clear_through_seq: number } | undefined
          if (cleared !== undefined && range.toSeq <= cleared.clear_through_seq) { existing += 1; continue }
          const fromSeq = Math.max(range.fromSeq, cleared === undefined ? 0 : cleared.clear_through_seq + 1)
          // Range receipts survive output retention and template upgrades. A newer complete rollout
          // also covers an older listing result; rediscovery must not cancel its successor.
          const covered = this.db.prepare(`SELECT id FROM source_ranges WHERE session_id=? AND policy_version=?
            AND from_seq<=? AND to_seq>=? AND id!=? ORDER BY to_seq DESC LIMIT 1`)
            .get(range.sessionId, range.policyVersion, fromSeq, range.toSeq, range.sourceRangeId)
          if (covered !== undefined) { existing += 1; continue }
          const inputFingerprint = fingerprint({
            sourceRangeId: range.sourceRangeId,
            sessionId: range.sessionId,
            fromSeq,
            toSeq: range.toSeq,
            completedAt: range.completedAt,
            workspaceIdAtEvidence: range.workspaceIdAtEvidence,
            workspacePathAtEvidence: range.workspacePathAtEvidence,
            policyVersion: range.policyVersion,
          })
          const superseded = this.db.prepare(`SELECT id FROM source_ranges
            WHERE session_id=? AND policy_version=? AND id!=? AND status!='leased'`).all(
            range.sessionId,
            range.policyVersion,
            range.sourceRangeId,
          ) as Array<{ id: string }>
          for (const prior of superseded) {
            this.db.prepare("UPDATE candidates SET status='consumed',phase2_job_id=NULL WHERE source_range_id=? AND status IN ('pending','claimed')").run(prior.id)
            this.db.prepare("UPDATE source_ranges SET status='cancelled',terminal_reason='superseded-by-complete-rollout',updated_at=? WHERE id=?").run(now, prior.id)
          }
          const result = this.db.prepare(`INSERT OR IGNORE INTO source_ranges
            (id, session_id, from_seq, to_seq, completed_at, workspace_id, workspace_path, policy_version, input_fingerprint, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`).run(
            range.sourceRangeId,
            range.sessionId,
            fromSeq,
            range.toSeq,
            range.completedAt,
            range.workspaceIdAtEvidence ?? null,
            range.workspacePathAtEvidence ?? null,
            range.policyVersion,
            inputFingerprint,
            now,
            now,
          )
          if (result.changes === 1) inserted += 1
          else {
            const stored = this.db.prepare('SELECT input_fingerprint FROM source_ranges WHERE id = ?').get(range.sourceRangeId) as { input_fingerprint: string } | undefined
            if (stored?.input_fingerprint !== inputFingerprint) throw new Error(`source range identity collision: ${range.sourceRangeId}`)
            existing += 1
          }
        }
      })
      if (inserted > 0) this.ctx.emit('memory/pipeline-work-available', { kind: 'source' })
      return { inserted, existing }
    })
  }

  /** Claim one due Phase 1 range with an expiring fencing token. */
  claimPhase1(request: Phase1ClaimRequest): Promise<Phase1Claim | undefined> {
    return this.exclusive(() => this.transaction(() => {
      if (request.leaseMs < 1 || request.maxAttempts < 1) throw new Error('Phase 1 claim limits must be positive')
      this.db.prepare("UPDATE source_ranges SET status='queued', owner_token=NULL, leased_until=NULL, updated_at=? WHERE status='leased' AND leased_until < ?")
        .run(request.now, request.now)
      const row = this.db.prepare(`SELECT * FROM source_ranges
        WHERE (status='queued' OR (status='retry_wait' AND next_attempt_at <= ?)) AND attempt < ?
        ORDER BY completed_at, id LIMIT 1`).get(request.now, request.maxAttempts) as SourceRow | undefined
      if (row === undefined) return undefined
      const ownerToken = MemoryClaimToken(randomUUID())
      const leasedUntil = request.now + request.leaseMs
      const attempt = row.attempt + 1
      const changed = this.db.prepare("UPDATE source_ranges SET status='leased', owner_token=?, leased_until=?, attempt=?, next_attempt_at=NULL, updated_at=? WHERE id=? AND status IN ('queued','retry_wait')")
        .run(ownerToken, leasedUntil, attempt, request.now, row.id)
      if (changed.changes !== 1) return undefined
      return {
        jobId: Phase1JobId(row.id),
        sourceRangeId: MemorySourceRangeId(row.id),
        sessionId: SessionId(row.session_id),
        fromSeq: row.from_seq,
        toSeq: row.to_seq,
        inputFingerprint: row.input_fingerprint,
        lease: { ownerToken, leasedUntil, attempt },
      }
    }))
  }

  private requirePhase1Claim(claim: Phase1Claim): SourceRow {
    const row = this.db.prepare('SELECT * FROM source_ranges WHERE id = ?').get(claim.sourceRangeId) as SourceRow | undefined
    if (row === undefined || row.status !== 'leased' || row.owner_token !== claim.lease.ownerToken || row.input_fingerprint !== claim.inputFingerprint || row.leased_until === null || row.leased_until < Date.now()) {
      throw new Error('Phase 1 claim is stale or no longer owned')
    }
    return row
  }

  /** Open one audit attempt after validating claim ownership. */
  beginPhase1Attempt(claim: Phase1Claim): Promise<Phase1Attempt> {
    return this.exclusive(() => this.transaction(() => {
      const source = this.requirePhase1Claim(claim)
      const attemptId = MemoryAttemptId(randomUUID())
      this.db.prepare("INSERT INTO phase1_attempts (id, source_range_id, attempt, owner_token, status, created_at) VALUES (?, ?, ?, ?, 'opened', ?)")
        .run(attemptId, source.id, source.attempt, claim.lease.ownerToken, Date.now())
      return { attemptId, jobId: claim.jobId, lease: claim.lease }
    }))
  }

  /** Persist and size-check one exact Phase 1 request before dispatch. */
  recordPhase1Request(request: RecordedPhase1Request): Promise<void> {
    return this.exclusive(() =>{  this.transaction(() => {
      const json = JSON.stringify(request.request)
      const bytes = Buffer.byteLength(json, 'utf8')
      if (bytes !== request.bytes || bytes > this.config.maxAuditRequestBytes) throw new Error('Phase 1 audit request size is invalid')
      const usage = this.db.prepare(`SELECT
        (SELECT COUNT(*) FROM phase1_attempts WHERE status='opened' OR request_json IS NOT NULL OR result_json IS NOT NULL)
          + (SELECT COUNT(*) FROM maintenance_sessions WHERE status!='pruned')
          + (SELECT COUNT(*) FROM phase2_structured_attempts) AS attempts,
        COALESCE((SELECT SUM(COALESCE(request_bytes,0)+COALESCE(result_bytes,0)
          + CASE WHEN status='request_logged' AND result_json IS NULL THEN ? ELSE 0 END)
          FROM phase1_attempts WHERE status='opened' OR request_json IS NOT NULL OR result_json IS NOT NULL),0)
          + COALESCE((SELECT SUM(total_bytes) FROM maintenance_sessions WHERE status!='pruned'),0)
          + COALESCE((SELECT SUM(length(CAST(request_json AS BLOB))+COALESCE(length(CAST(result_json AS BLOB)),?)) FROM phase2_structured_attempts),0) AS bytes`)
        .get(this.config.maxAuditResultBytes, this.config.maxAuditResultBytes) as { attempts: number | bigint; bytes: number | bigint }
      if (asNumber(usage.attempts) > this.config.maxAuditAttempts
        || asNumber(usage.bytes) + bytes + this.config.maxAuditResultBytes > this.config.maxAuditTotalBytes) {
        throw new Error('Phase 1 audit capacity is exhausted')
      }
      const changed = this.db.prepare("UPDATE phase1_attempts SET status='request_logged', request_fingerprint=?, request_json=?, request_bytes=?,output_format_version=? WHERE id=? AND status='opened'")
        .run(request.requestFingerprint, json, bytes, request.outputFormatVersion ?? 1, request.attemptId)
      if (changed.changes !== 1) throw new Error('Phase 1 attempt cannot accept a request record')
      this.db.prepare("UPDATE memory_rebuilds SET model_calls=model_calls+1,updated_at=? WHERE status IN ('extracting','waiting-for-idle','scanning')").run(Date.now())
    }) })
  }

  /** Persist one complete result or bounded overflow prefix before apply. */
  recordPhase1Result(result: RecordedPhase1Result): Promise<void> {
    return this.exclusive(() =>{  this.transaction(() => {
      const json = JSON.stringify(result.result)
      const bytes = Buffer.byteLength(json, 'utf8')
      if (bytes !== result.bytes || bytes > this.config.maxAuditResultBytes) throw new Error('Phase 1 audit result size is invalid')
      const changed = this.db.prepare(`UPDATE phase1_attempts SET status='result_logged', result_json=?, result_bytes=?, result_chunks=?, termination=?, finished_at=?
        WHERE id=? AND status='request_logged'`).run(json, bytes, result.chunkCount, result.termination, result.recordedAt, result.attemptId)
      if (changed.changes !== 1) throw new Error('Phase 1 attempt cannot accept a result record')
    }) })
  }

  /** Atomically apply candidates or another terminal/retrying source outcome. */
  commitPhase1Outcome(claim: Phase1Claim, outcome: Phase1Outcome): Promise<void> {
    return this.exclusive(() => {
      const phase2 = this.transaction(() => {
        const source = this.requirePhase1Claim(claim)
        const now = Date.now()
        const latest = this.db.prepare('SELECT id, status FROM phase1_attempts WHERE source_range_id=? AND attempt=?').get(source.id, source.attempt) as { id: string; status: string } | undefined
        if (outcome.kind === 'applied' && latest?.status !== 'result_logged') throw new Error('an applied Phase 1 outcome requires a logged result')
        if (outcome.kind === 'empty' && latest !== undefined && latest.status !== 'result_logged') throw new Error('an attempted empty Phase 1 outcome requires a logged result')
        if (outcome.kind === 'applied') {
          outcome.candidates.forEach((candidate, index) => {
            if (candidate.candidateId !== `${claim.jobId}:${index}`) throw new Error('candidateId is not deterministic for this Phase 1 output')
            if (candidate.rawMemory.trim().length === 0 || candidate.rolloutSummary.trim().length === 0 || candidate.evidenceIds.length === 0) throw new Error('Phase 1 rollout output is incomplete')
            this.db.prepare(`INSERT INTO candidates
              (id, source_range_id, output_index, body, kind, keywords_json, evidence_ids_json, raw_memory, rollout_summary, rollout_slug, status, created_at)
              VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, 'pending', ?)`)
              .run(
                candidate.candidateId,
                source.id,
                index,
                candidate.rawMemory,
                'evidence',
                JSON.stringify(candidate.evidenceIds),
                candidate.rawMemory,
                candidate.rolloutSummary,
                candidate.rolloutSlug ?? null,
                now,
              )
          })
          this.db.prepare("UPDATE source_ranges SET status='succeeded', owner_token=NULL, leased_until=NULL, terminal_reason=NULL, updated_at=? WHERE id=?").run(now, source.id)
          this.db.prepare("UPDATE memory_rebuilds SET extracted_sessions=extracted_sessions+1,updated_at=? WHERE status IN ('extracting','waiting-for-idle','scanning')").run(now)
        } else if (outcome.kind === 'empty') {
          this.db.prepare("UPDATE source_ranges SET status='succeeded', owner_token=NULL, leased_until=NULL, terminal_reason=NULL, updated_at=? WHERE id=?").run(now, source.id)
          this.db.prepare("UPDATE memory_rebuilds SET extracted_sessions=extracted_sessions+1,empty_sessions=empty_sessions+1,updated_at=? WHERE status IN ('extracting','waiting-for-idle','scanning')").run(now)
        } else if (outcome.kind === 'retry') {
          this.db.prepare("UPDATE source_ranges SET status='retry_wait', owner_token=NULL, leased_until=NULL, next_attempt_at=?, terminal_reason=?, updated_at=? WHERE id=?")
            .run(outcome.nextAttemptAt, outcome.reason, now, source.id)
        } else if (outcome.kind === 'quarantined') {
          this.db.prepare("UPDATE source_ranges SET status='quarantined', owner_token=NULL, leased_until=NULL, quarantine_id=?, terminal_reason=?, updated_at=? WHERE id=?")
            .run(outcome.quarantineId, outcome.reason, now, source.id)
          this.db.prepare("UPDATE memory_rebuilds SET failed_sessions=failed_sessions+1,updated_at=? WHERE status IN ('extracting','waiting-for-idle','scanning')").run(now)
        } else {
          this.db.prepare("UPDATE source_ranges SET status='cancelled', owner_token=NULL, leased_until=NULL, terminal_reason=?, updated_at=? WHERE id=?")
            .run(outcome.reason, now, source.id)
        }
        if (latest !== undefined) this.db.prepare('UPDATE phase1_attempts SET status=?, finished_at=COALESCE(finished_at,?) WHERE id=?')
          .run(outcome.kind === 'applied' || outcome.kind === 'empty' ? 'applied' : 'failed', now, latest.id)
        return outcome.kind === 'applied' && outcome.candidates.length > 0
      })
      if (phase2) this.ctx.emit('memory/pipeline-work-available', { kind: 'phase2' })
      this.emitMemoryChanged()
    })
  }

  /** Claim a deterministic bounded Phase 2 candidate and note batch. */
  claimPhase2(request: Phase2ClaimRequest): Promise<Phase2Claim | undefined> {
    return this.exclusive(() => this.transaction(() => {
      if (request.leaseMs < 1 || request.maxSources < 1 || request.maxAttempts < 1 || request.maxUnusedDays < 1) throw new Error('Phase 2 claim limits must be positive')
      if (currentProfile(this.db).enabled !== 1) return undefined
      const rebuilding = this.db.prepare("SELECT status,waiting_sessions FROM memory_rebuilds WHERE status NOT IN ('published','failed','cancelled') LIMIT 1").get() as
        { status: MemoryRebuild['status']; waiting_sessions: number } | undefined
      const extractionPending = this.db.prepare("SELECT 1 AS value FROM source_ranges WHERE status IN ('queued','leased','retry_wait') LIMIT 1").get() as { value: number } | undefined
      if (rebuilding !== undefined
        && (rebuilding.status !== 'extracting' || extractionPending !== undefined || rebuilding.waiting_sessions > 0)) return undefined
      const expired = this.db.prepare("SELECT id FROM phase2_jobs WHERE status NOT IN ('finalized','stale','quarantined','cancelled') AND leased_until < ?").all(request.now) as Array<{ id: string }>
      for (const job of expired) {
        this.db.prepare("UPDATE candidates SET status='pending', phase2_job_id=NULL WHERE phase2_job_id=? AND status='claimed'").run(job.id)
        this.db.prepare("UPDATE ad_hoc_notes SET status='pending',processing_status='pending',claimed_job_id=NULL,revision=revision+1,updated_at=? WHERE claimed_job_id=? AND processing_status='claimed'").run(request.now, job.id)
        this.db.prepare("UPDATE maintenance_sessions SET status='failed',finished_at=COALESCE(finished_at,?) WHERE phase2_job_id=? AND status IN ('allocated','live')")
          .run(request.now, job.id)
        this.db.prepare("UPDATE phase2_jobs SET status='stale', updated_at=? WHERE id=?").run(request.now, job.id)
      }
      const blockedByExistingJob = this.db.prepare(`SELECT 1 AS value FROM phase2_jobs
        WHERE status NOT IN ('finalized','stale','quarantined','cancelled')
          AND NOT (status='retry_wait' AND next_attempt_at IS NOT NULL AND next_attempt_at<=?)
        LIMIT 1`).get(request.now) as { value: number } | undefined
      if (blockedByExistingJob !== undefined) return undefined
      const retry = this.db.prepare("SELECT * FROM phase2_jobs WHERE status='retry_wait' AND next_attempt_at<=? ORDER BY next_attempt_at,created_at,id LIMIT 1")
        .get(request.now) as Phase2Row | undefined
      if (retry !== undefined) {
        const ownerToken = MemoryClaimToken(randomUUID())
        const attempt = retry.attempt + 1
        const leasedUntil = request.now + request.leaseMs
        this.db.prepare('DELETE FROM phase2_workspaces WHERE job_id=?').run(retry.id)
        this.db.prepare("UPDATE generations SET status='abandoned' WHERE phase2_job_id=? AND status IN ('materializing','prepared')").run(retry.id)
        const changed = this.db.prepare(`UPDATE phase2_jobs SET status='leased',owner_token=?,leased_until=?,attempt=?,next_attempt_at=NULL,
          workspace_id=NULL,maintenance_session_id=NULL,updated_at=? WHERE id=? AND status='retry_wait' AND next_attempt_at<=?`)
          .run(ownerToken, leasedUntil, attempt, request.now, retry.id, request.now)
        if (changed.changes !== 1) return undefined
        const candidates = this.db.prepare('SELECT candidate_id AS id FROM phase2_job_candidates WHERE job_id=? ORDER BY candidate_id').all(retry.id) as Array<{ id: string }>
        const notes = this.db.prepare('SELECT note_id AS id FROM phase2_job_notes WHERE job_id=? ORDER BY note_id').all(retry.id) as Array<{ id: string }>
        return {
          jobId: Phase2JobId(retry.id),
          candidateIds: candidates.map(row => MemoryCandidateId(row.id)),
          adHocNoteIds: notes.map(row => AdHocNoteId(row.id)),
          ...retry.baseline_generation_id === null ? {} : { baselineGenerationId: MemoryGenerationId(retry.baseline_generation_id) },
          inputFingerprint: retry.input_fingerprint,
          sourceSelectionDiff: parseSourceSelectionDiff(retry.source_diff_json),
          lease: { ownerToken, leasedUntil, attempt },
        }
      }
      const profile = currentProfile(this.db)
      const currentPolicyVersion = runtimeSettings(this.db).policyVersion
      const expiryBefore = request.now - request.maxUnusedDays * 24 * 60 * 60_000
      const selected = selectAutomaticSources(this.db, currentPolicyVersion, expiryBefore, request.maxSources)
      const previous = previousAutomaticSources(this.db, profile.current_generation_id)
      const priorBySession = new Map(previous.map(source => [source.sessionId, source]))
      const selectedIds = new Set(selected.map(source => source.rangeId))
      const added = selected.filter(source => !priorBySession.has(source.sessionId)).map(source => source.rangeId)
      const updated = selected.filter((source) => {
        const prior = priorBySession.get(source.sessionId)
        return prior !== undefined && (prior.rangeId !== source.rangeId || prior.version !== source.version)
      }).map(source => source.rangeId)
      const retained = selected.filter(source => !added.includes(source.rangeId) && !updated.includes(source.rangeId))
        .map(source => source.rangeId)
      const removed = previous.filter(source => !selectedIds.has(source.rangeId)).map(source => source.rangeId)
      const candidates = selected.flatMap(source => this.db.prepare(
        "SELECT id,source_range_id FROM candidates WHERE source_range_id=? AND status!='suppressed' ORDER BY output_index,id",
      ).all(source.rangeId) as Array<{ id: string; source_range_id: string }>)
      const notes = this.db.prepare(`SELECT id,action,content,target,source_user_text FROM ad_hoc_notes
        WHERE authority_status='active' ${request.includeAdHocNotes === false && rebuilding === undefined ? "AND processing_status!='pending'" : ''}
        ORDER BY id`).all() as Array<{ id: string; action: string; content: string; target: string | null; source_user_text: string | null }>
      const selectionFingerprint = fingerprint({ selected, notes, policyVersion: currentPolicyVersion, memoryEpoch: profile.memory_epoch })
      const previousJob = profile.current_generation_id === null ? undefined : this.db.prepare(`SELECT j.selection_fingerprint
        FROM phase2_jobs j JOIN generations g ON g.phase2_job_id=j.id WHERE g.id=?`).get(profile.current_generation_id) as
        { selection_fingerprint: string | null } | undefined
      const pendingNote = this.db.prepare("SELECT 1 FROM ad_hoc_notes WHERE authority_status='active' AND processing_status='pending' LIMIT 1").get()
      const sameLegacySelection = previousJob?.selection_fingerprint === null && added.length === 0 && updated.length === 0
        && removed.length === 0 && (pendingNote === undefined || request.includeAdHocNotes === false)
      if (rebuilding === undefined && (previousJob?.selection_fingerprint === selectionFingerprint || sameLegacySelection
        || (profile.current_generation_id === null && selected.length === 0 && notes.length === 0))) return undefined
      const sourceSelectionDiff = { added, updated, retained, removed }
      const jobId = Phase2JobId(randomUUID())
      const ownerToken = MemoryClaimToken(randomUUID())
      const leasedUntil = request.now + request.leaseMs
      const inputFingerprint = fingerprint({
        selectionFingerprint, baseline: profile.current_generation_id,
        templateVersion: MEMORY_TEMPLATE_VERSION,
      })
      this.db.prepare(`INSERT INTO phase2_jobs
        (id,status,owner_token,leased_until,attempt,input_fingerprint,baseline_generation_id,source_diff_json,created_at,updated_at)
        VALUES (?, 'leased', ?, ?, 1, ?, ?, ?, ?, ?)`)
        .run(
          jobId,
          ownerToken,
          leasedUntil,
          inputFingerprint,
          profile.current_generation_id,
          JSON.stringify(sourceSelectionDiff),
          request.now,
          request.now,
        )
      this.db.prepare("UPDATE memory_rebuilds SET status='consolidating',updated_at=? WHERE status IN ('extracting','waiting-for-idle','scanning')").run(request.now)
      this.db.prepare('UPDATE phase2_jobs SET selection_fingerprint=? WHERE id=?').run(selectionFingerprint, jobId)
      for (const source of selected) this.db.prepare(`INSERT INTO phase2_selected_sources
        (job_id,session_id,source_range_id,version_fingerprint) VALUES (?,?,?,?)`).run(jobId,source.sessionId,source.rangeId,source.version)
      for (const candidate of candidates) {
        this.db.prepare('INSERT INTO phase2_job_candidates (job_id,candidate_id) VALUES (?,?)').run(jobId, candidate.id)
        this.db.prepare("UPDATE candidates SET status='claimed', phase2_job_id=? WHERE id=? AND status IN ('pending','consumed')").run(jobId, candidate.id)
      }
      for (const note of notes) {
        this.db.prepare('INSERT INTO phase2_job_notes (job_id,note_id) VALUES (?,?)').run(jobId, note.id)
        this.db.prepare("UPDATE ad_hoc_notes SET status='claimed',processing_status='claimed',claimed_job_id=?,revision=revision+1,updated_at=? WHERE id=? AND authority_status='active'").run(jobId, request.now, note.id)
      }
      return {
        jobId,
        candidateIds: candidates.map(row => MemoryCandidateId(row.id)),
        adHocNoteIds: notes.map(row => AdHocNoteId(row.id)),
        ...profile.current_generation_id === null ? {} : { baselineGenerationId: MemoryGenerationId(profile.current_generation_id) },
        inputFingerprint,
        sourceSelectionDiff: {
          added: added.map(MemorySourceRangeId),
          updated: updated.map(MemorySourceRangeId),
          retained: retained.map(MemorySourceRangeId),
          removed: removed.map(MemorySourceRangeId),
        },
        lease: { ownerToken, leasedUntil, attempt: 1 },
      }
    }))
  }

  private requirePhase2Claim(claim: Phase2Claim, allowed?: readonly string[]): Phase2Row {
    const row = this.db.prepare('SELECT * FROM phase2_jobs WHERE id=?').get(claim.jobId) as Phase2Row | undefined
    const states = allowed ?? ['leased', 'session_running', 'validating', 'materializing', 'prepared']
    if (row === undefined
      || !states.includes(row.status)
      || row.owner_token !== claim.lease.ownerToken
      || row.input_fingerprint !== claim.inputFingerprint
      || row.leased_until < Date.now()) {
      throw new Error('Phase 2 claim is stale or no longer owned')
    }
    return row
  }

  private requirePhase2Baseline(row: Phase2Row): void {
    if (currentProfile(this.db).current_generation_id !== row.baseline_generation_id) {
      throw new Error('Phase 2 baseline is stale')
    }
  }

  private async readonlyHash(root: string): Promise<string> {
    const hash = createHash('sha256')
    const paths = ['raw_memories.md', 'rollout_summaries', 'extensions/ad_hoc/notes']
    const visit = async (absolute: string): Promise<void> => {
      const info = await stat(absolute).catch(() => undefined)
      if (info === undefined) return
      if (info.isDirectory()) {
        const children = (await readdir(absolute)).sort()
        for (const child of children) await visit(join(absolute, child))
      } else if (info.isFile()) {
        hash.update(relative(root, absolute).split(sep).join('/')).update('\0').update(await readFile(absolute)).update('\0')
      } else throw new Error('memory evidence region contains an unsupported entry')
    }
    for (const path of paths) await visit(join(root, path))
    return hash.digest('hex')
  }

  /** Materialize one isolated Phase 2 staging tree. */
  createPhase2Workspace(claim: Phase2Claim): Promise<Phase2Workspace> {
    return this.exclusive(async () => {
      this.requirePhase2Claim(claim, ['leased'])
      const workspaceId = Phase2WorkspaceId(randomUUID())
      const root = join(this.stagingRoot, workspaceId)
      await rm(root, { recursive: true, force: true })
      const baseline = claim.baselineGenerationId === undefined
        ? undefined
        : this.currentGeneration(claim.baselineGenerationId)
      if (baseline !== undefined && this.generationIsReady(baseline)) {
        await cp(baseline.root, root, { recursive: true, errorOnExist: true })
        await rm(join(root, '.git'), { recursive: true, force: true })
        await rm(join(root, 'generation-manifest.json'), { force: true })
      } else {
        await mkdir(root, { recursive: true, mode: 0o700 })
        await writeFile(join(root, 'memory_summary.md'), "v1\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n")
        await writeFile(join(root, 'MEMORY.md'), '# Memory\n')
        await writeFile(join(root, 'raw_memories.md'), '')
      }
      await rm(join(root, 'rollout_summaries'), { recursive: true, force: true })
      await mkdir(join(root, 'rollout_summaries'), { recursive: true })
      await mkdir(join(root, 'skills'), { recursive: true })
      await rm(join(root, 'extensions', 'ad_hoc', 'notes'), { recursive: true, force: true })
      await mkdir(join(root, 'extensions', 'ad_hoc', 'notes'), { recursive: true })
      await writeFile(join(root, 'raw_memories.md'), '')
      const selectedSources = [
        ...claim.sourceSelectionDiff.retained, ...claim.sourceSelectionDiff.added, ...claim.sourceSelectionDiff.updated,
      ].sort()
      const sourcePlaceholders = selectedSources.map(() => '?').join(',')
      const candidates = this.db.prepare(`SELECT c.id,c.body,c.kind,c.evidence_ids_json,c.source_range_id,c.raw_memory,c.rollout_summary,c.rollout_slug
        FROM candidates c WHERE c.status IN ('claimed','consumed') ${selectedSources.length === 0 ? 'AND 0' : `AND c.source_range_id IN (${sourcePlaceholders})`}
        ORDER BY c.source_range_id,c.output_index`)
        .all(...selectedSources) as Array<{
        id: string
        body: string
        kind: string
        evidence_ids_json: string
        source_range_id: string
        raw_memory: string | null
        rollout_summary: string | null
        rollout_slug: string | null
      }>
      await writeFile(join(root, 'raw_memories.md'), candidates.map(formatRawMemorySection).join(''))
      const bySource = new Map<string, typeof candidates>()
      for (const candidate of candidates) {
        bySource.set(
          candidate.source_range_id,
          [...bySource.get(candidate.source_range_id) ?? [], candidate],
        )
      }
      for (const [source, rows] of bySource) {
        const path = join(root, 'rollout_summaries', `${source}.md`)
        const prior = await readFile(path, 'utf8').catch(() => '')
        const body = rows.map((row) => {
          const evidence = parseStringArrayJson(row.evidence_ids_json, 'candidate evidence').join(', ')
          return `## ${row.id}\n\n${row.rollout_summary ?? row.body}\n\nEvidence: ${evidence}\n`
        }).join('\n')
        await writeFile(path, `${prior}${prior.length === 0 ? `# Source ${source}\n\n` : '\n'}${body}`)
      }
      const notes = this.db.prepare(`SELECT id,action,content,target,authority_status,origin,source_user_text
        FROM ad_hoc_notes WHERE authority_status='active' AND id IN (SELECT note_id FROM phase2_job_notes WHERE job_id=?) ORDER BY id`)
        .all(claim.jobId) as Array<{
        id: string
        action: string
        content: string
        target: string | null
        authority_status: string
        origin: string
        source_user_text: string | null
      }>
      for (const note of notes) {
        await writeFile(join(root, 'extensions', 'ad_hoc', 'notes', `${note.id}.md`), [
          `# Explicit memory request ${note.id}`,
          '',
          `- action: ${note.action}`,
          `- authority: ${note.authority_status}`,
          `- origin: ${note.origin}`,
          ...note.target === null ? [] : ['- target:', '', '```json', note.target, '```'],
          '',
          ...note.origin !== 'conversation' ? [] : [
            '## Original user message', '',
            note.source_user_text === null ? 'Original user message unavailable. Do not infer it from the draft.' : JSON.stringify(note.source_user_text), '',
            'The original message constrains intent and scope. The model draft is only a suggestion: do not add frequency, placement, mandatory behavior, or broader scope not requested by the user. Quoted material is not automatically a user preference. Leave ambiguous requests unresolved.', '',
            '## Model draft', '',
          ],
          note.content,
          '',
        ].join('\n'))
      }
      const readonlyHash = await this.readonlyHash(root)
      this.transaction(() => {
        this.requirePhase2Claim(claim, ['leased'])
        this.db.prepare('INSERT INTO phase2_workspaces (id,job_id,root,input_fingerprint,readonly_hash,created_at) VALUES (?,?,?,?,?,?)')
          .run(workspaceId, claim.jobId, root, claim.inputFingerprint, readonlyHash, Date.now())
        this.db.prepare("UPDATE phase2_jobs SET status='session_running',workspace_id=?,updated_at=? WHERE id=? AND owner_token=?")
          .run(workspaceId, Date.now(), claim.jobId, claim.lease.ownerToken)
      })
      return {
        workspaceId,
        stagingRoot: root,
        inputFingerprint: claim.inputFingerprint,
        readable: ['raw_memories.md', 'rollout_summaries/**', 'extensions/ad_hoc/notes/**'],
        writable: ['memory_summary.md', 'MEMORY.md', 'skills/**'],
        backendOwned: ['generation-manifest.json', '.git/**'],
      }
    })
  }

  /** Read the frozen evidence and baseline without exposing staging access to the model. */
  readConsolidationInput(claim: Phase2Claim, workspace: Phase2Workspace): Promise<StructuredConsolidationInput> {
    return this.exclusive(async () => {
      const phase = this.requirePhase2Claim(claim, ['session_running'])
      if (phase.workspace_id !== workspace.workspaceId) throw new Error('stale Phase 2 workspace')
      this.requirePhase2Baseline(phase)
      const owned = this.db.prepare('SELECT * FROM phase2_workspaces WHERE id=?').get(workspace.workspaceId) as unknown as WorkspaceRow
      if (await this.readonlyHash(owned.root) !== owned.readonly_hash) throw new Error('Phase 2 modified read-only evidence')
      const files: Array<{ path: string; content: string }> = []
      let bytes = 0
      const visit = async (path: string): Promise<void> => {
        for (const entry of (await readdir(join(owned.root, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.name === '.git' || entry.name === 'generation-manifest.json') continue
          const child = path ? `${path}/${entry.name}` : entry.name
          if (entry.isDirectory()) await visit(child)
          else if (entry.isFile()) {
            const content = await readFile(join(owned.root, child), 'utf8')
            bytes += Buffer.byteLength(content)
            if (bytes > this.config.maxAuditRequestBytes) throw new Error('Phase 2 input too large')
            files.push({ path: child, content: redactMemoryText(content) })
          } else throw new Error('Phase 2 input contains an unsupported file')
        }
      }
      await visit('')
      return {
        files,
        sourceIds: [...claim.sourceSelectionDiff.retained, ...claim.sourceSelectionDiff.added, ...claim.sourceSelectionDiff.updated].sort(),
        noteIds: claim.adHocNoteIds,
      }
    })
  }

  /** Persist exact structured Phase 2 input before dispatch. */
  recordPhase2Request(request: Phase2StructuredRequest): Promise<MemoryAttemptId> {
    return this.exclusive(() => this.transaction(() => {
      const phase = this.requirePhase2Claim(request.claim, ['session_running'])
      this.requirePhase2Baseline(phase)
      const json = JSON.stringify(request.request)
      if (Buffer.byteLength(json) !== request.bytes || request.bytes > this.config.maxAuditRequestBytes) throw new Error('Phase 2 request audit too large or invalid bytes')
      const usage = this.db.prepare(`SELECT
        (SELECT COUNT(*) FROM phase2_structured_attempts)
        + (SELECT COUNT(*) FROM phase1_attempts WHERE request_json IS NOT NULL OR status='opened')
        + (SELECT COUNT(*) FROM maintenance_sessions WHERE status!='pruned') AS count,
        COALESCE((SELECT SUM(length(CAST(request_json AS BLOB))+COALESCE(length(CAST(result_json AS BLOB)),?)) FROM phase2_structured_attempts),0)
        + COALESCE((SELECT SUM(request_bytes+COALESCE(result_bytes,?)) FROM phase1_attempts WHERE request_json IS NOT NULL),0)
        + COALESCE((SELECT SUM(total_bytes) FROM maintenance_sessions WHERE status!='pruned'),0) AS bytes`)
        .get(this.config.maxAuditResultBytes, this.config.maxAuditResultBytes) as { count: number; bytes: number }
      if (usage.count >= this.config.maxAuditAttempts || usage.bytes + request.bytes + this.config.maxAuditResultBytes > this.config.maxAuditTotalBytes) throw new Error('Phase 2 audit capacity exhausted')
      const id = MemoryAttemptId(randomUUID())
      this.db.prepare(`INSERT INTO phase2_structured_attempts (id,job_id,attempt,owner_token,input_fingerprint,request_json,status,created_at)
        VALUES (?,?,?,?,?,?,'request_logged',?)`).run(id, phase.id, phase.attempt, phase.owner_token, phase.input_fingerprint, json, Date.now())
      this.db.prepare("UPDATE memory_rebuilds SET model_calls=model_calls+1,updated_at=? WHERE status='consolidating'").run(Date.now())
      return id
    }))
  }

  /** Persist final JSON, usage, and error without tool or reasoning payloads. */
  recordPhase2Result(result: Phase2StructuredResult): Promise<void> {
    return this.exclusive(() =>{  this.transaction(() => {
      this.requirePhase2Claim(result.claim, ['session_running'])
      const json = JSON.stringify(result.result)
      if (Buffer.byteLength(json) !== result.bytes || result.bytes > this.config.maxAuditResultBytes) throw new Error('Phase 2 result audit too large or invalid bytes')
      const changed = this.db.prepare(`UPDATE phase2_structured_attempts SET result_json=?,status=?,finished_at=?
        WHERE id=? AND job_id=? AND owner_token=? AND input_fingerprint=? AND status='request_logged'`).run(
        json, result.completed ? 'result_logged' : 'failed', Date.now(), result.attemptId, result.claim.jobId, result.claim.lease.ownerToken, result.claim.inputFingerprint,
      )
      if (Number(changed.changes) !== 1) throw new Error('stale Phase 2 structured audit')
    }) })
  }

  private structuredResult(jobId: string, attemptId?: MemoryAttemptId): StructuredConsolidationResult {
    const row = this.db.prepare(`SELECT a.result_json FROM phase2_structured_attempts a JOIN phase2_jobs j ON j.id=a.job_id
      WHERE a.job_id=? AND a.attempt=j.attempt AND a.owner_token=j.owner_token AND a.input_fingerprint=j.input_fingerprint
      AND a.status IN ('result_logged','applied') ${attemptId === undefined ? '' : 'AND a.id=?'} ORDER BY a.attempt DESC LIMIT 1`)
      .get(jobId, ...attemptId === undefined ? [] : [attemptId]) as { result_json: string } | undefined
    if (!row) throw new Error('Phase 2 structured result is not durable')
    const envelope: unknown = JSON.parse(row.result_json)
    if (!isRecord(envelope) || envelope.finishReason !== 'completed') throw new Error('invalid-model-output: Phase 2 did not complete')
    const errors = validateJsonSchemaValue(CONSOLIDATION_SCHEMA, envelope.value)
    if (errors.length) throw new Error(`invalid-model-output: ${errors.join('; ')}`)
    const result = envelope.value as StructuredConsolidationResult
    const job = this.db.prepare('SELECT source_diff_json FROM phase2_jobs WHERE id=?').get(jobId) as { source_diff_json: string }
    const diff = parseSourceSelectionDiff(job.source_diff_json)
    const notes = (this.db.prepare('SELECT note_id FROM phase2_job_notes WHERE job_id=?').all(jobId) as Array<{ note_id: string }>).map(row => row.note_id)
    const exact = (actual: string[], expected: string[]): boolean =>
      new Set(actual).size === actual.length && actual.length === expected.length && actual.every(id => expected.includes(id))
    if (!exact(result.sourceDecisions.map(item => item.sourceId), [...diff.retained, ...diff.added, ...diff.updated])
      || !exact(result.noteDispositions.map(item => item.noteId), notes)) throw new Error('invalid-model-output: incomplete source/note disposition partition')
    return result
  }

  /** Apply only validated, durably audited JSON to a backend-owned staging tree. */
  applyConsolidationResult(claim: Phase2Claim, workspace: Phase2Workspace, attemptId: MemoryAttemptId): Promise<void> {
    return this.exclusive(async () => {
      const phase = this.requirePhase2Claim(claim, ['session_running'])
      this.requirePhase2Baseline(phase)
      if (phase.workspace_id !== workspace.workspaceId) throw new Error('stale Phase 2 workspace')
      const owned = this.db.prepare('SELECT * FROM phase2_workspaces WHERE id=?').get(workspace.workspaceId) as unknown as WorkspaceRow
      if (await this.readonlyHash(owned.root) !== owned.readonly_hash) throw new Error('Phase 2 modified read-only evidence')
      const result = this.structuredResult(claim.jobId, attemptId)
      const names = new Set<string>()
      for (const skill of result.skills) {
        const validPath = /^skills\/[a-z0-9][a-z0-9-]*\/(?:SKILL\.md|(?:scripts|templates|examples)\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/u
        if (!validPath.test(skill.path)
          || names.has(skill.path.toLowerCase())) throw new Error('invalid-model-output: invalid or duplicate Skill path')
        names.add(skill.path.toLowerCase())
      }
      if ([result.memorySummary, result.memoryManual, ...result.skills.map(item => item.content)].some(text => Buffer.byteLength(text) > this.config.maxFileBytes)) throw new Error('Phase 2 file too large')
      await rm(join(owned.root, 'skills'), { recursive: true, force: true })
      await mkdir(join(owned.root, 'skills'), { recursive: true })
      for (const file of [{ path: 'memory_summary.md', content: result.memorySummary }, { path: 'MEMORY.md', content: result.memoryManual }, ...result.skills]) {
        await mkdir(resolve(owned.root, file.path, '..'), { recursive: true })
        await writeFile(join(owned.root, file.path), file.content)
      }
      const retained: string[] = []
      for (const decision of [...result.sourceDecisions].sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0)) {
        const path = join(owned.root, 'rollout_summaries', `${decision.sourceId}.md`)
        if (decision.action === 'discard') await rm(path, { force: true })
        else {
          const rows = this.db.prepare(`SELECT id,source_range_id,raw_memory,rollout_slug,body FROM candidates
            WHERE source_range_id=? AND status!='suppressed' ORDER BY output_index,id`)
            .all(decision.sourceId) as Array<Parameters<typeof formatRawMemorySection>[0]>
          retained.push(...rows.map(formatRawMemorySection))
        }
      }
      await writeFile(join(owned.root, 'raw_memories.md'), retained.join(''))
      const hash = await this.readonlyHash(owned.root)
      this.transaction(() => {
        this.requirePhase2Baseline(this.requirePhase2Claim(claim, ['session_running']))
        this.db.prepare('UPDATE phase2_workspaces SET readonly_hash=? WHERE id=?').run(hash, workspace.workspaceId)
      })
    })
  }

  /** Create or return the private maintenance Session binding for a claimed workspace. */
  openMaintenanceSession(claim: Phase2Claim): Promise<MaintenanceSessionBinding> {
    return this.exclusive(() => {
      const row = this.requirePhase2Claim(claim, ['session_running'])
      if (row.workspace_id === null) throw new Error('Phase 2 workspace is missing')
      const existing = row.maintenance_session_id
      const sessionId = existing === null ? SessionId(randomUUID()) : SessionId(existing)
      if (existing === null) {
        const workspace = this.db.prepare('SELECT root FROM phase2_workspaces WHERE id=?').get(row.workspace_id) as { root: string } | undefined
        if (workspace === undefined) throw new Error('Phase 2 workspace record is missing')
        const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: Date.now(), purpose: 'maintenance', cwd: workspace.root }
        this.transaction(() => {
          this.requirePhase2Claim(claim, ['session_running'])
          this.db.prepare(`INSERT INTO maintenance_sessions
            (id,phase2_job_id,header_json,status,created_at) VALUES (?,?,?,'allocated',?)`)
            .run(sessionId, claim.jobId, JSON.stringify(header), header.createdAt)
          this.db.prepare('UPDATE phase2_jobs SET maintenance_session_id=?,updated_at=? WHERE id=?').run(sessionId, Date.now(), claim.jobId)
        })
      }
      return { sessionId, persistence: { flush: () => this.flushMaintenanceSession(sessionId) } }
    })
  }

  /** Verify evidence immutability and allocate a monotonic generation sequence. */
  allocateGeneration(claim: Phase2Claim): Promise<MaterializingGeneration> {
    return this.exclusive(async () => {
      const phase = this.requirePhase2Claim(claim, ['session_running'])
      this.requirePhase2Baseline(phase)
      if (phase.workspace_id === null) throw new Error('Phase 2 workspace is missing')
      const workspace = this.db.prepare('SELECT * FROM phase2_workspaces WHERE id=?').get(phase.workspace_id) as WorkspaceRow | undefined
      if (workspace === undefined || await this.readonlyHash(workspace.root) !== workspace.readonly_hash) throw new Error('Phase 2 modified a read-only evidence region')
      return this.transaction(() => {
        const owned = this.requirePhase2Claim(claim, ['session_running'])
        this.requirePhase2Baseline(owned)
        const profile = currentProfile(this.db)
        const publishSequence = profile.publish_sequence + 1
        const generationId = MemoryGenerationId(randomUUID())
        const materializingId = MaterializingGenerationId(randomUUID())
        const root = join(this.generationsRoot, generationId)
        this.db.prepare('UPDATE profile_state SET publish_sequence=? WHERE singleton=1').run(publishSequence)
        this.db.prepare(`INSERT INTO generations
          (id,materializing_id,publish_sequence,parent_generation_id,phase2_job_id,status,root,created_at)
          VALUES (?,?,?,?,?,'materializing',?,?)`)
          .run(generationId, materializingId, publishSequence, profile.current_generation_id, claim.jobId, root, Date.now())
        this.db.prepare("UPDATE phase2_jobs SET status='materializing',updated_at=? WHERE id=? AND owner_token=?")
          .run(Date.now(), claim.jobId, claim.lease.ownerToken)
        return {
          id: materializingId,
          generationId,
          publishSequence,
          ...profile.current_generation_id === null ? {} : { parentGenerationId: MemoryGenerationId(profile.current_generation_id) },
        }
      })
    })
  }

  /** Validate the staged output, create its manifest and Git baseline, and persist an immutable generation. */
  validateAndPrepareGeneration(request: PrepareGenerationRequest): Promise<PreparedGeneration> {
    return this.exclusive(async () => {
      const phase = this.requirePhase2Claim(request.claim, ['materializing'])
      this.requirePhase2Baseline(phase)
      const workspace = this.db.prepare('SELECT * FROM phase2_workspaces WHERE id=? AND job_id=?').get(request.workspace.workspaceId, request.claim.jobId) as WorkspaceRow | undefined
      if (workspace === undefined || phase.workspace_id !== workspace.id || workspace.input_fingerprint !== request.claim.inputFingerprint) throw new Error('Phase 2 workspace does not match its claim')
      if (request.structuredAttemptId !== undefined && request.maintenanceSessionId === undefined) {
        this.structuredResult(request.claim.jobId, request.structuredAttemptId)
      } else if (request.maintenanceSessionId !== undefined && request.structuredAttemptId === undefined) {
        if (phase.maintenance_session_id !== request.maintenanceSessionId) throw new Error('Phase 2 maintenance Session does not match its claim')
        this.requireMaintenanceTranscript(request.maintenanceSessionId, request.claim.jobId)
        this.noteDispositions(request.maintenanceSessionId, request.claim.jobId)
      } else throw new Error('Phase 2 requires exactly one durable result audit')
      const generation = this.db.prepare("SELECT * FROM generations WHERE materializing_id=? AND phase2_job_id=? AND status='materializing'").get(request.materializing.id, request.claim.jobId) as GenerationRow | undefined
      if (generation === undefined || generation.id !== request.materializing.generationId || generation.publish_sequence !== request.materializing.publishSequence) throw new Error('materializing generation does not match its allocation')
      if (await this.readonlyHash(workspace.root) !== workspace.readonly_hash) throw new Error('Phase 2 modified a read-only evidence region')
      this.transaction(() => {
        const owned = this.requirePhase2Claim(request.claim, ['materializing'])
        this.requirePhase2Baseline(owned)
        this.db.prepare("UPDATE phase2_jobs SET status='validating',updated_at=? WHERE id=?").run(Date.now(), request.claim.jobId)
      })
      const manifest = await buildGenerationManifest(workspace.root, {
        generationId: generation.id,
        ...generation.parent_generation_id === null ? {} : { parentGenerationId: generation.parent_generation_id },
        publishSequence: generation.publish_sequence,
        createdAt: generation.created_at,
        policyVersion: runtimeSettings(this.db).policyVersion,
        templateVersion: MEMORY_TEMPLATE_VERSION,
      }, this.config)
      const removedSources = new Set(request.claim.sourceSelectionDiff.removed.map(id => `source:${id}`))
      if (request.structuredAttemptId !== undefined) {
        const retained = this.structuredResult(request.claim.jobId, request.structuredAttemptId).sourceDecisions.filter(item => item.action === 'retain')
        const referenced = new Set(manifest.files.filter(file => ['summary', 'catalog', 'skill'].includes(file.role)).flatMap(file => file.sourceIds))
        if (retained.some(item => !referenced.has(`source:${item.sourceId}`))) throw new Error('invalid-model-output: retained source is not used by formal memory')
      }
      const staleReference = manifest.files.flatMap(file => file.sourceIds).find(sourceId => removedSources.has(sourceId))
      if (staleReference !== undefined) throw new Error(`final generation still references removed source ${staleReference}`)
      const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
      await writeFileAtomic(join(workspace.root, 'generation-manifest.json'), manifestText, { mode: 0o600, dirMode: 0o700 })
      await execFileAsync('git', ['init', '--quiet'], { cwd: workspace.root, windowsHide: true })
      await execFileAsync('git', ['add', '--all'], { cwd: workspace.root, windowsHide: true })
      await execFileAsync('git', ['-c', 'user.name=DSH Memory', '-c', 'user.email=memory@localhost', 'commit', '--quiet', '-m', `memory generation ${generation.publish_sequence}`], { cwd: workspace.root, windowsHide: true })
      await rename(workspace.root, generation.root)
      const totalBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0) + Buffer.byteLength(manifestText, 'utf8')
      const manifestSha256 = memorySha256(manifestText)
      return this.transaction(() => {
        const owned = this.requirePhase2Claim(request.claim, ['validating'])
        this.requirePhase2Baseline(owned)
        const changed = this.db.prepare("UPDATE generations SET status='prepared',manifest_sha256=?,total_bytes=? WHERE id=? AND status='materializing'")
          .run(manifestSha256, totalBytes, generation.id)
        if (changed.changes !== 1) throw new Error('generation could not transition to prepared')
        this.db.prepare("UPDATE phase2_jobs SET status='prepared',updated_at=? WHERE id=? AND owner_token=?")
          .run(Date.now(), request.claim.jobId, request.claim.lease.ownerToken)
        return {
          generationId: MemoryGenerationId(generation.id),
          publishSequence: generation.publish_sequence,
          manifestSha256,
          claimToken: request.claim.lease.ownerToken,
        }
      })
    })
  }

  private finalizePublished(jobId: string, generation: GenerationRow, now: number): number {
    const profile = currentProfile(this.db)
    const changeSequence = profile.change_sequence + 1
    this.db.prepare('UPDATE profile_state SET current_generation_id=?,current_publish_sequence=?,change_sequence=? WHERE singleton=1')
      .run(generation.id, generation.publish_sequence, changeSequence)
    this.db.prepare("UPDATE generations SET status='finalized',published_at=COALESCE(published_at,?) WHERE id=?").run(now, generation.id)
    this.db.prepare("UPDATE phase2_jobs SET status='finalized',updated_at=? WHERE id=?").run(now, jobId)
    this.db.prepare("UPDATE candidates SET status='consumed' WHERE phase2_job_id=? AND status='claimed'").run(jobId)
    const maintenance = this.db.prepare('SELECT id FROM maintenance_sessions WHERE phase2_job_id=?').get(jobId) as { id: string } | undefined
    const dispositions = maintenance === undefined
      ? this.structuredResult(jobId).noteDispositions : this.noteDispositions(SessionId(maintenance.id), jobId)
    for (const disposition of dispositions) {
      const changed = this.db.prepare(`UPDATE ad_hoc_notes SET status='participated',processing_status=?,participated_generation_id=?,
        disposition=?,revision=revision+1,updated_at=? WHERE id=? AND claimed_job_id=? AND processing_status='claimed'`)
        .run(disposition.status, generation.id, disposition.detail, now, disposition.noteId, jobId)
      if (changed.changes !== 1) throw new Error(`note ${disposition.noteId} could not commit its Phase 2 disposition`)
    }
    this.db.prepare("UPDATE phase2_structured_attempts SET status='applied' WHERE job_id=? AND status='result_logged'").run(jobId)
    const manifest = parseManifest(readFileSync(join(generation.root, 'generation-manifest.json'), 'utf8'))
    for (const sourceId of [...new Set(manifest.files.flatMap(file => file.sourceIds))]) {
      this.db.prepare('INSERT OR IGNORE INTO generation_sources (generation_id,source_id) VALUES (?,?)').run(generation.id, sourceId)
    }
    this.db.prepare("UPDATE memory_rebuilds SET status='published',updated_at=?,finished_at=? WHERE status NOT IN ('published','failed','cancelled')").run(now, now)
    return changeSequence
  }

  /** Publish one prepared generation under a cross-process writer lock and SQLite fence. */
  publishGeneration(request: PublishGenerationRequest): Promise<PublishedGeneration> {
    return this.exclusive(async () => {
      let published!: PublishedGeneration
      await withFileLock(this.publishLockPath, async () => {
        begin(this.db)
        try {
          const owned = this.requirePhase2Claim(request.claim, ['prepared'])
          this.requirePhase2Baseline(owned)
          const generation = this.db.prepare("SELECT * FROM generations WHERE id=? AND status='prepared'").get(request.prepared.generationId) as GenerationRow | undefined
          if (generation === undefined
            || generation.publish_sequence !== request.prepared.publishSequence
            || generation.manifest_sha256 !== request.prepared.manifestSha256
            || request.prepared.claimToken !== request.claim.lease.ownerToken) {
            throw new Error('prepared generation does not match its fenced claim')
          }
          const profile = currentProfile(this.db)
          if (profile.current_publish_sequence !== null && generation.publish_sequence <= profile.current_publish_sequence) throw new Error('stale publisher cannot replace a newer generation')
          const pointer = `${JSON.stringify({ formatVersion: 1, generationId: generation.id, publishSequence: generation.publish_sequence, manifestSha256: generation.manifest_sha256 })}\n`
          await writeFileAtomic(this.pointerPath, pointer, { mode: 0o600, dirMode: 0o700 })
          this.db.prepare("UPDATE generations SET status='published',published_at=? WHERE id=?").run(Date.now(), generation.id)
          this.db.prepare("UPDATE phase2_jobs SET status='pointer_published',updated_at=? WHERE id=?").run(Date.now(), request.claim.jobId)
          const changeSequence = this.finalizePublished(request.claim.jobId, generation, Date.now())
          this.db.exec('COMMIT')
          published = { generationId: MemoryGenerationId(generation.id), publishSequence: generation.publish_sequence, changeSequence }
        } catch (error: unknown) {
          rollback(this.db)
          throw error
        }
      })
      this.ctx.emit('memory/changed', { changeSequence: published.changeSequence, generationId: published.generationId })
      return published
    })
  }

  /** Renew one still-owned Phase 1 or Phase 2 lease. */
  renewLease(request: RenewMemoryLeaseRequest): Promise<MemoryLease> {
    return this.exclusive(() => this.transaction(() => {
      if (request.leaseMs < 1) throw new Error('memory lease duration must be positive')
      const leasedUntil = request.now + request.leaseMs
      if (request.phase === 'phase1') {
        const row = this.db.prepare('SELECT attempt FROM source_ranges WHERE id=? AND status=\'leased\' AND owner_token=? AND leased_until>=?')
          .get(request.jobId, request.ownerToken, request.now) as { attempt: number } | undefined
        if (row === undefined) throw new Error('Phase 1 lease is stale')
        this.db.prepare('UPDATE source_ranges SET leased_until=?,updated_at=? WHERE id=? AND owner_token=?').run(leasedUntil, request.now, request.jobId, request.ownerToken)
        return { ownerToken: request.ownerToken, leasedUntil, attempt: row.attempt }
      }
      const row = this.db.prepare("SELECT attempt FROM phase2_jobs WHERE id=? AND status NOT IN ('finalized','stale','quarantined','cancelled') AND owner_token=? AND leased_until>=?")
        .get(request.jobId, request.ownerToken, request.now) as { attempt: number } | undefined
      if (row === undefined) throw new Error('Phase 2 lease is stale')
      this.db.prepare('UPDATE phase2_jobs SET leased_until=?,updated_at=? WHERE id=? AND owner_token=?').run(leasedUntil, request.now, request.jobId, request.ownerToken)
      return { ownerToken: request.ownerToken, leasedUntil, attempt: row.attempt }
    }))
  }

  /** Persist and classify one scheduler-reported operational failure. */
  recordFailure(request: MemoryFailureRecord): Promise<MemoryFailureDisposition> {
    return this.exclusive(() => {
      const disposition = this.transaction(() => {
        if (request.phase === 'phase1') {
          const row = this.db.prepare("SELECT id FROM source_ranges WHERE id=? AND status='leased' AND owner_token=?").get(request.jobId, request.ownerToken) as { id: string } | undefined
          if (row === undefined) return { kind: 'stale' } as const
          this.db.prepare('INSERT INTO failures (phase,job_id,attempt_id,category,message,created_at) VALUES (?,?,?,?,?,?)')
            .run(request.phase, request.jobId, request.attemptId ?? null, request.category, request.message, request.now)
          this.db.prepare("UPDATE phase1_attempts SET status='failed',finished_at=COALESCE(finished_at,?) WHERE source_range_id=? AND owner_token=? AND status NOT IN ('applied','failed')")
            .run(request.now, row.id, request.ownerToken)
          if (request.category === 'cancelled') {
            this.db.prepare("UPDATE source_ranges SET status='cancelled',owner_token=NULL,leased_until=NULL,terminal_reason=?,updated_at=? WHERE id=?").run(request.message, request.now, row.id)
            return { kind: 'cancelled' } as const
          }
          if (request.retryAt !== undefined) {
            this.db.prepare("UPDATE source_ranges SET status='retry_wait',owner_token=NULL,leased_until=NULL,next_attempt_at=?,terminal_reason=?,updated_at=? WHERE id=?")
              .run(request.retryAt, request.category, request.now, row.id)
            return { kind: 'retry', nextAttemptAt: request.retryAt } as const
          }
          const quarantineId = QuarantineRangeId(randomUUID())
          this.db.prepare("UPDATE source_ranges SET status='quarantined',owner_token=NULL,leased_until=NULL,quarantine_id=?,terminal_reason=?,updated_at=? WHERE id=?")
            .run(quarantineId, request.category, request.now, row.id)
          this.db.prepare("UPDATE memory_rebuilds SET failed_sessions=failed_sessions+1,updated_at=? WHERE status IN ('extracting','waiting-for-idle','scanning')").run(request.now)
          return { kind: 'quarantined', quarantineId } as const
        }
        const row = this.db.prepare("SELECT id FROM phase2_jobs WHERE id=? AND owner_token=? AND status NOT IN ('finalized','stale','quarantined','cancelled')")
          .get(request.jobId, request.ownerToken) as { id: string } | undefined
        if (row === undefined) return { kind: 'stale' } as const
        this.db.prepare('INSERT INTO failures (phase,job_id,attempt_id,category,message,created_at) VALUES (?,?,?,?,?,?)')
          .run(request.phase, request.jobId, request.attemptId ?? null, request.category, request.message, request.now)
        this.db.prepare("UPDATE generations SET status='abandoned' WHERE phase2_job_id=? AND status IN ('materializing','prepared')")
          .run(row.id)
        this.db.prepare("UPDATE maintenance_sessions SET status='failed',finished_at=COALESCE(finished_at,?) WHERE phase2_job_id=? AND status IN ('allocated','live')")
          .run(request.now, row.id)
        if (request.category === 'cancelled') {
          this.releasePhase2Batch(row.id, request.now)
          this.db.prepare("UPDATE phase2_jobs SET status='cancelled',updated_at=? WHERE id=?").run(request.now, row.id)
          return { kind: 'cancelled' } as const
        }
        if (request.category === 'stale') {
          this.releasePhase2Batch(row.id, request.now)
          this.db.prepare("UPDATE phase2_jobs SET status='stale',updated_at=? WHERE id=?").run(request.now, row.id)
          return { kind: 'stale' } as const
        }
        if (request.retryAt !== undefined) {
          this.db.prepare("UPDATE phase2_jobs SET status='retry_wait',next_attempt_at=?,updated_at=? WHERE id=?").run(request.retryAt, request.now, row.id)
          return { kind: 'retry', nextAttemptAt: request.retryAt } as const
        }
        this.db.prepare("UPDATE phase2_jobs SET status='quarantined',updated_at=? WHERE id=?").run(request.now, row.id)
        this.db.prepare("UPDATE memory_rebuilds SET status='failed',error=?,updated_at=?,finished_at=? WHERE status NOT IN ('published','failed','cancelled')")
          .run(`${request.category}: ${request.message}`, request.now, request.now)
        return { kind: 'quarantined', quarantineId: QuarantineRangeId(`phase2-${row.id}`) } as const
      })
      this.emitMemoryChanged()
      return disposition
    })
  }

  private releasePhase2Batch(jobId: string, now: number): void {
    this.db.prepare("UPDATE candidates SET status='pending',phase2_job_id=NULL WHERE phase2_job_id=? AND status='claimed'").run(jobId)
    this.db.prepare("UPDATE ad_hoc_notes SET status='pending',processing_status='pending',claimed_job_id=NULL,revision=revision+1,updated_at=? WHERE claimed_job_id=? AND processing_status='claimed'").run(now, jobId)
  }

  /** Bounded retention cleanup for expired leases, audit payloads, staging, and old generations. */
  prune(request: MemoryPruneRequest): Promise<MemoryPruneResult> {
    return this.exclusive(async () => {
      if (request.maxRows < 1 || request.maxBytes < 1) throw new Error('memory prune limits must be positive')
      let auditAttempts = 0
      let generations = 0
      let sourceSnapshots = 0
      let bytes = 0
      this.transaction(() => {
        this.db.prepare('DELETE FROM read_leases WHERE leased_until < ?').run(request.now)
        this.db.prepare(`UPDATE phase2_structured_attempts SET status='failed',finished_at=COALESCE(finished_at,?)
          WHERE status IN ('request_logged','result_logged') AND job_id IN
          (SELECT id FROM phase2_jobs WHERE status IN ('stale','cancelled','quarantined','retry_wait'))`).run(request.now)
        const structured = this.db.prepare(`SELECT id,length(CAST(request_json AS BLOB))+COALESCE(length(CAST(result_json AS BLOB)),0) AS bytes
          FROM phase2_structured_attempts WHERE status IN ('applied','failed') AND finished_at<? ORDER BY finished_at LIMIT ?`)
          .all(request.now - this.config.auditRetentionMs, request.maxRows) as Array<{ id: string; bytes: number }>
        for (const attempt of structured) {
          if (bytes + attempt.bytes > request.maxBytes) break
          this.db.prepare('DELETE FROM phase2_structured_attempts WHERE id=?').run(attempt.id)
          auditAttempts += 1
          bytes += attempt.bytes
        }
        const attempts = this.db.prepare("SELECT id,COALESCE(request_bytes,0)+COALESCE(result_bytes,0) AS bytes FROM phase1_attempts WHERE status IN ('applied','failed') AND finished_at IS NOT NULL AND finished_at<? AND (request_json IS NOT NULL OR result_json IS NOT NULL) ORDER BY finished_at LIMIT ?")
          .all(request.now - this.config.auditRetentionMs, request.maxRows) as Array<{ id: string; bytes: number }>
        for (const attempt of attempts) {
          if (auditAttempts >= request.maxRows || bytes + attempt.bytes > request.maxBytes) break
          this.db.prepare('UPDATE phase1_attempts SET request_json=NULL,result_json=NULL WHERE id=?').run(attempt.id)
          auditAttempts += 1
          bytes += attempt.bytes
        }
        const maintenance = this.db.prepare(`SELECT id,total_bytes AS bytes FROM maintenance_sessions
          WHERE status IN ('completed','failed') AND finished_at IS NOT NULL AND finished_at<?
          ORDER BY finished_at LIMIT ?`).all(request.now - this.config.auditRetentionMs, request.maxRows) as Array<{ id: string; bytes: number }>
        for (const session of maintenance) {
          if (auditAttempts >= request.maxRows || bytes + session.bytes > request.maxBytes) break
          this.db.prepare('DELETE FROM maintenance_session_events WHERE session_id=?').run(session.id)
          this.db.prepare("UPDATE maintenance_sessions SET status='pruned',total_bytes=0 WHERE id=?").run(session.id)
          auditAttempts += 1
          bytes += session.bytes
        }
      })
      const old = this.db.prepare(`SELECT g.* FROM generations g LEFT JOIN read_leases l ON l.generation_id=g.id
        WHERE g.status IN ('finalized','abandoned') AND g.published_at IS NOT NULL AND g.total_bytes>0
        AND g.id != (SELECT current_generation_id FROM profile_state WHERE singleton=1) AND l.id IS NULL
        AND NOT EXISTS (SELECT 1 FROM phase2_jobs j WHERE j.baseline_generation_id=g.id AND j.status NOT IN ('finalized','stale','quarantined','cancelled'))
        GROUP BY g.id ORDER BY g.publish_sequence LIMIT ?`).all(request.maxRows) as unknown as GenerationRow[]
      for (const generation of old) {
        const size = generation.total_bytes ?? 0
        if (auditAttempts + generations >= request.maxRows || bytes + size > request.maxBytes) break
        if (resolve(generation.root) !== resolve(this.generationsRoot, generation.id)) throw new Error('generation prune path is outside its owned directory')
        const retired = this.transaction(() => this.db.prepare(`UPDATE generations SET status='abandoned' WHERE id=?
          AND id != (SELECT current_generation_id FROM profile_state WHERE singleton=1)
          AND NOT EXISTS (SELECT 1 FROM read_leases WHERE generation_id=? AND leased_until>=?)
          AND NOT EXISTS (SELECT 1 FROM phase2_jobs WHERE baseline_generation_id=? AND status NOT IN ('finalized','stale','quarantined','cancelled'))`)
          .run(generation.id, generation.id, request.now, generation.id).changes === 1)
        if (!retired) continue
        await rm(generation.root, { recursive: true, force: true })
        this.transaction(() => { this.db.prepare("UPDATE generations SET total_bytes=0 WHERE id=? AND status='abandoned'").run(generation.id) })
        generations += 1
        bytes += size
      }
      this.transaction(() => {
        const unusedMs = runtimeSettings(this.db).maxUnusedDays * 24 * 60 * 60_000
        const outputs = this.db.prepare(`SELECT r.id,SUM(length(CAST(c.body AS BLOB))+COALESCE(length(CAST(c.raw_memory AS BLOB)),0)
          +COALESCE(length(CAST(c.rollout_summary AS BLOB)),0)) AS bytes
          FROM source_ranges r JOIN candidates c ON c.source_range_id=r.id
          LEFT JOIN session_source_usage u ON u.session_id=r.session_id
          JOIN profile_state p ON p.singleton=1 JOIN generations current ON current.id=p.current_generation_id AND current.status='finalized'
          WHERE r.status IN ('succeeded','cancelled') AND COALESCE(u.last_adopted_at,r.completed_at)+? < MIN(?,current.published_at)
          AND NOT EXISTS (SELECT 1 FROM generation_sources gs WHERE gs.source_id='source:'||r.id
            AND (gs.generation_id=p.current_generation_id OR EXISTS (SELECT 1 FROM read_leases l WHERE l.generation_id=gs.generation_id AND l.leased_until>=?)))
          AND NOT EXISTS (SELECT 1 FROM phase2_selected_sources s JOIN phase2_jobs j ON j.id=s.job_id
            WHERE s.source_range_id=r.id AND (j.id=current.phase2_job_id OR j.status NOT IN ('finalized','stale','quarantined','cancelled')))
          AND NOT EXISTS (SELECT 1 FROM phase2_job_candidates jc JOIN phase2_jobs j ON j.id=jc.job_id
            JOIN candidates owned ON owned.id=jc.candidate_id WHERE owned.source_range_id=r.id
            AND j.status NOT IN ('finalized','stale','quarantined','cancelled'))
          AND NOT EXISTS (SELECT 1 FROM phase2_jobs j,json_each(j.source_diff_json,'$.retained') retained
            WHERE j.selection_fingerprint IS NULL AND retained.value=r.id
            AND j.status NOT IN ('finalized','stale','quarantined','cancelled'))
          GROUP BY r.id ORDER BY r.completed_at,r.id LIMIT ?`).all(unusedMs,request.now,request.now,request.maxRows) as Array<{ id: string; bytes: number }>
        for (const output of outputs) {
          if (sourceSnapshots + auditAttempts + generations >= request.maxRows || bytes + output.bytes > request.maxBytes) break
          this.db.prepare('DELETE FROM phase2_job_candidates WHERE candidate_id IN (SELECT id FROM candidates WHERE source_range_id=?)').run(output.id)
          this.db.prepare('DELETE FROM candidates WHERE source_range_id=?').run(output.id)
          sourceSnapshots += 1
          bytes += output.bytes
        }
      })
      return { auditAttempts, sourceSnapshots, generations, bytes }
    })
  }

  /** Recover expired ownership, pointer publication, and orphan staging before scheduling. */
  recover(signal: AbortSignal): Promise<MemoryRecoveryResult> {
    return this.exclusive(async () => {
      signal.throwIfAborted()
      const now = Date.now()
      let recoveredJobs = 0
      let finalizedGenerations = 0
      let recoveredChange: { changeSequence: number; generationId: MemoryGenerationId } | undefined
      // Pointer publication precedes the SQLite commit. Reconcile that durable
      // file while the publication lock still fences every competing writer,
      // before expiring the claim whose batch the pointer already published.
      await withFileLock(this.publishLockPath, async () => {
        signal.throwIfAborted()
        const pointer = await readFile(this.pointerPath, 'utf8').then(parsePointer, () => undefined)
        const profileBefore = currentProfile(this.db)
        const pointed = pointer === undefined ? undefined : this.db.prepare(`SELECT * FROM generations
          WHERE id=? AND publish_sequence=? AND manifest_sha256=? AND status IN ('prepared','published','finalized')`)
          .get(pointer.generationId, pointer.publishSequence, pointer.manifestSha256) as GenerationRow | undefined
        if (pointed !== undefined
          && (profileBefore.current_publish_sequence === null || pointed.publish_sequence >= profileBefore.current_publish_sequence)) {
          await this.verifiedManifest(pointed)
          if (pointed.status !== 'finalized' || profileBefore.current_generation_id !== pointed.id) {
            const changeSequence = this.transaction(() => this.finalizePublished(pointed.phase2_job_id, pointed, now))
            finalizedGenerations += 1
            recoveredChange = { changeSequence, generationId: MemoryGenerationId(pointed.id) }
          }
        }

        const profileAfter = currentProfile(this.db)
        if (profileAfter.current_generation_id === null) {
          if (pointer !== undefined) await rm(this.pointerPath, { force: true })
          return
        }
        const current = this.db.prepare("SELECT * FROM generations WHERE id=? AND status='finalized'")
          .get(profileAfter.current_generation_id) as GenerationRow | undefined
        if (current === undefined || current.manifest_sha256 === null) throw new Error('current memory generation is missing during recovery')
        await this.verifiedManifest(current)
        if (pointer?.generationId !== current.id || pointer.publishSequence !== current.publish_sequence
          || pointer.manifestSha256 !== current.manifest_sha256) {
          const text = `${JSON.stringify({
            formatVersion: 1,
            generationId: current.id,
            publishSequence: current.publish_sequence,
            manifestSha256: current.manifest_sha256,
          })}\n`
          await writeFileAtomic(this.pointerPath, text, { mode: 0o600, dirMode: 0o700 })
        }
      })
      if (recoveredChange !== undefined) this.ctx.emit('memory/changed', recoveredChange)

      this.transaction(() => {
        this.db.prepare(`UPDATE generations SET status='abandoned'
          WHERE status IN ('materializing','prepared')
            AND phase2_job_id IN (SELECT id FROM phase2_jobs WHERE status IN ('finalized','stale','quarantined','cancelled'))`).run()
        recoveredJobs += Number(this.db.prepare("UPDATE source_ranges SET status='queued',owner_token=NULL,leased_until=NULL,updated_at=? WHERE status='leased' AND leased_until<?").run(now, now).changes)
        const expired = this.db.prepare("SELECT id FROM phase2_jobs WHERE status NOT IN ('finalized','stale','quarantined','cancelled') AND leased_until<?").all(now) as Array<{ id: string }>
        for (const job of expired) {
          this.releasePhase2Batch(job.id, now)
          this.db.prepare("UPDATE generations SET status='abandoned' WHERE phase2_job_id=? AND status IN ('materializing','prepared')").run(job.id)
          this.db.prepare("UPDATE maintenance_sessions SET status='failed',finished_at=COALESCE(finished_at,?) WHERE phase2_job_id=? AND status IN ('allocated','live')")
            .run(now, job.id)
          this.db.prepare("UPDATE phase2_jobs SET status='stale',updated_at=? WHERE id=?").run(now, job.id)
          recoveredJobs += 1
        }
        this.db.prepare('DELETE FROM read_leases WHERE leased_until<?').run(now)
      })
      const known = new Set((this.db.prepare('SELECT root FROM phase2_workspaces').all() as Array<{ root: string }>).map(row => resolve(row.root)))
      let discardedStagingDirectories = 0
      for (const entry of await readdir(this.stagingRoot, { withFileTypes: true })) {
        signal.throwIfAborted()
        const path = resolve(this.stagingRoot, entry.name)
        if (entry.isDirectory() && !known.has(path)) {
          await rm(path, { recursive: true, force: true })
          discardedStagingDirectories += 1
        }
      }
      const workAvailable = (this.db.prepare("SELECT 1 AS value WHERE EXISTS(SELECT 1 FROM source_ranges WHERE status IN ('queued','retry_wait')) OR EXISTS(SELECT 1 FROM candidates WHERE status='pending') OR EXISTS(SELECT 1 FROM ad_hoc_notes WHERE processing_status='pending' AND authority_status='active')").get() as { value: number } | undefined) !== undefined
      if (workAvailable) this.ctx.emit('memory/pipeline-work-available', { kind: 'recovery' })
      return { recoveredJobs, finalizedGenerations, discardedStagingDirectories, workAvailable }
    })
  }
}

/** Opaque in-package runtime shared by the public and pipeline service facades. */
export type LocalMemoryRuntimeHandle = LocalMemoryRuntime

/**
 * Open one validated local-memory runtime for the resolved profile root.
 * @param ctx - Provider context that receives committed memory events.
 * @param config - Validated local-memory deployment configuration.
 * @returns The shared runtime handle owned by the provider effect.
 */
export function openLocalMemoryRuntime(ctx: Context, config: LocalMemoryConfig): Promise<LocalMemoryRuntimeHandle> {
  return LocalMemoryRuntime.open(ctx, config)
}

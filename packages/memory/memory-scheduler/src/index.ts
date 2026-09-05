/** Durable two-phase memory scheduler and maintenance service provider. @module @deepseek-ai/dsh-memory-scheduler */

import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-codex-structured-runner'
import z from '@deepseek-ai/schemastery'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import {
  DEFAULT_MEMORY_RUNTIME_SETTINGS,
  type MemoryRuntimeSettingsValues,
} from '@deepseek-ai/dsh-memory'
import MemoryMaintenanceService, { type MemoryMaintenanceRun, type MemoryWakeReason } from '@deepseek-ai/dsh-memory-maintenance'
import type { MemoryFailureCategory, Phase1Claim, Phase2Claim, Phase2Workspace } from '@deepseek-ai/dsh-memory-pipeline-store'
import { MemorySourceRangeId } from '@deepseek-ai/dsh-memory-pipeline-store'
import { MemoryStagingFileSystem } from '@deepseek-ai/dsh-memory-staging-tools'
import * as memoryStagingTools from '@deepseek-ai/dsh-memory-staging-tools'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import '@deepseek-ai/dsh-tools'
import { runPhase1, type Phase1Config } from './phase1.ts'
import { phase2ConsolidationPrompt } from './templates.ts'
import { codexPhase2 } from './structured-phase2.ts'
import { runClaimPool } from './worker-pool.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    memoryMaintenance: 'memory-maintenance'
  }
}

/** Scheduler deployment settings. */
export interface Config {
  /** Execution backend for Phase 1 extraction. */
  extractionBackend?: 'llm' | 'codex'
  /** Execution backend for Phase 2 consolidation. */
  consolidationBackend?: 'llm' | 'codex'
  /** Per-call Codex extraction effort. */
  extractionReasoningEffort?: string
  /** Default completion-time lookback for a confirmed rebuild. */
  rebuildLookbackMs?: number
  /** LLM provider used for Phase 1 extraction. */
  extractionProvider: string
  /** Model used for Phase 1 extraction. */
  extractionModel: string
  /** LLM provider used for Phase 2 consolidation. */
  consolidationProvider: string
  /** Model used for Phase 2 consolidation. */
  consolidationModel: string
  /** Adapter-owned Phase 2 reasoning effort, or `inherit` for the route default. */
  consolidationReasoningEffort?: string
  /** Whether this scheduler starts enabled before live profile settings load. */
  enabled?: boolean
  /** Required Session inactivity before automatic extraction, in milliseconds. */
  idleMs?: number
  /** Oldest completed source range eligible for extraction, in milliseconds. */
  maxSourceAgeMs?: number
  /** Days without citation use before an automatic source leaves consolidation. */
  maxUnusedDays?: number
  /** Remaining provider quota percentage below which background dispatch pauses when telemetry exists. */
  minRemainingQuotaPercent?: number
  /** Maximum Session headers inspected in one discovery run. */
  scanSessionsPerRun?: number
  /** Maximum source ranges registered in one discovery run. */
  maxRangesPerRun?: number
  /** Maximum Phase 1 claims dispatched in one scheduler run. */
  maxPhase1ClaimsPerRun?: number
  /** Phase 1 ownership lease duration in milliseconds. */
  phase1LeaseMs?: number
  /** Phase 2 ownership lease duration in milliseconds. */
  phase2LeaseMs?: number
  /** Maximum duration of one provider call in milliseconds. */
  providerTimeoutMs?: number
  /** Maximum provider dispatch attempts for one job. */
  maxAttempts?: number
  /** Initial durable retry delay in milliseconds. */
  retryBaseMs?: number
  /** Maximum candidates accepted from one source range. */
  maxCandidatesPerRange?: number
  /** Maximum automatic Session sources in the complete Phase 2 input set; explicit notes are separate. */
  maxPhase2Sources?: number
  /** Maximum independently leased extractions running at once, from 1 through 8. */
  phase1Concurrency?: number
  /** Maximum frozen evidence bytes sent to Phase 1. */
  maxEvidenceBytes?: number
  /** Maximum provider result bytes observed before abort. */
  maxResultBytes?: number
  /** Phase 1 response-token limit. */
  extractionMaxTokens?: number
  /** Phase 2 response-token limit. */
  consolidationMaxTokens?: number
  /** Maximum bytes of summary eligible for prompt injection. */
  promptSummaryMaxBytes?: number
  /** Maximum recall passes permitted per turn. */
  recallMaxPasses?: number
  /** Maximum memory tool calls permitted per turn. */
  recallMaxToolCalls?: number
  /** Maximum distinct detail files readable per turn. */
  recallMaxDetailFiles?: number
  /** Maximum file bytes exposed to the isolated Phase 2 agent. */
  phase2MaxFileBytes?: number
  /** Maximum files examined by one Phase 2 rooted search. */
  phase2SearchMaxFiles?: number
  /** Maximum matches returned by one Phase 2 rooted search. */
  phase2SearchMaxMatches?: number
  /** Minimum supporting tasks before a repeatable procedure may become a Skill. */
  skillMinSupportingTasks?: number
  /** Skip automatic extraction of externally influenced ranges; false permits untrusted evidence. */
  disableOnExternalContext?: boolean
  /** Tool-name prefixes that mark a frozen source range as externally influenced. */
  externalToolPrefixes?: string[]
  /** Extraction and consolidation policy identity used for rebuild fencing. */
  policyVersion?: number
  /** Maximum terminal state rows pruned in one scheduler run. */
  pruneRowsPerRun?: number
  /** Maximum payload bytes pruned in one scheduler run. */
  pruneBytesPerRun?: number
  /** Fallback scheduler wake interval in milliseconds. */
  fallbackWakeMs?: number
}

/** Runtime-validated scheduler settings. */
export const Config: z<Config> = z.object({
  extractionBackend: z.union(['llm', 'codex']).default('llm'),
  consolidationBackend: z.union(['llm', 'codex']).default('llm'),
  extractionReasoningEffort: z.string().default('high'),
  rebuildLookbackMs: z.number().step(1).min(1).default(DEFAULT_MEMORY_RUNTIME_SETTINGS.rebuildLookbackMs),
  extractionProvider: z.string().default(DEFAULT_MEMORY_RUNTIME_SETTINGS.extractionProvider),
  extractionModel: z.string().default(DEFAULT_MEMORY_RUNTIME_SETTINGS.extractionModel),
  consolidationProvider: z.string().default(DEFAULT_MEMORY_RUNTIME_SETTINGS.consolidationProvider),
  consolidationModel: z.string().default(DEFAULT_MEMORY_RUNTIME_SETTINGS.consolidationModel),
  consolidationReasoningEffort: z.string().default(DEFAULT_MEMORY_RUNTIME_SETTINGS.consolidationReasoningEffort),
  enabled: z.boolean().default(false),
  idleMs: z.number().step(1).min(1).default(6 * 60 * 60_000),
  maxSourceAgeMs: z.number().step(1).min(1).default(10 * 24 * 60 * 60_000),
  maxUnusedDays: z.number().step(1).min(1).default(30),
  minRemainingQuotaPercent: z.number().step(1).min(0).max(100).default(25),
  scanSessionsPerRun: z.number().step(1).min(1).default(64),
  maxRangesPerRun: z.number().step(1).min(1).default(128),
  maxPhase1ClaimsPerRun: z.number().step(1).min(1).default(2),
  phase1LeaseMs: z.number().step(1).min(1).default(60 * 60_000),
  phase2LeaseMs: z.number().step(1).min(1).default(20 * 60_000),
  providerTimeoutMs: z.number().step(1).min(1).default(10 * 60_000),
  maxAttempts: z.number().step(1).min(1).default(3),
  retryBaseMs: z.number().step(1).min(1).default(60_000),
  maxCandidatesPerRange: z.number().step(1).min(1).default(64),
  maxPhase2Sources: z.number().step(1).min(1).default(256),
  phase1Concurrency: z.number().step(1).min(1).max(8).default(2),
  maxEvidenceBytes: z.number().step(1).min(1).default(512 * 1024),
  maxResultBytes: z.number().step(1).min(1_024).default(2 * 1024 * 1024),
  extractionMaxTokens: z.number().step(1).min(1).default(8_192),
  consolidationMaxTokens: z.number().step(1).min(1).default(DEFAULT_MEMORY_RUNTIME_SETTINGS.consolidationMaxTokens),
  promptSummaryMaxBytes: z.number().step(1).min(1_024).default(32 * 1024),
  recallMaxPasses: z.number().step(1).min(1).default(2),
  recallMaxToolCalls: z.number().step(1).min(1).default(6),
  recallMaxDetailFiles: z.number().step(1).min(1).default(2),
  phase2MaxFileBytes: z.number().step(1).min(1).default(2 * 1024 * 1024),
  phase2SearchMaxFiles: z.number().step(1).min(1).default(512),
  phase2SearchMaxMatches: z.number().step(1).min(1).default(256),
  skillMinSupportingTasks: z.number().step(1).min(1).default(2),
  disableOnExternalContext: z.boolean().default(DEFAULT_MEMORY_RUNTIME_SETTINGS.disableOnExternalContext),
  externalToolPrefixes: z.array(z.string()).default(['web', 'mcp', 'tool_search']),
  policyVersion: z.number().step(1).min(1).default(DEFAULT_MEMORY_RUNTIME_SETTINGS.policyVersion),
  pruneRowsPerRun: z.number().step(1).min(1).default(100),
  pruneBytesPerRun: z.number().step(1).min(1).default(64 * 1024 * 1024),
  fallbackWakeMs: z.number().step(1).min(1).default(15 * 60_000),
})

type ResolvedConfig = Required<Config>
type PipelineStepOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'retried'; readonly nextWakeAt: number }
  | { readonly kind: 'quarantined' }

function sourceId(sessionId: SessionId, fromSeq: number, toSeq: number, policyVersion: number): MemorySourceRangeId {
  return MemorySourceRangeId(createHash('sha256').update(`${sessionId}\0${fromSeq}\0${toSeq}\0${policyVersion}`).digest('hex'))
}

/**
 * Classify one scheduler failure for durable retry and UI reporting.
 * @param error - Provider, parser, or storage failure.
 * @returns Stable failure category.
 */
export function classifyMemoryFailure(error: unknown): MemoryFailureCategory {
  const message = errorChain(error).toLowerCase()
  if (message.includes('unexpected-tool-use')) return 'unexpected-tool-use'
  if (message.includes('invalid-model-output')) return 'invalid-model-output'
  if (message.includes('output-budget-exhausted') || message.includes('max-tokens')) return 'output-budget-exhausted'
  if (message.includes('overflow') || message.includes('too large')) return 'result-overflow'
  if (message.includes('rate') || message.includes('429')) return 'provider-rate-limit'
  if (message.includes('timeout') || message.includes('timed out')) return 'provider-timeout'
  if (message.includes('stale') || message.includes('no longer owned')) return 'stale'
  if (message.includes('candidate')
    || message.includes('tool arguments')
    || message.includes('note dispositions')
    || message.includes('not valid json')
    || message.includes('exactly one')) return 'invalid-model-output'
  if (message.includes('validation')
    || message.includes('source graph')
    || message.includes('source link')
    || message.includes('memory_summary.md')
    || message.includes('read-only evidence')) return 'validation'
  return 'provider-failure'
}

const RETRYABLE_FAILURES: ReadonlySet<MemoryFailureCategory> = new Set([
  'provider-rate-limit', 'provider-timeout', 'provider-failure', 'invalid-model-output', 'output-budget-exhausted', 'validation',
])

function retryAt(config: MemoryRuntimeSettingsValues, attempt: number, now: number, category: MemoryFailureCategory): number | undefined {
  if (attempt >= config.maxAttempts || !RETRYABLE_FAILURES.has(category)) return undefined
  return now + config.retryBaseMs * (2 ** Math.max(0, attempt - 1))
}

function runtimeDefaults(config: ResolvedConfig): MemoryRuntimeSettingsValues {
  const { enabled: _enabled, ...settings } = config
  return settings
}

/**
 * Build one complete Session-level rollout suffix after a fork seed.
 * @param events - Durable Session events in sequence order.
 * @param seedLength - Inherited fork prefix excluded from new evidence.
 * @param completedAfter - Inclusive frozen completion-time cutoff in milliseconds.
 * @returns First complete turn start through the last complete turn end, or `undefined`.
 */
export function rolloutRange(
  events: readonly SessionEvent[],
  seedLength: number,
  completedAfter = 0,
): { fromSeq: number; toSeq: number; completedAt: number } | undefined {
  let firstStart: SessionEvent<'turn/start'> | undefined
  let start: SessionEvent<'turn/start'> | undefined
  let completed: SessionEvent<'turn/end'> | undefined
  for (const event of events) {
    if (event.seq < seedLength) continue
    if (event.type === 'turn/start') {
      start = event
    }
    else if (event.type === 'turn/end' && start !== undefined && event.data.turn === start.data.turn) {
      if (event.time >= completedAfter) { firstStart ??= start; completed = event }
      start = undefined
    }
  }
  if (firstStart === undefined || completed === undefined || completed.seq < firstStart.seq) return undefined
  const hasUserEvidence = events.some(event => event.seq >= firstStart.seq && event.seq <= completed.seq && event.type === 'user/message')
  return hasUserEvidence ? { fromSeq: firstStart.seq, toSeq: completed.seq, completedAt: completed.time } : undefined
}

/** Coalesced scheduler implementation over the private Store seam. */
export class MemoryScheduler extends MemoryMaintenanceService {
  static inject = ['memoryPipelineStore', 'sessionPersistence', 'workspaceRegistry', 'agents', 'llm', 'tools', 'systemPrompt', 'jobs']
  static Config = Config

  private readonly config: ResolvedConfig
  private readonly settingsReady: Promise<unknown>
  private accepting = true
  private recovered = false
  private discoveryCursor = 0
  private reasons = new Set<MemoryWakeReason>()
  private driver: Promise<void> | undefined
  private runTail: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private controller = new AbortController()
  private owned = new Set<Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
    this.settingsReady = this.ctx.memoryPipelineStore.initializeRuntimeSettings(runtimeDefaults(this.config))
    this.ctx.jobs.attachController('memory-scheduler')
    this.ctx.effect(() => () => this.disposeAndDrain(AbortSignal.timeout(this.config.providerTimeoutMs)), 'memory-scheduler.drain')
  }

  override wake(reason: MemoryWakeReason): void {
    if (!this.accepting || !this.config.enabled) return
    this.reasons.add(reason)
    if (this.driver !== undefined) return
    this.driver = this.drive().finally(() => {
      this.driver = undefined
      if (this.reasons.size > 0 && this.accepting) this.wake('pipeline-work')
    })
  }

  private async drive(): Promise<void> {
    while (this.accepting && this.reasons.size > 0) {
      const reasons = new Set(this.reasons)
      this.reasons.clear()
      const includeAdHocNotes = reasons.has('startup')
        || reasons.has('root-session-startup')
        || reasons.has('manual-scan')
        || reasons.has('manual-consolidation')
        || reasons.has('clean-rebuild')
      const discoverSources = [...reasons].some(reason => reason !== 'manual-consolidation')
      const result = await this.runDueForWake(this.controller.signal, {
        includeAdHocNotes,
        bypassIdle: reasons.has('manual-scan') || reasons.has('clean-rebuild'),
        bypassAge: reasons.has('clean-rebuild'),
        discoverSources,
      }).catch(() => undefined)
      if (result?.nextWakeAt !== undefined) {
        if (this.timer !== undefined) clearTimeout(this.timer)
        this.timer = setTimeout(() => { this.timer = undefined; this.wake('idle-deadline') }, Math.max(0, result.nextWakeAt - Date.now()))
      }
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.runTail.then(operation, operation)
    this.runTail = result.then(() => undefined, () => undefined)
    return result
  }

  override runDue(signal: AbortSignal): Promise<MemoryMaintenanceRun> {
    return this.runDueForWake(signal, { includeAdHocNotes: true, bypassIdle: false, bypassAge: false, discoverSources: true })
  }

  private runDueForWake(
    signal: AbortSignal,
    options: {
      readonly includeAdHocNotes: boolean
      readonly bypassIdle: boolean
      readonly bypassAge: boolean
      readonly discoverSources: boolean
    },
  ): Promise<MemoryMaintenanceRun> {
    return this.serialize(() => this.runTrackedPass(signal, options))
  }

  private runTrackedPass(
    signal: AbortSignal,
    options: {
      readonly includeAdHocNotes: boolean
      readonly bypassIdle: boolean
      readonly bypassAge: boolean
      readonly discoverSources: boolean
    },
  ): Promise<MemoryMaintenanceRun> {
    const cancellation = new AbortController()
    const operationSignal = AbortSignal.any([signal, cancellation.signal])
    let operation!: Promise<MemoryMaintenanceRun>
    this.ctx.jobs.start({
      kind: 'memory-maintenance',
      label: 'Long-term memory maintenance',
      visibility: 'internal',
      run: () => {
        operation = this.runPass(operationSignal, options)
        const done = operation.then<JobOutcome, JobOutcome>(
          result => ({ status: 'completed', detail: `${result.phase1Completed} extraction(s), ${result.phase2Completed} consolidation(s)` }),
          (error: unknown) => ({ status: operationSignal.aborted ? 'killed' : 'failed', detail: errorChain(error) }),
        )
        return {
          cancel: (reason) => { cancellation.abort(new Error(reason ?? 'memory maintenance cancelled')) },
          done,
        }
      },
    })
    return operation
  }

  private async runPass(
    signal: AbortSignal,
    options: {
      readonly includeAdHocNotes: boolean
      readonly bypassIdle: boolean
      readonly bypassAge: boolean
      readonly discoverSources: boolean
    },
  ): Promise<MemoryMaintenanceRun> {
    if (!this.config.enabled || !this.accepting) {
      return {
        discovered: 0,
        phase1Completed: 0,
        phase2Completed: 0,
        retried: 0,
        quarantined: 0,
        pruned: 0,
      }
    }
    signal.throwIfAborted()
    await this.settingsReady
    const settings = await this.ctx.memoryPipelineStore.getRuntimeSettings()
    if ((settings.extractionBackend === 'codex' || settings.consolidationBackend === 'codex') && !this.ctx.get('codexStructuredRunner')) {
      throw new Error('Codex memory backend requires the codexStructuredRunner provider')
    }
    if (!this.recovered) { await this.ctx.memoryPipelineStore.recover(signal); this.recovered = true }
    const rebuild = await this.ctx.memoryPipelineStore.getActiveCleanRebuild()
    const discovery = options.discoverSources
      ? await this.discover(
        settings, signal, options.bypassIdle || rebuild !== undefined, options.bypassAge || rebuild !== undefined,
        rebuild?.scanCursor, rebuild?.sourceCompletedAfter,
      )
      : { discovered: 0, totalSessions: 0, scannedSessions: 0, waitingSessions: 0, nextCursor: 0, reachedEnd: true }
    if (rebuild !== undefined && options.discoverSources) {
      const waitingSessions = (rebuild.scanCursor === 0 ? 0 : rebuild.waitingSessions) + discovery.waitingSessions
      const scanComplete = discovery.reachedEnd && waitingSessions === 0
      await this.ctx.memoryPipelineStore.reportCleanRebuildDiscovery({
        rebuildId: rebuild.id,
        totalSessions: discovery.totalSessions,
        scannedSessions: scanComplete ? discovery.totalSessions : discovery.reachedEnd
          ? 0 : Math.min(discovery.totalSessions, rebuild.scannedSessions + discovery.scannedSessions),
        scanCursor: discovery.reachedEnd ? 0 : discovery.nextCursor,
        waitingSessions,
        scanComplete,
      })
    }
    let nextWakeAt = discovery.nextWakeAt ?? Date.now() + settings.fallbackWakeMs
    let phase1Completed = 0
    let retried = 0
    let quarantined = 0
    const extractionQuota = this.ctx.bail('memory/quota-remaining', {
      provider: settings.extractionProvider,
      model: settings.extractionModel,
    })
    const extractionAllowed = extractionQuota === undefined || extractionQuota >= settings.minRemainingQuotaPercent
    const phase1Claims = await runClaimPool(settings.phase1Concurrency,
      extractionAllowed ? settings.maxPhase1ClaimsPerRun : 0, signal,
      () => this.ctx.memoryPipelineStore.claimPhase1({
        now: Date.now(),
        leaseMs: settings.phase1LeaseMs,
        maxAttempts: settings.maxAttempts,
      }), async (claim) => {
        const outcome = await this.processPhase1(claim, settings, signal)
        if (outcome.kind === 'completed') phase1Completed += 1
        else if (outcome.kind === 'retried') { retried += 1; nextWakeAt = Math.min(nextWakeAt, outcome.nextWakeAt) }
        else quarantined += 1
      })
    if (extractionAllowed && phase1Claims === settings.maxPhase1ClaimsPerRun) {
      nextWakeAt = Math.min(nextWakeAt, Date.now())
    }
    let phase2Completed = 0
    const consolidationQuota = this.ctx.bail('memory/quota-remaining', {
      provider: settings.consolidationProvider,
      model: settings.consolidationModel,
    })
    let phase2: Phase2Claim | undefined
    if (consolidationQuota !== undefined && consolidationQuota < settings.minRemainingQuotaPercent) {
      phase2 = undefined
    } else {
      phase2 = await this.ctx.memoryPipelineStore.claimPhase2({
        now: Date.now(),
        leaseMs: settings.phase2LeaseMs,
        maxSources: settings.maxPhase2Sources,
        maxAttempts: settings.maxAttempts,
        maxUnusedDays: settings.maxUnusedDays,
        includeAdHocNotes: options.includeAdHocNotes,
      })
    }
    if (phase2 !== undefined) {
      const outcome = await this.processPhase2(phase2, settings, signal)
      if (outcome.kind === 'completed') phase2Completed = 1
      else if (outcome.kind === 'retried') { retried += 1; nextWakeAt = Math.min(nextWakeAt, outcome.nextWakeAt) }
      else quarantined += 1
    }
    const pruned = await this.ctx.memoryPipelineStore.prune({
      now: Date.now(),
      maxRows: settings.pruneRowsPerRun,
      maxBytes: settings.pruneBytesPerRun,
    })
    return {
      discovered: discovery.discovered,
      phase1Completed,
      phase2Completed,
      retried,
      quarantined,
      pruned: pruned.auditAttempts + pruned.sourceSnapshots + pruned.generations,
      nextWakeAt,
    }
  }

  private async discover(
    settings: MemoryRuntimeSettingsValues,
    signal: AbortSignal,
    bypassIdle: boolean,
    bypassAge: boolean,
    durableCursor?: number,
    completedAfter?: number,
  ): Promise<{
    discovered: number
    totalSessions: number
    scannedSessions: number
    waitingSessions: number
    nextCursor: number
    reachedEnd: boolean
    nextWakeAt?: number
  }> {
    const snapshots = await this.ctx.sessionPersistence.listSnapshots(signal)
    const workspaceRegistry = this.ctx.get('workspaceRegistry') as { readonly archivedSessionIds: readonly SessionId[] } | undefined
    if (workspaceRegistry === undefined) throw new Error('memory scheduler requires workspaceRegistry to exclude archived Sessions')
    const archived = new Set(workspaceRegistry.archivedSessionIds)
    const eligibleSnapshots = snapshots
      .filter(snapshot => snapshot.header.purpose === 'interactive' && !archived.has(snapshot.header.id))
      .sort((left, right) => String(left.header.id).localeCompare(String(right.header.id)))
    if (eligibleSnapshots.length === 0) {
      return { discovered: 0, totalSessions: 0, scannedSessions: 0, waitingSessions: 0, nextCursor: 0, reachedEnd: true }
    }
    const startCursor = Math.min(durableCursor ?? this.discoveryCursor, eligibleSnapshots.length)
    const count = Math.min(settings.scanSessionsPerRun, eligibleSnapshots.length - startCursor)
    const ranges = []
    const now = Date.now()
    const sourceCutoff = completedAfter ?? Math.max(0, now - settings.maxSourceAgeMs)
    let nextWakeAt: number | undefined
    let waitingSessions = 0
    for (let index = 0; index < count && ranges.length < settings.maxRangesPerRun; index += 1) {
      signal.throwIfAborted()
      const snapshot = eligibleSnapshots[startCursor + index]
      if (snapshot === undefined || snapshot.header.purpose !== 'interactive') continue
      const live = this.ctx.agents.get(snapshot.header.id)
      if (live?.status === 'running') { waitingSessions += 1; continue }
      let inspection: SessionInspection
      if (live === undefined) inspection = await this.ctx.sessionPersistence.inspect(snapshot.header.id, signal)
      else {
        try {
          inspection = await live.runMaintenance((maintenanceSignal) => {
            maintenanceSignal.throwIfAborted()
            return Promise.resolve({
              meta: structuredClone(live.session.header),
              events: structuredClone([...live.session.events]),
            } satisfies SessionInspection)
          })
        } catch {
          // Another turn or maintenance owner won after the status check; this source remains eligible for a later scan.
          waitingSessions += 1
          continue
        }
      }
      const completed = [...inspection.events].reverse().find(event => event.type === 'turn/end')
      if (completed === undefined) continue
      const age = now - completed.time
      if (!bypassIdle && age < settings.idleMs) {
        const eligibleAt = completed.time + settings.idleMs
        nextWakeAt = nextWakeAt === undefined ? eligibleAt : Math.min(nextWakeAt, eligibleAt)
        continue
      }
      if (!bypassAge && age > settings.maxSourceAgeMs) continue
      const range = rolloutRange(inspection.events, inspection.meta.seedLength ?? 0, sourceCutoff)
      if (range !== undefined) {
        ranges.push({
          sourceRangeId: sourceId(inspection.meta.id, range.fromSeq, range.toSeq, settings.policyVersion),
          sessionId: inspection.meta.id,
          fromSeq: range.fromSeq,
          toSeq: range.toSeq,
          completedAt: range.completedAt,
          sessionPurpose: 'interactive' as const,
          policyVersion: settings.policyVersion,
        })
      }
    }
    const nextCursor = startCursor + count
    const reachedEnd = nextCursor >= eligibleSnapshots.length
    if (durableCursor === undefined) this.discoveryCursor = reachedEnd ? 0 : nextCursor
    const progress = { totalSessions: eligibleSnapshots.length, scannedSessions: count, waitingSessions, nextCursor, reachedEnd }
    if (ranges.length === 0) return { discovered: 0, ...progress, ...nextWakeAt === undefined ? {} : { nextWakeAt } }
    const discovered = (await this.ctx.memoryPipelineStore.registerSourceRanges(ranges)).inserted
    return { discovered, ...progress, ...nextWakeAt === undefined ? {} : { nextWakeAt } }
  }

  private async frozenInspection(claim: Phase1Claim, signal: AbortSignal): Promise<SessionInspection> {
    const live = this.ctx.agents.get(claim.sessionId)
    if (live === undefined) return this.ctx.sessionPersistence.inspect(claim.sessionId, signal)
    if (live.status === 'running') throw new Error('source Agent is active')
    return live.runMaintenance((maintenanceSignal) => {
      maintenanceSignal.throwIfAborted()
      return Promise.resolve({
        meta: structuredClone(live.session.header),
        events: structuredClone([...live.session.events]),
      })
    })
  }

  private heartbeat(
    phase: 'phase1' | 'phase2',
    claim: Phase1Claim | Phase2Claim,
    leaseMs: number,
    signal: AbortSignal,
  ): { signal: AbortSignal; stop: () => Promise<void> } {
    let releaseWait: (() => void) | undefined
    const renewal = new AbortController()
    const stopController = new AbortController()
    const operationSignal = AbortSignal.any([signal, renewal.signal, stopController.signal])
    const releaseOnAbort = (): void => { releaseWait?.() }
    operationSignal.addEventListener('abort', releaseOnAbort, { once: true })
    const loop = (async () => {
      while (true) {
        await new Promise<void>((resolve) => {
          releaseWait = resolve
          const timer = setTimeout(resolve, Math.max(1, Math.floor(leaseMs / 3)))
          const prior = releaseWait
          releaseWait = () => { clearTimeout(timer); prior() }
        })
        if (operationSignal.aborted) return
        try {
          await this.ctx.memoryPipelineStore.renewLease({
            phase,
            jobId: claim.jobId,
            ownerToken: claim.lease.ownerToken,
            now: Date.now(),
            leaseMs,
          })
        } catch (error: unknown) {
          renewal.abort(error)
          return
        }
      }
    })()
    this.owned.add(loop)
    void loop.then(() => { this.owned.delete(loop) })
    return {
      signal: operationSignal,
      stop: async () => {
        stopController.abort(new Error('memory lease heartbeat stopped'))
        releaseWait?.()
        await loop
        operationSignal.removeEventListener('abort', releaseOnAbort)
      },
    }
  }

  private async processPhase1(
    claim: Phase1Claim,
    settings: MemoryRuntimeSettingsValues,
    signal: AbortSignal,
  ): Promise<PipelineStepOutcome> {
    const heartbeat = this.heartbeat('phase1', claim, settings.phase1LeaseMs, signal)
    try {
      const inspection = await this.frozenInspection(claim, heartbeat.signal)
      const timeout = AbortSignal.any([heartbeat.signal, AbortSignal.timeout(settings.providerTimeoutMs)])
      const phaseConfig: Phase1Config = {
        backend: settings.extractionBackend,
        reasoningEffort: settings.extractionReasoningEffort,
        provider: settings.extractionProvider,
        model: settings.extractionModel,
        maxTokens: settings.extractionMaxTokens,
        maxEvidenceBytes: settings.maxEvidenceBytes,
        maxResultBytes: settings.maxResultBytes,
        maxCandidates: settings.maxCandidatesPerRange,
        disableOnExternalContext: settings.disableOnExternalContext,
        externalToolPrefixes: settings.externalToolPrefixes,
        policyVersion: settings.policyVersion,
      }
      const candidates = await runPhase1(this.ctx, claim, inspection.events, phaseConfig, timeout)
      await this.ctx.memoryPipelineStore.commitPhase1Outcome(claim, candidates.length === 0 ? { kind: 'empty' } : { kind: 'applied', candidates })
      return { kind: 'completed' }
    } catch (error: unknown) {
      const now = Date.now()
      const category = classifyMemoryFailure(error)
      const next = retryAt(settings, claim.lease.attempt, now, category)
      const disposition = await this.ctx.memoryPipelineStore.recordFailure({
        phase: 'phase1', jobId: claim.jobId, ownerToken: claim.lease.ownerToken, category,
        message: `${settings.extractionBackend}/${settings.extractionModel}/${settings.extractionReasoningEffort}: ${errorChain(error)}`, now,
        ...next === undefined ? {} : { retryAt: next },
      })
      return disposition.kind === 'retry'
        ? { kind: 'retried', nextWakeAt: disposition.nextAttemptAt }
        : { kind: 'quarantined' }
    } finally {
      await heartbeat.stop()
    }
  }

  private async runConsolidationAgent(
    claim: Phase2Claim,
    settings: MemoryRuntimeSettingsValues,
    signal: AbortSignal,
  ): Promise<{ workspace: Phase2Workspace; sessionId: SessionId }> {
    const workspace = await this.ctx.memoryPipelineStore.createPhase2Workspace(claim)
    const binding = await this.ctx.memoryPipelineStore.openMaintenanceSession(claim)
    let handle: AgentHandle | undefined
    const cancelForSignal = (): void => {
      handle?.agent.cancel({ kind: 'hook', reason: 'memory-consolidation-aborted' })
    }
    signal.addEventListener('abort', cancelForSignal, { once: true })
    try {
      handle = await this.ctx.agents.create({
        sessionId: binding.sessionId,
        meta: { cwd: workspace.stagingRoot, purpose: 'maintenance' },
        agentOptions: {
          provider: settings.consolidationProvider,
          model: settings.consolidationModel,
          maxTokens: settings.consolidationMaxTokens,
        },
        signal,
        setup: async (agentCtx) => {
          const allowedTools = new Set(['read', 'write', 'edit', 'grep', 'glob'])
          agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
            const result = await next()
            return { ...result, tools: result.tools.filter(tool => allowedTools.has(tool.name)) }
          })
          agentCtx.on('tools/pre-execute', (execution, next) => allowedTools.has(execution.name)
            ? next()
            : Promise.resolve({ kind: 'deny', reason: `maintenance Agent cannot call ${execution.name}` }))
          if (settings.consolidationReasoningEffort !== 'inherit') {
            agentCtx.on('agent/request', async (_request, next) => ({
              ...await next(),
              reasoningEffort: ReasoningEffortId(settings.consolidationReasoningEffort),
            }))
          }
          const stagingCtx = agentCtx.isolate('fs')
          await stagingCtx.plugin(MemoryStagingFileSystem, {
            cwd: workspace.stagingRoot,
            diffBasisMaxBytes: settings.phase2MaxFileBytes,
          })
          await stagingCtx.plugin(toolFs, {})
          await stagingCtx.plugin(memoryStagingTools, {
            maxFiles: settings.phase2SearchMaxFiles,
            maxMatches: settings.phase2SearchMaxMatches,
            maxFileBytes: settings.phase2MaxFileBytes,
          })
        },
      })
      if (signal.aborted) cancelForSignal()
      handle.agent.followup(createUserMessage({
        source: { kind: 'plugin', plugin: 'dsh-memory-scheduler', form: 'recall' },
        content: [{ type: 'text', text: phase2ConsolidationPrompt(claim, settings) }],
      }))
      await handle.agent.whenIdle()
      signal.throwIfAborted()
      await binding.persistence.flush()
      const ended = [...handle.agent.session.events].reverse().find(event => event.type === 'turn/end')
      if (ended?.type !== 'turn/end') throw new Error('Phase 2 maintenance Agent ended without a durable turn/end event')
      if (ended.data.reason.kind !== 'completed') {
        if (ended.data.reason.kind === 'max-tokens') {
          throw new Error(`output-budget-exhausted: Phase 2 reached max-tokens at ${settings.consolidationMaxTokens} tokens`)
        }
        throw new Error(`Phase 2 maintenance Agent ended with ${ended.data.reason.kind}`)
      }
      return { workspace, sessionId: binding.sessionId }
    } finally {
      signal.removeEventListener('abort', cancelForSignal)
      await handle?.dispose()
      if (handle !== undefined) await binding.persistence.flush()
    }
  }

  private async processPhase2(
    claim: Phase2Claim,
    settings: MemoryRuntimeSettingsValues,
    signal: AbortSignal,
  ): Promise<PipelineStepOutcome> {
    const heartbeat = this.heartbeat('phase2', claim, settings.phase2LeaseMs, signal)
    try {
      const phaseSignal = AbortSignal.any([
        heartbeat.signal,
        AbortSignal.timeout(settings.providerTimeoutMs),
      ])
      const output = settings.consolidationBackend === 'codex'
        ? await codexPhase2(this.ctx, claim, settings, phaseSignal)
        : await this.runConsolidationAgent(claim, settings, phaseSignal)
      heartbeat.signal.throwIfAborted()
      const materializing = await this.ctx.memoryPipelineStore.allocateGeneration(claim)
      heartbeat.signal.throwIfAborted()
      const prepared = await this.ctx.memoryPipelineStore.validateAndPrepareGeneration({
        claim,
        workspace: output.workspace,
        materializing,
        ...'structuredAttemptId' in output ? { structuredAttemptId: output.structuredAttemptId } : { maintenanceSessionId: output.sessionId },
      })
      heartbeat.signal.throwIfAborted()
      await this.ctx.memoryPipelineStore.publishGeneration({ claim, prepared })
      return { kind: 'completed' }
    } catch (error: unknown) {
      const now = Date.now()
      const category = classifyMemoryFailure(error)
      const next = retryAt(settings, claim.lease.attempt, now, category)
      const disposition = await this.ctx.memoryPipelineStore.recordFailure({
        phase: 'phase2', jobId: claim.jobId, ownerToken: claim.lease.ownerToken, category,
        message: `${settings.consolidationBackend}/${settings.consolidationModel}/${settings.consolidationReasoningEffort}: ${errorChain(error)}`, now,
        ...next === undefined ? {} : { retryAt: next },
      })
      return disposition.kind === 'retry'
        ? { kind: 'retried', nextWakeAt: disposition.nextAttemptAt }
        : { kind: 'quarantined' }
    } finally {
      await heartbeat.stop()
    }
  }

  override async disposeAndDrain(_signal: AbortSignal): Promise<void> {
    if (this.accepting) {
      this.accepting = false
      this.reasons.clear()
      if (this.timer !== undefined) clearTimeout(this.timer)
      this.controller.abort(new Error('memory scheduler is disposing'))
    }
    const owned = [this.driver, this.runTail, ...this.owned]
      .filter((value): value is Promise<unknown> => value !== undefined)
    await Promise.allSettled(owned)
  }
}

export default MemoryScheduler

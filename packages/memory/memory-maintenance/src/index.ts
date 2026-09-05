/** Memory scheduler lifecycle Service Definition. @module @deepseek-ai/dsh-memory-maintenance */

import { Context, Service } from '@deepseek-ai/cordis'

/** Durable or runtime reason that may make pipeline work due. */
export type MemoryWakeReason =
  | 'startup'
  | 'root-session-startup'
  | 'idle-deadline'
  | 'retry-deadline'
  | 'defer-deadline'
  | 'lease-expiry'
  | 'budget-window'
  | 'configuration'
  | 'session-controls'
  | 'manual-scan'
  | 'manual-consolidation'
  | 'clean-rebuild'
  | 'quarantine-retry'
  | 'pipeline-work'

/** Work counters for one bounded scheduler pass. */
export interface MemoryMaintenanceRun {
  readonly discovered: number
  readonly phase1Completed: number
  readonly phase2Completed: number
  readonly retried: number
  readonly quarantined: number
  readonly pruned: number
  readonly nextWakeAt?: number
}

/** Provider route whose remaining background-call quota may be reported. */
export interface MemoryQuotaQuery {
  readonly provider: string
  readonly model: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memoryMaintenance: MemoryMaintenanceService
  }

  interface Events {
    /**
     * Returns the remaining provider quota percentage when the active route exposes that telemetry.
     * @mode bail
     * @param query - Provider and model selected for a background memory call.
     */
    'memory/quota-remaining'(query: MemoryQuotaQuery): number | undefined
  }
}

/** Coalesced scheduler driver and quiescent shutdown seam. */
export abstract class MemoryMaintenanceService extends Service {
  constructor(ctx: Context) {
    if (new.target === MemoryMaintenanceService) {
      throw new Error('@deepseek-ai/dsh-memory-maintenance is an abstract service; load @deepseek-ai/dsh-memory-scheduler')
    }
    super(ctx, 'memoryMaintenance')
  }

  /**
   * Coalesce a reason and arrange a scheduler pass without waiting for it.
   * @param reason - Work source that requested a pass.
   */
  abstract wake(reason: MemoryWakeReason): void
  /**
   * Run one bounded due-work pass using caller cancellation.
   * @param signal - Cancellation for claims and owned work.
   * @returns Counts and next wake deadline from the settled pass.
   */
  abstract runDue(signal: AbortSignal): Promise<MemoryMaintenanceRun>
  /**
   * Stop claims, cancel owned work, and wait until every owned operation settles.
   * @param signal - Caller deadline; settlement still completes after it aborts.
   */
  abstract disposeAndDrain(signal: AbortSignal): Promise<void>
}

export default MemoryMaintenanceService

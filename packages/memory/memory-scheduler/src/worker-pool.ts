/** Bounded claim-and-run ownership for a single extraction pass. @module @deepseek-ai/dsh-memory-scheduler/worker-pool */

/**
 * Claim only with a free worker; drain every started operation before returning or throwing.
 * @param concurrency - Maximum simultaneous owners.
 * @param limit - Maximum claims attempted in this pass.
 * @param signal - Stops new claims; operations receive the same cancellation signal from their owner.
 * @param claim - Acquire the next independently leased job, or report an empty queue.
 * @param run - Settle one job including its per-job failure disposition.
 * @returns Number of acquired jobs after all workers have settled.
 */
export async function runClaimPool<T>(concurrency: number, limit: number, signal: AbortSignal,
  claim: () => Promise<T | undefined>, run: (job: T) => Promise<void>): Promise<number> {
  let attempts = 0
  let acquired = 0
  let stopped = false
  const worker = async (): Promise<void> => {
    try {
      while (!stopped && !signal.aborted && attempts < limit) {
        attempts += 1
        const job = await claim()
        if (job === undefined) { stopped = true; return }
        acquired += 1
        await run(job)
      }
    } catch (error) { stopped = true; throw error }
  }
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, limit) }, worker))
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
  signal.throwIfAborted()
  return acquired
}

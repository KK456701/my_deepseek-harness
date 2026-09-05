import { describe, expect, it } from 'vitest'
import { runClaimPool } from '../src/worker-pool.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('extraction worker ownership', () => {
  it('claims only in free slots and actually overlaps two jobs', async () => {
    const blocked = deferred()
    const overlap = deferred()
    let claims = 0
    let running = 0
    let peak = 0
    const completed: number[] = []
    const run = runClaimPool(2, 4, new AbortController().signal, async () => ++claims, async (id) => {
      running += 1
      peak = Math.max(peak, running)
      if (running === 2) overlap.resolve()
      await blocked.promise
      completed.push(id)
      running -= 1
    })
    await overlap.promise
    expect(claims).toBe(2)
    blocked.resolve()
    expect(await run).toBe(4)
    expect(peak).toBe(2)
    expect(completed.sort()).toEqual([1,2,3,4])
  })

  it('stops claiming on cancellation and drains every owned operation', async () => {
    const abort = new AbortController()
    const blocked = deferred()
    const started = deferred()
    let claims = 0
    let settled = false
    const run = runClaimPool(2, 8, abort.signal, async () => ++claims, async () => {
      if (claims === 2) started.resolve()
      await blocked.promise
    })
    const result = run.catch((error: unknown) => { settled = true; return error })
    await started.promise
    abort.abort(new Error('cancelled'))
    expect(settled).toBe(false)
    blocked.resolve()
    expect(await result).toMatchObject({ message: 'cancelled' })
    expect(claims).toBe(2)
  })

  it('contains per-job failure outcomes without cancelling siblings and drains unexpected errors', async () => {
    const blocked = deferred()
    const failed = deferred()
    let id = 0
    let siblingSettled = false
    const run = runClaimPool(2, 3, new AbortController().signal, async () => ++id, async (job) => {
      if (job === 1) { failed.resolve(); throw new Error('store unavailable') }
      await blocked.promise
      siblingSettled = true
    })
    const result = run.catch((error: unknown) => error)
    await failed.promise
    expect(siblingSettled).toBe(false)
    blocked.resolve()
    expect(await result).toMatchObject({ message: 'store unavailable' })
    expect(siblingSettled).toBe(true)
    expect(id).toBe(2)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MemoryMaintenanceService, { type MemoryMaintenanceRun, type MemoryWakeReason } from '@deepseek-ai/dsh-memory-maintenance'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import * as triggers from '../src/index.ts'

class FakeMaintenance extends MemoryMaintenanceService {
  readonly reasons: MemoryWakeReason[] = []
  wake(reason: MemoryWakeReason): void { this.reasons.push(reason) }
  runDue(): Promise<MemoryMaintenanceRun> {
    return Promise.resolve({
      discovered: 0,
      phase1Completed: 0,
      phase2Completed: 0,
      retried: 0,
      quarantined: 0,
      pruned: 0,
    })
  }
  disposeAndDrain(): Promise<void> { return Promise.resolve() }
}

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

describe('memory maintenance triggers', () => {
  it('wakes on interactive Session startup while turn completion only flushes', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(FakeMaintenance)
    let flushed = 0
    ctx.on('session/flush', async () => { await Promise.resolve(); flushed += 1 })
    const fiber = await ctx.plugin(triggers)
    const maintenance = ctx.memoryMaintenance as FakeMaintenance
    expect(maintenance.reasons).toEqual(['startup'])
    const session = ctx.sessions.create(SessionId('interactive'), { meta: { purpose: 'interactive' } })
    expect(maintenance.reasons).toEqual(['startup', 'root-session-startup'])
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await vi.waitFor(() => { expect(flushed).toBe(1) })
    expect(maintenance.reasons).toEqual(['startup', 'root-session-startup'])
    ctx.sessions.create(SessionId('subagent'), { meta: { purpose: 'subagent' } })
    expect(maintenance.reasons).toEqual(['startup', 'root-session-startup'])
    session.append('turn/start', { turn: 2 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await vi.waitFor(() => { expect(flushed).toBe(2) })
    expect(maintenance.reasons).toEqual(['startup', 'root-session-startup'])
    await fiber.dispose()
    session.append('turn/start', { turn: 3 })
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    await Promise.resolve()
    expect(flushed).toBe(2)
  })

  it('keeps explicit notes pending unless the user requests immediate consolidation', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(FakeMaintenance)
    await ctx.plugin(triggers)
    const maintenance = ctx.memoryMaintenance as FakeMaintenance

    ctx.emit('memory/pipeline-work-available', { kind: 'ad-hoc' })
    expect(maintenance.reasons).toEqual(['startup'])
    ctx.emit('memory/pipeline-work-available', { kind: 'manual-consolidation' })
    expect(maintenance.reasons).toEqual(['startup', 'manual-consolidation'])
    ctx.emit('memory/pipeline-work-available', { kind: 'manual-scan' })
    expect(maintenance.reasons).toEqual(['startup', 'manual-consolidation', 'manual-scan'])
  })
})

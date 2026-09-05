/** Wake consumers for memory scheduler lifecycle and durable work. @module @deepseek-ai/dsh-memory-maintenance-triggers */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-memory'
import type {} from '@deepseek-ai/dsh-memory-maintenance'
import type {} from '@deepseek-ai/dsh-memory-pipeline-store'

/** Cordis plugin name. */
export const name = 'memory-maintenance-triggers'
/** Services needed to flush completed turns and wake maintenance. */
export const inject = ['memoryMaintenance', 'sessions']

/** Register effect-owned Session-startup, control, and durable-work wake sources. */
export function apply(ctx: Context): void {
  ctx.on('session/created', (session) => {
    if (session.header.purpose === 'interactive') ctx.memoryMaintenance.wake('root-session-startup')
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end' || session.header.purpose !== 'interactive') return
    void ctx.sessions.flush(session).catch((error: unknown) => {
      ctx.logger.warn(`memory-maintenance-triggers: failed to flush Session "${session.id}": ${error instanceof Error ? error.message : String(error)}`)
    })
  }, { global: true })
  ctx.on('memory/session-controls-changed', () => { ctx.memoryMaintenance.wake('session-controls') })
  ctx.on('memory/runtime-settings-changed', () => { ctx.memoryMaintenance.wake('configuration') })
  ctx.on('memory/pipeline-work-available', (reason) => {
    if (reason.kind === 'ad-hoc') return
    if (reason.kind === 'manual-scan') ctx.memoryMaintenance.wake('manual-scan')
    else if (reason.kind === 'manual-consolidation') ctx.memoryMaintenance.wake('manual-consolidation')
    else if (reason.kind === 'clean-rebuild') ctx.memoryMaintenance.wake('clean-rebuild')
    else if (reason.kind === 'quarantine') ctx.memoryMaintenance.wake('quarantine-retry')
    else ctx.memoryMaintenance.wake('pipeline-work')
  })
  ctx.memoryMaintenance.wake('startup')
}

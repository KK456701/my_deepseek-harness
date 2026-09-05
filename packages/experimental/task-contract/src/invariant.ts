/** Package-owned relational checks for Task Contract revisions. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { foldTaskContract } from './fold.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-task-contract'

/** Cordis companion plugin name. */
export const name = 'task-contract-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

/** Validate an appended Contract revision against its exact committed prefix. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'task-contract/update') return
    try {
      foldTaskContract({ events: [...session.events, event] })
    } catch (error: unknown) {
      fail(`session event ${event.seq} violates Task Contract revisions: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, { global: true })
}, { inject: ['sessions'] })

/** Register the Task Contract invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

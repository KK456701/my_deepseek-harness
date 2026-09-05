/** Package-owned relational checks for progress-observation pairs. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-progress-integrity-observer'

/** Cordis companion plugin name. */
export const name = 'progress-integrity-observer-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

/** Require one start before at most one observation for each step. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'progress-integrity/start' && event.type !== 'progress-integrity/observation') return
    const same = session.events.filter(item => (item.type === 'progress-integrity/start' || item.type === 'progress-integrity/observation')
      && item.data.turn === event.data.turn && item.data.step === event.data.step)
    if (event.type === 'progress-integrity/start' && same.some(item => item.type === 'progress-integrity/start')) {
      fail(`progress observation repeats start for turn ${event.data.turn}/step ${event.data.step}`)
    }
    if (event.type === 'progress-integrity/observation') {
      if (!same.some(item => item.type === 'progress-integrity/start')) fail(`progress observation has no start for turn ${event.data.turn}/step ${event.data.step}`)
      if (same.some(item => item.type === 'progress-integrity/observation')) fail(`progress observation repeats turn ${event.data.turn}/step ${event.data.step}`)
    }
  }, { global: true })
}, { inject: ['sessions'] })

/** Register the Progress Observer invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

/** Dispatch results must refer to an earlier persisted execution intent. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller, InvariantFailure } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from './types.ts'

/** Companion registration name. */
export const name = 'task-execution-control-invariant'
/** Required invariant registry. */
export const inject = ['invariants']
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, name, args) => {
    if (name !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'task-execution/result') return
    if (!session.events.some(prior => prior.type === 'task-execution/dispatch' && prior.data.incarnation === event.data.incarnation && prior.data.callId === event.data.callId)) {
      fail('task execution result has no matching dispatch intent')
    }
  }, { global: true })
}, { inject: ['sessions'] })
/**
 * Register the execution receipt invariant.
 * @param ctx - Companion context.
 * @returns Registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-experimental-task-execution-control', install))

/** Invariant companion for the event-derived task-review presentation. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Required invariant registry. */
export const inject = ['invariants']
/** Invariant companion plugin name. */
export const name = 'experimental-ui-task-review-invariant'
/** No runtime invariant: conversation definitions only fold durable events. */
const install: InvariantInstaller = () => {}

/**
 * Reserve the package's invariant ownership.
 * @param ctx - Context carrying the invariant registry.
 * @returns Registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-experimental-ui-task-review', install))

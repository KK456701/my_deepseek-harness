/** Invariant companion for the public memory Definition. @module @deepseek-ai/dsh-memory/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'memory-invariant'
/** Service required before package ownership can be reserved. */
export const inject = ['invariants']

// No runtime invariant: public methods are request/response operations; durable relations belong to the local provider.
const install: InvariantInstaller = () => {}

/** Register the public memory package's intentionally empty companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-memory', install))

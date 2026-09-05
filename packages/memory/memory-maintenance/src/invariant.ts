/** Invariant companion for the maintenance Definition. @module @deepseek-ai/dsh-memory-maintenance/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'memory-maintenance-invariant'
/** Service required before package ownership can be reserved. */
export const inject = ['invariants']

// Wake coalescing and drain settlement are provider-owned lifecycle relations.
// No runtime invariant: the service only exposes effect-owned wake and drain operations.
const install: InvariantInstaller = () => {}

/** Register the maintenance Definition's intentionally empty companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-memory-maintenance', install))

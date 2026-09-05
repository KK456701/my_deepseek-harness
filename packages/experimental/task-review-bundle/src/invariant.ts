/** Invariant ownership for the static task-review bundle. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'experimental-task-review-bundle-invariant'
/** Registry used to reserve the companion. */
export const inject = ['invariants']

// No runtime invariant: the bundle owns no live state; the Loader and providers validate its composition.
const install: InvariantInstaller = () => {}

/**
 * Reserve invariant ownership for this static bundle.
 * @param ctx - context carrying the invariant registry.
 * @returns registry disposer.
 */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(
  ctx.invariants.register('@deepseek-ai/dsh-experimental-task-review-bundle', install),
)

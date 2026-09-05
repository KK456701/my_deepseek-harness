/** Invariant companion for the pipeline-store Definition. @module @deepseek-ai/dsh-memory-pipeline-store/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'memory-pipeline-store-invariant'
/** Service required before package ownership can be reserved. */
export const inject = ['invariants']

// Cross-call durable relations are provider-owned and cannot be observed from this abstract seam.
// No runtime invariant: opaque handles are validated transactionally by the selected provider.
const install: InvariantInstaller = () => {}

/** Register the pipeline-store Definition's intentionally empty companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-memory-pipeline-store', install))

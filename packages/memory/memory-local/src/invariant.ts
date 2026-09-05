/** Invariant companion for the local memory provider. @module @deepseek-ai/dsh-memory-local/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'memory-local-invariant'
/** Service required before package ownership can be reserved. */
export const inject = ['invariants']

// No runtime invariant: SQLite transactions and generation validation enforce provider-owned relationships.
const install: InvariantInstaller = () => {}

/** Reserve the public and private local-memory service ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-memory-local', install))

/** Invariant companion for memory maintenance triggers. @module @deepseek-ai/dsh-memory-maintenance-triggers/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
/** Cordis companion plugin name. */
export const name = 'memory-maintenance-triggers-invariant'
/** Service required before package ownership can be reserved. */
export const inject = ['invariants']
// No runtime invariant: effect-owned event listeners have no mutable companion relationship to scan.
const install: InvariantInstaller = () => {}
/** Reserve trigger package ownership; listeners are effect-owned directly. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-memory-maintenance-triggers', install))

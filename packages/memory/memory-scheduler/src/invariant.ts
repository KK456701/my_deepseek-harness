/** Invariant companion for the memory scheduler. @module @deepseek-ai/dsh-memory-scheduler/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'memory-scheduler-invariant'
/** Service required before package ownership can be reserved. */
export const inject = ['invariants']
// No runtime invariant: owned jobs, leases, and driver promises are validated at their lifecycle operations.
const install: InvariantInstaller = () => {}
/** Reserve scheduler package ownership; durable transition tests own its relations. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-memory-scheduler', install))

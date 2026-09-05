/** Invariant companion for rooted memory staging tools. @module @deepseek-ai/dsh-memory-staging-tools/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'memory-staging-tools-invariant'
/** Service required before package ownership can be reserved. */
export const inject = ['invariants']
// No runtime invariant: the rooted filesystem validates every path and role at the operation point.
const install: InvariantInstaller = () => {}
/** Register the package's operation-point policy companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-memory-staging-tools', install))

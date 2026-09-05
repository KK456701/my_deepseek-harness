/** Package-owned invariant companion. @module @deepseek-ai/dsh-memory-bundle/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory-bundle'

/** Cordis companion plugin name. */
export const name = 'memory-bundle-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

// No runtime invariant: the Loader and each assembled package validate the bundle dependency graph.
const install: InvariantInstaller = () => {}

/** Register the static bundle's empty runtime companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

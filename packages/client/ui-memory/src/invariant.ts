/** Package-owned invariant companion. @module @deepseek-ai/dsh-client-ui-memory/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-memory'

/** Cordis companion plugin name. */
export const name = 'client-ui-memory-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No owned cross-plugin mutable state; the Host and Remote remain authoritative. */
// No runtime invariant: slot registration and Remote injection are checked by their owning registries.
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

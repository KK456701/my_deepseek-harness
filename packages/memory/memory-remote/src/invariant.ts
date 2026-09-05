/** Package-owned invariant companion. @module @deepseek-ai/dsh-memory-remote/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory-remote'

/** Cordis companion plugin name. */
export const name = 'memory-remote-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No mutable runtime state: Typert and MemoryService own registration and data lifetimes. */
// No runtime invariant: Typert owns namespace registration and public method resolution.
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

/** Structured-call Definition invariant companion. @module @deepseek-ai/dsh-codex-structured-runner/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'codex-structured-runner-invariant'
export const inject = ['invariants']
// No runtime invariant: the provider owns dispatch and process settlement; the Definition owns no live relationship.
const install: InvariantInstaller = () => {}
/**
 * Register the empty Definition companion.
 * @param ctx - Invariant registry context.
 * @returns Registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-codex-structured-runner', install))

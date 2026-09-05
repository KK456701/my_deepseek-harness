/** Invariant companion for memory prompt injection. @module @deepseek-ai/dsh-memory-prompt/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller, InvariantFailure } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-memory'
/** Cordis companion plugin name. */
export const name = 'memory-prompt-invariant'
/** Service required before package ownership can be reserved. */
export const inject = ['invariants']
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const check = (session: Session, event: SessionEvent): void => {
    if (event.type !== 'memory/context') return
    const header = session.events.find(item => item.seq === event.data.headerSeq)
    if (header?.type !== 'request/header' || header.seq >= event.seq) fail('memory observation must reference an earlier request/header')
    if (event.data.selection.kind === 'available' && !header.data.header.system?.includes(`Generation: ${event.data.selection.generationId}\n`)) fail('memory observation generation must match its logged request header')
    if (event.ignorable !== true) fail('memory observation must remain ignorable and non-model-visible')
  }
  for (const session of ctx.sessions.list()) for (const event of session.events) check(session, event)
  ctx.on('session/event', check, { global: true })
}, { inject: ['sessions'] })
/** Register header-reference and generation-attribution checks. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-memory-prompt', install))

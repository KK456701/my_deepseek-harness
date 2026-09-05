/** Package-owned relational checks for final-draft lifecycle events. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-final-completeness-gate'

/** Cordis companion plugin name. */
export const name = 'final-completeness-gate-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

/** Validate candidate and reviewer events against earlier events for the same identities. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (!event.type.startsWith('final-draft/') && !event.type.startsWith('final-review/')) return
    const prior = session.events
    const candidateId = 'candidateId' in event.data ? event.data.candidateId : undefined
    if (candidateId === undefined) return
    const candidateEvents = prior.filter(item => 'candidateId' in item.data && item.data.candidateId === candidateId)
    const count = (type: string): number => candidateEvents.filter(item => item.type === type).length
    const hasStart = event.type === 'final-review/input' || event.type === 'final-review/evidence-access'
      ? count('final-review/shadow-start') + count('final-draft/start') === 1
      : count(event.type.startsWith('final-review/') ? 'final-review/shadow-start' : 'final-draft/start') === 1
    if (event.type === 'final-draft/start' || event.type === 'final-review/shadow-start') {
      if (candidateEvents.length > 0) fail(`candidate ${candidateId} repeats its lifecycle start`)
      return
    }
    if (!hasStart) fail(`candidate ${candidateId} has ${event.type} before its lifecycle start`)
    if (event.type === 'final-review/input') {
      if (count('final-review/input') !== 0) fail(`candidate ${candidateId} repeats its frozen review input`)
      if (event.data.input.evidence.some(evidence => evidence.seq >= event.data.input.candidateSeq)) fail(`candidate ${candidateId} includes evidence newer than itself`)
    }
    if (event.type === 'final-draft/candidate' && count('final-draft/candidate') > 0) fail(`candidate ${candidateId} repeats its complete draft`)
    if (event.type === 'final-draft/review-start' && count('final-draft/candidate') !== 1) fail(`candidate ${candidateId} starts review before one complete draft`)
    if (event.type === 'final-review/evidence-access') {
      const start = candidateEvents.find(item => item.type === 'final-draft/review-start'
        && item.data.attemptId === event.data.attemptId)
      if (start === undefined) fail(`candidate ${candidateId} evidence access has no matching review attempt`)
    }
    if (event.type === 'final-draft/review-result') {
      const start = candidateEvents.find(item => item.type === 'final-draft/review-start'
        && item.data.attemptId === event.data.attemptId)
      if (start === undefined) fail(`candidate ${candidateId} review result has no matching attempt start`)
    }
    if (event.type === 'final-draft/end') {
      const decision = candidateEvents.findLast(item => item.type === 'final-draft/decision')
      if (decision?.type !== 'final-draft/decision'
        || !['committed', 'rejected', 'superseded', 'aborted'].includes(decision.data.status)) {
        fail(`candidate ${candidateId} ends without a terminal decision`)
      }
    }
  }, { global: true })
}, { inject: ['sessions'] })

/** Register the Final Gate invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

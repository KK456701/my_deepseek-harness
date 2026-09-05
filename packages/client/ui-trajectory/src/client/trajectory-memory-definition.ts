/** Memory request observations projected without accessing the current memory provider. @module */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-memory'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type { TrajectoryMemoryContext } from './trajectory-contract.ts'
import { trajectoryNode } from './trajectory-definition-common.ts'

const definition: ConversationNodeDefinition<TrajectoryMemoryContext> = {
  kind: 'trajectory-memory-context',
  target: 'trajectory',
  match: event => event.type === 'memory/context' ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match) => {
    if (match.event.type !== 'memory/context') throw new Error('memory context requires memory/context')
    return { seq: match.event.seq, time: match.event.time, context: match.event.data }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined ? null : trajectoryNode(context, context.state.seq, { kind: 'memory-context', memory: context.state }),
}

/**
 * Register the memory observation projection.
 * @param ctx - Client contribution owner.
 */
export function registerTrajectoryMemoryDefinition(ctx: Context): void {
  ctx.conversationEvents.register(definition)
}

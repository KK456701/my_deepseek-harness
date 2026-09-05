/** Chat-only projections of received input and audited extraction failures. */
import type { ConversationNodeContext, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-experimental-task-contract/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Claimed direct inputs awaiting pre-step admission, never a model-history replacement. */
export interface InputReceiptData {
  readonly messages: SessionEventMap['task-contract/input']['messages']
  readonly stopped: boolean
  readonly seq: number
}

/** Attempt route and terminal audit; older records may have no response diagnostics. */
export interface ExtractionFailureData {
  readonly seq: number
  readonly request: SessionEventMap['task-contract/extraction-start']
  readonly result?: SessionEventMap['task-contract/extraction-result']
  readonly startedAt: number
  readonly endedAt?: number
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    'task-input-receipt': InputReceiptData
    'task-extraction-failure': ExtractionFailureData
  }
}

function location(context: ConversationNodeContext) {
  return context.start?.location ?? { kind: 'unresolved' as const }
}

/** Pre-admission input remains visible after cancellation; step admission replaces it with normal messages. */
export const inputReceiptDefinition: ConversationNodeDefinition<InputReceiptData> = {
  kind: 'task-input-receipt',
  target: 'chat',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'task-contract/input' || event.type === 'task-contract/input-admitted' || event.type === 'turn/end') {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => ({ messages: [], stopped: false, seq: match.event.seq }),
  update: (context, match) => {
    const event = match.event
    if (event.type === 'task-contract/input') {
      const messages = new Map(context.state.messages.map(message => [message.id, message]))
      for (const message of event.data.messages) messages.set(message.id, message)
      return { ...context.state, messages: [...messages.values()], seq: event.seq }
    }
    if (event.type === 'task-contract/input-admitted') return { ...context.state,
      messages: context.state.messages.filter(message => !event.data.messageIds.includes(message.id)) }
    if (event.type === 'turn/end') return { ...context.state, stopped: true }
    return context.state
  },
  publication: () => 'immediate',
  buildViewNode: context => context.state === undefined ? null : {
    key: context.key, id: context.id, kind: 'task-input-receipt', target: 'chat',
    anchorSeq: context.state.seq, location: location(context),
    visibility: context.state.messages.length === 0 ? 'hidden' : 'visible', data: context.state,
  },
}

/** Each failed attempt remains independently inspectable after a retry or reload. */
export const extractionFailureDefinition: ConversationNodeDefinition<ExtractionFailureData> = {
  kind: 'task-extraction-failure',
  target: 'chat',
  match: (event) => {
    if (event.type === 'task-contract/extraction-start') return { id: event.data.attemptId, role: 'start' }
    if (event.type === 'task-contract/extraction-result') return { id: event.data.attemptId, role: 'update' }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'task-contract/extraction-start') throw new Error('extraction requires its request audit')
    return { seq: match.event.seq, request: match.event.data, startedAt: match.event.time }
  },
  update: (context, match) => match.event.type === 'task-contract/extraction-result'
    ? { ...context.state, result: match.event.data, endedAt: match.event.time }
    : context.state,
  publication: () => 'immediate',
  buildViewNode: context => context.state === undefined ? null : {
    key: context.key, id: context.id, kind: 'task-extraction-failure', target: 'chat',
    anchorSeq: context.state.seq, location: location(context),
    visibility: context.state.result?.error === undefined ? 'hidden' : 'visible', data: context.state,
  },
}

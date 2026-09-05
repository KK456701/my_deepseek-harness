/** Post-delivery review state projected from existing Session events. */
import type { ReactNode } from 'react'
import type {
  ConversationNodeDefinition, ConversationViewBuilder, ConversationViewDefinition, ConversationViewNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  AssistantBodyOwnerProps, AssistantChatData,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-experimental-final-completeness-gate'
import css from './DeliveryReview.module.css'

/** One enforcing review decision projected without fabricating a chat message. */
export interface DeliveryReviewMarker {
  readonly seq: number
  readonly turn: number
  readonly candidateSeq: number
}

/** Read-only rejected-delivery lookup assembled from existing review results. */
export interface DeliveryReviewSnapshot {
  readonly markers: readonly DeliveryReviewMarker[]
}

interface DeliveryReviewViewNode extends ConversationViewNode {
  readonly target: 'task-review-delivery'
  readonly data: DeliveryReviewMarker
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationViewSnapshotMap {
    /** Enforcing post-delivery rejections keyed independently from Chat rows. */
    'task-review-delivery': DeliveryReviewSnapshot
  }
}

class DeliveryReviewSnapshotBuilder implements ConversationViewBuilder<DeliveryReviewViewNode, DeliveryReviewSnapshot> {
  private readonly byKey = new Map<string, DeliveryReviewViewNode>()
  private snapshot: DeliveryReviewSnapshot = { markers: [] }
  readonly empty: DeliveryReviewSnapshot = this.snapshot

  replace(input: { readonly nodes: readonly DeliveryReviewViewNode[] }): DeliveryReviewSnapshot {
    this.byKey.clear()
    for (const node of input.nodes) this.byKey.set(node.key, node)
    return this.publish()
  }

  apply(input: { readonly upserts: readonly DeliveryReviewViewNode[] }): DeliveryReviewSnapshot {
    for (const node of input.upserts) this.byKey.set(node.key, node)
    return this.publish()
  }

  private publish(): DeliveryReviewSnapshot {
    this.snapshot = { markers: [...this.byKey.values()].map(node => node.data)
      .sort((left, right) => left.seq - right.seq) }
    return this.snapshot
  }
}

/** Dedicated projection keeps review state out of Chat rows and model history. */
export const deliveryReviewViewDefinition: ConversationViewDefinition<DeliveryReviewViewNode, DeliveryReviewSnapshot> = {
  target: 'task-review-delivery',
  create: () => new DeliveryReviewSnapshotBuilder(),
}

/** Rejected delivery markers remain queryable even when the review completed after its Turn boundary. */
export const deliveryReviewDefinition: ConversationNodeDefinition<DeliveryReviewMarker> = {
  kind: 'task-review-delivery-marker',
  target: 'task-review-delivery',
  match: event => event.type === 'final-review/shadow-result'
    && event.data.enforced === true
    && event.data.turn !== undefined
    && event.data.candidateSeq !== undefined
    && event.data.action !== undefined
    && event.data.action !== 'commit'
    ? { id: event.data.candidateId, role: 'start' }
    : null,
  start: (_context, match) => {
    const event = match.event
    if (event.type !== 'final-review/shadow-result'
      || event.data.turn === undefined || event.data.candidateSeq === undefined) {
      throw new Error('task-review-delivery-marker requires an identified review result')
    }
    return { seq: event.seq, turn: event.data.turn, candidateSeq: event.data.candidateSeq }
  },
  update: context => context.state,
  publication: () => 'immediate',
  buildViewNode: context => context.state === undefined ? null : {
    key: context.key, id: context.id, kind: context.kind, target: 'task-review-delivery', data: context.state,
  },
}

/** Chain match for any finalized Assistant; the component subscribes to review state itself. */
export type DeliveryReviewMatch = AssistantBodyOwnerProps & {
  readonly messageSeq: number
}

/**
 * Select finalized Assistant messages without interpreting their review status.
 * @param owner Assistant renderer currency.
 * @returns Stable finalized-message identity or null for streaming/interrupted rows.
 */
export function selectDeliveryReview(owner: AssistantBodyOwnerProps): DeliveryReviewMatch | null {
  const messageSeq = owner.node.data.finalNode?.seq
  return messageSeq === undefined ? null : { ...owner, messageSeq }
}

type DeliveryReviewProps = PropsRuntime<'conversation.chat.assistant-body'> & {
  matched: DeliveryReviewMatch
}

/**
 * Collapse an enforcing review's rejected answer while preserving full replay.
 * @param props Finalized Assistant content and the live Session selector hook.
 * @returns Original content or a closed disclosure naming its replacement state.
 */
export function DeliveryReview({ matched, useSession }: DeliveryReviewProps): ReactNode {
  const turnNumber = matched.turn?.turn
  const disposition = useSession((snapshot) => {
    if (turnNumber === undefined) return undefined
    const rejected = snapshot.views.get('task-review-delivery')?.markers.some(marker =>
      marker.turn === turnNumber && marker.candidateSeq === matched.messageSeq) ?? false
    if (!rejected) return undefined
    const replaced = snapshot.chat.nodes.values().some((node) => {
      if (node.kind !== 'assistant-step') return false
      const assistant = node.data as AssistantChatData
      return assistant.turn === turnNumber && (assistant.finalNode?.seq ?? -1) > matched.messageSeq
    })
    return replaced ? 'replaced' : 'rejected'
  })
  if (disposition === undefined) return matched.content
  return <details className={css.reviewed}>
    <summary className={css.summary}>
      {disposition === 'replaced' ? '已被修正版替代' : '审查未通过'}
    </summary>
    <div className={css.body}>{matched.content}</div>
  </details>
}

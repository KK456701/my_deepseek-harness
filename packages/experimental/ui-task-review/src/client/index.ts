/** Optional task admission views registered through the conversation extension points. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { inputReceiptDefinition, extractionFailureDefinition } from './definitions.ts'
import { InputReceiptRow, ExtractionFailureRow } from './Rows.tsx'
import { auxiliaryDefinition } from './auxiliary.ts'
import { testRecordDefinition, TestRecordRow } from './test-record.tsx'
import {
  DeliveryReview, deliveryReviewDefinition, deliveryReviewViewDefinition, selectDeliveryReview,
} from './delivery.tsx'

/** Client services owning event projection and keyed rendering. */
export const inject = ['conversationEvents', 'conversationViews', 'slots']

/**
 * Install event-derived rows without modifying model history.
 * @param ctx - Browser context carrying conversation registries.
 */
export function apply(ctx: ClientContext): void {
  ctx.conversationViews.register(deliveryReviewViewDefinition)
  ctx.conversationEvents.register(auxiliaryDefinition)
  ctx.conversationEvents.register(testRecordDefinition)
  ctx.conversationEvents.register(inputReceiptDefinition)
  ctx.conversationEvents.register(extractionFailureDefinition)
  ctx.conversationEvents.register(deliveryReviewDefinition)
  ctx.slots.inject('conversation.chat.node', function* () {
    yield ctx.slots.register({ name: 'conversation.chat.node', key: 'task-review-test' }, TestRecordRow)
    yield ctx.slots.register({ name: 'conversation.chat.node', key: 'task-input-receipt' }, InputReceiptRow)
    yield ctx.slots.register({ name: 'conversation.chat.node', key: 'task-extraction-failure' }, ExtractionFailureRow)
  })
  ctx.slots.inject('conversation.chat.assistant-body', () => ctx.slots.register({
    name: 'conversation.chat.assistant-body',
    select: selectDeliveryReview,
  }, DeliveryReview))
}

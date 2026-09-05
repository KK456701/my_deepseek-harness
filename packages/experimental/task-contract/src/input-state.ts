/** Parsed user identities derived from applied updates and auxiliary assessments. */
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

/**
 * Collect applied user inputs and validated empty changes without relying on an input receipt alone.
 * @param session Session containing the parser's durable assessments.
 * @returns Successfully reconciled real user-message identities.
 */
export function parsedInputIds(session: Session): ReadonlySet<MessageId> {
  const ids = new Set<MessageId>()
  for (const event of session.events) {
    if (event.type === 'task-contract/update' && event.data.formatVersion === 3) {
      for (const id of event.data.sourceMessageIds) ids.add(id)
    }
    if (event.type !== 'task-contract/model-assessment' || event.data.status !== 'validated') continue
    const result = event.data.result
    if (result === null || typeof result !== 'object' || Array.isArray(result)) continue
    const source = result.sourceBinding
    if (source !== null && typeof source === 'object' && !Array.isArray(source)
      && typeof source.messageId === 'string') ids.add(source.messageId as MessageId)
  }
  return ids
}

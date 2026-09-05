/** Bounded read-only lookup over an explicitly frozen Session event set. */
import { z } from 'zod'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { parseExitStatus } from '@deepseek-ai/dsh-shell'

/** Exact event returned to an auxiliary model. */
export interface FrozenSessionEvidence {
  readonly eventId: { readonly kind: 'local'; readonly seq: number }
  readonly time: number
  readonly type: string
  readonly success?: boolean
  readonly invocation?: { readonly seq: number; readonly name: string; readonly arguments: string }
  readonly content: string
}

/** Compact locator included in the auxiliary model's initial request. */
export interface FrozenSessionEvidenceIndex {
  readonly eventId: { readonly kind: 'local'; readonly seq: number }
  readonly type: string
  readonly success?: boolean
  readonly invocation?: { readonly seq: number; readonly name: string }
  readonly target?: string
}

/** Session-log tools exposed only inside one bounded auxiliary attempt. */
export const frozenSessionEvidenceTools: readonly ToolSchema[] = [{
  name: 'session_event_search',
  description: 'Search the frozen Session events authorized for this auxiliary judgment.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Text to find in the frozen events.' } },
    required: ['query'],
    additionalProperties: false,
  },
}, {
  name: 'session_event_read',
  description: 'Read an exact frozen event; tool results include their original invocation parameters. Multiple reads may be requested together.',
  parameters: {
    type: 'object',
    properties: { seq: { type: 'integer', minimum: 0, description: 'Session event sequence number.' } },
    required: ['seq'],
    additionalProperties: false,
  },
}] as const

const searchSchema = z.object({ query: z.string().min(1) }).strict()
const readSchema = z.object({ seq: z.number().int().nonnegative() }).strict()

function contentText(content: readonly ContentBlock[]): string {
  return content.map(block => block.type === 'text' ? block.text : JSON.stringify(block)).join('\n\n')
}

/**
 * Resolve the recorded outcome without confusing successful dispatch with process completion.
 * @param result Persisted tool result.
 * @param call Matching persisted invocation, if available.
 * @returns Success or failure; undefined when completion is not recorded.
 */
export function taskToolResultSuccess(
  result: Extract<SessionEvent, { type: 'tool/result' }>,
  call: Extract<SessionEvent, { type: 'tool/call' }> | undefined,
): boolean | undefined {
  if (result.data.message.content.some(block => block.isError)) return false
  if (call === undefined || call.data.callId !== result.data.message.source.callId) return undefined
  if (call.data.name !== 'bash' && call.data.name !== 'pwsh') return true
  const args: unknown = JSON.parse(call.data.arguments)
  if (args !== null && typeof args === 'object' && 'run_in_background' in args && args.run_in_background === true) {
    return undefined
  }
  const statuses = result.data.message.content.flatMap(block => block.content
    .flatMap(content => content.type === 'text' ? [parseExitStatus(content.text)] : []))
  if (statuses.length === 0) return undefined
  return statuses.every(status => 'exitCode' in status && status.exitCode === 0)
}

function resultCall(event: SessionEvent, events: readonly SessionEvent[]): Extract<SessionEvent, { type: 'tool/call' }> | undefined {
  if (event.type !== 'tool/result') return undefined
  return events.find((item): item is Extract<SessionEvent, { type: 'tool/call' }> => item.type === 'tool/call'
    && item.seq < event.seq && item.data.callId === event.data.message.source.callId)
}

function invocationTarget(call: Extract<SessionEvent, { type: 'tool/call' }> | undefined): string | undefined {
  if (call === undefined) return undefined
  let args: unknown
  try { args = JSON.parse(call.data.arguments) } catch (error: unknown) {
    // Invalid model arguments remain readable evidence, but cannot supply a target hint.
    if (error instanceof SyntaxError) return undefined
    throw error
  }
  if (args === null || typeof args !== 'object') return undefined
  const target = ['file_path', 'path', 'url', 'query', 'description', 'command']
    .map((key): unknown => Reflect.get(args, key)).find((value): value is string => typeof value === 'string' && value.length > 0)
  return target === undefined ? undefined : Array.from(target).slice(0, 120).join('')
}

/**
 * Project one persisted event into the common frozen lookup representation.
 * @param event Event admitted by the owning Reviewer or Observer.
 * @param events Frozen events containing the matching invocation.
 * @returns Exact type, content, outcome, and Session identity.
 */
export function frozenSessionEvidence(event: SessionEvent, events: readonly SessionEvent[]): FrozenSessionEvidence {
  if (event.type === 'tool/result') {
    const call = resultCall(event, events)
    const success = taskToolResultSuccess(event, call)
    return {
      eventId: { kind: 'local', seq: event.seq },
      time: event.time,
      type: event.type,
      ...(success === undefined ? {} : { success }),
      ...(call === undefined ? {} : { invocation: { seq: call.seq, name: call.data.name, arguments: call.data.arguments } }),
      content: event.data.message.content.map(block => contentText(block.content)).join('\n\n'),
    }
  }
  return {
    eventId: { kind: 'local', seq: event.seq },
    time: event.time,
    type: event.type,
    content: JSON.stringify(event.data),
  }
}

/**
 * Build one bounded locator without copying full event content into the prompt.
 * @param event Frozen event.
 * @param events Frozen events containing the matching invocation.
 * @returns Identity, outcome, and a bounded invocation target hint; never result content.
 */
export function frozenSessionEvidenceIndex(event: SessionEvent, events: readonly SessionEvent[]): FrozenSessionEvidenceIndex {
  const evidence = frozenSessionEvidence(event, events)
  const call = event.type === 'tool/call' ? event : resultCall(event, events)
  const target = invocationTarget(call)
  return {
    eventId: evidence.eventId,
    type: evidence.type,
    ...(evidence.success === undefined ? {} : { success: evidence.success }),
    ...(call === undefined ? {} : { invocation: { seq: call.seq, name: call.data.name } }),
    ...(target === undefined ? {} : { target }),
  }
}

/** Result of one bounded auxiliary lookup. */
export interface FrozenSessionEvidenceToolResult {
  readonly content: string
  readonly readEventIds: readonly number[]
}

/**
 * Execute search or read against only the caller-provided immutable event set.
 * @param events Frozen events visible to this attempt.
 * @param name Allowed query tool.
 * @param rawArguments Model-authored JSON arguments.
 * @param maxSearchResults Maximum matches returned by one search.
 * @returns JSON tool-result text and exact events read in full.
 */
export function executeFrozenSessionEvidenceTool(
  events: readonly SessionEvent[], name: string, rawArguments: string, maxSearchResults: number,
): FrozenSessionEvidenceToolResult {
  if (!Number.isSafeInteger(maxSearchResults) || maxSearchResults < 1) {
    throw new Error('maxSearchResults must be a positive safe integer')
  }
  if (name === 'session_event_search') {
    const { query } = searchSchema.parse(JSON.parse(rawArguments))
    const needle = query.toLocaleLowerCase()
    const matches = events.flatMap((event) => {
      const evidence = frozenSessionEvidence(event, events)
      const index = evidence.content.toLocaleLowerCase().indexOf(needle)
      if (index < 0) return []
      const start = Math.max(0, index - 120)
      const snippet = Array.from(evidence.content.slice(start)).slice(0, 360).join('')
      return [{ eventId: evidence.eventId, type: evidence.type,
        ...(evidence.invocation === undefined ? {} : {
          invocation: { seq: evidence.invocation.seq, name: evidence.invocation.name },
        }),
        ...(evidence.success === undefined ? {} : { success: evidence.success }), snippet }]
    }).slice(0, maxSearchResults)
    return { content: JSON.stringify({ matches }), readEventIds: [] }
  }
  if (name === 'session_event_read') {
    const { seq } = readSchema.parse(JSON.parse(rawArguments))
    const event = new Map(events.map(item => [item.seq, item])).get(seq)
    if (event === undefined) throw new Error(`event ${seq} is outside the frozen Session event set`)
    return { content: JSON.stringify({ event: frozenSessionEvidence(event, events) }), readEventIds: [seq] }
  }
  throw new Error(`unsupported frozen Session evidence tool: ${name}`)
}

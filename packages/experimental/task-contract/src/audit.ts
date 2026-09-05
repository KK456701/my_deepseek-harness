/** Reconstructable request records for experimental task-review calls. */

import type { Context } from '@deepseek-ai/cordis'
import { deepFreeze, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue, type AuditedLlmCallId, type JsonValue, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AuxiliaryRequestMetadata } from './model-input.ts'
import { ExtractionCapture } from './extraction-capture.ts'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ExtractionResponseStats } from './types.ts'

const MAX_AUDIT_DELTA_PARTS = 64
const MAX_AUDIT_DELTA_BYTES = 4_096

/** Coalesce adjacent provider deltas before they enter a durable audit or staging log. */
export class StreamChunkBatcher {
  private pending: StreamChunk | undefined
  private parts = 0

  /**
   * Accept one provider chunk.
   * @param chunk Next chunk in provider order.
   * @returns Complete coalesced chunks ready for durable append.
   */
  push(chunk: StreamChunk): StreamChunk[] {
    const merged = this.pending === undefined ? undefined : mergeDelta(this.pending, chunk)
    if (merged !== undefined) {
      this.pending = merged
      this.parts += 1
      if (this.parts < MAX_AUDIT_DELTA_PARTS && chunkBytes(merged) < MAX_AUDIT_DELTA_BYTES) return []
      return this.flush()
    }
    const ready = this.flush()
    if (isDelta(chunk)) {
      this.pending = chunk
      this.parts = 1
      return ready
    }
    return [...ready, chunk]
  }

  /**
   * Finish the current delta batch.
   * @returns Any pending delta as one final durable chunk.
   */
  flush(): StreamChunk[] {
    if (this.pending === undefined) return []
    const chunk = this.pending
    this.pending = undefined
    this.parts = 0
    return [chunk]
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Exact prepared auxiliary request; separate from the Worker's request/header. */
    'task-contract/model-request': {
      formatVersion: 1
      callId: AuditedLlmCallId
      request: JsonValue
      metadata?: AuxiliaryRequestMetadata
    }
    /** Marks entry into the prepared stream, not merely prompt preparation. */
    'task-contract/model-dispatch': { callId: AuditedLlmCallId }
    /** Actual provider output in stream order, excluded from Worker message history. */
    'task-contract/model-chunk': { callId: AuditedLlmCallId; chunk: StreamChunk }
    /** Prepared requests cancelled or rejected before entering the provider stream. */
    'task-contract/model-not-dispatched': { callId: AuditedLlmCallId; error: string }
    /** Runtime decision after validation, distinct from model-authored output. */
    'task-contract/model-application': { callId: AuditedLlmCallId; eventSeq: number; eventType: string; decision: JsonValue }
    /** Consumer validation is independent from successful model transport. */
    'task-contract/model-assessment': {
      callId: AuditedLlmCallId
      status: 'validated' | 'failed' | 'stale'
      result?: JsonValue
      error?: string
    }
    /** Retains the actual auxiliary stream independently of downstream JSON validation. */
    'task-contract/model-response': {
      callId: AuditedLlmCallId
      rawOutput: ContentBlock[]
      usage?: TokenUsage
      response: ExtractionResponseStats
    }
  }
}

/**
 * Freeze and checkpoint an auxiliary request before its registration-bound dispatch.
 * @param ctx - consumer context carrying LLM and Session services.
 * @param session - live interactive Session that owns the request record.
 * @param callId - identity shared with the result's usage record.
 * @param options - complete request, including cancellation and the provider route.
 * @param metadata - Template and projection identity for new auxiliary requests.
 * @param assertCurrent - Recheck queued judgment authority immediately before dispatch.
 * @returns provider-neutral chunks from the audited dispatch.
 */
export async function* auditedReviewStream(
  ctx: Context,
  session: Session,
  callId: AuditedLlmCallId,
  options: GenerateOptions,
  metadata?: AuxiliaryRequestMetadata,
  assertCurrent?: () => void,
): AsyncGenerator<StreamChunk> {
  options.signal?.throwIfAborted()
  assertCurrent?.()
  const prepared = await ctx.llm.prepareCall({
    provider: options.provider,
    model: options.model,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
  }, options.signal)
  const { signal, ...input } = options
  const request = deepFreeze({ ...structuredClone(input), ...prepared.config, audit: { callId, attempt: metadata?.attempt ?? 1 } })
  const audit = snapshotJsonValue({
    input: request,
    adapterDefaults: prepared.adapterDefaults,
    retryPolicy: prepared.retryPolicy,
    ...(prepared.context === undefined ? {} : { context: prepared.context }),
  })
  if (audit === undefined) throw new Error('task review request is not losslessly JSON serializable')
  session.append('task-contract/model-request', {
    formatVersion: 1,
    callId,
    // The durable JSON parser above validates interfaces without index signatures.
    request: audit as unknown as JsonValue,
    ...(metadata === undefined ? {} : { metadata }),
  })
  try {
    await ctx.sessions.flush(session)
    signal?.throwIfAborted()
    assertCurrent?.()
  } catch (error: unknown) {
    session.append('task-contract/model-not-dispatched', { callId, error: String(error) })
    throw error
  }
  const capture = new ExtractionCapture()
  const auditChunks = new StreamChunkBatcher()
  let failed = false
  session.append('task-contract/model-dispatch', { callId })
  try {
    for await (const chunk of prepared.stream({ ...request, ...(signal === undefined ? {} : { signal }) })) {
      capture.push(chunk)
      for (const audited of auditChunks.push(chunk)) session.append('task-contract/model-chunk', { callId, chunk: audited })
      yield chunk
    }
  } catch (error: unknown) { failed = true; throw error } finally {
    for (const audited of auditChunks.flush()) session.append('task-contract/model-chunk', { callId, chunk: audited })
    const usage = capture.assembler.usage
    const timedOut = signal?.aborted === true && signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
    if (timedOut) capture.timeoutSignal = signal
    const terminal = capture.assembler.finish.kind
    const completed = terminal === 'stop' || terminal === 'tool-calls'
    const response = capture.stats(signal?.aborted === true && !timedOut, failed || !completed)
    session.append('task-contract/model-response', { callId,
      rawOutput: completed ? capture.assembler.blocks() : capture.assembler.interruptedBlocks(),
      response, ...(usage === undefined ? {} : { usage }) })
    session.append('llm/audited-call', { callId, purpose: options.purpose ?? 'auxiliary-review',
      provider: request.provider, model: request.model, durationMs: response.durationMs,
      ...(usage === undefined ? {} : { usage }) })
  }
}

function isDelta(chunk: StreamChunk): chunk is Extract<StreamChunk,
  { type: 'text-delta' | 'reasoning-delta' | 'tool-call-delta' }> {
  return chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta'
}

function mergeDelta(left: StreamChunk, right: StreamChunk): StreamChunk | undefined {
  if (left.type === 'text-delta' && right.type === 'text-delta' && left.index === right.index) {
    return { ...left, text: left.text + right.text }
  }
  if (left.type === 'reasoning-delta' && right.type === 'reasoning-delta' && left.index === right.index) {
    return { ...left, text: left.text + right.text }
  }
  if (left.type === 'tool-call-delta' && right.type === 'tool-call-delta'
    && left.index === right.index && left.id === right.id
    && (right.name === undefined || left.name === undefined || left.name === right.name)) {
    return { ...left, ...(left.name === undefined && right.name !== undefined ? { name: right.name } : {}),
      argumentsDelta: left.argumentsDelta + right.argumentsDelta }
  }
  return undefined
}

function chunkBytes(chunk: StreamChunk): number {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return Buffer.byteLength(chunk.text)
    case 'tool-call-delta':
      return Buffer.byteLength(chunk.argumentsDelta)
    default:
      return 0
  }
}

/**
 * Retain the consumer's validated judgment or rejection without inventing model output.
 * @param session - Session owning the audited dispatch.
 * @param callId - Exact dispatch identity, including its retry attempt.
 * @param outcome - Consumer validation result; validation does not itself commit a task.
 */
export function recordAuxiliaryAssessment(session: Session, callId: AuditedLlmCallId,
  outcome: { status: 'validated' | 'failed' | 'stale'; result?: unknown; error?: string }): void {
  const result = outcome.result === undefined ? undefined : snapshotJsonValue(outcome.result)
  if (outcome.result !== undefined && result === undefined) throw new Error('auxiliary assessment is not JSON serializable')
  session.append('task-contract/model-assessment', { callId, status: outcome.status,
    ...(result === undefined ? {} : { result: result as JsonValue }), ...(outcome.error === undefined ? {} : { error: outcome.error }) })
}

/**
 * Associate a persisted runtime decision with the exact model attempt.
 * @param session - Decision owner.
 * @param callId - Exact attempt.
 * @param event - Persisted runtime decision.
 */
export function recordAuxiliaryApplication(session: Session, callId: AuditedLlmCallId, event: SessionEvent): void {
  const decision = snapshotJsonValue(event.data)
  if (decision === undefined) throw new Error('auxiliary application is not JSON serializable')
  session.append('task-contract/model-application', { callId, eventSeq: event.seq, eventType: event.type, decision: decision as JsonValue })
}

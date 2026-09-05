/** Phase 1 evidence projection, audited dispatch, and strict output validation. @module @deepseek-ai/dsh-memory-scheduler/phase1 */

import { BlockAssembler, createUserMessage, deepFreeze, errorChain, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage, foldSurface, snapshotJsonValue, type JsonValue, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  MemoryCandidateId,
  MemoryEvidenceId,
  type MemoryCandidate,
  type MemoryEvidenceItem,
  type Phase1Claim,
  type RecordedPhase1Result,
} from '@deepseek-ai/dsh-memory-pipeline-store'
import { MEMORY_EXTRACTION_TEMPLATE_VERSION, redactMemoryText, redactMemoryJson as redactJsonValue } from '@deepseek-ai/dsh-memory'
import type { Context } from '@deepseek-ai/cordis'
import { PHASE1_SYSTEM_PROMPT } from './templates.ts'
import { codexPhase1 } from './structured-phase1.ts'

/** Phase 1 model and payload limits resolved by the scheduler. */
export interface Phase1Config {
  readonly backend: 'llm' | 'codex'
  readonly reasoningEffort: string
  readonly provider: string
  readonly model: string
  readonly maxTokens: number
  readonly maxEvidenceBytes: number
  readonly maxResultBytes: number
  readonly maxCandidates: number
  readonly disableOnExternalContext: boolean
  readonly externalToolPrefixes: readonly string[]
  readonly policyVersion: number
}

function contentText(event: SessionEvent): string | undefined {
  const message = deriveEventMessage(event)
  if (message === null) return undefined
  if (event.type === 'user/message' && message.source.kind !== 'user') return undefined
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
  }
  const text = parts.join('\n').trim()
  return text.length === 0 ? undefined : text
}

/**
 * Replace high-confidence secret assignments and PEM private keys before audit.
 * @param text - Untrusted evidence text.
 * @returns Deterministically redacted text.
 */
export function redactMemoryEvidence(text: string): string {
  return redactMemoryText(text)
}

/**
 * Test whether the frozen range observed an external-context tool call.
 * @param events - Effective events inside the frozen source range.
 * @param prefixes - Tool-name prefixes classified as external context.
 * @returns Whether any persisted call matches the configured classification.
 */
export function rangeHasExternalContext(events: readonly SessionEvent[], prefixes: readonly string[]): boolean {
  return events.some(event => event.type === 'tool/call' && prefixes.some(prefix => event.data.name === prefix || event.data.name.startsWith(`${prefix}.`) || event.data.name.startsWith(`${prefix}_`)))
}

/**
 * Project the effective message surface into deterministic evidence items.
 * @param claim - Claimed sequence range and deterministic job identity.
 * @param events - Validated Session events containing the effective surface.
 * @param maxBytes - Maximum combined UTF-8 evidence body size.
 * @param externalToolPrefixes - Persisted tool-name classification for external evidence.
 * @returns Ordered evidence items whose ids are derived from the frozen snapshot.
 */
export function projectEvidence(
  claim: Phase1Claim,
  events: readonly SessionEvent[],
  maxBytes: number,
  externalToolPrefixes: readonly string[],
): MemoryEvidenceItem[] {
  const frozen = events.filter(event => event.seq <= claim.toSeq)
  const bySeq = new Map(frozen.map(event => [event.seq, event]))
  const calls = new Map(frozen
    .filter((event): event is SessionEvent<'tool/call'> => event.type === 'tool/call')
    .map(event => [event.data.callId, event]))
  const nodes = foldSurface(frozen).nodes.filter(seq => seq >= claim.fromSeq && seq <= claim.toSeq)
  const items: MemoryEvidenceItem[] = []
  let bytes = 0
  for (const seq of nodes) {
    const event = bySeq.get(seq)
    if (event === undefined) throw new Error(`memory evidence surface lost event ${seq}`)
    let text = contentText(event)
    let sourceEventSeqs = [event.seq, ...('sourceEventSeqs' in event ? event.sourceEventSeqs ?? [] : [])]
    let kind: MemoryEvidenceItem['kind'] = event.type === 'user/message' ? 'user' : 'assistant'
    let trust: MemoryEvidenceItem['trust'] = 'eligible-local-untrusted'
    if (event.type === 'tool/result') {
      const call = calls.get(event.data.message.source.callId)
      if (call === undefined || call.seq < claim.fromSeq || call.seq > claim.toSeq) continue
      const result = event.data.message.content[0]
      const resultText = result.content
        .flatMap(block => block.type === 'text' ? [block.text] : [])
        .join('\n')
        .trim()
      text = [`Tool: ${call.data.name}`, `Arguments: ${call.data.arguments}`, `Result${result.isError ? ' (error)' : ''}:`, resultText]
        .filter(part => part.length > 0)
        .join('\n')
      sourceEventSeqs = [call.seq, event.seq, ...event.sourceEventSeqs ?? []]
      kind = 'tool-result'
      if (rangeHasExternalContext([call], externalToolPrefixes)) trust = 'external-untrusted'
    }
    if (text === undefined) continue
    const redacted = redactMemoryEvidence(text)
    const nextBytes = Buffer.byteLength(redacted, 'utf8')
    if (bytes + nextBytes > maxBytes) break
    items.push({
      evidenceId: MemoryEvidenceId(`${claim.sourceRangeId}:${items.length}`),
      sourceEventSeqs,
      kind,
      text: redacted,
      trust,
    })
    bytes += nextBytes
  }
  return items
}

function extractionTool(): NonNullable<GenerateOptions['tools']>[number] {
  return {
    name: 'submit_memory_rollout',
    description: 'Submit task-first evidence for the complete rollout, or useful=false when it has no durable value.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['useful', 'rawMemory', 'rolloutSummary', 'rolloutSlug', 'evidenceIds'],
      properties: {
        useful: { type: 'boolean' },
        rawMemory: { type: 'string' },
        rolloutSummary: { type: 'string' },
        rolloutSlug: { type: 'string' },
        evidenceIds: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
    },
  }
}

interface RolloutOutput {
  useful: unknown
  rawMemory: unknown
  rolloutSummary: unknown
  rolloutSlug: unknown
  evidenceIds: unknown
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

/**
 * Validate one structured extraction result and normalize an explicit no-op.
 * @param claim - Owned source range.
 * @param blocks - Provider-neutral final message blocks.
 * @param allowedEvidence - Frozen evidence ids the model may reference.
 * @returns Validated candidates, or an empty no-op.
 */
export function parsePhase1Candidates(claim: Phase1Claim, blocks: ReturnType<BlockAssembler['blocks']>, allowedEvidence: ReadonlySet<string>): MemoryCandidate[] {
  const calls = blocks.filter(block => block.type === 'tool-call')
  const other = blocks.filter(block => block.type !== 'tool-call' && !(block.type === 'text' && block.text.trim().length === 0) && block.type !== 'reasoning')
  if (calls.length !== 1 || other.length !== 0 || calls[0]?.name !== 'submit_memory_rollout') throw new Error('Phase 1 must return exactly one submit_memory_rollout call')
  let parsed: unknown
  try { parsed = JSON.parse(calls[0].arguments) } catch (error: unknown) { throw new Error('Phase 1 tool arguments are not JSON', { cause: error }) }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
    || !exactKeys(parsed as Record<string, unknown>, ['useful', 'rawMemory', 'rolloutSummary', 'rolloutSlug', 'evidenceIds'])) {
    throw new Error('Phase 1 tool arguments have unknown or missing keys')
  }
  const output = parsed as RolloutOutput
  if (typeof output.useful !== 'boolean'
    || typeof output.rawMemory !== 'string'
    || typeof output.rolloutSummary !== 'string'
    || typeof output.rolloutSlug !== 'string'
    || !Array.isArray(output.evidenceIds)
    || output.evidenceIds.some(value => typeof value !== 'string' || !allowedEvidence.has(value))) {
    throw new Error('Phase 1 rollout output is invalid')
  }
  if (!output.useful) return []
  if (output.rawMemory.trim().length === 0 || output.rolloutSummary.trim().length === 0 || output.evidenceIds.length === 0) {
    throw new Error('a useful Phase 1 rollout is incomplete')
  }
  const rawMemory = redactMemoryText(output.rawMemory).trim()
  const rolloutSummary = redactMemoryText(output.rolloutSummary).trim()
  const rolloutSlug = redactMemoryText(output.rolloutSlug).trim()
  if (!rawMemory.startsWith('# Rollout context') || !/\n## Task 1(?::|\s)/u.test(rawMemory)) {
    throw new Error('Phase 1 rawMemory must use the multi-task rollout schema')
  }
  return [{
    candidateId: MemoryCandidateId(`${claim.jobId}:0`),
    rawMemory,
    rolloutSummary,
    ...rolloutSlug.length === 0 ? {} : { rolloutSlug },
    evidenceIds: output.evidenceIds.map(value => MemoryEvidenceId(value as string)),
  }]
}

/**
 * Dispatch one already-claimed Phase 1 call with durable request/result ordering.
 * @param ctx - Scheduler context carrying the LLM and pipeline Store services.
 * @param claim - Durable claimed source range.
 * @param events - Validated Session events used to build the frozen projection.
 * @param config - Resolved extraction model, limits, and evidence policy.
 * @param signal - Cancellation signal bounded by the active lease.
 * @returns Strictly validated candidates, or an empty list for ineligible evidence.
 */
export async function runPhase1(
  ctx: Context,
  claim: Phase1Claim,
  events: readonly SessionEvent[],
  config: Phase1Config,
  signal: AbortSignal,
): Promise<MemoryCandidate[]> {
  const range = events.filter(event => event.seq >= claim.fromSeq && event.seq <= claim.toSeq)
  if (config.disableOnExternalContext && rangeHasExternalContext(range, config.externalToolPrefixes)) return []
  const evidence = projectEvidence(claim, events, config.maxEvidenceBytes, config.externalToolPrefixes)
  if (evidence.length === 0) return []
  if (config.backend === 'codex') return codexPhase1(ctx, claim, evidence, config, signal)
  const attempt = await ctx.memoryPipelineStore.beginPhase1Attempt(claim)
  const prepared = await ctx.llm.prepareCall({ provider: config.provider, model: config.model, maxTokens: config.maxTokens }, signal)
  const requestWithoutSignal: GenerateOptions = {
    ...prepared.config,
    messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify({ policyVersion: config.policyVersion, templateVersion: MEMORY_EXTRACTION_TEMPLATE_VERSION, evidence }) }], source: { kind: 'plugin', plugin: 'dsh-memory-scheduler', form: 'recall' } })],
    system: PHASE1_SYSTEM_PROMPT,
    tools: [extractionTool()],
    purpose: 'memory-extraction',
  }
  const requestJson = snapshotJsonValue(requestWithoutSignal)
  if (requestJson === undefined) throw new Error('Phase 1 request is not lossless JSON')
  const requestBytes = Buffer.byteLength(JSON.stringify(requestJson), 'utf8')
  await ctx.memoryPipelineStore.recordPhase1Request({
    attemptId: attempt.attemptId,
    outputFormatVersion: 2,
    requestFingerprint: claim.inputFingerprint,
    request: requestJson as unknown as JsonValue,
    bytes: requestBytes,
    recordedAt: Date.now(),
  })
  const assembler = new BlockAssembler()
  const chunks: JsonValue[] = []
  let resultBytes = 2
  let observedChunks = 0
  let observedBytes = 2
  let termination: RecordedPhase1Result['termination'] = 'complete'
  const dispatch = new AbortController()
  const dispatchSignal = AbortSignal.any([signal, dispatch.signal])
  try {
    for await (const chunk of prepared.stream(deepFreeze({ ...requestWithoutSignal, signal: dispatchSignal }))) {
      const frozen = snapshotJsonValue(chunk)
      if (frozen === undefined) throw new Error('Phase 1 provider chunk is not lossless JSON')
      const chunkBytes = Buffer.byteLength(JSON.stringify(frozen), 'utf8') + (chunks.length === 0 ? 0 : 1)
      observedChunks += 1
      observedBytes += chunkBytes
      if (resultBytes + chunkBytes > config.maxResultBytes) {
        termination = 'result-overflow'
        dispatch.abort(new Error('Phase 1 result overflow'))
        break
      }
      assembler.push(chunk)
      chunks.push(redactJsonValue(frozen as JsonValue))
      resultBytes += chunkBytes
    }
    if (assembler.finish.kind === 'error') termination = 'provider-error'
    else if (assembler.finish.kind === 'aborted') termination = signal.aborted ? 'cancelled' : 'timeout'
  } catch (error: unknown) {
    if (termination !== 'result-overflow') {
      termination = signal.aborted ? 'cancelled' : 'provider-error'
      chunks.push({ type: 'scheduler-error', message: errorChain(error) })
    }
  }
  let result = { chunks, observedChunks, observedBytes, termination, finish: assembler.finish, usage: assembler.usage ?? null }
  let resultJson = snapshotJsonValue(result)
  if (resultJson === undefined) throw new Error('Phase 1 observed result is not lossless JSON')
  let exactResultBytes = Buffer.byteLength(JSON.stringify(resultJson), 'utf8')
  while (exactResultBytes > config.maxResultBytes && chunks.length > 0) {
    chunks.pop()
    result = { ...result, chunks }
    resultJson = snapshotJsonValue(result)
    if (resultJson === undefined) throw new Error('Phase 1 observed result is not lossless JSON')
    exactResultBytes = Buffer.byteLength(JSON.stringify(resultJson), 'utf8')
  }
  if (exactResultBytes > config.maxResultBytes) throw new Error('Phase 1 result overflow metadata exceeds the audit limit')
  await ctx.memoryPipelineStore.recordPhase1Result({
    attemptId: attempt.attemptId,
    result: resultJson as JsonValue,
    bytes: exactResultBytes,
    chunkCount: chunks.length,
    termination,
    recordedAt: Date.now(),
  })
  if (termination !== 'complete' || assembler.finish.kind !== 'tool-calls') throw new Error(`Phase 1 model call ended as ${termination}/${assembler.finish.kind}`)
  return parsePhase1Candidates(claim, assembler.blocks(), new Set(evidence.map(item => item.evidenceId)))
}

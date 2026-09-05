/** Structured extraction validation and deterministic evidence rendering. @module @deepseek-ai/dsh-memory-scheduler/structured-phase1 */
import type { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { MEMORY_EXTRACTION_TEMPLATE_VERSION, redactMemoryText, redactMemoryJson } from '@deepseek-ai/dsh-memory'
import { MemoryCandidateId, MemoryEvidenceId, STAGE_ONE_SCHEMA, LEGACY_STAGE_ONE_SCHEMA, type MemoryCandidate, type MemoryEvidenceItem, type Phase1Claim, type StageOneResult } from '@deepseek-ai/dsh-memory-pipeline-store'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { Phase1Config } from './phase1.ts'
import { STRUCTURED_PHASE1_PROMPT } from './templates.ts'

/**
 * Validate task evidence before producing backend-owned Markdown.
 * @param value - Untrusted model JSON.
 * @param claim - Frozen range.
 * @param evidence - Allowed evidence and roles.
 * @param outputFormatVersion - Version recorded with the audited request; never inferred from model output.
 * @returns Redacted candidates or an empty result.
 */
export function structuredCandidates(
  value: unknown, claim: Phase1Claim, evidence: readonly MemoryEvidenceItem[], outputFormatVersion: 1 | 2 = 2,
): MemoryCandidate[] {
  const errors = validateJsonSchemaValue(outputFormatVersion === 1 ? LEGACY_STAGE_ONE_SCHEMA : STAGE_ONE_SCHEMA, value)
  if (errors.length) throw new Error(`invalid-model-output: ${errors.join('; ')}`)
  const result = value as StageOneResult
  if (result.useful !== (result.tasks.length > 0)) throw new Error('invalid-model-output: useful/tasks disagree')
  const allowed = new Map(evidence.map(item => [String(item.evidenceId), item.kind]))
  const all = new Set<string>()
  const check = (ids: string[], kind?: MemoryEvidenceItem['kind']): void => {
    if (new Set(ids).size !== ids.length) throw new Error('invalid-model-output: duplicate EvidenceId')
    if (ids.some(id => !allowed.has(id))) throw new Error('invalid-model-output: unknown EvidenceId')
    if (kind && !ids.some(id => allowed.get(id) === kind)) throw new Error(`invalid-model-output: missing ${kind} evidence`)
    ids.forEach(id => all.add(id))
  }
  for (const task of result.tasks) {
    check(task.evidenceIds)
    if (![task.preferenceSignals, task.verifiedFacts, task.reusableProcedures, task.failuresAndCorrections].some(items => items.length)) {
      throw new Error('invalid-model-output: task has no meaningful signal')
    }
    task.preferenceSignals.forEach((item) =>{  check(item.evidenceIds, 'user') })
    task.verifiedFacts.forEach((item) =>{  check(item.evidenceIds, 'tool-result') })
    task.reusableProcedures.forEach((item) =>{  check(item.evidenceIds) })
    task.failuresAndCorrections.forEach((item) =>{  check(item.evidenceIds) })
  }
  if (!result.useful) {
    if (outputFormatVersion === 2 && (result.rolloutSummary !== '' || result.rolloutSlug !== '')) throw new Error('invalid-model-output: empty extraction has content')
    return []
  }
  if (outputFormatVersion === 2 && result.rolloutSummary.trim().length === 0) throw new Error('invalid-model-output: missing rollout summary')
  const tasks = result.tasks.map((task, index) => [
    `## Task ${index + 1}: ${task.title}`, `outcome: ${task.outcome}`, `scope: ${task.scope}`,
    '### User intent', task.userIntent,
    '### Preference signals', ...task.preferenceSignals.map(item => `- ${JSON.stringify(item)}`),
    '### Verified facts', ...task.verifiedFacts.map(item => `- ${JSON.stringify(item)}`),
    '### Reusable procedures', ...task.reusableProcedures.map(item => `- ${JSON.stringify(item)}`),
    '### Failures and corrections', ...task.failuresAndCorrections.map(item => `- ${JSON.stringify(item)}`),
    `Evidence: ${task.evidenceIds.join(', ')}`,
  ].join('\n')).join('\n\n')
  const rawMemory = redactMemoryText(`# Rollout context\nsource: ${claim.sourceRangeId}\nsession: ${claim.sessionId}\n\n${tasks}`)
  return [{ candidateId: MemoryCandidateId(`${claim.jobId}:0`), rawMemory,
    rolloutSummary: outputFormatVersion === 1 ? rawMemory : redactMemoryText(result.rolloutSummary),
    ...outputFormatVersion === 2 && result.rolloutSlug.trim() !== '' ? { rolloutSlug: redactMemoryText(result.rolloutSlug.trim()) } : {},
    evidenceIds: [...all].map(MemoryEvidenceId) }]
}

/**
 * Run audited Codex extraction.
 * @param ctx - Runner and Store services.
 * @param claim - Current owner.
 * @param evidence - Redacted frozen input.
 * @param config - Resolved settings.
 * @param signal - Lease-bound cancellation.
 * @returns Validated candidates.
 */
export async function codexPhase1(
  ctx: Context, claim: Phase1Claim, evidence: readonly MemoryEvidenceItem[], config: Phase1Config, signal: AbortSignal,
): Promise<MemoryCandidate[]> {
  const attempt = await ctx.memoryPipelineStore.beginPhase1Attempt(claim)
  const runner = ctx.get('codexStructuredRunner')
  if (!runner) throw new Error('Codex memory backend requires the codexStructuredRunner provider')
  const prepared = await runner.prepareCall({
    purpose: 'memory-phase1', model: config.model, reasoningEffort: config.reasoningEffort,
    prompt: `${STRUCTURED_PHASE1_PROMPT}\n\n${JSON.stringify({ policyVersion: config.policyVersion, templateVersion: MEMORY_EXTRACTION_TEMPLATE_VERSION, evidence })}`,
    outputSchema: STAGE_ONE_SCHEMA, maxResultBytes: config.maxResultBytes,
  }, signal)
  try {
    await ctx.memoryPipelineStore.recordPhase1Request({
      attemptId: attempt.attemptId, outputFormatVersion: 2, requestFingerprint: claim.inputFingerprint, request: prepared.exactRequest,
      bytes: Buffer.byteLength(JSON.stringify(prepared.exactRequest)), recordedAt: Date.now(),
    })
    const result = await prepared.dispatch(signal)
    const redacted = redactMemoryJson(result as unknown as JsonValue)
    await ctx.memoryPipelineStore.recordPhase1Result({
      attemptId: attempt.attemptId, result: redacted, bytes: Buffer.byteLength(JSON.stringify(redacted)), chunkCount: 1,
      termination: result.finishReason === 'completed' ? 'complete' : result.finishReason === 'result-overflow' ? 'result-overflow' : result.finishReason === 'cancelled' ? 'cancelled' : 'provider-error', recordedAt: Date.now(),
    })
    if (result.finishReason !== 'completed') throw new Error(`${result.finishReason}: ${result.error}`)
    return structuredCandidates((redacted as Record<string, JsonValue>).value, claim, evidence)
  } finally { await prepared.dispose() }
}

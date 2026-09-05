/** Audited tool-free consolidation Consumer. @module @deepseek-ai/dsh-memory-scheduler/structured-phase2 */
import type { Context } from '@deepseek-ai/cordis'
import { CONSOLIDATION_SCHEMA, type Phase2Claim, type Phase2Workspace, type MemoryAttemptId } from '@deepseek-ai/dsh-memory-pipeline-store'
import { MEMORY_TEMPLATE_VERSION, redactMemoryJson, type MemoryRuntimeSettingsValues } from '@deepseek-ai/dsh-memory'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { STRUCTURED_PHASE2_PROMPT } from './templates.ts'

/**
 * Run one frozen consolidation without exposing filesystem tools.
 * @param ctx - Runner and Store services.
 * @param claim - Owned batch.
 * @param settings - Frozen runtime settings.
 * @param signal - Cancellation and timeout.
 * @returns Workspace and completed structured audit handle.
 */
export async function codexPhase2(
  ctx: Context, claim: Phase2Claim, settings: MemoryRuntimeSettingsValues, signal: AbortSignal,
): Promise<{ workspace: Phase2Workspace; structuredAttemptId: MemoryAttemptId }> {
  const store = ctx.memoryPipelineStore
  const workspace = await store.createPhase2Workspace(claim)
  const input = await store.readConsolidationInput(claim, workspace)
  const runner = ctx.get('codexStructuredRunner')
  if (!runner) throw new Error('Codex memory backend requires the codexStructuredRunner provider')
  const prepared = await runner.prepareCall({
    purpose: 'memory-phase2', model: settings.consolidationModel, reasoningEffort: settings.consolidationReasoningEffort,
    outputSchema: CONSOLIDATION_SCHEMA, maxResultBytes: settings.maxResultBytes,
    prompt: `${STRUCTURED_PHASE2_PROMPT}\n\n${JSON.stringify({
      policyVersion: settings.policyVersion, templateVersion: MEMORY_TEMPLATE_VERSION,
      summaryMaxBytes: settings.promptSummaryMaxBytes, skillMinSupportingTasks: settings.skillMinSupportingTasks,
      sourceSelectionDiff: claim.sourceSelectionDiff, ...input,
    })}`,
  }, signal)
  try {
    const structuredAttemptId = await store.recordPhase2Request({
      claim, request: prepared.exactRequest, bytes: Buffer.byteLength(JSON.stringify(prepared.exactRequest)),
    })
    const result = await prepared.dispatch(signal)
    const redacted = redactMemoryJson(result as unknown as JsonValue)
    await store.recordPhase2Result({ claim, attemptId: structuredAttemptId, result: redacted, bytes: Buffer.byteLength(JSON.stringify(redacted)), completed: result.finishReason === 'completed' })
    if (result.finishReason !== 'completed') throw new Error(`${result.finishReason}: ${result.error}`)
    await store.applyConsolidationResult(claim, workspace, structuredAttemptId)
    return { workspace, structuredAttemptId }
  } finally { await prepared.dispose() }
}

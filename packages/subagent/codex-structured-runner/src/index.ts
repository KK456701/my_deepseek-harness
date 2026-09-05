/** Auditable one-shot Codex JSON calls. @module @deepseek-ai/dsh-codex-structured-runner */
import { Context, Service } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'

/** Inputs frozen before dispatch; output is independently validated by the consumer. */
export interface CodexStructuredCallRequest {
  readonly purpose: 'memory-phase1' | 'memory-phase2'
  readonly model: string
  readonly reasoningEffort: string
  readonly prompt: string
  readonly outputSchema: Record<string, JsonValue>
  readonly maxResultBytes: number
}

/** Final observed JSON or a bounded failure, without reasoning or tool payloads. */
export interface CodexStructuredResult {
  readonly value: JsonValue | null
  readonly finishReason: 'completed' | 'failed' | 'cancelled' | 'result-overflow' | 'unexpected-tool-use'
  readonly usage: JsonValue | null
  readonly error: string | null
}

/** A single-use prepared call; disposing before dispatch releases its empty directory. */
export interface PreparedCodexStructuredCall {
  readonly exactRequest: JsonValue
  dispatch(signal: AbortSignal): Promise<CodexStructuredResult>
  dispose(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context { codexStructuredRunner: CodexStructuredRunner }
}

/** Private capability whose consumer owns durable request/result auditing. */
export abstract class CodexStructuredRunner extends Service {
  constructor(ctx: Context) {
    if (new.target === CodexStructuredRunner) throw new Error('Load a CodexStructuredRunner provider')
    super(ctx, 'codexStructuredRunner')
  }

  /**
   * Freeze per-call settings without dispatching a provider request.
   * @param request - Model, reasoning, prompt, schema, and result bound.
   * @param callerSignal - Cancellation covering local configuration resolution and dispatch preparation.
   * @returns Owned single-use call; the caller must dispose it in finally.
   */
  abstract prepareCall(request: CodexStructuredCallRequest, callerSignal: AbortSignal): Promise<PreparedCodexStructuredCall>
}

export default CodexStructuredRunner

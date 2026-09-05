/** Shared live/replay policy for trusted active-job polling. */

import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from './index.ts'

/**
 * Recognize polling only from trusted registration and a successful target-bound result.
 * @param tool Registered implementation, not a model-authored policy.
 * @param args Original target arguments.
 * @param result Durable result status and tool-owned metadata.
 * @returns Whether exact-repeat detection should ignore this active observation.
 */
export function isActivePollingResult(tool: ToolDefinition | undefined, args: unknown,
  result: { readonly isError?: boolean; readonly meta?: JsonValue }): boolean {
  return result.isError !== true && tool?.repeatPolicy === 'polling'
    && tool.activePollingResult?.(args, result.meta) === true
}

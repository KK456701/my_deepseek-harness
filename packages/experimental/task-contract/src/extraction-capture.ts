/** Attempt-owned response evidence, retained even when extraction rejects. */
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ExtractionResponseStats } from './types.ts'

/** Collects provider output independently of parsing and task-state admission. */
export class ExtractionCapture {
  /** Provider chunks assembled before semantic validation. */
  readonly assembler = new BlockAssembler()
  /** Capture start, used for duration and first-output measurements. */
  readonly startedAt = Date.now()
  /** Attempt deadline, separate from user cancellation. */
  timeoutSignal: AbortSignal | undefined
  private firstOutputMs: number | undefined
  private lastOutputMs: number | undefined
  private firstTextMs: number | undefined
  private firstReasoningMs: number | undefined
  private outputChunks = 0
  private finishReason: ExtractionResponseStats['finishReason']

  /**
   * Retain a received chunk before any response validation.
   * @param chunk - Provider-normalized stream chunk.
   */
  push(chunk: StreamChunk): void {
    this.assembler.push(chunk)
    if (chunk.type === 'finish') this.finishReason = chunk.reason.kind
    if (((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text.length > 0)
      || (chunk.type === 'block-end' && (chunk.block.type === 'text' || chunk.block.type === 'reasoning') && chunk.block.text.length > 0)) {
      const elapsed = Date.now() - this.startedAt
      this.firstOutputMs ??= elapsed
      const type = chunk.type === 'block-end' ? chunk.block.type : chunk.type === 'text-delta' ? 'text' : 'reasoning'
      if (type === 'text') this.firstTextMs ??= elapsed
      if (type === 'reasoning') this.firstReasoningMs ??= elapsed
      this.lastOutputMs = elapsed
      this.outputChunks += 1
    }
  }

  /**
   * Describe received output without inventing unreported token usage.
   * @param cancelled - Whether the owning operation was cancelled.
   * @param failed - Whether streaming, parsing, or admission rejected the result.
   * @returns Terminal diagnostics; byte counts refer to retained text, not tokens.
   */
  stats(cancelled: boolean, failed: boolean): ExtractionResponseStats {
    const blocks = this.assembler.interruptedBlocks()
    const bytes = (type: 'text' | 'reasoning') => blocks.reduce((total, block) =>
      total + (block.type === type ? Buffer.byteLength(block.text, 'utf8') : 0), 0)
    return {
      durationMs: Date.now() - this.startedAt,
      outputChunks: this.outputChunks,
      textBytes: bytes('text'),
      reasoningBytes: bytes('reasoning'),
      termination: cancelled ? 'cancelled' : this.timeoutSignal?.aborted === true ? 'timeout' : failed ? 'failed' : 'completed',
      ...(this.firstOutputMs === undefined ? {} : { firstOutputMs: this.firstOutputMs }),
      ...(this.lastOutputMs === undefined ? {} : { lastOutputMs: this.lastOutputMs }),
      ...(this.firstTextMs === undefined ? {} : { firstTextMs: this.firstTextMs }),
      ...(this.firstReasoningMs === undefined ? {} : { firstReasoningMs: this.firstReasoningMs }),
      ...(this.finishReason === undefined ? {} : { finishReason: this.finishReason }),
    }
  }
}

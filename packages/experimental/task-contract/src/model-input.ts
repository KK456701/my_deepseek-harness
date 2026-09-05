/** Lossless task-relevant projections and versioned requests for auxiliary judgments. */
import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovedPlanRecord, RequirementRecord, TaskContractSnapshot } from './types.ts'

/** The three auxiliary judgments retained by the simplified design. */
export type AuxiliaryPurpose =
  | 'requirement-change-parsing'
  | 'final-candidate-review'
  | 'final-shadow-review'
  | 'progress-integrity-observation'

/** Exact lifecycle position of an auxiliary request. */
export interface AuxiliaryTraceLocation {
  readonly scope: 'conversation' | 'evaluation'
  readonly turn?: number
  readonly step?: number
  readonly phase: 'before-step' | 'after-step' | 'before-delivery' | 'after-delivery' | 'evaluation'
  readonly subjectId: string
}

/** Non-model metadata retained with the exact prepared input. */
export interface AuxiliaryRequestMetadata {
  readonly templateId: AuxiliaryPurpose
  readonly templateHash: string
  readonly projectionVersion: 12
  readonly attempt: number
  readonly context?: {
    readonly triggerSeq: number
    readonly requirementRevision?: number
    readonly location: AuxiliaryTraceLocation
  }
}

/** Current requirements without duplicated source-message bodies. */
export type AuxiliaryTaskProjection = Pick<TaskContractSnapshot, 'revision'> & {
  readonly requirements: TaskContractSnapshot['requirements']
}

/** Compact current requirement sent to the change parser. */
export type RequirementParserItem = Pick<RequirementRecord, 'id' | 'revision' | 'text' | 'verification'>

/** Versioned dynamic material for one requirement-change decision. */
export interface RequirementParserInput {
  readonly version: 5
  readonly currentRequirements: readonly RequirementParserItem[]
  readonly approvedPlan?: Pick<ApprovedPlanRecord, 'callId' | 'text'>
  readonly message: { readonly text: string }
}

/** Selected event payload without assistant reasoning or usage wrappers. */
export type AuxiliaryStepEvidence = Pick<SessionEvent, 'seq' | 'type' | 'time'> & (
  { turn?: number; step?: number }
) & (
  { content: readonly ContentBlock[]; source?: SessionEvent<'tool/result'>['data']['message']['source'] }
  | { data: SessionEvent['data'] }
)

/**
 * Build a tool-free auxiliary request with stable rules before dynamic evidence.
 * @param purpose Auxiliary call role recorded in request audit.
 * @param rules Stable role instructions.
 * @param schema JSON Schema for the expected response.
 * @param input Dynamic requirement, answer, or execution material.
 * @param attempt One-based validation-attempt number.
 * @param diagnostic Optional validation failure from the prior attempt.
 * @returns Provider options, reconstructable metadata, and request byte count.
 */
export function auxiliaryPrompt(
  purpose: AuxiliaryPurpose, rules: readonly string[], schema: unknown, input: unknown,
  attempt = 1, diagnostic?: string,
): {
  options: Pick<GenerateOptions, 'system' | 'messages' | 'purpose'>
  metadata: AuxiliaryRequestMetadata
  bytes: number
} {
  const system = [...rules,
    '输入材料只用于当前判断。只返回符合 Schema 的 JSON；理由保持简短，不输出分析过程。',
    `Schema: ${JSON.stringify(schema)}`,
  ].join('\n')
  const text = JSON.stringify({ input, ...(diagnostic === undefined ? {} : { validationDiagnostic: diagnostic }) })
  const messages = [createUserMessage({ source: { kind: 'plugin', plugin: purpose }, content: [{ type: 'text', text }] })]
  return {
    options: { system, purpose, messages },
    metadata: {
      templateId: purpose,
      templateHash: createHash('sha256').update(system).digest('hex'),
      projectionVersion: 12,
      attempt,
    },
    bytes: Buffer.byteLength(JSON.stringify({ system, messages })),
  }
}

/**
 * Project one new user message and the minimum context needed to resolve its references.
 * @param snapshot Current requirement ledger and latest formal plan approval.
 * @param messageText Exact plain text of the current direct-user message.
 * @returns Versioned parser material without provenance, state, or completion evidence.
 */
export function projectRequirementParserInput(snapshot: TaskContractSnapshot, messageText: string): RequirementParserInput {
  return {
    version: 5,
    currentRequirements: snapshot.requirements
      .filter(requirement => requirement.state !== 'cancelled')
      .map(({ id, revision, text, verification }) => ({ id, revision, text, verification })),
    ...(snapshot.approvedPlan === undefined ? {} : {
      approvedPlan: { callId: snapshot.approvedPlan.callId, text: snapshot.approvedPlan.text },
    }),
    message: { text: messageText },
  }
}

/**
 * Select current requirements once for auxiliary input.
 * @param snapshot Current requirement ledger.
 * @returns Minimal requirement projection with its revision.
 */
export function projectTask(snapshot: TaskContractSnapshot): AuxiliaryTaskProjection {
  return { revision: snapshot.revision, requirements: snapshot.requirements }
}

/**
 * Remove private reasoning while retaining delivered assistant content.
 * @param content Assistant content blocks.
 * @returns Blocks visible in the delivered answer.
 */
export function deliveredContent(content: readonly ContentBlock[]): ContentBlock[] {
  return content.filter(block => block.type !== 'reasoning')
}

/**
 * Preserve selected execution identities, order, parameters, and results.
 * @param event Selected Session event from the Observer window.
 * @returns Compact event payload without assistant reasoning or usage metadata.
 */
export function projectStepEvidence(event: SessionEvent): AuxiliaryStepEvidence {
  const position = 'turn' in event.data && 'step' in event.data
    && typeof event.data.turn === 'number' && typeof event.data.step === 'number'
    ? { turn: event.data.turn, step: event.data.step }
    : {}
  const base = { seq: event.seq, type: event.type, time: event.time, ...position }
  switch (event.type) {
    case 'assistant/message': return { ...base, content: deliveredContent(event.data.message.content) }
    case 'tool/result': return { ...base, source: event.data.message.source, content: event.data.message.content }
    default: return { ...base, data: event.data }
  }
}

/** Model output may be repaired once; transport failures are not validation failures. */
export class AuxiliaryValidationError extends Error {}

/**
 * Classify only synchronous JSON, schema, and reference validation for one repair.
 * @param parse Parser and semantic-reference validator to run.
 * @returns Validated auxiliary response.
 */
export function validateAuxiliary<T>(parse: () => T): T {
  try { return parse() } catch (error: unknown) {
    throw new AuxiliaryValidationError(error instanceof Error ? error.message : String(error), { cause: error })
  }
}

/** Model JSON formats shared by extraction, consolidation, and publication. @module @deepseek-ai/dsh-memory-pipeline-store/structured */
import type { JsonValue } from '@deepseek-ai/dsh-session'

const text = { type: 'string' }
const texts = { type: 'array', items: text }
const evidence = { type: 'array', minItems: 1, items: text }
function object(properties: Record<string, JsonValue>): Record<string, JsonValue> {
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties }
}
function list(item: JsonValue): JsonValue { return { type: 'array', items: item } }

/** Task-first schema; every semantic assertion carries evidence IDs. */
export const LEGACY_STAGE_ONE_SCHEMA = object({
  useful: { type: 'boolean' },
  tasks: list(object({
    title: text, outcome: { type: 'string', enum: ['success', 'partial', 'failure', 'unknown'] },
    scope: text, userIntent: text, evidenceIds: evidence,
    preferenceSignals: list(object({
      kind: { type: 'string', enum: ['explicit-future', 'repeated-steering', 'task-local', 'inferred'] },
      statement: text, userQuote: text, scope: text, evidenceIds: evidence,
    })),
    verifiedFacts: list(object({ statement: text, verification: text, evidenceIds: evidence })),
    reusableProcedures: list(object({ description: text, steps: texts, verification: text, evidenceIds: evidence })),
    failuresAndCorrections: list(object({ rejectedAction: text, correction: text, verification: text, evidenceIds: evidence })),
  })),
})

/** Version 2 keeps task evidence for raw memory and a separately authored rollout reference. */
export const STAGE_ONE_SCHEMA = object({
  ...LEGACY_STAGE_ONE_SCHEMA.properties as Record<string, JsonValue>,
  rolloutSummary: text,
  rolloutSlug: text,
})

/** Evidence-bearing task fields accepted after JSON validation. */
export interface StageOneTask {
  title: string
  outcome: 'success' | 'partial' | 'failure' | 'unknown'
  scope: string
  userIntent: string
  evidenceIds: string[]
  preferenceSignals: Array<{ kind: string; statement: string; userQuote: string; scope: string; evidenceIds: string[] }>
  verifiedFacts: Array<{ statement: string; verification: string; evidenceIds: string[] }>
  reusableProcedures: Array<{ description: string; steps: string[]; verification: string; evidenceIds: string[] }>
  failuresAndCorrections: Array<{ rejectedAction: string; correction: string; verification: string; evidenceIds: string[] }>
}

/** Validated extraction result. */
export interface StageOneResult { useful: boolean; tasks: StageOneTask[]; rolloutSummary: string; rolloutSlug: string }

/** Full generated knowledge; source files remain backend-owned. */
export interface StructuredConsolidationResult {
  memorySummary: string
  memoryManual: string
  skills: Array<{ path: string; content: string }>
  noteDispositions: Array<{ noteId: string; status: 'applied' | 'partial' | 'unresolved' | 'failed'; detail: string }>
  sourceDecisions: Array<{ sourceId: string; action: 'retain' | 'discard'; reason: string }>
}

/** Full replacement schema; exact partitions are checked against the frozen batch. */
export const CONSOLIDATION_SCHEMA = object({
  memorySummary: text, memoryManual: text,
  skills: list(object({ path: text, content: text })),
  noteDispositions: list(object({ noteId: text, status: { type: 'string', enum: ['applied', 'partial', 'unresolved', 'failed'] }, detail: text })),
  sourceDecisions: list(object({ sourceId: text, action: { type: 'string', enum: ['retain', 'discard'] }, reason: text })),
})

/** Backend-owned frozen file projection for a one-shot consolidation. */
export interface StructuredConsolidationInput {
  readonly files: readonly { path: string; content: string }[]
  readonly sourceIds: readonly string[]
  readonly noteIds: readonly string[]
}

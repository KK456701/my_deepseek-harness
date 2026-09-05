/** Durable requirement ledger types and auxiliary-model audit events. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CallId, ContentBlock, FinishReason, MessageId, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Stable identity for one requirement across revisions. */
export type RequirementId = Branded<'RequirementId'>

/**
 * Brand a runtime-assigned requirement identity.
 * @param value Runtime-assigned opaque value.
 * @returns Branded requirement identity.
 */
export function RequirementId(value: string): RequirementId { return value as RequirementId }

/** Session-log evidence local to this Session or inherited from another Session. */
export type EventRef =
  | { readonly kind: 'local'; readonly seq: number }
  | { readonly kind: 'external'; readonly sessionId: SessionId; readonly seq: number }

/** Exact UTF-16 range in a runtime-identified user message. */
export interface UserSourceRef {
  readonly messageId: MessageId
  readonly start: number
  readonly end: number
  readonly quote: string
  /** Present after the claimed message has entered the Session log. */
  readonly event?: EventRef
}

/** Whether the answer itself or an executed operation must prove completion. */
export type RequirementVerification = 'answer' | 'execution'

/** Current requirement state. Historical revisions remain in ledger events. */
export type RequirementState = 'open' | 'fulfilled' | 'cancelled'

/** Current value of one user requirement. */
export interface RequirementRecord {
  readonly id: RequirementId
  readonly revision: number
  readonly text: string
  readonly verification: RequirementVerification
  readonly source: UserSourceRef
  readonly state: RequirementState
  readonly verifiedRevision?: number
  readonly evidenceEventIds: readonly EventRef[]
}

/** Original identified user message retained even when parsing fails or returns no changes. */
export interface RequirementInputRecord {
  readonly messageId: MessageId
  readonly content: readonly ContentBlock[]
  readonly inputSeq: number
  readonly turn: number
}

/** Latest exact plan approved through DSH plan review. */
export interface ApprovedPlanRecord {
  readonly callId: CallId
  readonly text: string
  readonly review: EventRef
  readonly approval: EventRef
  /** Rebuilt from the ledger prefix at the persisted approval event, not model output. */
  readonly requirementRevisions?: readonly { readonly id: RequirementId; readonly revision: number }[]
  /** Missing historical baselines require reconciliation, never implicit approval. */
  readonly applicability?: 'current' | 'needs-reconciliation'
  readonly changedRequirementIds?: readonly RequirementId[]
}

/** Model-proposed change; the runtime assigns ids, revisions, and durable state. */
export type RequirementChange =
  | {
    readonly op: 'add'
    readonly text: string
    readonly verification: RequirementVerification
  }
  | {
    readonly op: 'revise'
    readonly targetId: RequirementId
    readonly text: string
    readonly verification: RequirementVerification
  }
  | {
    readonly op: 'cancel'
    readonly targetId: RequirementId
  }

/** Complete response expected from the requirement-change parser. */
export interface RequirementChangeProposal {
  readonly changes: readonly RequirementChange[]
}

/** Runtime-owned ledger changes admitted atomically. */
export type RequirementUpdate =
  | { readonly kind: 'add'; readonly requirement: RequirementRecord }
  | {
    readonly kind: 'revise'
    readonly id: RequirementId
    readonly source: UserSourceRef
    readonly text: string
    readonly verification: RequirementVerification
  }
  | { readonly kind: 'cancel'; readonly id: RequirementId; readonly source: UserSourceRef }
  | {
    readonly kind: 'fulfill'
    readonly id: RequirementId
    readonly requirementRevision: number
    readonly evidenceEventIds: readonly EventRef[]
  }

/** Current event-sourced requirement ledger. */
export interface TaskContractSnapshot {
  readonly revision: number
  readonly requirements: readonly RequirementRecord[]
  readonly inputs: readonly RequirementInputRecord[]
  readonly inputRevision: number
  readonly approvedPlan?: ApprovedPlanRecord
}

/** Deployment policy for requirement-change parsing. */
export interface Config {
  /** Shadow records failures; enforce rejects a Step whose new input cannot be reconciled. */
  readonly mode?: 'shadow' | 'enforce'
  /** Inject the current requirement and approved-plan projection into root Worker requests. */
  readonly injectWorkerContext?: boolean
  /** Parser provider; empty inherits the Agent route. */
  readonly parserProvider?: string
  /** Parser model; empty inherits the Agent model. */
  readonly parserModel?: string
  /** Adapter-owned effort; empty inherits the route default. */
  readonly parserReasoningEffort?: string
  /** Milliseconds allowed for one parsing call. */
  readonly parserTimeoutMs?: number
  /** Maximum provider output tokens for one parsing call. */
  readonly parserMaxTokens?: number
  /** Maximum UTF-8 bytes of the complete parser request. */
  readonly maxInputBytes?: number
  /** Maximum live requirements retained by the Session ledger. */
  readonly maxRequirements?: number
}

/** Received response diagnostics; missing fields in older logs mean unrecorded, not zero. */
export interface ExtractionResponseStats {
  readonly durationMs: number
  readonly firstOutputMs?: number
  readonly lastOutputMs?: number
  readonly firstTextMs?: number
  readonly firstReasoningMs?: number
  readonly outputChunks: number
  readonly textBytes: number
  readonly reasoningBytes: number
  readonly finishReason?: FinishReason['kind']
  readonly termination: 'completed' | 'timeout' | 'cancelled' | 'failed'
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Non-conversation evaluation metadata; fixed materials never authorize Worker execution. */
    'task-review/test-case': {
      version: 1
      kind: 'reviewer' | 'full-on' | 'full-off'
      caseId: string
      title: string
      materials?: import('@deepseek-ai/dsh-session/types').JsonValue
      expected?: import('@deepseek-ai/dsh-session/types').JsonValue
      faultInjection?: string
      legacy?: boolean
    }
    /** Evaluation outcome, separate from model transport and task completion. */
    'task-review/test-result': {
      caseId: string
      status: 'passed' | 'failed' | 'failed-expectation'
      actual?: import('@deepseek-ai/dsh-session/types').JsonValue
      error?: string
    }
    /** Exact claimed messages subsequently appended to Worker history. */
    'task-contract/input-admitted': { turn: number; messageIds: readonly MessageId[] }
    /** Claimed direct-user input saved before requirement-change parsing. */
    'task-contract/input': { turn: number; messages: readonly { id: MessageId; content: readonly ContentBlock[] }[] }
    /** Atomically advances the requirement ledger. Legacy batches omit formatVersion. */
    'task-contract/update': {
      formatVersion?: 3
      baseRevision: number
      revision: number
      sourceMessageIds: readonly MessageId[]
      updates: readonly RequirementUpdate[]
    }
    /** Legacy parser request retained for read-only trajectory replay. */
    'task-contract/extraction-start': {
      attemptId: string
      baseRevision: number
      sourceMessageIds: readonly MessageId[]
      sourceMessages: readonly ContentBlock[][]
      provider: string
      model: string
      maxTokens: number
    }
    /** Legacy parser result retained for read-only trajectory replay. */
    'task-contract/extraction-result': {
      attemptId: string
      baseRevision: number
      rawOutput: readonly ContentBlock[]
      extracted?: readonly unknown[]
      usage?: TokenUsage
      error?: string
      response?: ExtractionResponseStats
    }
  }
}

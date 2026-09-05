/** Durable final-candidate staging and simplified review results. */

import type { AssistantCandidateFinish } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AssistantMessage, ContentBlock, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { EventRef, RequirementId, RequirementInputRecord, TaskContractSnapshot } from '@deepseek-ai/dsh-experimental-task-contract'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { EvidenceFreshness } from '@deepseek-ai/dsh-experimental-task-execution-control'

/** Stable identity for one staged answer candidate. */
export type CandidateId = Branded<'CandidateId'>
/** Stable identity for one Reviewer attempt. */
export type ReviewAttemptId = Branded<'ReviewAttemptId'>
/**
 * Brand a staged candidate identity.
 * @param value Runtime-assigned opaque value.
 * @returns Branded candidate identity.
 */
export function CandidateId(value: string): CandidateId { return value as CandidateId }
/**
 * Brand a Reviewer attempt identity.
 * @param value Runtime-assigned opaque value.
 * @returns Branded review-attempt identity.
 */
export function ReviewAttemptId(value: string): ReviewAttemptId { return value as ReviewAttemptId }

/** Revisions and request position that must still match at commit. */
export interface CandidateBasis {
  readonly requirementRevision?: number
  readonly inputRevision?: number
  readonly approvedPlanSeq?: number
  readonly nextStepRevision: number
  readonly turn: number
  readonly step: number
  /** The request was admitted from the execution controller's own pause notice. */
  readonly controlNotice?: true
  readonly incarnation?: string
  /** Legacy fields retained for read-only staged drafts. */
  readonly taskId?: string
  readonly taskRevision?: number
  readonly planRevision?: number
}

/** Deterministic action derived from a validated final review. */
export type ReviewDeliveryAction = 'commit' | 'rewrite' | 'verify' | 'continue_work' | 'replan'

/** One effective requirement checked against answer paragraphs and actual result events. */
export interface RequirementReview {
  readonly requirementId: RequirementId
  readonly requirementRevision: number
  readonly answer: 'covered' | 'pending-disclosed' | 'missing'
  readonly work: 'verified' | 'needs-verification' | 'not-done' | 'incorrect' | 'not-needed'
  readonly answerEvidence: readonly { readonly paragraphId: string; readonly quote: string }[]
  readonly evidenceEventIds: readonly EventRef[]
  readonly gap: string
}

/** Complete Reviewer response; the runtime derives commit and remediation actions. */
export interface FinalReviewResult {
  readonly reply: 'complete' | 'interim' | 'blocked' | 'continue'
  readonly requirements: readonly RequirementReview[]
  readonly missingPlanQuotes: readonly string[]
  readonly unsupportedParagraphIds: readonly string[]
  readonly reason: string
}

/** Stable paragraph of the delivered answer, excluding private reasoning. */
export interface CandidateParagraph {
  readonly id: string
  readonly start: number
  readonly end: number
  readonly text: string
}

/** Immutable evidence shared by every review attempt for one candidate. */
export interface FrozenReviewInput {
  readonly version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
  /** Absent legacy state is unknown, never implicitly current. */
  readonly freshness?: Readonly<Record<number, EvidenceFreshness>>
  readonly candidateSeq: number
  readonly contract: TaskContractSnapshot
  readonly originalInputs: readonly RequirementInputRecord[]
  readonly evidence: readonly SessionEvent[]
  readonly candidate: AssistantMessage
  readonly paragraphs: readonly CandidateParagraph[]
}

/** Review routing, staging, and response limits. */
export interface Config {
  /** Whether review records only diagnostics or gates candidate delivery. */
  readonly mode?: 'shadow' | 'enforce'
  /** Enforce stages before delivery by default; Shadow can only inspect an already delivered message. */
  readonly reviewTiming?: 'after-delivery' | 'before-delivery'
  /** Reviewer provider; empty inherits the Worker provider. */
  readonly reviewerProvider?: string
  /** Reviewer model; empty inherits the Worker model. */
  readonly reviewerModel?: string
  /** Adapter-owned Reviewer effort; empty inherits the route default. */
  readonly reviewerReasoningEffort?: string
  /** Maximum provider output tokens for one review attempt. */
  readonly reviewerMaxTokens?: number
  /** Milliseconds allowed for one review attempt. */
  readonly reviewerTimeoutMs?: number
  /** Whether review input may be sent to a provider other than the Worker provider. */
  readonly allowCrossProviderReview?: boolean
  /** Maximum UTF-8 bytes in one staged candidate answer. */
  readonly maxCandidateBytes?: number
  /** Maximum staged candidate bytes retained for one Turn. */
  readonly maxTurnStagingBytes?: number
  /** Maximum staged candidate bytes retained for one Session. */
  readonly maxSessionStagingBytes?: number
  /** Maximum terminal answer attempts retained for one Turn; tool-call Steps do not consume this quota. */
  readonly maxCandidatesPerTurn?: number
  /** Maximum UTF-8 bytes accepted from one Reviewer response. */
  readonly maxReviewOutputBytes?: number
  /** Maximum event citations accepted from one Reviewer response. */
  readonly maxEvidenceRefs?: number
  /** Maximum read-only evidence-search or evidence-read request rounds before review fails closed. */
  readonly maxEvidenceLookupRounds?: number
  /** Maximum UTF-8 bytes in the complete Reviewer request. */
  readonly maxReviewInputBytes?: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Freezes the exact requirement, plan, evidence, and candidate material reviewed for one staged answer. */
    'final-review/input': { candidateId: CandidateId; input: FrozenReviewInput }
    /** Starts a non-blocking Shadow review and records the candidate, route, and requirement snapshot it evaluates. */
    'final-review/shadow-start': { candidateId: CandidateId; turn: number; message: AssistantMessage; contract: TaskContractSnapshot; provider: string; model: string }
    /** Records one post-delivery review result and the runtime action applied to that delivered message. */
    'final-review/shadow-result': {
      candidateId: CandidateId
      /** Present on new records; old logs without it remain visible but are not reclassified. */
      turn?: number
      /** Delivered `assistant/message` sequence reviewed by this result. */
      candidateSeq?: number
      /** Whether this review could start a same-Turn repair. */
      enforced?: boolean
      /** Runtime-derived action; absent when transport or validation failed in Shadow mode. */
      action?: ReviewDeliveryAction
      result?: FinalReviewResult
      rawOutput: ContentBlock[]
      usage?: TokenUsage
      error?: string
    }
    /** Opens one Enforce-mode staging transaction with the revisions and model route that must remain current. */
    'final-draft/start': { candidateId: CandidateId; basis: CandidateBasis; provider: string; model: string }
    /** Appends one ordered, possibly coalesced provider stream chunk without exposing it as an Assistant message. */
    'final-draft/chunk': { candidateId: CandidateId; chunk: StreamChunk }
    /** Records a Reviewer-owned lookup of the frozen candidate evidence prefix. */
    'final-review/evidence-access': {
      candidateId: CandidateId
      attemptId: ReviewAttemptId
      callId: string
      toolCallId: string
      operation: 'search' | 'read'
      eventIds: readonly number[]
    }
    /** Seals the complete staged answer, finish metadata, stream membership, and usage before final review. */
    'final-draft/candidate': { candidateId: CandidateId; basis: CandidateBasis; message: AssistantMessage; finish: AssistantCandidateFinish; chunkSeqs: number[]; usage?: TokenUsage }
    /** Starts one Reviewer attempt against the named candidate and exact requirement snapshot. */
    'final-draft/review-start': { candidateId: CandidateId; attemptId: ReviewAttemptId; contract: TaskContractSnapshot; provider: string; model: string; maxTokens: number }
    /** Records the parsed Reviewer result, raw provider output and usage, or the terminal transport or validation error. */
    'final-draft/review-result': { candidateId: CandidateId; attemptId: ReviewAttemptId; result?: FinalReviewResult; rawOutput: ContentBlock[]; usage?: TokenUsage; error?: string }
    /** Records the durable delivery state and program-derived remediation action for one staged candidate. */
    'final-draft/decision': {
      candidateId: CandidateId
      status: 'awaiting_user' | 'awaiting_commit' | 'committed' | 'rejected' | 'superseded' | 'aborted'
      action?: ReviewDeliveryAction
      reason?: string
      delivery?: { replyAllowed: boolean; turnEnds: boolean; taskCompleted: boolean }
    }
    /** Closes one staging transaction after commit, rejection, supersession, abort, or recovery cleanup. */
    'final-draft/end': { candidateId: CandidateId }
  }
}

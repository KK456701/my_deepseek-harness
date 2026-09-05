/** Durable execution pauses, repair budgets, and dispatch receipts. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { FsTarget, FsObservation } from '@deepseek-ai/dsh-fs'

/** One live Agent incarnation; an old receipt cannot authorize a restarted Agent. */
export type ExecutionIncarnation = Branded<'ExecutionIncarnation'>
/** Repair and pause modes independent from collaboration plan mode. */
export type TaskExecutionMode = 'running' | 'rewrite' | 'verify' | 'continue_work' | 'replanning' | 'outcome_unknown'

/** Runtime-observed file identity; it is not a claim about file contents. */
export interface TaskFileObservation {
  readonly target: FsTarget
  readonly observation: FsObservation
}

/** Applicability of one historical result to the frozen final state. */
export interface EvidenceFreshness {
  readonly status: 'current' | 'stale' | 'unknown'
  readonly reason: string
}

/** Exact persisted invocation used only for outcome recovery. */
export interface PendingTaskOperation {
  readonly name: string
  readonly argumentsJson: string
  readonly callId: CallId
}

/** Session-scoped execution restriction and repair budget. */
export interface TaskExecutionSnapshot {
  readonly revision: number
  readonly incarnation: ExecutionIncarnation
  readonly mode: TaskExecutionMode
  readonly reason: string
  readonly repairStartedAt?: number
  readonly repairSteps: number
  readonly repairCalls: number
  readonly lastWorkerStep?: string
}

/** Validated deployment limits; Shadow never changes execution. */
export interface Config {
  /** Whether execution state only records diagnostics or enforces restrictions. */
  readonly mode?: 'shadow' | 'enforce'
  /** Maximum Worker Steps allowed within one repair budget. */
  readonly maxRepairWorkerSteps?: number
  /** Maximum task-tool dispatches allowed within one repair budget. */
  readonly maxRepairToolCalls?: number
  /** Wall-clock milliseconds allowed from the first repair restriction. */
  readonly maxRepairMs?: number
  /** Maximum task-tool dispatches in one Turn, or `false` to disable this experiment-only safety fuse. */
  readonly maxTaskToolCallsPerTurn?: number | false
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Advances the Session execution restriction; only formal plan approval releases a hold. */
    'task-execution/state': { snapshot: TaskExecutionSnapshot }
    /** Flushed intent before a tool body starts; a missing result means unknown outcome. */
    'task-execution/dispatch': {
      incarnation: ExecutionIncarnation
      callId: CallId
      rootCallId: CallId
      name: string
      argumentsJson: string
      requirementRevision?: number
      inputRevision: number
      /** Captured trusted tool effect; omitted legacy records have unknown scope. */
      effect?: 'read-only' | 'side-effect' | 'unknown'
      /** Last potentially mutating dispatch preceding this invocation. */
      mutationSeq?: number
      /** Legacy fields retained for read-only logs. */
      taskRevision?: number
      taskId?: string
    }
    /** Registry invocation settled, independently of whether it fulfilled a requirement. */
    'task-execution/result': {
      incarnation: ExecutionIncarnation
      callId: CallId
      isError: boolean
      /** Missing legacy flags do not prove that the body ran. */
      started?: boolean
      /** Last potentially mutating dispatch when this result settled. */
      mutationSeq?: number
      files?: readonly TaskFileObservation[]
    }
    /** Legacy classifier record; new runtimes never append it. */
    'task-execution/authorization': { callId: CallId; decision: 'allow' | 'ask'; reason: string; sourceMessageIds: string[] }
    /** Legacy classifier dispatch; new runtimes never append it. */
    'task-execution/authorization-start': { callId: CallId; rootCallId: CallId; name: string; argumentsJson: string; turn: number; taskRevision: number }
  }
}

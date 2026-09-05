import type {
  AssistantMessageNode, ConversationLocation, ConversationNode,
  ConversationPromptSnapshot, ConversationViewNode, PartialAssistant,
  RequestPromptChange, RequestView, RunningToolCall, ToolCallBlock,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { MemoryRequestContext } from '@deepseek-ai/dsh-memory'
import type { TrajectoryCellProps } from './trajectory-record.ts'

/** Consumer-owned non-Worker record with an explicit historical location and stable identity. */
export interface TrajectoryRecordContribution {
  readonly seq: number
  readonly turn: number | null
  /** Exact Step when the producer can locate the lifecycle event. */
  readonly step?: number
  /** Placement inside the Step; absent records remain chronological turn-level rows. */
  readonly phase?: 'before-step' | 'after-step' | 'before-delivery' | 'after-delivery' | 'evaluation'
  readonly group: string
  readonly cell: Omit<TrajectoryCellProps, 'index'>
}

/** Durable selection metadata; summary text stays in the request header. */
export interface TrajectoryMemoryContext {
  readonly seq: number
  readonly time: number
  readonly context: MemoryRequestContext
}

/** Request-header facts retained by the Trajectory target. */
export interface TrajectoryRequestHeaderState {
  readonly seq: number
  readonly time: number
  readonly prompt: ConversationPromptSnapshot
  readonly change?: RequestPromptChange
  readonly location: ConversationLocation
}

/** One independently assembled contribution to the legacy Trajectory ledger. */
export type TrajectoryContribution =
  | { readonly kind: 'record'; readonly record: TrajectoryRecordContribution }
  | { readonly kind: 'memory-context'; readonly memory: TrajectoryMemoryContext }
  | {
    readonly kind: 'node'
    readonly node: ConversationNode
  }
  | {
    readonly kind: 'assistant'
    readonly node?: AssistantMessageNode
    readonly partial: PartialAssistant | null
    readonly request?: Extract<RequestView, { purpose: 'assistant' }>
  }
  | {
    readonly kind: 'tool'
    readonly root: ToolCallBlock
  }
  | {
    readonly kind: 'request-header'
    readonly header: TrajectoryRequestHeaderState
  }
  | {
    readonly kind: 'compaction'
    readonly request: Extract<RequestView, { purpose: 'compaction' }>
  }
  | {
    readonly kind: 'session-end'
    readonly seq: number
    readonly time: number
  }
  | {
    readonly kind: 'turn-end'
    readonly turn: number
    readonly time: number
    readonly error?: string
  }

/** Target envelope consumed by the Trajectory snapshot builder. */
export interface TrajectoryConversationViewNode extends ConversationViewNode {
  readonly target: 'trajectory'
  readonly anchorSeq: number
  readonly location: ConversationLocation
  readonly data: TrajectoryContribution
}

/** Stage-oriented Trajectory data assembled from registered business Contexts. */
export interface TrajectorySnapshot {
  readonly records?: readonly TrajectoryRecordContribution[]
  readonly memoryContexts?: readonly TrajectoryMemoryContext[]
  readonly eventNodes: readonly ConversationNode[]
  readonly eventLocations: ReadonlyMap<number, ConversationLocation>
  readonly requests: readonly RequestView[]
  readonly callSchemas: ReadonlyMap<string, ConversationPromptSnapshot['tools'][number]>
  readonly partial: PartialAssistant | null
  readonly runningCalls: readonly RunningToolCall[]
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationViewSnapshotMap {
    /** Independently assembled data consumed by the Trajectory view. */
    trajectory: TrajectorySnapshot
  }
}

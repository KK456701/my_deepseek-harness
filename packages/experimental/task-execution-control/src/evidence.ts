/** Result applicability derived from dispatch receipts and backend file versions. */

import type FileSystem from '@deepseek-ai/dsh-fs'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { EvidenceFreshness } from './types.ts'

type Dispatch = Extract<SessionEvent, { type: 'task-execution/dispatch' }>
type Receipt = Extract<SessionEvent, { type: 'task-execution/result' }>

function receiptFor(events: readonly SessionEvent[], dispatch: Dispatch): Receipt | undefined {
  return events.findLast((event): event is Receipt => event.type === 'task-execution/result'
    && event.data.callId === dispatch.data.callId && event.data.incarnation === dispatch.data.incarnation)
}

/**
 * Locate the latest potentially mutating dispatch, excluding bodies known not to have started.
 * @param events Existing Session event prefix.
 * @returns Dispatch sequence or zero before any possible modification.
 */
export function mutationWatermark(events: readonly SessionEvent[]): number {
  return events.findLast(event => event.type === 'task-execution/dispatch' && event.data.effect !== 'read-only'
    && receiptFor(events, event)?.data.started !== false)?.seq ?? 0
}

/**
 * Check result freshness against the observed workspace and current backend file identities.
 * @param session Session containing original dispatch and result receipts.
 * @param evidence Frozen result events to classify.
 * @param fs File provider for this execution scope, when available.
 * @param signal Review cancellation signal.
 * @param peers Other loaded sessions sharing the execution workspace.
 * @returns Program-generated applicability by original result sequence; historical records remain unknown.
 */
export async function freezeEvidenceFreshness(session: Pick<Session, 'events'>, evidence: readonly SessionEvent[],
  fs: Pick<FileSystem, 'stat'> | undefined, signal: AbortSignal,
  peers: readonly Pick<Session, 'events'>[] = []): Promise<Readonly<Record<number, EvidenceFreshness>>> {
  const statuses: Record<number, EvidenceFreshness> = {}
  const events = [...session.events]
  const peerWatermarks = peers.map(peer => mutationWatermark(peer.events))
  for (const event of evidence) {
    if (event.type !== 'tool/result') continue
    const unknown = (reason: string): void => { statuses[event.seq] = { status: 'unknown', reason } }
    const stale = (reason: string): void => { statuses[event.seq] = { status: 'stale', reason } }
    const dispatch = events.findLast((item): item is Dispatch => item.type === 'task-execution/dispatch'
      && item.data.callId === event.data.message.source.callId && item.seq < event.seq)
    const receipt = dispatch === undefined ? undefined : receiptFor(events, dispatch)
    if (dispatch === undefined || receipt?.data.started !== true || dispatch.data.effect === undefined) {
      unknown('缺少实际启动或受测状态依据；旧日志不能自动证明当前版本。'); continue
    }
    if (receipt.data.files !== undefined && receipt.data.files.length > 0) {
      if (fs === undefined) { unknown('文件后端不可用，无法核对当前版本。'); continue }
      let changed = false
      for (const file of receipt.data.files) {
        signal.throwIfAborted()
        const current = await fs.stat(file.target, signal)
        changed ||= file.observation.kind === 'absent' ? current !== undefined
          : current?.version !== file.observation.version
      }
      if (changed) { stale('文件在观察期间或之后已变化、删除或替换。'); continue }
      statuses[event.seq] = { status: 'current', reason: '已核对所引用文件的后端版本；不证明文件之外的服务或业务状态。' }
      continue
    }
    const overlap = events.some(item => item.type === 'task-execution/dispatch' && item !== dispatch
      && item.data.effect !== 'read-only' && receiptFor(events, item)?.data.started !== false
      && (item.seq > dispatch.seq || (receiptFor(events, item)?.seq ?? Infinity) > dispatch.seq))
    if (overlap) { stale('检查开始时存在未结束修改，或检查期间／之后发生了其他可能修改工作区的调用。'); continue }
    const peerMutation = peers.some(peer => peer !== session && peer.events.some(item => item.type === 'task-execution/dispatch'
      && item.data.effect !== 'read-only' && receiptFor(peer.events, item)?.data.started !== false
      && (item.time >= dispatch.time || (receiptFor(peer.events, item)?.time ?? Infinity) >= dispatch.time)))
    if (peerMutation) { stale('同工作区的其他已加载会话存在并发或后续修改，不能沿用旧测试。'); continue }
    if (dispatch.data.name !== 'bash' && dispatch.data.name !== 'pwsh' && dispatch.data.effect !== 'read-only') {
      unknown('操作影响范围没有可靠声明；需要针对当前对象重新核验。'); continue
    }
    statuses[event.seq] = { status: 'current', reason: 'Harness 观察范围内的工作区未发生后续或并发修改；不覆盖未观察到的外部修改、部署或远端状态。' }
  }
  signal.throwIfAborted()
  if (mutationWatermark(session.events) !== mutationWatermark(events)
    || peers.some((peer, index) => mutationWatermark(peer.events) !== peerWatermarks[index])) {
    for (const key of Object.keys(statuses)) statuses[Number(key)] = { status: 'stale', reason: '冻结证据期间出现新的工作区修改。' }
  }
  return statuses
}

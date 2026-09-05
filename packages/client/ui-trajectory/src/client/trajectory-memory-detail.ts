/** Logged memory-context rows and legacy prompt fallback. @module */
import type { RequestView } from '@deepseek-ai/dsh-client-runtime/client'
import { zh, type TrajectoryKey } from './locales.ts'
import type { TrajectoryMemoryContext } from './trajectory-contract.ts'
import type { TrajectoryCellProps } from './trajectory-record.ts'

function memorySection(system: string): { generation?: string; summary: string } | undefined {
  const start = system.indexOf('<dsh-long-term-memory>')
  if (start < 0) return undefined
  const end = system.indexOf('</dsh-long-term-memory>', start)
  if (end < 0) return undefined
  const block = system.slice(start, end)
  const generation = /^Generation: (.+)$/mu.exec(block)?.[1]
  const separator = block.indexOf('\n\n')
  return { ...generation === undefined ? {} : { generation }, summary: separator < 0 ? block : block.slice(separator + 2).replace(/\n$/u, '') }
}

/**
 * Build one compact context row per assistant request from persisted observations or its header.
 * @param requests - Requests in chronological order with their effective logged headers.
 * @param observations - Memory events for this event window.
 * @param t - View dictionary; standalone projections use the Chinese dictionary.
 * @returns Non-tool rows, with the exact request summary in the input inspector.
 */
export function memoryRequestCells(
  requests: readonly RequestView[],
  observations: readonly TrajectoryMemoryContext[],
  t: (key: TrajectoryKey) => string = key => zh[key],
): Array<{
  kind: 'memory'
  seq: number
  turn: number
  step: number
  cell: Omit<TrajectoryCellProps, 'index'>
}> {
  const byStep = new Map(observations.map(item => [`${item.context.turn}:${item.context.step}`, item]))
  let previous: string | undefined
  return requests.flatMap((request) => {
    if (request.purpose !== 'assistant') return []
    const observation = byStep.get(`${request.turn}:${request.step}`)
    const section = memorySection(request.prompt?.system ?? '')
    // Older non-memory conversations have no observation and no management instructions.
    if (observation === undefined && section === undefined && !request.prompt?.tools.some(tool => tool.name === 'memory_update_request')) return []
    const selection = observation?.context.selection
    const available = selection?.kind === 'available' || selection === undefined && section !== undefined
    const signature = selection?.kind === 'available' ? `${selection.generationId}:${selection.summarySha256}` : section === undefined ? undefined : `${section.generation}:${section.summary}`
    const status = t(!available ? 'memory.skipped' : previous === undefined ? 'memory.first' : previous === signature ? 'memory.reused' : 'memory.updated')
    if (available) previous = signature
    const detail = available
      ? [
        `${t('memory.generation')}: ${selection?.kind === 'available' ? selection.generationId : section?.generation ?? t('memory.unrecorded')}`,
        ...selection?.kind !== 'available' ? [t('memory.legacy-crop')] : [
          `${t('memory.bytes')}: ${selection.bytes}; ${t('memory.retained')}: ${selection.retainedItems}; ${t('memory.omitted')}: ${selection.omittedItems}`,
          `SHA-256: ${selection.summarySha256}`,
          `${t('memory.header')}: #${observation?.context.headerSeq}`,
        ],
        '', selection?.kind === 'available' && request.prompt !== undefined
          ? request.prompt.system.slice(selection.summaryStart, selection.summaryEnd)
          : section?.summary ?? t('memory.missing-header'),
      ].join('\n')
      : `${t('memory.reason')}: ${selection?.kind === 'skipped' ? t(`memory.${selection.reason}`) : t('memory.unrecorded')}`
    return [{
      kind: 'memory' as const, seq: observation?.seq ?? request.startSeq, turn: request.turn, step: request.step,
      cell: { kind: 'context' as const, text: `${t('memory.title')} · ${status}`, inputDetail: detail, sourceSeq: observation?.seq ?? request.startSeq, timeSeconds: 0, startedAt: request.startedAt },
    }]
  })
}

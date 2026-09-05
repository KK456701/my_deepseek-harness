import { describe, expect, it } from 'vitest'
import type { RequestView } from '@deepseek-ai/dsh-client-runtime/client'
import { MemoryGenerationId } from '@deepseek-ai/dsh-memory'
import type { TrajectoryMemoryContext } from '../src/client/trajectory-contract.ts'
import { memoryRequestCells } from '../src/client/trajectory-memory-detail.ts'

function request(step: number, summary = '- Persist the exact rule.') {
  return { purpose: 'assistant', turn: 1, step, startSeq: step * 10, startedAt: 10, completedAt: 20, status: 'complete', prompt: { config: { provider: 'test', model: 'test' }, system: `<dsh-long-term-memory>\nGeneration: gen\nInstructions\n\n${summary}\n</dsh-long-term-memory>`, tools: [{ name: 'memory_update_request', description: '', parameters: {} }] } } as RequestView
}
function observation(step: number, hash = 'same', summary = '- Persist the exact rule.'): TrajectoryMemoryContext {
  const summaryStart = '<dsh-long-term-memory>\nGeneration: gen\nInstructions\n\n'.length
  return { seq: step * 10, time: 10, context: { turn: 1, step, headerSeq: 1, selection: { kind: 'available', generationId: MemoryGenerationId('gen'), summarySha256: hash, summaryStart, summaryEnd: summaryStart + summary.length, bytes: 25, retainedItems: 1, omittedItems: 2 } } }
}

describe('memory request rows', () => {
  it('shows first, reused and changed contexts without tool rows', () => {
    const rows = memoryRequestCells([request(1), request(2), request(3, '- New rule.')], [observation(1), observation(2), observation(3, 'changed', '- New rule.')])
    expect(rows.map(row => row.cell.text)).toEqual(['长期记忆上下文 · 首次注入', '长期记忆上下文 · 沿用', '长期记忆上下文 · 更新'])
    expect(rows.every(row => row.cell.kind === 'context')).toBe(true)
    expect(rows[2]?.cell.inputDetail).toContain('- New rule.')
    expect(rows[0]?.cell.inputDetail).toContain('省略条目: 2')
  })
  it('uses recorded offsets rather than interpreting marker-like text inside memory', () => {
    const summary = '- Keep the literal </dsh-long-term-memory> string.\n'
    const row = memoryRequestCells([request(1, summary)], [observation(1, 'hash', summary)])[0]!
    expect(row.cell.inputDetail?.endsWith(summary)).toBe(true)
  })
  it('uses the persisted skip reason rather than current profile settings', () => {
    const row = observation(1)
    const rows = memoryRequestCells([request(1)], [{ ...row, context: { ...row.context, selection: { kind: 'skipped', reason: 'session-denied' } } }])
    expect(rows[0]?.cell.text).toContain('未注入')
    expect(rows[0]?.cell.inputDetail).toBe('未注入原因: 会话禁止读取')
  })
  it('recovers old summaries but does not invent missing reasons', () => {
    expect(memoryRequestCells([request(1)], [])[0]?.cell.inputDetail).toContain('旧日志未记录')
    const old = request(2)
    if (old.purpose !== 'assistant' || old.prompt === undefined) throw new Error('fixture')
    const rows = memoryRequestCells([{ ...old, prompt: { ...old.prompt, system: '' } }], [])
    expect(rows[0]?.cell.inputDetail).toBe('未注入原因: 未记录')
  })
})

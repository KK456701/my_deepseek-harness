import { describe, expect, it } from 'vitest'
import { budgetSummary } from '../src/summary-budget.ts'

describe('whole summary item budget', () => {
  const text = 'v1\n## User Profile\n\n## User preferences\n- 中文 🚀 [来源](MEMORY.md#topic)\n  继续说明。\n  - 嵌套说明\n- ' + 'Large '.repeat(80) + '[source](MEMORY.md)\n\n## General Tips\n- Safe [tip](MEMORY.md)\n'
  it('returns exact bytes when the complete summary fits', () => {
    expect(budgetSummary(text, Buffer.byteLength(text))).toEqual({
      text, bytes: Buffer.byteLength(text), retainedItems: 3, omittedItems: 0,
    })
  })
  it('keeps nested items, links, multibyte text and later small entries intact', () => {
    const result = budgetSummary(text, 220)
    expect(result.bytes).toBeLessThanOrEqual(220)
    expect(result.text).toContain('- 中文 🚀 [来源](MEMORY.md#topic)\n  继续说明。\n  - 嵌套说明')
    expect(result.text).toContain('- Safe [tip](MEMORY.md)')
    expect(result.text).not.toContain('Large')
    expect(result).toMatchObject({ retainedItems: 2, omittedItems: 1 })
  })
  it.each([0, 1, 2])('does not emit a partial version marker at budget %s', (limit) => {
    expect(budgetSummary(text, limit).text).toBe('')
  })
  it('counts headings and reference definitions in the output budget', () => {
    const source = 'v1\n## User preferences\n- Remember [choice][s].\n\n[s]: MEMORY.md\n\n- ' + 'excess '.repeat(50)
    const result = budgetSummary(source, 100)
    expect(result.text).toContain('[s]: MEMORY.md')
    expect(result.text).toContain('## User preferences')
    expect(result.bytes).toBe(Buffer.byteLength(result.text))
    expect(result.bytes).toBeLessThanOrEqual(100)
  })
})

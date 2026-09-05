/** Whole-node summary selection without rewriting retained Markdown. @module */
import { fromMarkdown } from 'mdast-util-from-markdown'

/** Exact rendered summary and item accounting. */
export interface BudgetedSummary {
  readonly text: string
  readonly bytes: number
  readonly retainedItems: number
  readonly omittedItems: number
}

/**
 * Select complete Markdown items in document order, including their headings and reference definitions.
 * @param text - Verified, suppression-filtered summary.
 * @param maxBytes - UTF-8 budget including headings and separators.
 * @returns Original node slices; oversized nodes are omitted rather than truncated.
 */
export function budgetSummary(text: string, maxBytes: number): BudgetedSummary {
  const tree = fromMarkdown(text)
  const slice = (node: (typeof tree.children)[number] | { position?: { start: { offset?: number }; end: { offset?: number } } }): string =>
    text.slice(node.position?.start.offset, node.position?.end.offset)
  const totalItems = tree.children.reduce((count, node) => count + (node.type === 'list' ? node.children.length : node.type === 'heading' || node.type === 'definition' || node.type === 'paragraph' && slice(node).trim() === 'v1' ? 0 : 1), 0)
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, bytes: Buffer.byteLength(text, 'utf8'), retainedItems: totalItems, omittedItems: 0 }
  const definitions = tree.children.filter(node => node.type === 'definition').map(slice)
  const prefix: string[] = []
  let heading: string | undefined
  const selected: string[] = []
  const emittedHeadings = new Set<string>()
  let retainedItems = 0
  let omittedItems = 0
  const render = (parts: readonly string[]): string => parts.length === 0 ? '' : [...parts, ...definitions].join('\n\n') + '\n'
  for (const node of tree.children) {
    if (node.type === 'definition') continue
    if (node.type === 'heading') { heading = slice(node); continue }
    if (node.type === 'paragraph' && slice(node).trim() === 'v1' && selected.length === 0) {
      prefix.push(slice(node))
      continue
    }
    const items = node.type === 'list' ? node.children : [node]
    for (const item of items) {
      const additions = [
        ...selected.length === 0 ? prefix : [],
        ...heading === undefined || emittedHeadings.has(heading) ? [] : [heading],
        slice(item),
      ]
      if (Buffer.byteLength(render([...selected, ...additions]), 'utf8') > maxBytes) { omittedItems++; continue }
      selected.push(...additions)
      if (heading !== undefined) emittedHeadings.add(heading)
      retainedItems++
    }
  }
  // An empty summary still carries its format marker when the budget permits it.
  const result = render(selected.length === 0 && Buffer.byteLength(render(prefix), 'utf8') <= maxBytes ? prefix : selected)
  return { text: result, bytes: Buffer.byteLength(result, 'utf8'), retainedItems, omittedItems }
}

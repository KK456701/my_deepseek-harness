/** Generation validation and source-closure manifest construction. @module @deepseek-ai/dsh-memory-local/manifest */

import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { containsMemorySecret, type MemoryGenerationFileRole } from '@deepseek-ai/dsh-memory'

/** One manifest file record used by the public browser and citation resolver. */
export interface GenerationManifestFile {
  readonly path: string
  readonly role: MemoryGenerationFileRole
  readonly bytes: number
  readonly sha256: string
  readonly sourceIds: readonly string[]
  readonly anchors: readonly GenerationManifestSourceAnchor[]
}

/** Machine-derived line attribution for one non-empty Markdown line. */
export interface GenerationManifestSourceAnchor {
  readonly startLine: number
  readonly endLine: number
  readonly heading?: string
  readonly sourceIds: readonly string[]
}

/** Machine-owned manifest for one immutable generation. */
export interface GenerationManifest {
  readonly formatVersion: 1 | 2
  readonly policyVersion?: number
  readonly templateVersion?: string
  readonly generationId: string
  readonly parentGenerationId?: string
  readonly publishSequence: number
  readonly createdAt: number
  readonly files: readonly GenerationManifestFile[]
}

interface MarkdownNode {
  readonly type: string
  readonly url?: string
  readonly children?: readonly MarkdownNode[]
  readonly position?: {
    readonly start: { readonly line: number }
    readonly end: { readonly line: number }
  }
}

interface FileDraft {
  readonly path: string
  readonly role: MemoryGenerationFileRole
  readonly bytes: number
  readonly sha256: string
  readonly links: readonly string[]
  readonly directSources: readonly string[]
  readonly content: string
}

/** Validation limits for one generated memory workspace. */
export interface GenerationValidationLimits {
  /** Maximum number of files in one generation. */
  readonly maxFiles: number
  /** Maximum bytes in any generated file. */
  readonly maxFileBytes: number
  /** Maximum aggregate bytes in one generation. */
  readonly maxTotalBytes: number
  /** Maximum bytes in `memory_summary.md`. */
  readonly maxSummaryBytes: number
}

function sha256(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function slash(value: string): string {
  return value.split(sep).join('/')
}

function contained(root: string, candidate: string): boolean {
  const offset = relative(root, candidate)
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
}

function roleOf(path: string): MemoryGenerationFileRole | undefined {
  if (path === 'memory_summary.md') return 'summary'
  if (path === 'MEMORY.md') return 'catalog'
  if (path === 'raw_memories.md') return 'raw'
  if (path === 'generation-manifest.json') return 'manifest'
  if (path.startsWith('rollout_summaries/')) return 'rollout'
  if (path.startsWith('skills/')) return 'skill'
  if (path.startsWith('extensions/ad_hoc/notes/')) return 'ad-hoc-note'
  return undefined
}

function allowedLink(from: MemoryGenerationFileRole, to: MemoryGenerationFileRole): boolean {
  if (from === 'summary') return to === 'catalog' || to === 'skill' || to === 'rollout' || to === 'ad-hoc-note'
  if (from === 'catalog') return to === 'skill' || to === 'rollout' || to === 'ad-hoc-note'
  if (from === 'skill') return to === 'rollout' || to === 'ad-hoc-note'
  if (from === 'raw') return to === 'rollout'
  return false
}

function linksFromMarkdown(content: string): string[] {
  const root = fromMarkdown(content) as MarkdownNode
  const links: string[] = []
  const visit = (node: MarkdownNode): void => {
    if (node.type === 'link' && node.url !== undefined) links.push(node.url)
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  return links
}

function linksByLineFromMarkdown(content: string): ReadonlyMap<number, readonly string[]> {
  const root = fromMarkdown(content) as MarkdownNode
  const byLine = new Map<number, string[]>()
  const visit = (node: MarkdownNode): void => {
    if (node.type === 'link' && node.url !== undefined && node.position !== undefined) {
      for (let line = node.position.start.line; line <= node.position.end.line; line += 1) {
        byLine.set(line, [...byLine.get(line) ?? [], node.url])
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  return byLine
}

function requireSummarySources(content: string): void {
  const root = fromMarkdown(content) as MarkdownNode
  const containsLink = (node: MarkdownNode): boolean =>
    node.type === 'link' || (node.children ?? []).some(containsLink)
  const visit = (node: MarkdownNode): void => {
    if (node.type === 'listItem' && !containsLink(node)) {
      throw new Error('every memory_summary.md list item must contain a source link')
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
}

function requireSummaryFormat(content: string): void {
  const lines = content.split(/\r?\n/u)
  if (lines[0] !== 'v1') throw new Error('memory_summary.md must start with v1')
  const required = ['## User Profile', '## User preferences', '## General Tips', "## What's in Memory"]
  let prior = 0
  for (const heading of required) {
    const positions = lines.flatMap((line, index) => line === heading ? [index] : [])
    if (positions.length !== 1 || (positions[0] ?? 0) <= prior) throw new Error(`memory_summary.md must contain one ordered ${heading} heading`)
    prior = positions[0] ?? prior
  }
}

function requireMemoryFormat(content: string): void {
  const lines = content.split(/\r?\n/u)
  if (lines[0] !== '# Memory') throw new Error('MEMORY.md must start with # Memory')
  if (lines.some(line => /^#{2,}\s+Task Group\s*:/u.test(line))) {
    throw new Error('MEMORY.md Task Groups must use top-level # Task Group: headings')
  }
  const groups = lines.flatMap((line, index) => /^# Task Group:\s*\S/u.test(line) ? [index] : [])
  const contentOutsideGroups = lines.slice(1, groups[0] ?? lines.length)
    .some(line => line.trim().length > 0 && !line.trimStart().startsWith('<!--'))
  if (groups.length === 0) {
    if (contentOutsideGroups) throw new Error('non-empty MEMORY.md must contain a # Task Group: block')
    return
  }
  if (contentOutsideGroups) throw new Error('MEMORY.md content must be inside a # Task Group: block')
  for (let index = 0; index < groups.length; index += 1) {
    const start = groups[index] ?? 0
    const end = groups[index + 1] ?? lines.length
    const block = lines.slice(start + 1, end)
    if (!block.some(line => /^scope:\s*\S/u.test(line))) throw new Error('every MEMORY.md Task Group must contain scope:')
    if (!block.some(line => /^applies_to:\s*\S/u.test(line))) throw new Error('every MEMORY.md Task Group must contain applies_to:')
    const tasks = block.flatMap((line, lineIndex) => /^## Task \d+:\s*\S/u.test(line) ? [lineIndex] : [])
    if (tasks.length === 0) throw new Error('every MEMORY.md Task Group must contain a ## Task N: section')
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
      const taskStart = tasks[taskIndex] ?? 0
      const nextTask = tasks[taskIndex + 1] ?? block.length
      const consolidated = block.findIndex((line, lineIndex) => lineIndex > taskStart && /^## (?!Task \d+:)/u.test(line))
      const taskEnd = consolidated < 0 ? nextTask : Math.min(nextTask, consolidated)
      const task = block.slice(taskStart + 1, taskEnd)
      if (!task.includes('### rollout_summary_files')) throw new Error('every MEMORY.md task must contain ### rollout_summary_files')
      if (!task.includes('### keywords')) throw new Error('every MEMORY.md task must contain ### keywords')
    }
  }
}

async function collectFiles(root: string, limits: GenerationValidationLimits): Promise<FileDraft[]> {
  const drafts: FileDraft[] = []
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name)
      if (!contained(root, absolute)) throw new Error('generation path escaped its root')
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new Error(`generation contains a symbolic link: ${slash(relative(root, absolute))}`)
      if (info.isDirectory()) {
        if (entry.name === '.git') continue
        await walk(absolute)
        continue
      }
      if (!info.isFile()) throw new Error(`generation contains an unsupported filesystem entry: ${slash(relative(root, absolute))}`)
      const path = slash(relative(root, absolute))
      if (path === 'generation-manifest.json') continue
      const role = roleOf(path)
      if (role === undefined) throw new Error(`generation contains an unowned file: ${path}`)
      if (info.size > limits.maxFileBytes) throw new Error(`generation file exceeds maxFileBytes: ${path}`)
      const bytes = await readFile(absolute)
      const content = bytes.toString('utf8')
      if (Buffer.from(content, 'utf8').compare(bytes) !== 0) throw new Error(`generation file is not valid UTF-8: ${path}`)
      if (containsMemorySecret(content)) throw new Error(`generation contains an unredacted secret: ${path}`)
      if (role === 'summary' && info.size > limits.maxSummaryBytes) throw new Error('memory_summary.md exceeds maxSummaryBytes')
      const links = path.endsWith('.md') ? linksFromMarkdown(content) : []
      if (role === 'summary') {
        requireSummaryFormat(content)
        requireSummarySources(content)
      }
      if (role === 'catalog') requireMemoryFormat(content)
      const directSources = role === 'rollout'
        ? [`source:${path.slice('rollout_summaries/'.length).replace(/\.md$/u, '')}`]
        : role === 'ad-hoc-note'
          ? [`ad-hoc:${path.slice('extensions/ad_hoc/notes/'.length).replace(/\.md$/u, '')}`]
          : []
      drafts.push({ path, role, bytes: info.size, sha256: sha256(bytes), links, directSources, content })
      if (drafts.length > limits.maxFiles) throw new Error('generation exceeds maxFiles')
    }
  }
  await walk(root)
  const total = drafts.reduce((sum, file) => sum + file.bytes, 0)
  if (total > limits.maxTotalBytes) throw new Error('generation exceeds maxTotalBytes')
  return drafts
}

function resolveLinks(drafts: readonly FileDraft[]): Map<string, readonly string[]> {
  const byPath = new Map(drafts.map(file => [file.path, file]))
  const graph = new Map<string, readonly string[]>()
  for (const file of drafts) {
    const targets: string[] = []
    for (const raw of file.links) {
      const target = resolveLinkTarget(file.path, raw)
      if (target === undefined) continue
      if (target === file.path) continue
      const targetFile = byPath.get(target)
      if (targetFile === undefined) throw new Error(`memory link target does not exist: ${file.path} -> ${raw}`)
      if (!allowedLink(file.role, targetFile.role)) throw new Error(`memory link violates the source graph: ${file.path} -> ${target}`)
      targets.push(target)
    }
    graph.set(file.path, [...new Set(targets)].sort())
  }
  return graph
}

function resolveLinkTarget(from: string, raw: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(raw) || raw.startsWith('#')) return undefined
  const withoutFragment = raw.split('#', 1)[0]
  if (withoutFragment === undefined || withoutFragment.length === 0) return undefined
  const target = slash(relative('.', resolve(dirname(from), decodeURIComponent(withoutFragment))))
  if (isAbsolute(target) || target === '..' || target.startsWith('../')) throw new Error(`memory link escapes the generation: ${from} -> ${raw}`)
  return target
}

/**
 * Validate one staging tree and build its deterministic source-closure manifest.
 * @param root - Absolute root of the fully written staging tree.
 * @param identity - Backend-assigned generation identity, parent, sequence, and timestamp.
 * @param limits - Fixed file-count, byte, and summary limits applied before publication.
 * @returns The verified manifest with hashes and transitive source closures.
 */
export async function buildGenerationManifest(
  root: string,
  identity: {
    generationId: string
    parentGenerationId?: string
    publishSequence: number
    createdAt: number
    policyVersion: number
    templateVersion: string
  },
  limits: GenerationValidationLimits,
): Promise<GenerationManifest> {
  for (const required of ['memory_summary.md', 'MEMORY.md', 'raw_memories.md']) {
    const info = await stat(resolve(root, required)).catch(() => undefined)
    if (info?.isFile() !== true) throw new Error(`generation is missing required file: ${required}`)
  }
  const drafts = await collectFiles(root, limits)
  const graph = resolveLinks(drafts)
  const byPath = new Map(drafts.map(file => [file.path, file]))
  const resolving = new Set<string>()
  const memo = new Map<string, readonly string[]>()
  const sources = (path: string): readonly string[] => {
    const cached = memo.get(path)
    if (cached !== undefined) return cached
    if (resolving.has(path)) throw new Error(`memory source graph contains a cycle at ${path}`)
    resolving.add(path)
    const file = byPath.get(path)
    if (file === undefined) throw new Error(`memory manifest lost file ${path}`)
    const result = [...new Set([...file.directSources, ...(graph.get(path) ?? []).flatMap(sources)])].sort()
    resolving.delete(path)
    memo.set(path, result)
    return result
  }
  const files = drafts.map((file) => {
    const fileSources = sources(file.path)
    const linksByLine = file.path.endsWith('.md') ? linksByLineFromMarkdown(file.content) : new Map<number, readonly string[]>()
    let heading: string | undefined
    const anchors = file.path.endsWith('.md')
      ? file.content.split(/\r?\n/u).flatMap((line, index): GenerationManifestSourceAnchor[] => {
        const match = /^#{1,6}\s+(.+?)\s*#*$/u.exec(line)
        if (match?.[1] !== undefined) heading = match[1]
        if (line.trim().length === 0) return []
        const linked = [...linksByLine.get(index + 1) ?? []]
          .flatMap((raw) => {
            const target = resolveLinkTarget(file.path, raw)
            return target === undefined ? [] : sources(target)
          })
        return [{
          startLine: index + 1,
          endLine: index + 1,
          ...heading === undefined ? {} : { heading },
          sourceIds: [...new Set(linked.length === 0 ? fileSources : linked)].sort(),
        }]
      })
      : []
    return {
      path: file.path,
      role: file.role,
      bytes: file.bytes,
      sha256: file.sha256,
      sourceIds: fileSources,
      anchors,
    }
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'))
  return {
    formatVersion: 2,
    policyVersion: identity.policyVersion,
    templateVersion: identity.templateVersion,
    generationId: identity.generationId,
    ...identity.parentGenerationId === undefined ? {} : { parentGenerationId: identity.parentGenerationId },
    publishSequence: identity.publishSequence,
    createdAt: identity.createdAt,
    files,
  }
}

/** SHA-256 used for pointer and manifest validation. */
export const memorySha256 = sha256

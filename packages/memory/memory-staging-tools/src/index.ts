/** Rooted `glob` and `grep` tools for the isolated Phase 2 agent. @module @deepseek-ai/dsh-memory-staging-tools */

import { matchesGlob } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { MemoryStagingFileSystem } from './filesystem.ts'

export { MemoryStagingFileSystem } from './filesystem.ts'
export type { MemoryStagingFileSystemConfig } from './filesystem.ts'

/** Cordis plugin name. */
export const name = 'memory-staging-tools'
/** Services required by the rooted discovery tools. */
export const inject = ['tools', 'fs', 'systemPrompt']

/** Bounded rooted search configuration. */
export interface Config {
  /** Maximum candidate files examined by one rooted search. */
  maxFiles?: number
  /** Maximum matches returned by one rooted search. */
  maxMatches?: number
  /** Maximum bytes read from any candidate file. */
  maxFileBytes?: number
}

/** Runtime-validated configuration. */
export const Config: z<Config> = z.object({
  maxFiles: z.number().default(512),
  maxMatches: z.number().default(256),
  maxFileBytes: z.number().default(1024 * 1024),
})

type ResolvedConfig = Required<Config>

async function collectFiles(
  fs: MemoryStagingFileSystem,
  root: FsTarget,
  maxFiles: number,
  signal?: AbortSignal,
): Promise<FsTarget[]> {
  const files: FsTarget[] = []
  const queue = [root]
  while (queue.length > 0) {
    signal?.throwIfAborted()
    const directory = queue.shift()
    if (directory === undefined) break
    for (const entry of await fs.listDir(directory, signal)) {
      if (entry.type === 'directory') queue.push(entry.target)
      else if (entry.type === 'file') {
        files.push(entry.target)
        if (files.length > maxFiles) throw new Error(`memory search exceeds the ${maxFiles}-file cap`)
      }
    }
  }
  return files.sort((left, right) => fs.displayRelative(left).localeCompare(fs.displayRelative(right)))
}

function requireMemoryFs(ctx: Context): MemoryStagingFileSystem {
  if (!(ctx.fs instanceof MemoryStagingFileSystem)) {
    throw new Error('@deepseek-ai/dsh-memory-staging-tools requires MemoryStagingFileSystem')
  }
  return ctx.fs
}

/** Register rooted, bounded discovery tools over the staging filesystem. */
export function apply(ctx: Context, config: Config): void {
  const caps = config as ResolvedConfig
  for (const [key, value] of Object.entries(caps)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`memory-staging-tools: ${key} must be a positive safe integer`)
  }
  const fs = requireMemoryFs(ctx)
  ctx.tools.register(defineTool({
    name: 'glob',
    description: 'List memory-workspace files matching one glob. Paths are always relative to the isolated memory workspace.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Path glob such as "skills/**/*.md".' },
      path: { type: 'string', description: 'Relative directory to search. Defaults to ".".' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { paths: { type: 'array', required: true, items: { type: 'string' } } } },
      render: (_args, value) => [{ type: 'text', text: value.paths.length === 0 ? 'No files found.' : value.paths.join('\n') }],
    },
    async execute(args, exec) {
      if (args.pattern.length === 0) throw new Error('pattern must be non-empty')
      const root = await fs.resolve(args.path ?? '.', { signal: exec.signal })
      const files = await collectFiles(fs, root, caps.maxFiles, exec.signal)
      return { paths: files.map(target => fs.displayRelative(target)).filter(path => matchesGlob(path, args.pattern)) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grep',
    description: 'Search UTF-8 memory-workspace files with an ECMAScript regular expression.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'ECMAScript regular expression.' },
      path: { type: 'string', description: 'Relative file or directory. Defaults to ".".' },
      include: { type: 'string', description: 'Optional path glob applied before reading.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, properties: {
          matches: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            path: { type: 'string', required: true }, lineNumber: { type: 'integer', required: true }, line: { type: 'string', required: true },
          } } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.matches.length === 0 ? 'No matches found.' : value.matches.map(match => `${match.path}:${match.lineNumber}:${match.line}`).join('\n') }],
    },
    async execute(args, exec) {
      let pattern: RegExp
      try { pattern = new RegExp(args.pattern, 'u') } catch (error: unknown) { throw new Error('invalid grep regular expression', { cause: error }) }
      const target = await fs.resolve(args.path ?? '.', { signal: exec.signal })
      const info = await fs.stat(target, exec.signal)
      if (info === undefined) throw new Error(`memory search path does not exist: ${args.path ?? '.'}`)
      const files = info.type === 'file' ? [target] : await collectFiles(fs, target, caps.maxFiles, exec.signal)
      const matches: Array<{ path: string; lineNumber: number; line: string }> = []
      for (const file of files) {
        const path = fs.displayRelative(file)
        if (args.include !== undefined && !matchesGlob(path, args.include)) continue
        const fileInfo = await fs.stat(file, exec.signal)
        if ((fileInfo?.size ?? 0) > caps.maxFileBytes) continue
        const lines = (await fs.readText(file, exec.signal)).split(/\r?\n/)
        for (const [index, line] of lines.entries()) {
          pattern.lastIndex = 0
          if (!pattern.test(line)) continue
          matches.push({ path, lineNumber: index + 1, line })
          if (matches.length >= caps.maxMatches) return { matches }
        }
      }
      return { matches }
    },
  }))
}

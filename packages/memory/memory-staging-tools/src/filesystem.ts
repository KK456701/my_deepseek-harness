/** Rooted Phase 2 filesystem provider. @module @deepseek-ai/dsh-memory-staging-tools/filesystem */

import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsEditOutcome, FsEditRequest, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'

/** Configuration fixed by one Store-issued Phase 2 workspace. */
export interface MemoryStagingFileSystemConfig {
  readonly cwd?: string
  readonly diffBasisMaxBytes?: number
}

type MemoryPathRole = 'read-only' | 'read-write' | 'backend-owned'

function normalizedRelative(value: string): string {
  return value.split(sep).join('/')
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function roleOf(path: string): MemoryPathRole {
  if (path === 'generation-manifest.json' || path === '.git' || path.startsWith('.git/')) return 'backend-owned'
  if (path === 'memory_summary.md' || path === 'MEMORY.md' || path === 'skills' || path.startsWith('skills/')) return 'read-write'
  if (path === '' || path === 'raw_memories.md' || path === 'rollout_summaries' || path.startsWith('rollout_summaries/')
    || path === 'extensions' || path === 'extensions/ad_hoc' || path === 'extensions/ad_hoc/notes'
    || path.startsWith('extensions/ad_hoc/notes/')) return 'read-only'
  return 'backend-owned'
}

/** Local filesystem whose operation points enforce one generated staging root and role table. */
export class MemoryStagingFileSystem extends LocalFileSystem {
  /** Canonical staging root used for relative display paths. */
  readonly stagingRoot: string
  private readonly maxFileBytes: number

  constructor(ctx: Context, config: MemoryStagingFileSystemConfig) {
    if (config.cwd === undefined || !isAbsolute(config.cwd)) throw new Error('memory staging cwd must be absolute')
    if (config.diffBasisMaxBytes === undefined || !Number.isSafeInteger(config.diffBasisMaxBytes) || config.diffBasisMaxBytes < 1) {
      throw new Error('memory staging maxFileBytes must be a positive safe integer')
    }
    const stagingRoot = resolve(config.cwd)
    super(ctx, { cwd: stagingRoot, diffBasisMaxBytes: config.diffBasisMaxBytes })
    this.stagingRoot = stagingRoot
    this.maxFileBytes = config.diffBasisMaxBytes
  }

  private validateInput(path: string): string {
    if (path.length === 0 || path.includes('\0') || isAbsolute(path)) {
      throw new FsError('memory staging paths must be non-empty relative paths', 'FS_SANDBOX_DENIED')
    }
    const slash = path.replaceAll('\\', '/')
    const segments = slash.split('/')
    if (segments.some(segment => segment === '..') || /^[A-Za-z]:/.test(slash)) {
      throw new FsError(`memory staging path escapes the workspace: ${path}`, 'FS_SANDBOX_DENIED')
    }
    return slash
  }

  private async rejectSymlinkComponents(path: string, signal?: AbortSignal): Promise<void> {
    const segments = path.split('/').filter(segment => segment !== '' && segment !== '.')
    let current = this.stagingRoot
    for (const segment of segments) {
      signal?.throwIfAborted()
      current = resolve(current, segment)
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new FsError(`memory staging path contains a symbolic link: ${path}`, 'FS_SANDBOX_DENIED')
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
    }
  }

  private relativeTarget(target: FsTarget): string {
    const processPath = super.processPath(target)
    if (!contained(this.stagingRoot, processPath)) {
      throw new FsError('filesystem target is outside the memory staging root', 'FS_SANDBOX_DENIED')
    }
    return normalizedRelative(relative(this.stagingRoot, processPath))
  }

  /**
   * Return a stable slash-separated staging-relative path.
   * @param target - Resolved filesystem target already subject to the rooted provider.
   * @returns The normalized relative display path.
   */
  displayRelative(target: FsTarget): string {
    return this.relativeTarget(target)
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.cwd !== undefined && resolve(opts.cwd) !== this.stagingRoot) {
      throw new FsError('memory staging cwd override is not allowed', 'FS_SANDBOX_DENIED')
    }
    const relativePath = this.validateInput(path)
    await this.rejectSymlinkComponents(relativePath, opts?.signal)
    const target = await super.resolve(relativePath, {
      cwd: this.stagingRoot,
      ...opts?.signal === undefined ? {} : { signal: opts.signal },
    })
    const role = roleOf(this.relativeTarget(target))
    if (role === 'backend-owned') throw new FsError(`memory staging path is backend-owned: ${path}`, 'FS_SANDBOX_DENIED')
    return target
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal) {
    if (opts?.cwd !== undefined && resolve(opts.cwd) !== this.stagingRoot) {
      throw new FsError('memory staging cwd override is not allowed', 'FS_SANDBOX_DENIED')
    }
    const relativePath = this.validateInput(path)
    if (roleOf(relativePath) === 'backend-owned') throw new FsError(`memory staging path is backend-owned: ${path}`, 'FS_SANDBOX_DENIED')
    await this.rejectSymlinkComponents(relativePath, signal)
    return super.lstat(relativePath, { cwd: this.stagingRoot }, signal)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    this.relativeTarget(target)
    const entries = await super.listDir(target, signal)
    return entries.filter(entry => roleOf(this.relativeTarget(entry.target)) !== 'backend-owned')
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    this.relativeTarget(target)
    return super.readText(target, signal)
  }

  /**
   * Write a role-authorized file without accepting a second sandbox policy.
   * @param target - Resolved staging target.
   * @param content - Complete replacement text.
   * @param expected - Optional optimistic write intent.
   * @param signal - Optional cancellation signal.
   * @param sandboxPolicy - Ignored caller policy; the fixed staging policy remains authoritative.
   * @returns The underlying filesystem write outcome.
   */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const path = this.relativeTarget(target)
    if (roleOf(path) !== 'read-write') throw new FsError(`memory evidence is read-only: ${path}`, 'FS_PERMISSION_DENIED')
    if (Buffer.byteLength(content, 'utf8') > this.maxFileBytes) throw new FsError(`memory file exceeds ${this.maxFileBytes} bytes`, 'FS_TOO_LARGE')
    void sandboxPolicy
    return super.writeText(target, content, expected, signal)
  }

  /**
   * Apply one role-authorized edit and verify the resulting real path.
   * @param target - Resolved staging target.
   * @param edit - Structured text edit.
   * @param expected - Optional expected file version.
   * @param signal - Optional cancellation signal.
   * @param sandboxPolicy - Ignored caller policy; the fixed staging policy remains authoritative.
   * @returns The verified edit outcome.
   */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const path = this.relativeTarget(target)
    if (roleOf(path) !== 'read-write') throw new FsError(`memory evidence is read-only: ${path}`, 'FS_PERMISSION_DENIED')
    void sandboxPolicy
    const result = await super.editText(target, edit, expected, signal)
    const actual = await realpath(super.processPath(target))
    if (!contained(this.stagingRoot, actual)) throw new FsError('edited target escaped the memory staging root', 'FS_SANDBOX_DENIED')
    return result
  }
}

export default MemoryStagingFileSystem

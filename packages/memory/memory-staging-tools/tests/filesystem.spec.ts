import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { MemoryStagingFileSystem } from '../src/filesystem.ts'

let ctx: Context
let root: string
let fiber: Awaited<ReturnType<Context['plugin']>>
let fs: MemoryStagingFileSystem

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-staging-'))
  await mkdir(join(root, 'rollout_summaries'), { recursive: true })
  await mkdir(join(root, 'skills'), { recursive: true })
  await mkdir(join(root, '.git'), { recursive: true })
  await writeFile(join(root, 'raw_memories.md'), 'evidence')
  await writeFile(join(root, 'MEMORY.md'), 'index')
  await writeFile(join(root, 'generation-manifest.json'), '{}')
  await writeFile(join(root, '.git', 'config'), 'private')
  ctx = new Context()
  fiber = await ctx.plugin(MemoryStagingFileSystem, { cwd: root, diffBasisMaxBytes: 64 })
  fs = ctx.fs as MemoryStagingFileSystem
})

afterEach(async () => {
  await fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('root enforcement', () => {
  it('rejects absolute paths, traversal, drive aliases, and foreign cwd values', async () => {
    await expect(fs.resolve(join(root, 'MEMORY.md'))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(fs.resolve('../MEMORY.md')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(fs.resolve('C:MEMORY.md')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(fs.resolve('MEMORY.md', { cwd: tmpdir() })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('does not resolve or list backend-owned files', async () => {
    await expect(fs.resolve('generation-manifest.json')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(fs.resolve('.git/config')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    const entries = await fs.listDir(await fs.resolve('.'))
    expect(entries.map(entry => entry.name)).not.toContain('.git')
    expect(entries.map(entry => entry.name)).not.toContain('generation-manifest.json')
  })
})

describe('role and capacity enforcement', () => {
  it('allows writes only in summary, index, and skills', async () => {
    await fs.writeText(await fs.resolve('MEMORY.md'), 'updated')
    await fs.writeText(await fs.resolve('skills/new.md'), 'procedure')
    await expect(fs.writeText(await fs.resolve('raw_memories.md'), 'changed'))
      .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    expect(await readFile(join(root, 'MEMORY.md'), 'utf8')).toBe('updated')
  })

  it('rejects writes above the workspace file limit', async () => {
    await expect(fs.writeText(await fs.resolve('MEMORY.md'), 'x'.repeat(65)))
      .rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  })
})

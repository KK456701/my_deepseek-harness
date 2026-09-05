import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

describe('memory scheduler dependency direction', () => {
  it('keeps storage and filesystem implementations behind MemoryPipelineStore', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const runtimeDependencies = {
      ...manifest.dependencies,
      ...manifest.peerDependencies,
    }
    expect(runtimeDependencies).not.toHaveProperty('@deepseek-ai/dsh-memory-local')
    expect(runtimeDependencies).not.toHaveProperty('@deepseek-ai/dsh-storage-sqlite')

    const sources = await readdir(join(packageRoot, 'src'))
    const text = (await Promise.all(sources
      .filter(file => file.endsWith('.ts'))
      .map(file => readFile(join(packageRoot, 'src', file), 'utf8'))))
      .join('\n')
    expect(text).not.toMatch(/from ['"]@deepseek-ai\/dsh-memory-local(?:\/|['"])/)
    expect(text).not.toMatch(/from ['"]node:(?:fs|sqlite)(?:\/promises)?['"]/)
  })
})

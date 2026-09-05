/** Assembled-app snapshot for replayable long-term-memory injection. */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeSessionLog,
  scrubRequestHeaders,
  type NormalizeContext,
} from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { describe, expect, it } from 'vitest'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'memory-snapshots/summary-injection')
const replayFixture = join(fixtureDir, 'replay.jsonl')
const replayOverride = join(fixtureDir, 'replay.override.json')
const sessionExpected = join(fixtureDir, 'session.expected.jsonl')
const memorySectionExpected = join(fixtureDir, 'memory-section.expected.txt')
const managementSectionExpected = join(fixtureDir, 'management-section.expected.txt')
const configPath = fileURLToPath(new URL('../memory.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

describe('long-term memory snapshot', () => {
  it('injects the published summary and logs the exact request header', async () => {
    let cwd = ''
    const result = await runLoaderSmoke({
      label: 'long-term memory prompt snapshot',
      tempDirPrefix: 'dsh-memory-snapshot-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'Apply the established memory publication decision.'],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT_FILE: replayFixture,
        DSH_SNAPSHOT_OVERRIDE: replayOverride,
        NODE_NO_WARNINGS: '1',
      },
      prepare: async (runCwd) => { cwd = runCwd },
      inspect: async () => {
        expect(JSON.parse(await readFile(join(cwd, 'memory-items.actual.json'), 'utf8'))).toEqual({
          items: 2, sourceUsage: [{ sourceId: 'source:snapshot-source', adoptedCount: 0 }],
        })
        const files = (await readdir(join(cwd, '.sessions'), { recursive: true }))
          .filter(file => file.endsWith('.jsonl'))
        const logs = await Promise.all(files.map(file => readFile(join(cwd, '.sessions', file), 'utf8')))
        const interactive = logs.find((log) => {
          const header = JSON.parse(log.split('\n', 1)[0] ?? '{}') as { purpose?: unknown }
          return header.purpose === 'interactive'
        })
        if (interactive === undefined) throw new Error('memory snapshot produced no interactive session')
        const header = JSON.parse(interactive.split('\n', 1)[0] ?? '{}') as { id?: unknown }
        if (typeof header.id !== 'string') throw new Error('memory snapshot session has no id')
        const records = interactive.split('\n').filter(Boolean).map(line => JSON.parse(line) as {
          type?: unknown
          data?: { header?: { system?: unknown } }
        })
        const system = records.find(record => record.type === 'request/header')?.data?.header?.system
        if (typeof system !== 'string') throw new Error('memory snapshot request has no logged system prompt')
        const managementSection = system.split('\n').find(line => line.startsWith('When the current user explicitly asks you'))
        if (managementSection === undefined) throw new Error('memory snapshot request has no explicit-management guidance')
        const memorySection = /<dsh-long-term-memory>[\s\S]*?<\/dsh-long-term-memory>/u.exec(system)?.[0]
        if (memorySection === undefined) throw new Error('memory snapshot request has no memory section')
        const stableMemorySection = memorySection
          .replace(/^Generation: .+$/mu, 'Generation: {{generationId}}')
          .replace(/^Memory directory: .+$/mu, 'Memory directory: {{memoryRoot}}')
        const normalized = scrubRequestHeaders(normalizeSessionLog(interactive, {
          sessionIds: [header.id],
          cwd,
        } satisfies NormalizeContext))
        if (refreshing) {
          await Promise.all([
            writeFile(sessionExpected, normalized),
            writeFile(memorySectionExpected, `${stableMemorySection}\n`),
            writeFile(managementSectionExpected, `${managementSection}\n`),
          ])
        }
        expect(normalized).toBe(await readFile(sessionExpected, 'utf8'))
        expect(`${stableMemorySection}\n`).toBe(await readFile(memorySectionExpected, 'utf8'))
        expect(`${managementSection}\n`).toBe(await readFile(managementSectionExpected, 'utf8'))
        expect(stableMemorySection).toContain('Use immutable memory generations')
        expect(normalized).toContain('"type":"request/header"')
        expect(normalized).toContain('"type":"memory/context"')
        expect(normalized).toContain('"ignorable":true')
        expect(normalized).not.toContain('"name":"memory_read"')
      },
    })

    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('MEMORY_SNAPSHOT_OK')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})

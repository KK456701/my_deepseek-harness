import { mkdtemp, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { upgradeSessionDatabase } from '../src/upgrade.ts'
import { openDatabase } from '../src/schema.ts'
import { sql } from '../src/sql.ts'
import { testSql } from './test-sql.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(version: 16 | 17): Promise<{ source: string; output: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-upgrade-'))
  directories.push(directory)
  const source = join(directory, 'source.db')
  const db = new DatabaseSync(source)
  try {
    db.exec(sql(version === 16 ? 'legacy-schema-16' : 'legacy-schema-17'))
    db.exec(sql('set-application-id'))
    db.exec(testSql(version === 16 ? 'set-user-version-16' : 'set-user-version-17'))
    db.exec(testSql(version === 16 ? 'upgrade-fixture-16' : 'upgrade-fixture-17'))
  } finally { db.close() }
  return { source, output: join(directory, 'upgraded.db') }
}

describe('offline SQLite copy upgrade', () => {
  it.each([16, 17] as const)('preserves schema %s logical history, IDs, lineage and revisions without modifying its source', async (version) => {
    const { source, output } = await fixture(version)
    const before = await readFile(source)
    const report = await upgradeSessionDatabase(source, output)
    expect(report).toMatchObject({ fromVersion: version, toVersion: 18, sessionIds: ['child', 'root'], logicalEvents: version === 16 ? 2 : 3 })
    expect(report.logicalSha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(await readFile(source)).toEqual(before)
    const db = await openDatabase(DatabaseSync, output, 'delete', 0)
    try {
      expect(db.prepare(sql('upgrade-select-sessions')).all()).toEqual([
        expect.objectContaining({ id: 'child', purpose: 'subagent', parent_session: 'root', seed_length: 1, revision: 2 }),
        expect.objectContaining({ id: 'root', purpose: 'interactive', revision: 7 }),
      ])
    } finally { db.close() }
  })

  it('refuses an existing destination without changing either file', async () => {
    const { source, output } = await fixture(16)
    await upgradeSessionDatabase(source, output)
    const before = await readFile(output)
    await expect(upgradeSessionDatabase(source, output)).rejects.toThrow('EEXIST')
    expect(await readFile(output)).toEqual(before)
  })

  it.each(['origin', 'version', 'schema'] as const)('rejects unknown %s instead of creating empty history', async (kind) => {
    const { source, output } = await fixture(17)
    const db = new DatabaseSync(source)
    try {
      if (kind === 'origin') db.exec(testSql('upgrade-unknown-origin'))
      if (kind === 'version') db.exec(testSql('set-user-version-15'))
      if (kind === 'schema') db.exec(testSql('add-unexpected-column'))
    } finally { db.close() }
    await expect(upgradeSessionDatabase(source, output)).rejects.toThrow(/unknown|unsupported|does not match/u)
    await expect(access(output)).rejects.toThrow('ENOENT')
  })
})

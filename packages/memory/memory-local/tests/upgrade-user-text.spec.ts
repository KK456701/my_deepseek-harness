import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { MEMORY_APPLICATION_ID, openMemoryDatabase } from '../src/schema.ts'
import { upgradeMemoryUserText } from '../src/upgrade-user-text.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('backs up schema 8 and recovers only bound originals without replacing the draft or generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-original-upgrade-'))
  roots.push(root)
  const path = join(root, 'memory.db')
  const backup = join(root, 'before.db')
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA application_id=${MEMORY_APPLICATION_ID}; PRAGMA user_version=8;
    CREATE TABLE profile_state(singleton INTEGER, change_sequence INTEGER, current_generation_id TEXT);
    INSERT INTO profile_state VALUES(1,4,'generation-kept');
    CREATE TABLE ad_hoc_notes(id TEXT, revision INTEGER, origin TEXT, source_session_id TEXT, source_turn TEXT, source_user_event_seq INTEGER,content TEXT);
    INSERT INTO ad_hoc_notes VALUES('found',1,'conversation','s1','2',3,'model draft'),('missing',1,'conversation','s2','4',5,'unverified draft');`)
  db.close()
  expect(() => openMemoryDatabase(path)).toThrow('schema version 8')
  const lookup = vi.fn(async ({ sessionId }: { sessionId: string }) => sessionId === 's1' ? 'Remember a greeting. token=secret-value-123456789' : undefined)
  expect(await upgradeMemoryUserText(path, backup, 1024, lookup)).toEqual({ recovered: 1, unavailable: 1 })
  expect(lookup).toHaveBeenCalledWith({ sessionId: 's1', turn: '2', userEventSeq: 3 })
  const before = new DatabaseSync(backup, { readOnly: true })
  expect(before.prepare('PRAGMA user_version').get()?.user_version).toBe(8)
  before.close()
  const after = new DatabaseSync(path, { readOnly: true })
  expect(after.prepare('PRAGMA user_version').get()?.user_version).toBe(9)
  expect(after.prepare('SELECT * FROM profile_state').get()).toMatchObject({ current_generation_id: 'generation-kept', change_sequence: 5 })
  const original = after.prepare("SELECT * FROM ad_hoc_notes WHERE id='found'").get()
  expect(original).toMatchObject({ content: 'model draft', revision: 2 })
  expect(original?.source_user_text).not.toContain('secret-value-123456789')
  expect(after.prepare("SELECT source_user_text FROM ad_hoc_notes WHERE id='missing'").get()?.source_user_text).toBeNull()
  after.close()
  await expect(upgradeMemoryUserText(path, join(root, 'again.db'), 1024, lookup)).rejects.toThrow('schema-8')
})

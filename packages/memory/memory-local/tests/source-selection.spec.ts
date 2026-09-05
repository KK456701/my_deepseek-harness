import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { selectAutomaticSources } from '../src/source-selection.ts'

it('ranks the complete valid pool and emits only latest Session versions in stable source order', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE source_ranges (id TEXT,session_id TEXT,to_seq INTEGER,completed_at INTEGER,status TEXT,policy_version INTEGER);
      CREATE TABLE session_source_usage (session_id TEXT,adopted_count INTEGER,last_adopted_at INTEGER);
      CREATE TABLE candidates (id TEXT,source_range_id TEXT,output_index INTEGER,status TEXT,raw_memory TEXT,rollout_summary TEXT,rollout_slug TEXT,body TEXT,evidence_ids_json TEXT);`)
    const source = (id: string, session: string, end: number, time: number, status = 'succeeded', candidateStatus = 'consumed'): void => {
      db.prepare('INSERT INTO source_ranges VALUES (?,?,?,?,?,7)').run(id,session,end,time,status)
      db.prepare("INSERT INTO candidates VALUES (?,?,0,?,'raw','summary',NULL,'raw','[]')").run(id+':0',id,candidateStatus)
    }
    source('z-frequent-old','frequent',3,150)
    source('z-frequent-new','frequent',6,160)
    source('a-recent-use','recent',3,170)
    source('b-unreferenced','fresh',3,200)
    source('expired','expired',3,99)
    source('cancelled','cancelled',3,400,'cancelled')
    source('suppressed','suppressed',3,400,'succeeded','suppressed')
    source('previous-signal','now-empty',3,190)
    source('latest-empty','now-empty',6,210)
    db.prepare('DELETE FROM candidates WHERE source_range_id=?').run('latest-empty')
    source('previous-unsuppressed','now-suppressed',3,190)
    source('latest-suppressed','now-suppressed',6,210,'succeeded','suppressed')
    db.prepare('INSERT INTO session_source_usage VALUES (?,?,?)').run('frequent',10,120)
    db.prepare('INSERT INTO session_source_usage VALUES (?,?,?)').run('recent',2,220)
    expect(selectAutomaticSources(db,7,100,2).map(row=>row.rangeId)).toEqual(['a-recent-use','z-frequent-new'])
    expect(selectAutomaticSources(db,7,100,9).map(row=>row.rangeId)).toEqual(['a-recent-use','b-unreferenced','z-frequent-new'])
    db.prepare('UPDATE session_source_usage SET adopted_count=2,last_adopted_at=220').run()
    expect(selectAutomaticSources(db,7,100,1).map(row=>row.rangeId)).toEqual(['a-recent-use'])
    expect(selectAutomaticSources(db,8,100,9)).toEqual([])
  } finally {db.close()}
})

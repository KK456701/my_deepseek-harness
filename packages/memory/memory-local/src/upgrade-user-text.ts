/** Offline, backup-first upgrade for bound conversation memory requests. @module */
import { DatabaseSync } from 'node:sqlite'
import { redactMemoryText } from '@deepseek-ai/dsh-memory'
import { MEMORY_APPLICATION_ID } from './schema.ts'

interface BoundNote {
  id: string
  source_session_id: string
  source_turn: string
  source_user_event_seq: number
}

/**
 * Add original wording to schema 8 without changing generations or automatic evidence.
 * The caller must stop every memory writer and resolve only the bound genuine user event.
 * @param path - Existing schema-8 database.
 * @param backupPath - New SQLite backup file; an existing destination fails before mutation.
 * @param maxBytes - Maximum redacted original size, matching the provider's note limit.
 * @param resolveOriginal - Read-only lookup; missing or unverifiable events return undefined.
 * @returns Counts of recovered and unavailable originals.
 */
export async function upgradeMemoryUserText(
  path: string,
  backupPath: string,
  maxBytes: number,
  resolveOriginal: (source: { sessionId: string; turn: string; userEventSeq: number }) => Promise<string | undefined>,
): Promise<{ recovered: number; unavailable: number }> {
  const db = new DatabaseSync(path)
  let began = false
  try {
    const identity = db.prepare('PRAGMA application_id').get()
    const version = db.prepare('PRAGMA user_version').get()
    if (identity?.application_id !== MEMORY_APPLICATION_ID || version?.user_version !== 8) throw new Error('Original-wording upgrade requires a DSH memory schema-8 database')
    db.prepare('VACUUM INTO ?').run(backupPath)
    const notes = db.prepare(`SELECT id,source_session_id,source_turn,source_user_event_seq
      FROM ad_hoc_notes WHERE origin='conversation'`).all() as unknown as BoundNote[]
    const originals = new Map<string, string>()
    for (const note of notes) {
      const original = await resolveOriginal({
        sessionId: note.source_session_id,
        turn: note.source_turn,
        userEventSeq: note.source_user_event_seq,
      })
      if (original === undefined) continue
      const redacted = redactMemoryText(original)
      if (redacted.trim().length === 0 || Buffer.byteLength(redacted, 'utf8') > maxBytes) continue
      originals.set(note.id, redacted)
    }
    db.exec('BEGIN IMMEDIATE')
    began = true
    if (db.prepare('PRAGMA user_version').get()?.user_version !== 8) throw new Error('Memory schema changed during offline upgrade')
    db.exec('ALTER TABLE ad_hoc_notes ADD COLUMN source_user_text TEXT')
    const update = db.prepare('UPDATE ad_hoc_notes SET source_user_text=?,revision=revision+1 WHERE id=?')
    for (const [id, text] of originals) update.run(text, id)
    db.exec('UPDATE profile_state SET change_sequence=change_sequence+1 WHERE singleton=1')
    db.exec('PRAGMA user_version=9')
    db.exec('COMMIT')
    began = false
    return { recovered: originals.size, unavailable: notes.length - originals.size }
  } catch (error) {
    if (began) db.exec('ROLLBACK')
    throw error
  } finally { db.close() }
}

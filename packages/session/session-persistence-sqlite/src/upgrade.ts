/** Explicit offline copy-upgrade of the two integration input schemas. */

import { createHash } from 'node:crypto'
import { lstat, open, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isJsonValue, KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { bindRecord, decodeRow } from './compression.ts'
import { decodeEventRow, decodeSessionRow, decodeStoreIdentity, openDatabase, rowToMeta, SESSION_PERSISTENCE_SQLITE_APPLICATION_ID } from './schema.ts'
import { sql } from './sql.ts'

/** Offline conversion proof; no source file or deployment pointer is replaced. */
export interface SessionUpgradeReport {
  fromVersion: 16 | 17
  toVersion: 18
  sessionIds: string[]
  logicalEvents: number
  logicalSha256: string
}

/**
 * Copy a stopped, backed-up schema-16/17 store to a new schema-18 file.
 * @param sourcePath - absolute regular-file path; must have no live writers.
 * @param outputPath - absolute path in an existing directory; must not exist.
 * @returns IDs, logical event count, and matching source/output digest.
 * @throws on unknown schema, origin, corrupt events, existing output, or failed verification.
 */
export async function upgradeSessionDatabase(sourcePath: string, outputPath: string): Promise<SessionUpgradeReport> {
  if (!isAbsolute(sourcePath) || !isAbsolute(outputPath)) throw new Error('upgrade paths must be absolute')
  const stat = await lstat(sourcePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('upgrade source must be a regular non-symlink file')
  const source = await realpath(sourcePath)
  const output = resolve(await realpath(dirname(outputPath)), outputPath.slice(dirname(outputPath).length + 1))
  if (source.toLowerCase() === output.toLowerCase()) throw new Error('upgrade output must differ from source')
  const input = new DatabaseSync(source, { readOnly: true, timeout: 0 })
  let target: DatabaseSync | undefined
  let ownsOutput = false
  let completed = false
  try {
    input.exec(sql('trusted-schema-off'))
    input.exec(sql('begin'))
    const version = input.prepare(sql('select-user-version')).get()?.user_version
    if (version !== 16 && version !== 17) throw new Error(`unsupported upgrade schema ${String(version)}`)
    if (input.prepare(sql('select-application-id')).get()?.application_id !== SESSION_PERSISTENCE_SQLITE_APPLICATION_ID) {
      throw new Error('upgrade source has a foreign application identity')
    }
    validateLegacySchema(input, version)
    if (input.prepare(sql('upgrade-check-foreign-keys')).all().length > 0) throw new Error('upgrade source has foreign-key violations')
    const storeId = decodeStoreIdentity(input.prepare(sql('select-store-id')).get())
    const headers = input.prepare(sql('upgrade-select-sessions')).all().map((value) => {
      const { origin, ...rest } = value
      if (version === 17 && origin !== null && origin !== 'subagent') throw new Error(`unknown session origin ${String(origin)}`)
      const row = decodeSessionRow(version === 17 ? { ...rest, purpose: origin === 'subagent' ? 'subagent' : 'interactive' } : value)
      if (row.version !== SESSION_FORMAT_VERSION) throw new Error(`unsupported session format ${row.version}`)
      return row
    })
    // Exclusive creation prevents an offline operator from replacing an existing store.
    const reserved = await open(output, 'wx', 0o600)
    ownsOutput = true
    await reserved.close()
    target = await openDatabase(DatabaseSync, output, 'delete', 0)
    target.exec(sql('begin-immediate'))
    target.prepare(sql('upgrade-store-id')).run(storeId)
    const before = createHash('sha256')
    let logicalEvents = 0
    for (const header of headers) {
      target.prepare(sql('upsert-session')).run(header.id, header.version, header.created_at, header.cwd, header.parent_session,
        header.seed_length, header.purpose, header.delegation_depth, header.agent_preset, header.incarnation)
      target.prepare(sql('upgrade-session-revision')).run(header.revision, header.id)
      before.update(JSON.stringify(rowToMeta(header)))
      let nextSeq = 0
      for (const stored of input.prepare(sql('select-events')).iterate(header.id)) {
        const events = version === 16 ? [decodeLegacyEvent(stored)] : decodeRow(decodeEventRow(stored))
        for (const event of events) {
          verifyEvent(event, nextSeq++)
          before.update(JSON.stringify(event))
          logicalEvents++
        }
        if (version === 17) {
          const row = decodeEventRow(stored)
          target.prepare(sql('insert-event')).run(header.id, row.seq, row.type, row.time, row.data, row.source_event_seqs, row.surface_op, row.ignorable)
        } else {
          const row = bindRecord(decodeLegacyEvent(stored))
          target.prepare(sql('insert-event')).run(header.id, row.seq, row.type, row.time, row.data, row.sourceEventSeqs, row.surfaceOp, row.ignorable)
        }
      }
    }
    const after = createHash('sha256')
    for (const header of target.prepare(sql('upgrade-select-sessions')).all().map(decodeSessionRow)) {
      after.update(JSON.stringify(rowToMeta(header)))
      for (const stored of target.prepare(sql('select-events')).iterate(header.id)) {
        for (const event of decodeRow(decodeEventRow(stored))) after.update(JSON.stringify(event))
      }
    }
    const logicalSha256 = before.digest('hex')
    if (after.digest('hex') !== logicalSha256) throw new Error('upgraded logical history differs from source')
    target.exec(sql('commit'))
    completed = true
    return { fromVersion: version, toVersion: 18, sessionIds: headers.map(row => row.id), logicalEvents, logicalSha256 }
  } finally {
    target?.close()
    input.close()
    if (ownsOutput && !completed) await unlink(output)
  }
}

function validateLegacySchema(input: DatabaseSync, version: 16 | 17): void {
  const reference = new DatabaseSync(':memory:')
  try {
    reference.exec(sql(version === 16 ? 'legacy-schema-16' : 'legacy-schema-17'))
    const canonical = (db: DatabaseSync): string => JSON.stringify(db.prepare(sql('select-schema-objects')).all().map(row => ({
      ...row, sql: String(row.sql).replaceAll(/\s+/gu, ' ').trim(),
    })))
    if (canonical(input) !== canonical(reference)) throw new Error('upgrade source does not match its declared legacy schema')
  } finally { reference.close() }
}

function decodeLegacyEvent(value: Record<string, unknown>): SessionEvent {
  if (typeof value.data !== 'string' || (value.source_event_seqs !== null && typeof value.source_event_seqs !== 'string')
    || (value.surface_op !== null && typeof value.surface_op !== 'string') || (value.ignorable !== null && value.ignorable !== 1)) {
    throw new Error('invalid schema-16 event fields')
  }
  const event = {
    type: value.type, seq: value.seq, time: value.time, data: parseJson(value.data),
    ...(value.source_event_seqs === null ? {} : { sourceEventSeqs: parseJson(value.source_event_seqs) }),
    ...(value.surface_op === null ? {} : { surfaceOp: parseJson(value.surface_op) }),
    ...(value.ignorable === 1 ? { ignorable: true } : {}),
  }
  // Envelope validation occurs before this durable value enters the current codec.
  verifyEvent(event as SessionEvent, event.seq as number)
  return event as SessionEvent
}

function parseJson(value: string): unknown {
  const parsed: unknown = JSON.parse(value)
  return parsed
}

function verifyEvent(event: SessionEvent, expectedSeq: number): void {
  if (!Number.isSafeInteger(event.seq) || event.seq < 0 || event.seq !== expectedSeq || !Number.isSafeInteger(event.time)
    || typeof event.type !== 'string' || (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) || !isJsonValue(event.data)) {
    throw new Error(`invalid or discontinuous event at seq ${String(event.seq)}`)
  }
  if ('sourceEventSeqs' in event && (!Array.isArray(event.sourceEventSeqs)
    || event.sourceEventSeqs.some(seq => !Number.isSafeInteger(seq) || seq < 0 || seq >= event.seq))) {
    throw new Error(`invalid source event references at seq ${event.seq}`)
  }
}

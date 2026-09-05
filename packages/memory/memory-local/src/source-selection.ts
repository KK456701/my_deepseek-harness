/** Stable Session feedback and complete automatic-source selection. @module @deepseek-ai/dsh-memory-local/source-selection */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/** Immutable version of a selected Session rollout. */
export interface SelectedSource {
  readonly sessionId: string
  readonly rangeId: string
  readonly version: string
}

/**
 * Hash immutable extraction outputs without depending on usage or processing status.
 * @param db - Owning Store connection.
 * @param rangeId - Registered source range.
 * @returns Content fingerprint for all unsuppressed outputs in stable order.
 */
export function sourceOutputFingerprint(db: DatabaseSync, rangeId: string): string {
  const rows = db.prepare(`SELECT id,raw_memory,rollout_summary,rollout_slug,body,evidence_ids_json
    FROM candidates WHERE source_range_id=? AND status!='suppressed' ORDER BY output_index,id`).all(rangeId)
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

/**
 * Rank all valid sources, then emit the selected set in stable source order.
 * @param db - Owning Store connection in a claim transaction.
 * @param policyVersion - Accepted source policy.
 * @param expiryBefore - Unused source cutoff, inclusive sources remain eligible.
 * @param limit - Whole automatic-source set capacity; notes are separate.
 * @returns Latest valid complete rollout per Session with frozen output fingerprints.
 */
export function selectAutomaticSources(db: DatabaseSync, policyVersion: number, expiryBefore: number, limit: number): SelectedSource[] {
  const rows = db.prepare(`WITH valid AS (
    SELECT r.*,ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY to_seq DESC,completed_at DESC,id DESC) AS version_rank
    FROM source_ranges r WHERE status='succeeded' AND policy_version=?
  ) SELECT r.id,r.session_id FROM valid r LEFT JOIN session_source_usage u ON u.session_id=r.session_id
    WHERE version_rank=1 AND COALESCE(u.last_adopted_at,r.completed_at)>=?
      AND EXISTS (SELECT 1 FROM candidates c WHERE c.source_range_id=r.id AND c.status!='suppressed')
    ORDER BY COALESCE(u.adopted_count,0) DESC,COALESCE(u.last_adopted_at,r.completed_at) DESC,
      r.completed_at DESC,r.id ASC LIMIT ?`).all(policyVersion, expiryBefore, limit) as Array<{ id: string; session_id: string }>
  return rows.sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map(row => ({ sessionId: row.session_id, rangeId: row.id, version: sourceOutputFingerprint(db, row.id) }))
}

/**
 * Read the last published input set independently of the model's adoption decisions.
 * @param db - Owning Store connection.
 * @param generationId - Current published generation, if any.
 * @returns Persisted selected versions; legacy jobs replay their baseline input diffs.
 */
export function previousAutomaticSources(db: DatabaseSync, generationId: string | null): SelectedSource[] {
  if (generationId === null) return []
  const diffs: Array<{ added: string[]; retained: string[]; removed: string[]; updated?: string[] }> = []
  const visited = new Set<string>()
  let cursor: string | null = generationId
  const sources = new Map<string, SelectedSource>()
  while (cursor !== null) {
    if (visited.has(cursor)) throw new Error('memory generation baseline contains a cycle')
    visited.add(cursor)
    const job = db.prepare(`SELECT j.source_diff_json,j.selection_fingerprint,j.baseline_generation_id FROM phase2_jobs j
      JOIN generations g ON g.phase2_job_id=j.id WHERE g.id=?`).get(cursor) as
      { source_diff_json: string; selection_fingerprint: string | null; baseline_generation_id: string | null } | undefined
    if (job === undefined) break
    if (job.selection_fingerprint !== null) {
      const rows = db.prepare(`SELECT s.session_id AS sessionId,s.source_range_id AS rangeId,s.version_fingerprint AS version
        FROM phase2_selected_sources s JOIN generations g ON g.phase2_job_id=s.job_id WHERE g.id=?`)
        .all(cursor) as unknown as SelectedSource[]
      for (const source of rows) sources.set(source.sessionId, source)
      break
    }
    diffs.push(JSON.parse(job.source_diff_json) as typeof diffs[number])
    cursor = job.baseline_generation_id
  }
  // Legacy retained lists contain adopted evidence, not every previously selected input.
  for (const diff of diffs.reverse()) {
    for (const [sessionId, source] of sources) if (diff.removed.includes(source.rangeId)) sources.delete(sessionId)
    for (const rangeId of new Set([...diff.added, ...diff.retained, ...diff.updated ?? []])) {
      const row = db.prepare('SELECT session_id FROM source_ranges WHERE id=?').get(rangeId) as { session_id: string } | undefined
      if (row !== undefined) {
        sources.set(row.session_id, { sessionId: row.session_id, rangeId, version: sourceOutputFingerprint(db, rangeId) })
      }
    }
  }
  return [...sources.values()].sort((a,b) => a.rangeId < b.rangeId ? -1 : a.rangeId > b.rangeId ? 1 : 0)
}

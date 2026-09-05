/** SQLite schema and ownership checks for the local memory pipeline. @module @deepseek-ai/dsh-memory-local/schema */

import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

/** Current incompatible on-disk memory schema. */
export const MEMORY_SCHEMA_VERSION = 10
/** SQLite application id for DSH memory state (`DSHM`). */
export const MEMORY_APPLICATION_ID = 0x4453484d

/**
 * Open and validate one memory-state database.
 * @param path - Absolute SQLite database path below the profile memory root.
 * @returns The configured connection after schema ownership and version checks.
 */
export function openMemoryDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  let began = false
  try {
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('PRAGMA busy_timeout = 25')
    const prior = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const identity = db.prepare('PRAGMA application_id').get() as { application_id: number }
    if (prior.user_version > 0 && prior.user_version < MEMORY_SCHEMA_VERSION && identity.application_id === MEMORY_APPLICATION_ID) {
      // VACUUM INTO is a consistent SQLite snapshot, including committed WAL pages.
      const backup = `${path}.before-v${MEMORY_SCHEMA_VERSION}-${randomUUID()}.bak`
      db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`)
    }
    db.exec('BEGIN IMMEDIATE')
    began = true
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").get() as { count: number }
    if (version === 0 && (applicationId !== 0 || count > 0)) {
      throw new Error(`memory database at "${path}" has an unversioned schema or application identity`)
    }
    if (![0, 3, 4, 5, 6, 7, 9, MEMORY_SCHEMA_VERSION].includes(version)) {
      throw new Error(`memory database at "${path}" has schema version ${version}, incompatible with this build (${MEMORY_SCHEMA_VERSION})`)
    }
    if (version !== 0 && applicationId !== MEMORY_APPLICATION_ID) {
      throw new Error(`memory database at "${path}" belongs to another application`)
    }
    installSchema(db)
    installVersionFiveColumns(db)
    const rebuildColumns = (db.prepare('PRAGMA table_info(memory_rebuilds)').all() as Array<{ name: string }>).map(row => row.name)
    if (!rebuildColumns.includes('source_completed_after')) db.exec('ALTER TABLE memory_rebuilds ADD COLUMN source_completed_after INTEGER NOT NULL DEFAULT 0 CHECK (source_completed_after >= 0)')
    if (!rebuildColumns.includes('explicit_note_policy')) db.exec("ALTER TABLE memory_rebuilds ADD COLUMN explicit_note_policy TEXT NOT NULL DEFAULT 'preserve-active' CHECK (explicit_note_policy IN ('preserve-active','purge-all'))")
    if (version !== 0 && version < 6) installVersionSixSourceRanges(db)
    installVersionTen(db, version)
    if (version === 0) {
      db.exec(`PRAGMA application_id = ${MEMORY_APPLICATION_ID}`)
    }
    if (version !== MEMORY_SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`)
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all()
    if (foreignKeyViolations.length > 0) {
      throw new Error(`memory database at "${path}" failed foreign-key validation after schema installation`)
    }
    db.exec('COMMIT')
    began = false
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = FULL')
    return db
  } catch (error: unknown) {
    if (began) {
      try { db.exec('ROLLBACK') } catch { /* Preserve the original schema failure. */ }
    }
    db.close()
    throw error
  }
}

function installVersionTen(db: DatabaseSync, version: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_source_usage (
    session_id TEXT PRIMARY KEY, adopted_count INTEGER NOT NULL CHECK(adopted_count>=1),
    last_adopted_at INTEGER NOT NULL CHECK(last_adopted_at>=0)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS phase2_selected_sources (
    job_id TEXT NOT NULL REFERENCES phase2_jobs(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL, source_range_id TEXT NOT NULL, version_fingerprint TEXT NOT NULL,
    PRIMARY KEY(job_id,session_id)
  ) STRICT;`)
  const columns = (db.prepare('PRAGMA table_info(phase2_jobs)').all() as Array<{ name: string }>).map(row => row.name)
  if (!columns.includes('selection_fingerprint')) db.exec('ALTER TABLE phase2_jobs ADD COLUMN selection_fingerprint TEXT')
  const attempts = (db.prepare('PRAGMA table_info(phase1_attempts)').all() as Array<{ name: string }>).map(row => row.name)
  if (!attempts.includes('output_format_version')) db.exec('ALTER TABLE phase1_attempts ADD COLUMN output_format_version INTEGER NOT NULL DEFAULT 1 CHECK(output_format_version IN (1,2))')
  if (version !== 0 && version < 10) {
    db.exec(`INSERT INTO session_source_usage SELECT r.session_id,SUM(u.adopted_count),MAX(u.last_adopted_at)
      FROM source_usage u JOIN source_ranges r ON u.source_id='source:'||r.id GROUP BY r.session_id;
      UPDATE runtime_settings SET values_json=json_remove(json_set(values_json,
        '$.maxPhase2Sources',json_extract(values_json,'$.maxPhase2Candidates'),'$.phase1Concurrency',2),
        '$.maxPhase2Candidates') WHERE json_type(values_json,'$.maxPhase2Candidates') IS NOT NULL;`)
  }
}

function installSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      inject_default INTEGER NOT NULL CHECK (inject_default IN (0, 1)),
      contribute_default INTEGER NOT NULL CHECK (contribute_default IN (0, 1)),
      change_sequence INTEGER NOT NULL CHECK (change_sequence >= 0),
      publish_sequence INTEGER NOT NULL CHECK (publish_sequence >= 0),
      current_generation_id TEXT,
      current_publish_sequence INTEGER CHECK (current_publish_sequence IS NULL OR current_publish_sequence >= 1),
      memory_epoch INTEGER NOT NULL DEFAULT 0 CHECK (memory_epoch >= 0),
      control_revision INTEGER NOT NULL DEFAULT 0 CHECK (control_revision >= 0),
      configured INTEGER NOT NULL DEFAULT 0 CHECK (configured IN (0,1))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS session_controls (
      session_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      inject TEXT NOT NULL CHECK (inject IN ('inherit', 'allow', 'deny')),
      contribute TEXT NOT NULL CHECK (contribute IN ('inherit', 'allow', 'deny')),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS source_ranges (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      from_seq INTEGER NOT NULL CHECK (from_seq >= 0),
      to_seq INTEGER NOT NULL CHECK (to_seq >= from_seq),
      completed_at INTEGER NOT NULL CHECK (completed_at >= 0),
      workspace_id TEXT,
      workspace_path TEXT,
      policy_version INTEGER NOT NULL CHECK (policy_version >= 0),
      input_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','leased','retry_wait','succeeded','quarantined','cancelled')),
      owner_token TEXT,
      leased_until INTEGER,
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      next_attempt_at INTEGER,
      quarantine_id TEXT UNIQUE,
      terminal_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_memory_source_due ON source_ranges(status, next_attempt_at, completed_at);
    CREATE TABLE IF NOT EXISTS phase1_attempts (
      id TEXT PRIMARY KEY,
      source_range_id TEXT NOT NULL REFERENCES source_ranges(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      owner_token TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('opened','request_logged','result_logged','applied','failed')),
      request_fingerprint TEXT,
      request_json TEXT,
      request_bytes INTEGER CHECK (request_bytes IS NULL OR request_bytes >= 0),
      result_json TEXT,
      result_bytes INTEGER CHECK (result_bytes IS NULL OR result_bytes >= 0),
      result_chunks INTEGER CHECK (result_chunks IS NULL OR result_chunks >= 0),
      termination TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      UNIQUE (source_range_id, attempt)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      source_range_id TEXT NOT NULL REFERENCES source_ranges(id) ON DELETE CASCADE,
      output_index INTEGER NOT NULL CHECK (output_index >= 0),
      body TEXT NOT NULL,
      kind TEXT NOT NULL,
      keywords_json TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL,
      raw_memory TEXT,
      rollout_summary TEXT,
      rollout_slug TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending','claimed','consumed','suppressed')),
      phase2_job_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (source_range_id, output_index)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_memory_candidates_pending ON candidates(status, created_at, id);
    CREATE TABLE IF NOT EXISTS phase2_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('leased','session_running','validating','materializing','prepared','pointer_published','finalized','retry_wait','stale','quarantined','cancelled')),
      owner_token TEXT NOT NULL,
      leased_until INTEGER NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      input_fingerprint TEXT NOT NULL,
      baseline_generation_id TEXT,
      source_diff_json TEXT NOT NULL DEFAULT '{"added":[],"retained":[],"removed":[]}',
      next_attempt_at INTEGER,
      workspace_id TEXT,
      maintenance_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_memory_phase2_due ON phase2_jobs(status, next_attempt_at, leased_until);
    CREATE TABLE IF NOT EXISTS maintenance_sessions (
      id TEXT PRIMARY KEY,
      phase2_job_id TEXT NOT NULL REFERENCES phase2_jobs(id) ON DELETE CASCADE,
      header_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('allocated','live','completed','failed','pruned')),
      event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
      total_bytes INTEGER NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS maintenance_session_events (
      session_id TEXT NOT NULL REFERENCES maintenance_sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL CHECK (seq >= 0),
      type TEXT NOT NULL,
      event_json TEXT NOT NULL,
      bytes INTEGER NOT NULL CHECK (bytes >= 0),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_memory_maintenance_retention ON maintenance_sessions(status, finished_at);
    CREATE TABLE IF NOT EXISTS phase2_job_candidates (
      job_id TEXT NOT NULL REFERENCES phase2_jobs(id) ON DELETE CASCADE,
      candidate_id TEXT NOT NULL REFERENCES candidates(id),
      PRIMARY KEY (job_id, candidate_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS phase2_job_notes (
      job_id TEXT NOT NULL REFERENCES phase2_jobs(id) ON DELETE CASCADE,
      note_id TEXT NOT NULL REFERENCES ad_hoc_notes(id),
      PRIMARY KEY (job_id, note_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS phase2_workspaces (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE REFERENCES phase2_jobs(id) ON DELETE CASCADE,
      root TEXT NOT NULL UNIQUE,
      input_fingerprint TEXT NOT NULL,
      readonly_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY,
      materializing_id TEXT NOT NULL UNIQUE,
      publish_sequence INTEGER NOT NULL UNIQUE CHECK (publish_sequence >= 1),
      parent_generation_id TEXT,
      phase2_job_id TEXT NOT NULL REFERENCES phase2_jobs(id),
      status TEXT NOT NULL CHECK (status IN ('materializing','prepared','published','finalized','abandoned')),
      root TEXT NOT NULL UNIQUE,
      manifest_sha256 TEXT,
      total_bytes INTEGER CHECK (total_bytes IS NULL OR total_bytes >= 0),
      created_at INTEGER NOT NULL,
      published_at INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS read_leases (
      id TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL REFERENCES generations(id),
      owner TEXT NOT NULL,
      leased_until INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_memory_read_leases_expiry ON read_leases(leased_until);
    CREATE TABLE IF NOT EXISTS ad_hoc_notes (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      status TEXT NOT NULL CHECK (status IN ('pending','claimed','participated','superseded','cancelled')),
      text TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT 'remember' CHECK (action IN ('remember','update','forget')),
      processing_status TEXT NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending','claimed','applied','partial','unresolved','failed')),
      authority_status TEXT NOT NULL DEFAULT 'active' CHECK (authority_status IN ('active','superseded','cleared')),
      content TEXT NOT NULL DEFAULT '',
      target TEXT,
      origin TEXT NOT NULL DEFAULT 'ui' CHECK (origin IN ('ui','conversation')),
      source_session_id TEXT,
      source_turn TEXT,
      source_user_event_seq INTEGER CHECK (source_user_event_seq IS NULL OR source_user_event_seq >= 0),
      source_user_text TEXT,
      disposition TEXT,
      claimed_job_id TEXT,
      participated_generation_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_memory_notes_status ON ad_hoc_notes(status, created_at, id);
    CREATE TABLE IF NOT EXISTS failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phase TEXT NOT NULL CHECK (phase IN ('phase1','phase2')),
      job_id TEXT NOT NULL,
      attempt_id TEXT,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS generation_file_usage (
      generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      adopted_count INTEGER NOT NULL CHECK (adopted_count >= 1),
      last_adopted_at INTEGER NOT NULL CHECK (last_adopted_at >= 0),
      PRIMARY KEY (generation_id, path)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS source_usage (
      source_id TEXT PRIMARY KEY,
      adopted_count INTEGER NOT NULL CHECK (adopted_count >= 1),
      last_adopted_at INTEGER NOT NULL CHECK (last_adopted_at >= 0)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS generation_sources (
      generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      PRIMARY KEY (generation_id, source_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS session_clear_watermarks (
      session_id TEXT PRIMARY KEY,
      clear_through_seq INTEGER NOT NULL CHECK (clear_through_seq >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS runtime_settings (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      values_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS memory_rebuilds (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('queued','purging-old-state','scanning','extracting','waiting-for-idle','consolidating','validating','published','failed','cancelled')),
      target_policy_version INTEGER NOT NULL CHECK (target_policy_version >= 1),
      template_version TEXT NOT NULL,
      total_sessions INTEGER NOT NULL DEFAULT 0 CHECK (total_sessions >= 0),
      scanned_sessions INTEGER NOT NULL DEFAULT 0 CHECK (scanned_sessions >= 0),
      scan_cursor INTEGER NOT NULL DEFAULT 0 CHECK (scan_cursor >= 0),
      extracted_sessions INTEGER NOT NULL DEFAULT 0 CHECK (extracted_sessions >= 0),
      empty_sessions INTEGER NOT NULL DEFAULT 0 CHECK (empty_sessions >= 0),
      failed_sessions INTEGER NOT NULL DEFAULT 0 CHECK (failed_sessions >= 0),
      waiting_sessions INTEGER NOT NULL DEFAULT 0 CHECK (waiting_sessions >= 0),
      model_calls INTEGER NOT NULL DEFAULT 0 CHECK (model_calls >= 0),
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_memory_rebuild_active ON memory_rebuilds(status, created_at);
    CREATE TABLE IF NOT EXISTS phase2_structured_attempts (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES phase2_jobs(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL,
      owner_token TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('request_logged','result_logged','applied','failed')),
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      UNIQUE(job_id, attempt)
    ) STRICT;
  `)
  db.prepare(`INSERT OR IGNORE INTO profile_state
    (singleton, enabled, inject_default, contribute_default, change_sequence, publish_sequence)
    VALUES (1, 0, 1, 1, 0, 0)`).run()
}

function installVersionFiveColumns(db: DatabaseSync): void {
  const columns = (table: string): Set<string> => new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name),
  )
  const profile = columns('profile_state')
  if (!profile.has('memory_epoch')) db.exec('ALTER TABLE profile_state ADD COLUMN memory_epoch INTEGER NOT NULL DEFAULT 0 CHECK (memory_epoch >= 0)')
  if (!profile.has('control_revision')) db.exec('ALTER TABLE profile_state ADD COLUMN control_revision INTEGER NOT NULL DEFAULT 0 CHECK (control_revision >= 0)')
  if (!profile.has('configured')) db.exec('ALTER TABLE profile_state ADD COLUMN configured INTEGER NOT NULL DEFAULT 0 CHECK (configured IN (0,1))')
  const candidates = columns('candidates')
  if (!candidates.has('raw_memory')) db.exec('ALTER TABLE candidates ADD COLUMN raw_memory TEXT')
  if (!candidates.has('rollout_summary')) db.exec('ALTER TABLE candidates ADD COLUMN rollout_summary TEXT')
  if (!candidates.has('rollout_slug')) db.exec('ALTER TABLE candidates ADD COLUMN rollout_slug TEXT')
  const phase2 = columns('phase2_jobs')
  if (!phase2.has('source_diff_json')) db.exec("ALTER TABLE phase2_jobs ADD COLUMN source_diff_json TEXT NOT NULL DEFAULT '{\"added\":[],\"retained\":[],\"removed\":[]}'")
  const notes = columns('ad_hoc_notes')
  if (!notes.has('action')) db.exec("ALTER TABLE ad_hoc_notes ADD COLUMN action TEXT NOT NULL DEFAULT 'remember' CHECK (action IN ('remember','update','forget'))")
  if (!notes.has('processing_status')) db.exec("ALTER TABLE ad_hoc_notes ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending','claimed','applied','partial','unresolved','failed'))")
  if (!notes.has('authority_status')) db.exec("ALTER TABLE ad_hoc_notes ADD COLUMN authority_status TEXT NOT NULL DEFAULT 'active' CHECK (authority_status IN ('active','superseded','cleared'))")
  if (!notes.has('content')) {
    db.exec("ALTER TABLE ad_hoc_notes ADD COLUMN content TEXT NOT NULL DEFAULT ''")
    db.exec('UPDATE ad_hoc_notes SET content=text WHERE content=\'\'')
  }
  if (!notes.has('target')) db.exec('ALTER TABLE ad_hoc_notes ADD COLUMN target TEXT')
  if (!notes.has('origin')) db.exec("ALTER TABLE ad_hoc_notes ADD COLUMN origin TEXT NOT NULL DEFAULT 'ui' CHECK (origin IN ('ui','conversation'))")
  if (!notes.has('source_session_id')) db.exec('ALTER TABLE ad_hoc_notes ADD COLUMN source_session_id TEXT')
  if (!notes.has('source_turn')) db.exec('ALTER TABLE ad_hoc_notes ADD COLUMN source_turn TEXT')
  if (!notes.has('source_user_event_seq')) db.exec('ALTER TABLE ad_hoc_notes ADD COLUMN source_user_event_seq INTEGER CHECK (source_user_event_seq IS NULL OR source_user_event_seq >= 0)')
  if (!notes.has('disposition')) db.exec('ALTER TABLE ad_hoc_notes ADD COLUMN disposition TEXT')
  if (!notes.has('source_user_text')) db.exec('ALTER TABLE ad_hoc_notes ADD COLUMN source_user_text TEXT')
}

function installVersionSixSourceRanges(db: DatabaseSync): void {
  db.exec(`
    PRAGMA legacy_alter_table = ON;
    ALTER TABLE source_ranges RENAME TO source_ranges_pre_v6;
    CREATE TABLE source_ranges (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      from_seq INTEGER NOT NULL CHECK (from_seq >= 0),
      to_seq INTEGER NOT NULL CHECK (to_seq >= from_seq),
      completed_at INTEGER NOT NULL CHECK (completed_at >= 0),
      workspace_id TEXT,
      workspace_path TEXT,
      policy_version INTEGER NOT NULL CHECK (policy_version >= 0),
      input_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','leased','retry_wait','succeeded','quarantined','cancelled')),
      owner_token TEXT,
      leased_until INTEGER,
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      next_attempt_at INTEGER,
      quarantine_id TEXT UNIQUE,
      terminal_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO source_ranges SELECT * FROM source_ranges_pre_v6;
    DROP TABLE source_ranges_pre_v6;
    CREATE INDEX idx_memory_source_due ON source_ranges(status, next_attempt_at, completed_at);
    PRAGMA legacy_alter_table = OFF;
  `)
}

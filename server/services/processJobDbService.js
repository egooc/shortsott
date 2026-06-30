const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { PROJECT_ROOT, readJsonIfExists } = require('./pipelinePaths');

const DB_PATH = path.join(PROJECT_ROOT, 'server', 'data', 'process_jobs.db');

let db = null;
let migrated = false;

function ensureDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS process_jobs (
      job_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued',
      stage TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      batch_name TEXT,
      worker_pid INTEGER,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      item_count INTEGER NOT NULL DEFAULT 0,
      job_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS process_job_logs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      time TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      item_id TEXT,
      message TEXT NOT NULL,
      FOREIGN KEY(job_id) REFERENCES process_jobs(job_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS process_job_items (
      job_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      stage TEXT,
      source_download_status TEXT,
      metadata_status TEXT,
      draft_status TEXT,
      updated_at TEXT,
      status_json TEXT NOT NULL,
      PRIMARY KEY(job_id, item_id),
      FOREIGN KEY(job_id) REFERENCES process_jobs(job_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_process_jobs_status ON process_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_process_jobs_created_at ON process_jobs(created_at);
    CREATE INDEX IF NOT EXISTS idx_process_job_logs_job_time ON process_job_logs(job_id, time);
  `);
  return db;
}

function normalizeJob(job = {}) {
  return {
    ...job,
    logs: Array.isArray(job.logs) ? job.logs : [],
    item_statuses: job.item_statuses && typeof job.item_statuses === 'object' ? job.item_statuses : {}
  };
}

function upsertJob(job) {
  if (!job?.job_id) return null;
  const database = ensureDb();
  const normalized = normalizeJob(job);
  const json = JSON.stringify(normalized);
  const itemCount = Array.isArray(normalized.item_ids) ? normalized.item_ids.length : Object.keys(normalized.item_statuses).length;

  const tx = database.transaction(() => {
    database.prepare(`
      INSERT INTO process_jobs (
        job_id, status, stage, created_at, updated_at, started_at, finished_at,
        batch_name, worker_pid, cancel_requested, item_count, job_json
      ) VALUES (
        @job_id, @status, @stage, @created_at, @updated_at, @started_at, @finished_at,
        @batch_name, @worker_pid, @cancel_requested, @item_count, @job_json
      )
      ON CONFLICT(job_id) DO UPDATE SET
        status = excluded.status,
        stage = excluded.stage,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        batch_name = excluded.batch_name,
        worker_pid = excluded.worker_pid,
        cancel_requested = excluded.cancel_requested,
        item_count = excluded.item_count,
        job_json = excluded.job_json
    `).run({
      job_id: normalized.job_id,
      status: normalized.status || 'queued',
      stage: normalized.stage || 'queued',
      created_at: normalized.created_at || normalized.updated_at || new Date().toISOString(),
      updated_at: normalized.updated_at || new Date().toISOString(),
      started_at: normalized.started_at || '',
      finished_at: normalized.finished_at || '',
      batch_name: normalized.batch_name || '',
      worker_pid: Number(normalized.worker_pid || 0) || null,
      cancel_requested: normalized.cancel_requested ? 1 : 0,
      item_count: itemCount,
      job_json: json
    });

    database.prepare('DELETE FROM process_job_logs WHERE job_id = ?').run(normalized.job_id);
    const insertLog = database.prepare(`
      INSERT OR REPLACE INTO process_job_logs (id, job_id, time, level, item_id, message)
      VALUES (@id, @job_id, @time, @level, @item_id, @message)
    `);
    for (const log of normalized.logs.slice(-500)) {
      insertLog.run({
        id: String(log.id || `${Date.now()}_${Math.random().toString(16).slice(2)}`),
        job_id: normalized.job_id,
        time: String(log.time || normalized.updated_at || new Date().toISOString()),
        level: String(log.level || 'info'),
        item_id: String(log.item_id || log.itemId || ''),
        message: String(log.message || '')
      });
    }

    database.prepare('DELETE FROM process_job_items WHERE job_id = ?').run(normalized.job_id);
    const insertItem = database.prepare(`
      INSERT OR REPLACE INTO process_job_items (
        job_id, item_id, stage, source_download_status, metadata_status,
        draft_status, updated_at, status_json
      ) VALUES (
        @job_id, @item_id, @stage, @source_download_status, @metadata_status,
        @draft_status, @updated_at, @status_json
      )
    `);
    for (const [itemId, status] of Object.entries(normalized.item_statuses)) {
      insertItem.run({
        job_id: normalized.job_id,
        item_id: itemId,
        stage: status.stage || '',
        source_download_status: status.source_download_status || '',
        metadata_status: status.metadata_status || '',
        draft_status: status.draft_status || '',
        updated_at: status.updated_at || normalized.updated_at || '',
        status_json: JSON.stringify(status)
      });
    }
  });

  tx();
  return normalized;
}

function parseJobRow(row) {
  if (!row) return null;
  try {
    return normalizeJob(JSON.parse(row.job_json));
  } catch {
    return null;
  }
}

function getJob(jobId) {
  const row = ensureDb().prepare('SELECT job_json FROM process_jobs WHERE job_id = ?').get(jobId);
  return parseJobRow(row);
}

function listJobs() {
  return ensureDb()
    .prepare('SELECT job_json FROM process_jobs ORDER BY created_at DESC, updated_at DESC')
    .all()
    .map(parseJobRow)
    .filter(Boolean);
}

function getJobLogs(jobId, limit = 200) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
  return ensureDb()
    .prepare(`
      SELECT id, time, level, item_id, message
      FROM process_job_logs
      WHERE job_id = ?
      ORDER BY time DESC
      LIMIT ?
    `)
    .all(jobId, safeLimit)
    .reverse();
}

function getJobItemStatuses(jobId) {
  return ensureDb()
    .prepare(`
      SELECT item_id, status_json
      FROM process_job_items
      WHERE job_id = ?
      ORDER BY item_id ASC
    `)
    .all(jobId)
    .reduce((acc, row) => {
      try {
        acc[row.item_id] = JSON.parse(row.status_json);
      } catch {
        acc[row.item_id] = { item_id: row.item_id, status: 'unknown' };
      }
      return acc;
    }, {});
}

function migrateJsonJobsToDb(jobsRoot) {
  if (migrated) return { migrated: 0, skipped: 0 };
  migrated = true;
  ensureDb();
  if (!fs.existsSync(jobsRoot)) return { migrated: 0, skipped: 0 };
  let migratedCount = 0;
  let skipped = 0;
  for (const entry of fs.readdirSync(jobsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jobPath = path.join(jobsRoot, entry.name, 'job.json');
    const job = readJsonIfExists(jobPath);
    if (!job?.job_id) {
      skipped += 1;
      continue;
    }
    if (!getJob(job.job_id)) migratedCount += 1;
    upsertJob(job);
  }
  return { migrated: migratedCount, skipped };
}

module.exports = {
  DB_PATH,
  ensureDb,
  upsertJob,
  getJob,
  listJobs,
  getJobLogs,
  getJobItemStatuses,
  migrateJsonJobsToDb
};

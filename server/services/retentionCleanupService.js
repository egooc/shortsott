// Retention sweep for disposable pipeline byproducts. Runs after a batch job
// reaches a terminal state (processJobService runJob finally) and once at
// server startup, so crashed workers still get cleaned up eventually.
//
// Deliberately conservative — it only ever touches two things:
//   1. server/output/drafts/process_<epoch>/ staging drafts older than
//      DRAFT_STAGING_RETENTION_HOURS (default 24). These are throwaway build
//      copies: the shipped draft is copied to the user's CapCut output root
//      during the same job, and the upload path reads only from there.
//      The age guard keeps any concurrently-running job's staging safe.
//   2. queue/process/item_*/item_config.backup.*.json trimmed to the newest
//      ITEM_CONFIG_BACKUP_KEEP (default 3) per item. item_config.json itself
//      is never touched.
//
// It must never touch: source videos (source_clean/source_aux/*.part),
// analysis results inside item_config.json, the CapCut output root,
// process_jobs.db, or asset folders (bgm/channel_asset/...).
//
// Fail-open: errors are collected into the summary, never thrown — a failed
// sweep must not affect job status. Kill switch: PROCESS_RETENTION_SWEEP=0.

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '../..');
const DRAFT_STAGING_ROOT = path.join(PROJECT_ROOT, 'server', 'output', 'drafts');
const QUEUE_ROOT = path.join(PROJECT_ROOT, 'queue', 'process');

const STAGING_DRAFT_DIR_RE = /^process_\d+$/;
const ITEM_DIR_RE = /^item_[A-Za-z0-9_]+$/;
const ITEM_CONFIG_BACKUP_RE = /^item_config\.backup\..+\.json$/;

const DEFAULT_RETENTION_HOURS = 24;
const DEFAULT_BACKUP_KEEP = 3;

function isDisabled() {
  return ['0', 'false', 'off'].includes(
    String(process.env.PROCESS_RETENTION_SWEEP || '').trim().toLowerCase()
  );
}

function retentionHours() {
  const parsed = Number(process.env.DRAFT_STAGING_RETENTION_HOURS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_HOURS;
}

function backupKeepCount() {
  const parsed = Number(process.env.ITEM_CONFIG_BACKUP_KEEP);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_BACKUP_KEEP;
}

function dirSizeBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    try {
      total += entry.isDirectory() ? dirSizeBytes(fullPath) : fs.statSync(fullPath).size;
    } catch { /* raced with deletion */ }
  }
  return total;
}

function sweepStagingDrafts(nowMs, errors) {
  let removedDirs = 0;
  let freedBytes = 0;
  if (!fs.existsSync(DRAFT_STAGING_ROOT)) {
    return { removedDirs, freedBytes };
  }
  const maxAgeMs = retentionHours() * 3600 * 1000;
  for (const name of fs.readdirSync(DRAFT_STAGING_ROOT)) {
    if (!STAGING_DRAFT_DIR_RE.test(name)) continue;
    const dirPath = path.join(DRAFT_STAGING_ROOT, name);
    try {
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) continue;
      if (nowMs - stat.mtimeMs <= maxAgeMs) continue;
      const bytes = dirSizeBytes(dirPath);
      fs.rmSync(dirPath, { recursive: true, force: true });
      removedDirs += 1;
      freedBytes += bytes;
    } catch (error) {
      errors.push(`staging ${name}: ${error.message}`);
    }
  }
  return { removedDirs, freedBytes };
}

function trimItemConfigBackups(errors) {
  let removedFiles = 0;
  let freedBytes = 0;
  if (!fs.existsSync(QUEUE_ROOT)) {
    return { removedFiles, freedBytes };
  }
  const keep = backupKeepCount();
  for (const name of fs.readdirSync(QUEUE_ROOT)) {
    if (!ITEM_DIR_RE.test(name)) continue;
    const itemDir = path.join(QUEUE_ROOT, name);
    try {
      if (!fs.statSync(itemDir).isDirectory()) continue;
      const backups = fs.readdirSync(itemDir)
        .filter((file) => ITEM_CONFIG_BACKUP_RE.test(file))
        .map((file) => {
          const fullPath = path.join(itemDir, file);
          return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs, size: fs.statSync(fullPath).size };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const backup of backups.slice(keep)) {
        fs.rmSync(backup.fullPath, { force: true });
        removedFiles += 1;
        freedBytes += backup.size;
      }
    } catch (error) {
      errors.push(`backups ${name}: ${error.message}`);
    }
  }
  return { removedFiles, freedBytes };
}

function runRetentionSweep({ nowMs = Date.now() } = {}) {
  const summary = {
    enabled: !isDisabled(),
    removed_draft_dirs: 0,
    trimmed_backups: 0,
    freed_bytes: 0,
    errors: []
  };
  if (!summary.enabled) return summary;
  const drafts = sweepStagingDrafts(nowMs, summary.errors);
  const backups = trimItemConfigBackups(summary.errors);
  summary.removed_draft_dirs = drafts.removedDirs;
  summary.trimmed_backups = backups.removedFiles;
  summary.freed_bytes = drafts.freedBytes + backups.freedBytes;
  return summary;
}

module.exports = {
  runRetentionSweep,
  __test__: {
    sweepStagingDrafts,
    trimItemConfigBackups,
    STAGING_DRAFT_DIR_RE,
    ITEM_CONFIG_BACKUP_RE,
    DEFAULT_RETENTION_HOURS,
    DEFAULT_BACKUP_KEEP
  }
};

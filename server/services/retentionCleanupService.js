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

// The header above assumed a shipped draft is self-contained once copied to the
// CapCut output root. It is not: the copied draft_content.json still points at
// absolute staging paths, so deleting the staging dir leaves CapCut opening the
// draft straight into "Couldn't find some of the imported media files" and the
// export automation can never run it. Measured 2026-08-15:
// 20260813-F-215210 lost all 18 media files this way and blocked the hourly
// export line until it was skipped by hand.
//
// So a staging dir stays as long as any draft that references it has not been
// exported yet. Once its mp4 exists, the staging copy is genuinely disposable.
function exportedDraftNames(root) {
  const names = new Set();
  const exportRoot = path.join(root, '_automation factory');
  // held/ holds exported videos that must not ship (duplicate source, script
  // held in review). They are exported, so their staging is disposable too.
  for (const dir of [exportRoot, path.join(exportRoot, 'uploaded'), path.join(exportRoot, 'held')]) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.toLowerCase().endsWith('.mp4')) continue;
      names.add(file.replace(/\.mp4$/i, '').replace(/\s*\(\d+\)$/, ''));
    }
  }
  return names;
}

function stagingDirsInUse(errors) {
  const inUse = new Set();
  let root = '';
  try {
    const queueConfig = JSON.parse(fs.readFileSync(path.join(QUEUE_ROOT, 'queue_config.json'), 'utf8'));
    root = String(queueConfig?.output?.output_root || queueConfig?.output?.capcut_draft_root || '').trim();
  } catch (error) {
    errors.push(`queue config: ${error.message}`);
  }
  if (!root || !fs.existsSync(root)) return inUse;

  const exported = exportedDraftNames(root);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '_automation factory') continue;
    if (exported.has(entry.name)) continue;
    const contentPath = path.join(root, entry.name, 'draft_content.json');
    if (!fs.existsSync(contentPath)) continue;
    try {
      const text = fs.readFileSync(contentPath, 'utf8');
      for (const match of text.matchAll(/process_\d+/g)) inUse.add(match[0]);
    } catch (error) {
      errors.push(`draft ${entry.name}: ${error.message}`);
    }
  }
  return inUse;
}

function sweepStagingDrafts(nowMs, errors) {
  let removedDirs = 0;
  let freedBytes = 0;
  if (!fs.existsSync(DRAFT_STAGING_ROOT)) {
    return { removedDirs, freedBytes };
  }
  const protectedDirs = stagingDirsInUse(errors);
  const maxAgeMs = retentionHours() * 3600 * 1000;
  for (const name of fs.readdirSync(DRAFT_STAGING_ROOT)) {
    if (!STAGING_DRAFT_DIR_RE.test(name)) continue;
    if (protectedDirs.has(name)) continue;
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

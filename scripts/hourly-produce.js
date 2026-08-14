// Hourly production of one unit of work (design 2026-08-15, user).
//
// The upload side drains a buffer of exported mp4s one video per hour, so this
// side only has to keep that buffer fed at the same pace. It does exactly one
// thing per run, in priority order:
//
//   1. If a shipped draft has no mp4 yet, export that draft. Exporting is the
//      step that actually adds to the buffer, and it is the serial one - CapCut
//      is driven through its GUI, so two exports can never overlap.
//   2. Otherwise analyse and build a draft for one queue item, which the next
//      run will export.
//
// Draft state is not recorded on the queue item, so "already exported" is read
// from the filesystem: a draft is done when an mp4 of the same name sits in the
// export dir or in uploaded/.
//
//   node scripts/hourly-produce.js [--dry-run]

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');
const DRAFTS_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
const EXPORT_DIR = path.join(DRAFTS_DIR, '_automation factory');
const UPLOADED_DIR = path.join(EXPORT_DIR, 'uploaded');
const QUEUE_DIR = path.join(ROOT, 'queue', 'process');
const EXPORT_TIMEOUT_MS = 15 * 60 * 1000;

function exportedNames() {
  const names = new Set();
  for (const dir of [EXPORT_DIR, UPLOADED_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.toLowerCase().endsWith('.mp4')) continue;
      names.add(name.replace(/\.mp4$/i, '').replace(/\s*\(\d+\)$/, ''));
    }
  }
  return names;
}

function pendingDrafts() {
  if (!fs.existsSync(DRAFTS_DIR)) return [];
  const done = exportedNames();
  return fs.readdirSync(DRAFTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '_automation factory')
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(DRAFTS_DIR, name, 'edit_manifest.json')))
    .filter((name) => !done.has(name))
    .sort();
}

function nextQueueItem() {
  if (!fs.existsSync(QUEUE_DIR)) return '';
  const ids = fs.readdirSync(QUEUE_DIR).filter((name) => /^item_/.test(name)).sort();
  for (const id of ids) {
    const configPath = path.join(QUEUE_DIR, id, 'item_config.json');
    if (!fs.existsSync(configPath)) continue;
    let config;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      continue;
    }
    // Untouched items only: 'success' already has a guide and the skip states
    // are decisions, not backlog.
    if (config.analysis_status) continue;
    if (!fs.existsSync(path.join(QUEUE_DIR, id, 'source_clean.mp4'))) continue;
    return id;
  }
  return '';
}

function main() {
  const dryRun = process.argv.includes('--dry-run');

  const pending = pendingDrafts();
  console.log(`pending drafts (no mp4 yet): ${pending.length}`);

  if (pending.length) {
    const target = pending[0];
    console.log(`export: ${target}`);
    if (dryRun) return;
    try {
      const out = execFileSync('python', [
        path.join(ROOT, 'scripts', 'capcut_export_one.py'),
        '--draft-name', target,
        '--export-dir', EXPORT_DIR
      ], { encoding: 'utf8', timeout: EXPORT_TIMEOUT_MS, windowsHide: false });
      console.log(String(out).trim().split('\n').slice(-2).join('\n'));
    } catch (error) {
      console.log(`export failed: ${String(error.message || error).slice(0, 200)}`);
      process.exitCode = 1;
    }
    return;
  }

  const itemId = nextQueueItem();
  if (!itemId) {
    console.log('nothing to produce: no pending draft and no unanalysed queue item');
    return;
  }

  console.log(`produce: ${itemId}`);
  if (dryRun) return;

  const { startProcessJob } = require('../server/services/processJobService');
  const result = startProcessJob({
    item_ids: [itemId],
    stages: ['metadata', 'draft'],
    batch_name: 'hourly_produce',
    continue_to_draft_after_metadata: true,
    enqueue_if_active: false
  });
  console.log(`job: ${result.job && result.job.job_id} (${result.job && result.job.status})`);
}

main();

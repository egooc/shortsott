// Continuous production, one unit at a time (design 2026-08-16, user).
//
// This used to do exactly one unit per hour, matching the upload cadence. That
// paced production to the slowest consumer: uploads drain one video an hour
// whatever happens, while a single longform source yields several shorts, so the
// backlog only grew. It now keeps working until there is nothing left, and the
// hourly schedule is just a supervisor that restarts the drain.
//
// Strictly serial, though - never a batch. Exports drive CapCut through its GUI
// and cannot overlap, and running analyses in parallel draws 429s from Gemini
// whose retries cost more than working one at a time does. A lock keeps two
// producers from starting.
//
// Each unit is chosen in priority order:
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
const HELD_DIR = path.join(EXPORT_DIR, 'held');
const QUEUE_DIR = path.join(ROOT, 'queue', 'process');
const EXPORT_TIMEOUT_MS = 15 * 60 * 1000;
// A draft whose media the retention sweep already deleted can never export:
// CapCut opens it straight into "Couldn't find some of the imported media
// files" and the editor never comes up. Without a ledger the producer retried
// the same dead draft every hour and the whole line stalled behind it
// (observed 2026-08-15 on 20260813-F-215210). Two attempts, then skip.
//
// Attempts are counted before the export runs, not after it fails, because a
// draft can loop without ever failing: CapCut truncates long project names, so
// one highlight draft exported fine but never under the name that marks it
// done, and it was re-exported 18 times in a row. Counting only failures left
// that unbounded. Whatever the outcome, a draft that is still pending after two
// attempts is something this loop cannot finish, so it stops trying.
const ATTEMPT_LEDGER_PATH = path.join(ROOT, 'server', 'data', 'export_failures.json');
const MAX_EXPORT_ATTEMPTS = 2;
const LOCK_PATH = path.join(ROOT, 'server', 'data', 'hourly_produce.lock');
// Long enough for a longform analysis plus its draft build; past this the job is
// left running and the loop stops rather than piling a second one on top.
const JOB_TIMEOUT_MS = 90 * 60 * 1000;
// The drain stops here so a run cannot outlive the day's work and hold the lock
// against a fixed producer; the next hourly tick picks up where it left off.
const DRAIN_BUDGET_MS = 6 * 60 * 60 * 1000;
const ANALYSIS_COOLDOWN_MS = 60 * 1000;
const startedAt = Date.now();

function acquireLock() {
  try {
    const raw = fs.readFileSync(LOCK_PATH, 'utf8');
    const held = JSON.parse(raw);
    if (held && held.pid) {
      try {
        process.kill(held.pid, 0); // throws if the pid is gone
        return false;
      } catch { /* stale lock from a killed run */ }
    }
  } catch { /* no lock file */ }
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  fs.writeFileSync(LOCK_PATH, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  return true;
}

function releaseLock() {
  try {
    const held = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    if (held && held.pid === process.pid) fs.rmSync(LOCK_PATH, { force: true });
  } catch { /* already gone */ }
}

function readLedger() {
  try {
    return JSON.parse(fs.readFileSync(ATTEMPT_LEDGER_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeLedger(ledger) {
  fs.mkdirSync(path.dirname(ATTEMPT_LEDGER_PATH), { recursive: true });
  fs.writeFileSync(ATTEMPT_LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}

// held/ is where a video is moved when it must not ship - a duplicate of a
// source already published, or a draft whose script failed review. It has still
// been exported, so leaving it out of this set made the producer see those
// drafts as pending and export them again, one per hour, forever.
function exportedNames() {
  const names = new Set();
  for (const dir of [EXPORT_DIR, UPLOADED_DIR, HELD_DIR]) {
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
    .filter((name) => (readLedger()[name]?.attempts || 0) < MAX_EXPORT_ATTEMPTS)
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

// Returns true if it did a unit of work, false if there was nothing to do.
function exportOnePendingDraft(dryRun) {
  const pending = pendingDrafts();
  console.log(`pending drafts (no mp4 yet): ${pending.length}`);
  if (!pending.length) return false;

  {
    const target = pending[0];
    console.log(`export: ${target}`);
    if (dryRun) return false;

    const ledger = readLedger();
    const entry = ledger[target] || { attempts: 0 };
    entry.attempts += 1;
    entry.lastAt = new Date().toISOString();
    ledger[target] = entry;
    writeLedger(ledger);

    try {
      const out = execFileSync('python', [
        path.join(ROOT, 'scripts', 'capcut_export_one.py'),
        '--draft-name', target,
        '--export-dir', EXPORT_DIR
      ], { encoding: 'utf8', timeout: EXPORT_TIMEOUT_MS, windowsHide: false });
      console.log(String(out).trim().split('\n').slice(-2).join('\n'));
    } catch (error) {
      // execFileSync's message is only the command line it ran. The export
      // script's own JSON - which says which step it reached and what went
      // wrong - is on stdout, and dropping it left the log saying nothing but
      // "Command failed: python ..." for every failure, so a whole afternoon of
      // dead exports could not be diagnosed from it at all.
      const out = `${String(error.stdout || '')}${String(error.stderr || '')}`.trim();
      const detail = out.split('\n').filter(Boolean).slice(-2).join(' | ');
      entry.lastError = (detail || String(error.message || error)).slice(0, 400);
      ledger[target] = entry;
      writeLedger(ledger);
      console.log(`export failed (attempt ${entry.attempts}/${MAX_EXPORT_ATTEMPTS}): ${entry.lastError}`);
      process.exitCode = 1;
    }
    if (entry.attempts >= MAX_EXPORT_ATTEMPTS && !exportedNames().has(target)) {
      console.log(`giving up on ${target}; it will be skipped from now on`);
    }
    return true;
  }
}

// Builds a draft for one queue item and waits for it, so the loop below never
// starts a second analysis on top of a running one.
async function buildOneDraft(dryRun) {
  const itemId = nextQueueItem();
  if (!itemId) return false;

  console.log(`produce: ${itemId}`);
  if (dryRun) return false;

  const { startProcessJob, readJob } = require('../server/services/processJobService');
  const result = startProcessJob({
    item_ids: [itemId],
    stages: ['metadata', 'draft'],
    batch_name: 'hourly_produce',
    continue_to_draft_after_metadata: true,
    enqueue_if_active: false
  });
  const jobId = result.job && result.job.job_id;
  console.log(`job: ${jobId} (${result.job && result.job.status})`);
  if (!jobId) return false;

  const TERMINAL = ['success', 'failed', 'cancelled', 'completed_with_warnings'];
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, 20000));
    let job;
    try { job = readJob(jobId); } catch { job = null; }
    const status = job && job.status;
    if (status && TERMINAL.includes(status)) {
      console.log(`job ${jobId} finished: ${status}`);
      return true;
    }
    if (Date.now() > deadline) {
      console.log(`job ${jobId} still ${status || '?'} after ${Math.round(JOB_TIMEOUT_MS / 60000)}min; leaving it to run`);
      return false;
    }
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    exportOnePendingDraft(true);
    await buildOneDraft(true);
    return;
  }

  // Only one producer at a time: exports drive CapCut through its GUI, and two
  // of them would fight over the same window.
  if (!acquireLock()) {
    console.log('another producer is already running; nothing to do');
    return;
  }

  try {
    // Keep going until there is nothing left. This used to do exactly one unit
    // per hour, which paced production to the upload cadence - but uploads drain
    // one video an hour whatever happens, and a longform source yields several
    // shorts, so the backlog only ever grew. Stacking is the point (user,
    // 2026-08-16); the hourly schedule is now just a supervisor that restarts
    // the drain if it ever stops.
    let units = 0;
    for (;;) {
      if (Date.now() > startedAt + DRAIN_BUDGET_MS) {
        console.log(`drain budget reached after ${units} unit(s); the next scheduled run continues`);
        break;
      }
      if (exportOnePendingDraft(false)) { units += 1; continue; }
      // eslint-disable-next-line no-await-in-loop
      if (await buildOneDraft(false)) {
        units += 1;
        // One analysis at a time is the whole point: a batch of them draws 429s
        // from Gemini and the retries cost more than the pause does.
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, ANALYSIS_COOLDOWN_MS));
        continue;
      }
      console.log(`nothing left to produce; did ${units} unit(s) this run`);
      break;
    }
  } finally {
    releaseLock();
  }
}

main().catch((error) => {
  releaseLock();
  console.error('FAILED:', String(error.message || error).slice(0, 400));
  process.exitCode = 1;
});

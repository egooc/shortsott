#!/usr/bin/env node
'use strict';

// Work the production failure queue: retry everything whose defect was decided while writing
// slot_fills, and leave the rest for a person.
//
//   node scripts/recover-queue.js [--limit N] [--dry-run]
//
// The nightly batch already retries a failure once, in the moment. This is the morning pass over
// what survived that - and over everything queued before the retry logic could classify it
// correctly (casebook 19, 20, 23). Each entry still has its compress run on disk, so recovery
// costs a fills regeneration and a pipeline resume, not a new download, transcript and vision
// pass. That is the whole reason the queue records compress_run_id.
//
// Classification and the retry mechanics come from nightly-batch so the two passes cannot drift.

const fs = require('fs');
const path = require('path');

const {
  FAILURE_QUEUE_PATH,
  readFailureQueue,
  isFillsRegenerable,
  mismatchIssues,
  recordNarrationRejections,
  regenerateFillsWithReason,
  resumeFromBootstrap,
  installDraft,
  readJsonQuiet,
  failureText,
  TEMPLATE_RUNS_DIR
} = require('./nightly-batch');

const ROOT = path.join(__dirname, '..');
const STEP_TIMEOUT_MS = 45 * 60 * 1000;

// A validation wall and a rate limit both come back as "compress-apply exited non-zero", but only
// one of them is worth waiting out. The first recovery run marked three sources failed in a row;
// re-running compress-apply on one of them by hand a few minutes later exited 0 with nothing
// changed, so what actually happened was the pass hammering Vertex with five back-to-back
// generations (2026-08-24, casebook 28).
const TRANSIENT_FAILURE = /\b(429|quota|rate.?limit|RESOURCE_EXHAUSTED|UNAVAILABLE|ETIMEDOUT|ECONNRESET|socket hang up|timed? ?out)\b/i;
const TRANSIENT_RETRIES = 2;
const TRANSIENT_BACKOFF_MS = 90 * 1000;
// Space the sources out even on success - the quota is per minute, and finishing one generation
// does not mean the window has refilled.
const BETWEEN_SOURCES_MS = 20 * 1000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Regenerate, waiting out a transient rather than burning the entry on it.
async function regenerateWithBackoff(compressRunId, log) {
  for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt += 1) {
    const reason = regenerateFillsWithReason(compressRunId, STEP_TIMEOUT_MS);
    if (!reason) return '';
    if (!TRANSIENT_FAILURE.test(reason) || attempt === TRANSIENT_RETRIES) return reason;
    const waitMs = TRANSIENT_BACKOFF_MS * (attempt + 1);
    log(`  transient (${reason.slice(0, 80)}) - waiting ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
  }
  return 'unreachable';
}

function parseArgs(argv) {
  const args = { limit: Infinity, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') args.limit = Number(argv[i + 1]) || Infinity;
    if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

function classify(entry) {
  const text = String(entry.failure || '');
  const issues = mismatchIssues(text);
  if (issues.length) return { kind: 'mismatch', issues };
  if (isFillsRegenerable(text)) return { kind: 'fills', issues: [] };
  return { kind: 'manual', issues: [] };
}

// A queued entry is only actionable if the artefacts it points at are still there. Workspaces are
// reused by the next source, so verify against the compress run - that one is per-source and
// keeps its name (casebook 17).
function isActionable(entry) {
  if (!entry.compress_run_id || !entry.template_path) return 'no compress run recorded';
  if (!fs.existsSync(path.join(ROOT, 'midform', 'test_runs', entry.compress_run_id))) return 'compress run is gone';
  if (!fs.existsSync(path.join(ROOT, entry.template_path))) return 'template is gone';
  return '';
}

function workspaceStatus(entry) {
  const summary = readJsonQuiet(path.join(TEMPLATE_RUNS_DIR, entry.workspace_dir || '', 'run_summary.json'));
  if (!summary) return null;
  // The workspace may belong to a LATER source by now; only trust it if the lineage still names
  // this entry's compress run.
  const lineage = summary.internal?.compression_run_id || '';
  if (lineage && lineage !== entry.compress_run_id) return null;
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const queue = readFailureQueue();
  const entries = Array.isArray(queue.entries) ? queue.entries : [];
  if (!entries.length) { console.log('queue is empty'); return; }

  const plan = entries.map((entry) => ({ entry, ...classify(entry), blocked: isActionable(entry) }));
  console.log(`queue: ${entries.length} entries`);
  for (const item of plan) {
    const label = item.blocked ? `manual (${item.blocked})` : item.kind;
    console.log(`  ${label.padEnd(28)} ${item.entry.source_id}  ${String(item.entry.title || '').slice(0, 44)}`);
  }

  const actionable = plan.filter((item) => !item.blocked && item.kind !== 'manual').slice(0, args.limit);
  console.log(`\n${actionable.length} recoverable${args.dryRun ? ' (dry run - nothing will run)' : ''}\n`);
  if (args.dryRun || !actionable.length) return;

  const recovered = [];
  const stillFailing = [];
  for (const [index, item] of actionable.entries()) {
    const { entry, issues } = item;
    console.log(`[${index + 1}/${actionable.length}] ${entry.source_id} (${item.kind}) on ${entry.compress_run_id}`);
    if (issues.length) {
      recordNarrationRejections(entry.compress_run_id, issues);
      console.log(`  fed back ${issues.length} rejected sentence(s)`);
    }
    if (index > 0) await sleep(BETWEEN_SOURCES_MS);
    const regenReason = await regenerateWithBackoff(entry.compress_run_id, (line) => console.log(line));
    if (regenReason) {
      console.log(`  fills regeneration failed: ${regenReason}`);
      // Keep the reason in the queue: next pass classifies against why THIS attempt died, and a
      // transient (a 429, a timeout) should not read the same as a validation wall.
      stillFailing.push({ entry, reason: `fills regeneration failed: ${regenReason}` });
      continue;
    }
    resumeFromBootstrap(entry.template_path, entry.compress_run_id, STEP_TIMEOUT_MS);
    const summary = workspaceStatus(entry);
    if (summary && summary.status !== 'failed') {
      console.log(`  recovered: ${summary.status}`);
      recovered.push({ entry, summary });
    } else {
      const reason = summary ? failureText(summary) : 'no run summary for this compress run';
      console.log(`  still failing: ${String(reason).slice(0, 160)}`);
      // A pipeline verdict, so it REPLACES the queued failure - the source hit a new wall.
      stillFailing.push({ entry, reason, isPipelineVerdict: Boolean(summary) });
    }
  }

  // Rewrite the queue. A new PIPELINE failure replaces the recorded one: the source got further
  // and hit a different wall, and the next pass should classify against that. A failure of the
  // recovery machinery itself must NOT - it is not a verdict on the source. Overwriting with one
  // cost three recoverable entries: a Vertex rate limit wrote "fills regeneration failed" over
  // their real failure text, which matches no classification rule, and they were demoted to manual
  // for good (2026-08-24, casebook 28).
  const recoveredIds = new Set(recovered.map((item) => item.entry.source_id));
  const resultById = new Map(stillFailing.map((item) => [item.entry.source_id, item]));
  queue.entries = entries
    .filter((entry) => !recoveredIds.has(entry.source_id))
    .map((entry) => {
      const result = resultById.get(entry.source_id);
      if (!result) return entry;
      const attempts = Number(entry.recovery_attempts || 0) + 1;
      if (!result.isPipelineVerdict) {
        return { ...entry, recovery_attempts: attempts, last_recovery_error: String(result.reason).slice(0, 400) };
      }
      return {
        ...entry,
        failure: String(result.reason),
        failed_at: new Date().toISOString(),
        recovery_attempts: attempts,
        last_recovery_error: ''
      };
    });
  queue.updated_at = new Date().toISOString();
  fs.writeFileSync(FAILURE_QUEUE_PATH, JSON.stringify(queue, null, 2), 'utf8');

  console.log(`\nrecovered ${recovered.length}, still failing ${stillFailing.length}, queue now ${queue.entries.length}`);
  for (const { entry, summary } of recovered) {
    // Installing is left to a human pass: these drafts have not been through the viewer read, and
    // a gate-passing cut can still be one nobody can follow (draft-verify section 1.8).
    console.log(`  READY (verify before installing): ${entry.source_id} ${summary.status} -> ${entry.workspace_dir}`);
  }
}

main().catch((error) => {
  console.error('recover-queue fatal:', error.message || error);
  process.exitCode = 1;
});

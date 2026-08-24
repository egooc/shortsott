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
  refreshPlanWithReason,
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

// Entries queued before 2026-08-24 carry a failure text cut at 600 chars, which beheads the
// machine-eye issue array mid-string - the entry names narration_visual_match but classifies as
// manual because the array cannot be parsed. The full issues still exist in the workspace's
// acceptance_gates.json; trust it only while run_summary lineage still names this entry's
// compress run (workspaces are reused - casebook 17).
function issuesFromGatesFile(entry) {
  if (!String(entry.failure || '').includes('narration_visual_match')) return [];
  const wsDir = path.join(TEMPLATE_RUNS_DIR, entry.workspace_dir || '');
  const summary = readJsonQuiet(path.join(wsDir, 'run_summary.json'));
  if (!summary || (summary.internal?.compression_run_id || '') !== entry.compress_run_id) return [];
  const gates = readJsonQuiet(path.join(wsDir, 'acceptance_gates.json'));
  const gate = (Array.isArray(gates?.results) ? gates.results : []).find((result) => result?.id === 'narration_visual_match');
  return (Array.isArray(gate?.issues) ? gate.issues : []).filter((issue) => issue && issue.segment_id && issue.on_screen);
}

// Failures whose MEASUREMENT has been fixed since the entry was queued. The source did nothing
// wrong; the code judging it did. These need no new fills - resume from bootstrap and let the
// corrected code re-measure. Each signature must name what fixed it, so that when the list grows
// stale it can be audited instead of trusted.
const CODE_FIXED_REBUILD = [
  {
    // Loudness alignment was polluted by 0.232s TTS stubs, sampled with bias, and judged from
    // different numbers than the correction used (casebook 18/22, commits d1a683a + a77b118).
    signature: /narration_dialogue_loudness_delta/,
    fixedBy: 'loudness measurement repairs, 2026-08-24'
  }
];

// The failure text names segments like slot_004_L01; the fills know whether that slot has been
// hand-authored since. If every named slot is authored, the wall this entry records has already
// been fixed by hand - regenerating would gamble the surgery away and pay Codex to do it.
function namedSlotsAllAuthored(entry) {
  const text = String(entry.failure || '');
  const named = [...new Set([...text.matchAll(/\b(slot_[0-9]+[a-z_]*?)_L\d+\b/g)].map((m) => m[1]))];
  if (!named.length) return false;
  const fills = readJsonQuiet(path.join(ROOT, 'midform', 'test_runs', entry.compress_run_id || '', 'compression_slot_fills.json'));
  const bySlot = new Map((fills?.slot_fills || []).map((sf) => [String(sf.slot_id), sf]));
  return named.every((slotId) => bySlot.get(slotId)?.authored === true);
}

function classify(entry) {
  const text = String(entry.failure || '');
  const issues = mismatchIssues(text);
  if (issues.length) return { kind: 'mismatch', issues };
  const recovered = issuesFromGatesFile(entry);
  if (recovered.length) return { kind: 'mismatch', issues: recovered };
  if (namedSlotsAllAuthored(entry)) return { kind: 'rebuild', issues: [], fixedBy: 'hand-authored slots' };
  if (isFillsRegenerable(text)) return { kind: 'fills', issues: [] };
  const codeFixed = CODE_FIXED_REBUILD.find((route) => route.signature.test(text));
  if (codeFixed) return { kind: 'rebuild', issues: [], fixedBy: codeFixed.fixedBy };
  // A bootstrap preflight failure is plan geometry - window resolution, overlaps, closing
  // placement - and those rules keep getting fixed in finalize (casebook: closing relocation,
  // b-roll widening, sort order). compress-refresh re-derives the plan under today's rules for
  // free, so try that before writing the source off. Capped: if two refreshed attempts still
  // fail preflight, the geometry problem is real and a human should look.
  if (/MIDFORM_BOOTSTRAP_PREFLIGHT_FAILED|Bootstrap preflight failed/.test(text)
      && Number(entry.recovery_attempts || 0) < 2) {
    return { kind: 'refresh', issues: [] };
  }
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
    // A code-fixed failure keeps its fills: the draft was fine, the measurement was not, and a
    // regeneration would gamble away validated text to fix a bug that is already fixed.
    let regenReason = '';
    if (item.kind === 'refresh') {
      regenReason = refreshPlanWithReason(entry.compress_run_id, STEP_TIMEOUT_MS);
    } else if (item.kind !== 'rebuild') {
      regenReason = await regenerateWithBackoff(entry.compress_run_id, (line) => console.log(line));
    }
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

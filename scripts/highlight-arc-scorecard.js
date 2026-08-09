// Post-batch arc scorecard for shipped highlight drafts. Research tool -
// read-only over job reports and draft folders, never wired into the
// production pipeline (see CLAUDE.md "Isolate experimental code").
//
//   node scripts/highlight-arc-scorecard.js [job_id]
//
// For every highlight the batch actually shipped, this verifies the
// hook -> process -> end arc with signals, not self-reports:
//   hook    : motion excitement (P1 audio_motion_score.py on the shipped
//             clip, ~1.4s each) must rise early - global peak inside the
//             first half, or a non-negative first-2s mean.
//   process : no dead stretch - flags 3s+ runs of excitement z < -0.8.
//   end     : edge_refinement.snap_path quoted when present (scene_end =
//             the end sits on a real cut), plus a mid-action-end proxy:
//             the final second must not be the global motion peak.
//   beats   : Gemini's own claims cross-read from the report - core change
//             offset, result visible inside the window with tail, reveal flag.
// Verdict per highlight: ok / review (advisory - nothing blocks, nothing
// regenerates; use it to pick what to upload and to watch drift).
//
// Output: table on stdout + JSON at server/output/scorecards/<job_id>.json

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'server', 'data', 'process_jobs.db');
const OUT_DIR = path.join(ROOT, 'server', 'output', 'scorecards');
const PROFILE_SCRIPT = path.join(ROOT, 'scripts', 'audio_motion_score.py');

const FLAT_Z = -0.8;
const FLAT_RUN_SEC = 3;
const HOOK_WINDOW_SEC = 2;

function pickJob(db, jobIdArg) {
  if (jobIdArg) {
    const row = db.prepare('select job_id, job_json from process_jobs where job_id=?').get(jobIdArg);
    if (!row) throw new Error(`job not found: ${jobIdArg}`);
    return row;
  }
  const row = db.prepare(
    "select job_id, job_json from process_jobs where status in ('success','completed_with_warnings','partial_success') order by finished_at desc limit 1"
  ).get();
  if (!row) throw new Error('no finished job in the db');
  return row;
}

// The report nests shipped windows two ways: the per-item primary block
// (highlight_output_folder + highlight_source_window) and per-window list
// entries (output_folder + source_window). Collect both, dedupe by folder.
function collectShippedHighlights(jobJson) {
  const byFolder = new Map();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const folder = node.highlight_output_folder || node.output_folder;
    const window = node.highlight_source_window || node.source_window;
    if (typeof folder === 'string' && folder && window && Number.isFinite(Number(window.start_sec))) {
      if (!byFolder.has(folder)) byFolder.set(folder, window);
    }
    Object.values(node).forEach(visit);
  };
  visit(jobJson);
  return [...byFolder.entries()].map(([folder, window]) => ({ folder, window }));
}

function motionProfile(clipPath) {
  const tmpPath = path.join(os.tmpdir(), `arc_profile_${process.pid}_${Math.floor(Math.random() * 1e6)}.json`);
  try {
    execFileSync(
      process.env.PYTHON_PATH || 'python',
      [PROFILE_SCRIPT, clipPath, '--json', tmpPath],
      { timeout: 60000, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
    );
    const parsed = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
    // Shipped clips carry no audio track; motion is the meaningful series.
    return { motion: parsed.motion || [], duration: parsed.duration_sec || 0 };
  } finally {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
  }
}

function analyzeMotion(motion) {
  if (!motion.length) return null;
  let peakIdx = 0;
  motion.forEach((value, i) => { if (value > motion[peakIdx]) peakIdx = i; });
  const firstMean = motion.slice(0, HOOK_WINDOW_SEC).reduce((a, b) => a + b, 0)
    / Math.max(1, Math.min(HOOK_WINDOW_SEC, motion.length));
  let flatRun = 0, worstFlat = 0;
  for (const value of motion) {
    flatRun = value < FLAT_Z ? flatRun + 1 : 0;
    worstFlat = Math.max(worstFlat, flatRun);
  }
  return {
    peak_sec: peakIdx,
    peak_in_first_half: peakIdx <= (motion.length - 1) / 2,
    first2s_mean_z: Number(firstMean.toFixed(2)),
    worst_flat_run_sec: worstFlat,
    ends_on_peak: peakIdx === motion.length - 1
  };
}

function beatChecks(window) {
  const start = Number(window.start_sec);
  const end = Number(window.end_sec);
  const core = Number(window.beat_core_change_sec);
  const result = Number(window.beat_result_visible_sec);
  return {
    reveal_claimed: window.has_result_reveal === true,
    core_offset_sec: Number.isFinite(core) ? Number((core - start).toFixed(1)) : null,
    result_offset_sec: Number.isFinite(result) ? Number((result - start).toFixed(1)) : null,
    tail_after_result_sec: Number.isFinite(result) ? Number((end - result).toFixed(1)) : null,
    snap_path: window.edge_refinement ? window.edge_refinement.snap_path : null
  };
}

function verdictFor(motion, beats) {
  const reasons = [];
  if (motion) {
    if (!motion.peak_in_first_half && motion.first2s_mean_z < 0) reasons.push('late_hook');
    if (motion.worst_flat_run_sec >= FLAT_RUN_SEC) reasons.push(`flat_${motion.worst_flat_run_sec}s`);
    if (motion.ends_on_peak) reasons.push('ends_mid_action');
  } else {
    reasons.push('no_motion_profile');
  }
  if (!beats.reveal_claimed) reasons.push('no_result_reveal');
  if (beats.result_offset_sec === null) reasons.push('beats_missing');
  else if (beats.tail_after_result_sec !== null && beats.tail_after_result_sec < 1) reasons.push('result_truncated');
  return { verdict: reasons.length ? 'review' : 'ok', reasons };
}

function main() {
  const db = require(path.join(ROOT, 'server', 'node_modules', 'better-sqlite3'))(DB_PATH, { readonly: true });
  const { job_id: jobId, job_json: jobJson } = pickJob(db, process.argv[2]);
  const shipped = collectShippedHighlights(JSON.parse(jobJson));
  console.log(`job ${jobId}: ${shipped.length} shipped highlight(s)\n`);

  const rows = [];
  for (const { folder, window } of shipped) {
    const clipPath = path.join(folder, 'video', 'source.mp4');
    let motion = null;
    let clipError = null;
    if (fs.existsSync(clipPath)) {
      try {
        motion = analyzeMotion(motionProfile(clipPath).motion);
      } catch (error) {
        clipError = String(error.message || error).slice(0, 80);
      }
    } else {
      clipError = 'clip missing';
    }
    const beats = beatChecks(window);
    const { verdict, reasons } = verdictFor(motion, beats);
    rows.push({
      folder: path.basename(folder),
      window: { start_sec: window.start_sec, end_sec: window.end_sec },
      selection_strategy: window.selection_strategy || null,
      motion, beats, clip_error: clipError, verdict, reasons
    });
    const label = path.basename(folder).slice(0, 52);
    console.log(`[${verdict.toUpperCase()}] ${label}`);
    console.log(`  window ${window.start_sec}-${window.end_sec}s | snap=${beats.snap_path || '-'} | ` +
      (motion
        ? `peak@${motion.peak_sec}s first2s=${motion.first2s_mean_z} flat=${motion.worst_flat_run_sec}s`
        : `no profile (${clipError})`) +
      ` | core+${beats.core_offset_sec ?? '?'}s result+${beats.result_offset_sec ?? '?'}s tail=${beats.tail_after_result_sec ?? '?'}s`);
    if (reasons.length) console.log(`  reasons: ${reasons.join(', ')}`);
  }

  const ok = rows.filter((r) => r.verdict === 'ok').length;
  console.log(`\nsummary: ${ok}/${rows.length} ok, ${rows.length - ok} to review`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `${jobId}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify({ job_id: jobId, rows }, null, 2)}\n`, 'utf8');
  console.log(`scorecard written: ${outPath}`);
}

main();

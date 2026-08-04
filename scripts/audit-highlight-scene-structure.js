// Audits the highlight scene structure of already-analysed queue items.
//
//   node scripts/audit-highlight-scene-structure.js [item_001 item_006 ...]
//
// Unlike the check:* scripts this asserts nothing about the code - it reads the real
// analysis output and reports whether the extracted scenes hold together: windows
// inside one camera shot, beats that fit the 0-1-4-8s formula, one title/caption per
// window, and candidates spread across the whole source instead of the opening minutes.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const QUEUE_ROOT = path.join(ROOT, 'queue', 'process');
const FORMULA_CORE_MAX_SEC = 4.5;
const FORMULA_RESULT_MAX_SEC = 8.5;

const findings = [];
const record = (severity, itemId, message) => findings.push({ severity, itemId, message });

function listItemIds(argv) {
  if (argv.length) return argv;
  if (!fs.existsSync(QUEUE_ROOT)) return [];
  return fs.readdirSync(QUEUE_ROOT).filter((name) => {
    const configPath = path.join(QUEUE_ROOT, name, 'item_config.json');
    if (!fs.existsSync(configPath)) return false;
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return Array.isArray(config?.ottogi_guide_output?.shortform_candidate_windows);
    } catch {
      return false;
    }
  });
}

function overlapSec(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function auditItem(itemId) {
  const configPath = path.join(QUEUE_ROOT, itemId, 'item_config.json');
  if (!fs.existsSync(configPath)) {
    record('WARN', itemId, 'item_config.json not found');
    return;
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const guide = config.ottogi_guide_output || {};
  const sourceDuration = Number(config.video_metadata?.duration_sec || config.source_classification?.duration_sec || 0);
  const windows = (guide.shortform_candidate_windows || []).map((window) => ({
    ...window,
    start: Number(window.start_sec),
    end: Number(window.end_sec)
  }));
  const scenes = (guide.scene_transitions || []).map((scene) => ({
    id: scene.scene_id,
    start: Number(scene.start_sec),
    end: Number(scene.end_sec)
  }));
  const titles = (guide.highlight_metadata || {}).highlight_candidate_titles || [];

  console.log(`\n=== ${itemId}  source ${Math.round(sourceDuration)}s  windows ${windows.length}  titles ${titles.length}  scenes ${scenes.length}`);
  if (!windows.length) {
    record('WARN', itemId, 'no candidate windows to audit');
    return;
  }

  windows.forEach((window, index) => {
    const label = `[${index + 1}] ${window.start}~${window.end}s`;
    const length = window.end - window.start;
    if (!(window.start >= 0 && window.end <= sourceDuration + 0.5)) {
      record('FAIL', itemId, `${label} falls outside the ${Math.round(sourceDuration)}s source`);
    }

    // One window should stay inside one camera shot.
    const crossed = scenes.filter((scene) => scene.start > window.start + 0.5 && scene.start < window.end - 0.5);
    if (crossed.length) {
      record('FAIL', itemId, `${label} runs across ${crossed.length} scene boundary/ies (${crossed.map((s) => `${s.id}@${s.start}`).join(', ')}) - reads as a compilation, not one process moment`);
    }

    // Beats must sit inside the window, in order, and near the formula bands.
    const core = Number(window.beat_core_change_sec) - window.start;
    const result = Number(window.beat_result_visible_sec) - window.start;
    if (Number.isFinite(core) && (core < 0 || core > length)) {
      record('FAIL', itemId, `${label} core-change beat +${core.toFixed(1)}s lies outside the window`);
    }
    if (Number.isFinite(result) && (result < 0 || result > length + 0.01)) {
      record('FAIL', itemId, `${label} result beat +${result.toFixed(1)}s lies outside the window`);
    }
    if (Number.isFinite(core) && Number.isFinite(result) && result <= core) {
      record('FAIL', itemId, `${label} result beat (+${result.toFixed(1)}s) is not after the core change (+${core.toFixed(1)}s)`);
    }
    if (Number.isFinite(core) && core > FORMULA_CORE_MAX_SEC) {
      record('WARN', itemId, `${label} core change at +${core.toFixed(1)}s is past the 1-4s band`);
    }
    if (Number.isFinite(result) && result > FORMULA_RESULT_MAX_SEC) {
      record('WARN', itemId, `${label} result at +${result.toFixed(1)}s is past the 4-8s band`);
    }
    if (window.has_result_reveal !== true) {
      record('WARN', itemId, `${label} has_result_reveal is not true - the completion payoff is missing`);
    }
    if (window.face_or_emotion_dominant === true) {
      record('FAIL', itemId, `${label} is face-led but still a candidate`);
    }

    // Each window needs its own title and a real per-window explanation.
    const match = titles.find((entry) => overlapSec(window.start, window.end, Number(entry.start_sec), Number(entry.end_sec)) >= Math.min(1, length * 0.25));
    if (!match) {
      record('FAIL', itemId, `${label} has no matching candidate-title entry - this cut falls back to a template caption`);
    } else if ([...String(match.scene_specific_explanation_ja || '')].length < 40) {
      record('WARN', itemId, `${label} per-window Japanese explanation is under 40 chars - it will fall back to a template`);
    }

    // Overlapping windows mean the same action shipped twice.
    windows.slice(index + 1).forEach((other, offset) => {
      const overlap = overlapSec(window.start, window.end, other.start, other.end);
      if (overlap > 0.25) {
        record('WARN', itemId, `${label} overlaps [${index + offset + 2}] by ${overlap.toFixed(1)}s`);
      }
    });
  });

  const uniqueTitles = new Set(titles.map((entry) => String(entry.title || '').split(' #')[0]));
  if (titles.length && uniqueTitles.size < titles.length) {
    record('FAIL', itemId, `${titles.length} title entries but only ${uniqueTitles.size} distinct titles`);
  }

  // Coverage: process videos put the finished result in the later half.
  if (sourceDuration > 0) {
    const positions = windows.map((window) => window.start / sourceDuration);
    const secondHalf = positions.filter((position) => position >= 0.5).length;
    const firstQuarter = positions.filter((position) => position < 0.25).length;
    console.log(`  coverage: ${positions.map((p) => `${Math.round(p * 100)}%`).join(', ')}`);
    if (!secondHalf) {
      record('WARN', itemId, 'no candidate comes from the second half of the source - the finishing and finished-result steps went unsampled');
    }
    if (windows.length >= 3 && firstQuarter === windows.length) {
      record('FAIL', itemId, 'every candidate sits inside the first quarter of the source');
    }
  }
}

const itemIds = listItemIds(process.argv.slice(2));
if (!itemIds.length) {
  console.log('no analysed queue items found');
  process.exit(0);
}
itemIds.forEach(auditItem);

const failures = findings.filter((finding) => finding.severity === 'FAIL');
console.log('\n=== result ===');
if (!findings.length) {
  console.log('highlight scene structure is coherent - no findings');
} else {
  findings.forEach((finding) => console.log(`${finding.severity}  ${finding.itemId}: ${finding.message}`));
}
console.log(`\nFAIL ${failures.length} / WARN ${findings.length - failures.length}`);
process.exit(failures.length ? 1 : 0);

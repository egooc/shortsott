// Bounded edge refinement for already-selected highlight windows.
//
// Approved production change (2026-08-08, user sign-off in session; scene-cut
// upgrade approved same day): the selection path keeps choosing the windows;
// this service only settles each chosen window's edges onto a natural boundary.
// Per edge, a TransNetV2 scene cut wins when one is in budget (the visual
// boundary is what a viewer perceives); otherwise a silence trough is used.
// Measured need: window starts already land on scene cuts (0.03-0.17s) but
// ends sit 0.8-1.6s mid-shot, and this catalog's continuous machine audio has
// no silence troughs near the chosen windows
// (docs/opensource-adoption-analysis-2026-08-08.md). Silence-snap math adapted
// from ClippyMe cut_ops.py (MIT); scene cuts come from
// scripts/scene_detect_transnet.py (adapted from openshorts, MIT).
//
// Hard limits - these are the contract, guarded by check:highlight-edge-refine:
//   - silence may move an edge at most 0.35s; a scene cut may move the START
//     at most 0.35s and the END at most 1.6s
//   - window count, order, selection_strategy, scene ids are never touched
//   - the refined duration never exceeds the item's max cap; it may shrink at
//     most 0.7s for silence-only moves and at most 2.0s when landing an edge
//     on a scene cut, and never below 4s
//   - windows are clamped in time order against already-refined neighbors so
//     refinement cannot create overlap
//   - any failure (python/torch missing, ffmpeg error) degrades gracefully:
//     scene detection failure falls back to silence-only, full failure returns
//     the original windows untouched (fail-open)
// Kill switch: HIGHLIGHT_EDGE_REFINE=0. Scene stage only: HIGHLIGHT_EDGE_REFINE_SCENES=0.

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveTool } = require('../utils/toolPaths');

const EDGE_BUDGET_SEC = 0.35;             // silence snap, both edges
const SCENE_START_BUDGET_SEC = 0.35;      // scene snap, start edge
const SCENE_END_BUDGET_SEC = 1.6;         // scene snap, end edge
const START_LEAD_SEC = 0.04;
const END_TAIL_SEC = 0.06;
const MIN_SILENCE_SEC = 0.08;
const MAX_SHRINK_SEC = 0.7;               // silence-only moves
const SCENE_MAX_SHRINK_SEC = 2.0;         // when a scene cut moved an edge
const MIN_DURATION_FLOOR_SEC = 4;
const MEASURE_TIMEOUT_MS = 180000;
const SCENE_DETECT_TIMEOUT_MS = 900000;

const SILENCE_START_RE = /silence_start:\s*(-?\d+(?:\.\d+)?)/g;
const SILENCE_END_RE = /silence_end:\s*(-?\d+(?:\.\d+)?)/g;
const MEAN_VOLUME_RE = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/;

function flagDisabled(envName) {
  return ['0', 'false', 'off'].includes(
    String(process.env[envName] || '').trim().toLowerCase()
  );
}

function isDisabled() {
  return flagDisabled('HIGHLIGHT_EDGE_REFINE');
}

function runFfmpegStderr(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      resolveTool('ffmpeg', { envKey: 'FFMPEG_PATH' }),
      ['-hide_banner', '-nostats', ...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => {
        const text = String(stderr || '');
        if (error && !text) return reject(error);
        resolve(text);
      }
    );
  });
}

function parseSilences(stderrText) {
  const starts = [...String(stderrText || '').matchAll(SILENCE_START_RE)].map((m) => Number(m[1]));
  const ends = [...String(stderrText || '').matchAll(SILENCE_END_RE)].map((m) => Number(m[1]));
  const silences = [];
  for (let i = 0; i < starts.length && i < ends.length; i += 1) {
    if (ends[i] > starts[i]) silences.push([starts[i], ends[i]]);
  }
  return silences.sort((a, b) => a[0] - b[0]);
}

async function detectSilences(videoPath) {
  const volumeText = await runFfmpegStderr(
    ['-i', videoPath, '-vn', '-af', 'volumedetect', '-f', 'null', '-'],
    MEASURE_TIMEOUT_MS
  );
  const meanMatch = MEAN_VOLUME_RE.exec(volumeText);
  // Machine audio: troughs sit just below the running level; a fixed -30dB
  // floor finds nothing over a factory noise floor.
  const noiseDb = meanMatch
    ? Math.max(-50, Math.min(-18, Number(meanMatch[1]) - 12))
    : -30;
  const silenceText = await runFfmpegStderr(
    ['-i', videoPath, '-vn',
     '-af', `silencedetect=noise=${noiseDb}dB:d=${MIN_SILENCE_SEC}`,
     '-f', 'null', '-'],
    MEASURE_TIMEOUT_MS
  );
  return { silences: parseSilences(silenceText), noiseDb };
}

// TransNetV2 via the P1 research script; the boundary list is every scene
// start except the first (a scene start IS a cut). Fail-open to [].
async function detectSceneCuts(videoPath) {
  if (flagDisabled('HIGHLIGHT_EDGE_REFINE_SCENES')) {
    return { cuts: [], engine: 'disabled' };
  }
  const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'scene_detect_transnet.py');
  const tmpPath = path.join(os.tmpdir(), `scenes_${crypto.randomBytes(4).toString('hex')}.json`);
  try {
    await new Promise((resolve, reject) => {
      execFile(
        resolveTool('python', { envKey: 'PYTHON_PATH' }),
        [scriptPath, videoPath, '--json', tmpPath],
        { timeout: SCENE_DETECT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (error) => (error ? reject(error) : resolve())
      );
    });
    const parsed = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
    const scenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
    const cuts = scenes.slice(1)
      .map((scene) => Number(scene.start_sec))
      .filter((value) => Number.isFinite(value) && value > 0);
    return { cuts, engine: parsed.engine || 'transnetv2' };
  } catch (error) {
    return { cuts: [], engine: `unavailable: ${String(error.message || error).slice(0, 120)}` };
  } finally {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
  }
}

function nearestTrough(silences, target, pickEdge, budget) {
  let best = null;
  for (const [s, e] of silences) {
    const anchor = pickEdge === 'end' ? e : s;
    const dist = Math.abs(anchor - target);
    if (dist <= budget && (best === null || dist < best.dist)) {
      best = { dist, s, e };
    }
  }
  return best;
}

function nearestCut(cuts, target, budget) {
  let best = null;
  for (const cut of cuts) {
    const dist = Math.abs(cut - target);
    if (dist <= budget && (best === null || dist < best.dist)) {
      best = { dist, cut };
    }
  }
  return best;
}

// Pure: refine one window. Per edge a scene cut wins over a silence trough.
// Returns { start, end, path } and never moves an edge beyond its budget.
function snapWindowEdges(startSec, endSec, silences, sceneCuts = [],
                         { floorStart = null, maxDurationSec = 0 } = {}) {
  let start = startSec;
  let end = endSec;
  const parts = [];

  // START edge: scene cut (the shot begins here) else silence trough end.
  const startCut = nearestCut(sceneCuts, startSec, SCENE_START_BUDGET_SEC);
  if (startCut && Math.abs(startCut.cut - startSec) > 1e-6) {
    start = startCut.cut;
    parts.push('scene_start');
  } else {
    const startHit = nearestTrough(silences, startSec, 'end', EDGE_BUDGET_SEC);
    if (startHit) {
      const candidate = Math.min(Math.max(startHit.e - START_LEAD_SEC, startHit.s), startHit.e);
      if (Math.abs(candidate - startSec) > 1e-6) {
        start = candidate;
        parts.push('silence_start');
      }
    }
  }

  // END edge: scene cut (the shot ends exactly here) else silence trough start.
  const endCut = nearestCut(sceneCuts, endSec, SCENE_END_BUDGET_SEC);
  if (endCut && Math.abs(endCut.cut - endSec) > 1e-6) {
    end = endCut.cut;
    parts.push('scene_end');
  } else {
    const endHit = nearestTrough(silences, endSec, 'start', EDGE_BUDGET_SEC);
    if (endHit) {
      const candidate = Math.min(Math.max(endHit.s + END_TAIL_SEC, endHit.s), endHit.e);
      if (Math.abs(candidate - endSec) > 1e-6) {
        end = candidate;
        parts.push('silence_end');
      }
    }
  }

  if (floorStart !== null) start = Math.max(start, floorStart);
  start = Math.max(0, start);

  const originalDuration = endSec - startSec;
  const usedScene = parts.some((p) => p.startsWith('scene'));
  const shrinkBudget = usedScene ? SCENE_MAX_SHRINK_SEC : MAX_SHRINK_SEC;
  const durationFloor = Math.max(MIN_DURATION_FLOOR_SEC, originalDuration - shrinkBudget);

  // Duration guards revert edge moves instead of inventing new positions.
  const revert = (label, value) => {
    const index = parts.indexOf(label);
    if (index >= 0) parts.splice(index, 1);
    return value;
  };
  if (maxDurationSec > 0 && end - start > maxDurationSec) {
    if (parts.includes('scene_end')) end = revert('scene_end', endSec);
    else if (parts.includes('silence_end')) end = revert('silence_end', endSec);
  }
  if (maxDurationSec > 0 && end - start > maxDurationSec) {
    if (parts.includes('scene_start')) start = revert('scene_start', Math.max(startSec, floorStart ?? startSec));
    else if (parts.includes('silence_start')) start = revert('silence_start', Math.max(startSec, floorStart ?? startSec));
  }
  if (end - start < durationFloor || end <= start) {
    return { start: startSec, end: endSec, path: 'none' };
  }
  return { start, end, path: parts.length ? parts.join('+') : 'none' };
}

// Refines the chosen windows' edges. Original array order is preserved (highlight
// ordinals H01.. map to array positions); clamping runs in time order internally.
async function refineHighlightWindowEdges({ videoPath, windows = [], maxDurationSec = 0 }) {
  const passthrough = {
    windows,
    summary: { enabled: false, refined_count: 0, noise_db: null, silence_count: 0, scene_cut_count: 0 }
  };
  if (isDisabled() || !videoPath || !Array.isArray(windows) || !windows.length) {
    return passthrough;
  }

  let silenceDetection;
  try {
    silenceDetection = await detectSilences(videoPath);
  } catch (error) {
    return {
      windows,
      summary: {
        enabled: true, refined_count: 0, noise_db: null, silence_count: 0, scene_cut_count: 0,
        error: `silence_detection_failed: ${error.message}`
      }
    };
  }
  const sceneDetection = await detectSceneCuts(videoPath);

  const { silences, noiseDb } = silenceDetection;
  const sceneCuts = sceneDetection.cuts;
  const order = windows
    .map((window, index) => ({ index, start: Number(window.start_sec) || 0 }))
    .sort((a, b) => a.start - b.start)
    .map((entry) => entry.index);

  const refined = windows.map((window) => ({ ...window }));
  let prevRefinedEnd = null;
  let refinedCount = 0;

  for (const index of order) {
    const window = refined[index];
    const startSec = Number(window.start_sec);
    const endSec = Number(window.end_sec);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
      continue;
    }
    const snapped = snapWindowEdges(startSec, endSec, silences, sceneCuts, {
      floorStart: prevRefinedEnd,
      maxDurationSec
    });
    prevRefinedEnd = snapped.end;
    if (snapped.path === 'none') continue;

    const startDelta = snapped.start - startSec;
    window.start_sec = Number(snapped.start.toFixed(3));
    window.end_sec = Number(snapped.end.toFixed(3));
    window.duration_sec = Number((snapped.end - snapped.start).toFixed(3));
    // Beat offsets are start-relative; keep them pointing at the same absolute
    // moments after the start edge moved.
    for (const key of ['beat_core_change_offset_sec', 'beat_result_visible_offset_sec']) {
      if (Number.isFinite(Number(window[key]))) {
        window[key] = Number((Number(window[key]) - startDelta).toFixed(3));
      }
    }
    window.edge_refinement = {
      original_start_sec: startSec,
      original_end_sec: endSec,
      snap_path: snapped.path,
      noise_db: noiseDb,
      scene_engine: sceneDetection.engine
    };
    refinedCount += 1;
  }

  return {
    windows: refined,
    summary: {
      enabled: true,
      refined_count: refinedCount,
      noise_db: noiseDb,
      silence_count: silences.length,
      scene_cut_count: sceneCuts.length,
      scene_engine: sceneDetection.engine
    }
  };
}

module.exports = {
  refineHighlightWindowEdges,
  __test: {
    snapWindowEdges,
    parseSilences,
    EDGE_BUDGET_SEC,
    SCENE_START_BUDGET_SEC,
    SCENE_END_BUDGET_SEC,
    START_LEAD_SEC,
    END_TAIL_SEC,
    MAX_SHRINK_SEC,
    SCENE_MAX_SHRINK_SEC
  }
};

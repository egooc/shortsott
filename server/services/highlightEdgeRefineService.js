// Bounded edge refinement for already-selected highlight windows.
//
// Approved production change (2026-08-08, user sign-off in session): the
// selection path keeps choosing the windows; this service only nudges each
// chosen window's edges onto the nearest silence trough so cuts open just as
// sound begins (lead 40ms) and close just as sound stops (tail 60ms). Measured
// need: neural scene analysis showed window starts already land on cuts but
// ends sit 0.8-1.6s mid-shot (docs/opensource-adoption-analysis-2026-08-08.md).
// Snap math adapted from ClippyMe cut_ops.py (MIT).
//
// Hard limits - these are the contract, guarded by check:highlight-edge-refine:
//   - an edge may move at most EDGE_BUDGET_SEC (0.35s)
//   - window count, order, selection_strategy, scene ids are never touched
//   - the refined duration never exceeds the item's max cap and never shrinks
//     more than 0.7s below the original
//   - windows are clamped in time order against already-refined neighbors so
//     refinement cannot create overlap
//   - any failure returns the original windows untouched (fail-open)
// Kill switch: HIGHLIGHT_EDGE_REFINE=0.

const { execFile } = require('child_process');
const { resolveTool } = require('../utils/toolPaths');

const EDGE_BUDGET_SEC = 0.35;
const START_LEAD_SEC = 0.04;
const END_TAIL_SEC = 0.06;
const MIN_SILENCE_SEC = 0.08;
const MAX_SHRINK_SEC = 0.7;
const MIN_DURATION_FLOOR_SEC = 3;
const MEASURE_TIMEOUT_MS = 180000;

const SILENCE_START_RE = /silence_start:\s*(-?\d+(?:\.\d+)?)/g;
const SILENCE_END_RE = /silence_end:\s*(-?\d+(?:\.\d+)?)/g;
const MEAN_VOLUME_RE = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/;

function isDisabled() {
  return ['0', 'false', 'off'].includes(
    String(process.env.HIGHLIGHT_EDGE_REFINE || '').trim().toLowerCase()
  );
}

function runFfmpegStderr(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      resolveTool('ffmpeg', { envKey: 'FFMPEG_PATH' }),
      ['-hide_banner', '-nostats', ...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => {
        const text = String(stderr || '');
        // -f null exits 0 normally; keep the stderr even on odd exits as long
        // as the filters produced output.
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

function nearestTrough(silences, target, pickEdge) {
  let best = null;
  for (const [s, e] of silences) {
    const anchor = pickEdge === 'end' ? e : s;
    const dist = Math.abs(anchor - target);
    if (dist <= EDGE_BUDGET_SEC && (best === null || dist < best.dist)) {
      best = { dist, s, e };
    }
  }
  return best;
}

// Pure: refine one window against the silence list. Returns
// { start, end, path } and never moves an edge more than EDGE_BUDGET_SEC.
function snapWindowEdges(startSec, endSec, silences, { floorStart = null, maxDurationSec = 0 } = {}) {
  let start = startSec;
  let end = endSec;
  const parts = [];

  // Start edge -> END of the nearest trough: the cut opens as sound begins.
  const startHit = nearestTrough(silences, startSec, 'end');
  if (startHit) {
    const candidate = Math.min(Math.max(startHit.e - START_LEAD_SEC, startHit.s), startHit.e);
    if (Math.abs(candidate - startSec) <= EDGE_BUDGET_SEC && Math.abs(candidate - startSec) > 1e-6) {
      start = candidate;
      parts.push('silence_start');
    }
  }
  // End edge -> START of the nearest trough: the cut closes as sound stops.
  const endHit = nearestTrough(silences, endSec, 'start');
  if (endHit) {
    const candidate = Math.min(Math.max(endHit.s + END_TAIL_SEC, endHit.s), endHit.e);
    if (Math.abs(candidate - endSec) <= EDGE_BUDGET_SEC && Math.abs(candidate - endSec) > 1e-6) {
      end = candidate;
      parts.push('silence_end');
    }
  }

  if (floorStart !== null) start = Math.max(start, floorStart);
  start = Math.max(0, start);

  const originalDuration = endSec - startSec;
  const durationFloor = Math.max(MIN_DURATION_FLOOR_SEC, originalDuration - MAX_SHRINK_SEC);

  // Duration guards revert edge moves instead of inventing new positions.
  if (maxDurationSec > 0 && end - start > maxDurationSec && parts.includes('silence_end')) {
    end = endSec;
    parts.splice(parts.indexOf('silence_end'), 1);
  }
  if (maxDurationSec > 0 && end - start > maxDurationSec && parts.includes('silence_start')) {
    start = Math.max(startSec, floorStart ?? startSec);
    parts.splice(parts.indexOf('silence_start'), 1);
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
    summary: { enabled: false, refined_count: 0, noise_db: null, silence_count: 0 }
  };
  if (isDisabled() || !videoPath || !Array.isArray(windows) || !windows.length) {
    return passthrough;
  }

  let detection;
  try {
    detection = await detectSilences(videoPath);
  } catch (error) {
    return {
      windows,
      summary: {
        enabled: true, refined_count: 0, noise_db: null, silence_count: 0,
        error: `silence_detection_failed: ${error.message}`
      }
    };
  }

  const { silences, noiseDb } = detection;
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
    const snapped = snapWindowEdges(startSec, endSec, silences, {
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
      noise_db: noiseDb
    };
    refinedCount += 1;
  }

  return {
    windows: refined,
    summary: {
      enabled: true,
      refined_count: refinedCount,
      noise_db: noiseDb,
      silence_count: silences.length
    }
  };
}

module.exports = {
  refineHighlightWindowEdges,
  __test: {
    snapWindowEdges,
    parseSilences,
    EDGE_BUDGET_SEC,
    START_LEAD_SEC,
    END_TAIL_SEC,
    MAX_SHRINK_SEC
  }
};

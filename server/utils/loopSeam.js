const { execFile } = require('child_process');
const { promisify } = require('util');
const { resolveTool, getToolEnv } = require('./toolPaths');
const { createHttpError } = require('../services/errorService');

const execFileAsync = promisify(execFile);

function ffmpegPath() {
  return resolveTool('ffmpeg', { envKey: 'FFMPEG_PATH' });
}

// Zero Gemini cost: compares the first frame of a window against its last frame
// via ffmpeg's own SSIM filter (structural similarity, 0..1, 1 = identical).
// As of prompt v2.1, this is the sole source of the visual-continuity signal
// for loop_seam -- see deriveLoopSeam() below. It's also used by the slicer's
// fine-grained window search.
async function computeSeamScore(videoPath, { start = null, duration = null } = {}) {
  const startArgs = start != null ? ['-ss', String(start)] : [];
  // 0.15s margin before the window's true end: seeking any closer to a stream's
  // actual last frame unreliably yields zero decodable frames on some sources
  // (empirically confirmed against a real downloaded clip), which silently
  // starves the ssim filter of its second input and produces no output at all.
  const endPos = start != null && duration != null ? String(start + duration - 0.15) : null;

  const args = [
    '-hide_banner', '-nostats',
    ...startArgs, '-i', videoPath,
    ...(endPos != null ? ['-ss', endPos] : ['-sseof', '-0.15']),
    '-i', videoPath,
    '-filter_complex',
    '[0:v]select=eq(n\\,0),scale=320:-2,format=gray[a];' +
    '[1:v]select=eq(n\\,0),scale=320:-2,format=gray[b];' +
    '[a][b]ssim',
    '-an', '-f', 'null', '-'
  ];

  let stderr = '';
  try {
    const result = await execFileAsync(ffmpegPath(), args, { timeout: 60_000, env: getToolEnv() });
    stderr = result.stderr || '';
  } catch (error) {
    stderr = error.stderr || '';
    if (!stderr) {
      throw createHttpError(500, 'SEAM_SCORE_FFMPEG_FAILED', error.message, { cause: error?.stack || String(error) });
    }
  }

  const match = stderr.match(/All:\s*([\d.]+)/);
  if (!match) {
    throw createHttpError(500, 'SEAM_SCORE_PARSE_FAILED', 'Could not parse SSIM output from ffmpeg', { stderr: stderr.slice(-500) });
  }
  return { seamScore: parseFloat(match[1]) };
}

// Rough bucket for quick human-readable inspection of a seam_score value.
// Thresholds are an initial approximation -- tune once real training-clip
// volume lets us check these against downstream success_multiple patterns.
function classifySeamScore(score) {
  if (score >= 0.9) return 'SEAMLESS_LIKELY';
  if (score >= 0.7) return 'AMBIGUOUS';
  return 'HARD_JUMP_LIKELY';
}

// v2.1: loop_seam is derived, not judged by Gemini. Autopsy of v2.0's
// reproducibility failures showed the HARD_JUMP/NATURAL_RESET boundary is a
// semantic question ("does this look like a repeating cycle?"), not a visual
// one -- so we let SSIM answer the visual-continuity question and Gemini's
// action_is_repetitive boolean answer the semantic one, then combine
// deterministically instead of asking one field to answer both at once.
// seamlessThreshold is an initial guess pending the calibration's SSIM
// distribution report.
function deriveLoopSeam(seamScore, actionIsRepetitive, { seamlessThreshold = 0.85 } = {}) {
  if (seamScore === null || seamScore === undefined || Number.isNaN(seamScore)) return 'UNKNOWN';
  if (seamScore >= seamlessThreshold) return 'SEAMLESS';
  return actionIsRepetitive ? 'NATURAL_RESET' : 'HARD_JUMP';
}

// Slicer helper: hold the window duration fixed and slide only the start time
// across a small local range, returning the position with the best seam score.
async function findBestSeamWindow(videoPath, centerStart, duration, { slideRange = 0.4, step = 0.1 } = {}) {
  const candidates = [];
  const from = Math.max(0, centerStart - slideRange);
  const to = centerStart + slideRange;
  for (let s = from; s <= to + 1e-9; s += step) {
    const start = Number(s.toFixed(2));
    try {
      const { seamScore } = await computeSeamScore(videoPath, { start, duration });
      candidates.push({ start, score: seamScore });
    } catch (error) {
      candidates.push({ start, score: null, error: error.message });
    }
  }
  const valid = candidates.filter((c) => c.score !== null);
  if (!valid.length) {
    throw createHttpError(500, 'SEAM_WINDOW_SEARCH_FAILED', 'All candidate windows failed SSIM computation');
  }
  const best = valid.reduce((a, b) => (b.score > a.score ? b : a));
  return { bestStart: best.start, bestScore: best.score, candidates };
}

module.exports = { computeSeamScore, classifySeamScore, deriveLoopSeam, findBestSeamWindow };

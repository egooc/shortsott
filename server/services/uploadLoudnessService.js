// Automatic loudness normalization for finished upload files.
//
// Every CapCut export measured so far ships around -7 LUFS with a true peak of
// +3.5 dBTP (see docs/opensource-adoption-analysis-2026-08-08.md, P3): loud
// enough that platform transcodes can clip audibly. YouTube turns the level
// down to its -14 LUFS reference anyway, so normalizing before upload loses
// nothing and removes the clipping risk. Runs unattended: measure first, only
// re-encode audio when the file is actually out of tolerance, and on any
// failure upload the original file untouched (fail-open - a loudness pass must
// never block an upload).
//
// Video is stream-copied; only the audio track is re-encoded, so the pass takes
// seconds and video quality is untouched. Kill switch: UPLOAD_LOUDNESS_NORMALIZE=0.

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { resolveTool } = require('../utils/toolPaths');

const TARGET_LUFS = -14;
const LOUDNESS_TOLERANCE_LU = 2;
const TRUE_PEAK_CEILING_DB = -1;
const LOUDNORM_FILTER = 'loudnorm=I=-14:TP=-1.5:LRA=11';
const MEASURE_TIMEOUT_MS = 120000;
const RENDER_TIMEOUT_MS = 300000;
const TMP_DIR = path.join(__dirname, '..', 'data', 'youtube_upload_tmp');

const LUFS_RE = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g;
const PEAK_RE = /Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/g;

function isDisabled() {
  return ['0', 'false', 'off'].includes(
    String(process.env.UPLOAD_LOUDNESS_NORMALIZE || '').trim().toLowerCase()
  );
}

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      resolveTool('ffmpeg', { envKey: 'FFMPEG_PATH' }),
      ['-hide_banner', '-nostats', ...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => {
        // ffmpeg -f null exits 0; a render error must reject, but measurement
        // parsing happens on stderr either way.
        if (error && !String(stderr || '').includes('LUFS')) return reject(error);
        resolve(String(stderr || ''));
      }
    );
  });
}

function lastMatch(regex, text) {
  let match = null;
  let current;
  regex.lastIndex = 0;
  while ((current = regex.exec(text))) match = current;
  return match ? Number(match[1]) : null;
}

async function measureLoudness(filePath) {
  const stderr = await runFfmpeg(
    ['-i', filePath, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'],
    MEASURE_TIMEOUT_MS
  );
  const integratedLufs = lastMatch(LUFS_RE, stderr);
  const truePeakDb = lastMatch(PEAK_RE, stderr);
  if (integratedLufs === null) return null;
  return { integratedLufs, truePeakDb };
}

function needsNormalization(measured) {
  if (!measured) return false;
  if (Math.abs(measured.integratedLufs - TARGET_LUFS) > LOUDNESS_TOLERANCE_LU) return true;
  return measured.truePeakDb !== null && measured.truePeakDb > TRUE_PEAK_CEILING_DB;
}

// Returns { path, applied, measured, error? , cleanup() }. `path` is always a
// playable upload source: the normalized temp file when the pass succeeded,
// the original file in every other case.
async function normalizeUploadLoudness(filePath, log = () => {}) {
  const passthrough = { path: filePath, applied: false, measured: null, cleanup: () => {} };
  if (isDisabled()) return passthrough;

  let measured;
  try {
    measured = await measureLoudness(filePath);
  } catch (error) {
    log(`Loudness measure skipped (${error.message}); uploading original audio.`);
    return { ...passthrough, error: `measure_failed: ${error.message}` };
  }
  if (!measured) {
    // No audio stream or unparsable output: nothing to normalize.
    return passthrough;
  }
  if (!needsNormalization(measured)) {
    log(`Loudness OK (${measured.integratedLufs} LUFS / ${measured.truePeakDb} dBTP); no normalization needed.`);
    return { ...passthrough, measured };
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const tmpPath = path.join(
    TMP_DIR,
    `loudnorm_${crypto.randomBytes(4).toString('hex')}${path.extname(filePath) || '.mp4'}`
  );
  try {
    await runFfmpeg(
      ['-y', '-i', filePath,
       '-c:v', 'copy',
       '-af', LOUDNORM_FILTER,
       '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
       '-movflags', '+faststart',
       tmpPath],
      RENDER_TIMEOUT_MS
    );
    const rendered = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
    if (rendered <= 0) throw new Error('normalized file is empty');
    log(`Loudness normalized for upload: ${measured.integratedLufs} LUFS / ${measured.truePeakDb} dBTP -> ${TARGET_LUFS} LUFS target (video stream copied).`);
    return {
      path: tmpPath,
      applied: true,
      measured,
      cleanup: () => { try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ } }
    };
  } catch (error) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    log(`Loudness normalization failed (${error.message}); uploading original file.`);
    return { ...passthrough, measured, error: `normalize_failed: ${error.message}` };
  }
}

module.exports = {
  normalizeUploadLoudness,
  __test: {
    needsNormalization,
    lastMatch,
    LUFS_RE,
    PEAK_RE,
    TARGET_LUFS,
    LOUDNESS_TOLERANCE_LU,
    TRUE_PEAK_CEILING_DB,
    LOUDNORM_FILTER
  }
};

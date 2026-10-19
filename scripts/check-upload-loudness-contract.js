// Guards the automatic upload loudness normalization contract.
//
// Every measured CapCut export ran ~-7 LUFS with +3.5 dBTP true peak (platform
// transcode clipping risk). The upload path must keep normalizing audio to the
// -14 LUFS reference automatically, fail-open (an audio pass must never block
// an upload), with the video stream copied untouched.
const fs = require('fs');
const path = require('path');
const {
  __test: loudnessTest
} = require('../server/services/uploadLoudnessService');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const uploadSource = read('server/services/youtubeUploadService.js');
const serviceSource = read('server/services/uploadLoudnessService.js');

// --- wiring ------------------------------------------------------------------

assert(
  uploadSource.includes("require('./uploadLoudnessService')"),
  'youtubeUploadService must import the loudness service'
);
assert(
  uploadSource.includes('normalizeUploadLoudness(filePath'),
  'uploadVideoToYouTube must normalize loudness before uploading'
);
assert(
  uploadSource.includes('fs.readFileSync(uploadFilePath)'),
  'the upload PUT body must read the (possibly normalized) uploadFilePath, not the raw filePath'
);
assert(
  uploadSource.includes('loudness.cleanup()'),
  'the normalized temp file must be cleaned up after the upload attempt'
);

// --- fail-open + stream copy -------------------------------------------------

assert(
  serviceSource.includes("'-c:v', 'copy'"),
  'normalization must stream-copy video; only audio is re-encoded'
);
assert(
  serviceSource.includes('uploading original'),
  'measure/normalize failures must fall back to the original file (fail-open)'
);
assert(
  serviceSource.includes('UPLOAD_LOUDNESS_NORMALIZE'),
  'the kill switch env var must exist'
);
assert(
  loudnessTest.LOUDNORM_FILTER.includes('I=-14'),
  'the loudnorm target must stay at the -14 LUFS platform reference'
);

// --- threshold behavior ------------------------------------------------------

const { needsNormalization } = loudnessTest;
assert(
  needsNormalization({ integratedLufs: -7.0, truePeakDb: 3.5 }) === true,
  'a -7 LUFS / +3.5 dBTP export (the measured CapCut reality) must be normalized'
);
assert(
  needsNormalization({ integratedLufs: -13.9, truePeakDb: -2.0 }) === false,
  'a file already at the reference must pass through untouched'
);
assert(
  needsNormalization({ integratedLufs: -14.5, truePeakDb: -0.5 }) === true,
  'loudness in tolerance but true peak above -1 dBTP must still be normalized'
);
const BEFORE = Date.parse('2026-10-20T23:59:00+09:00');
const AFTER = Date.parse('2026-10-21T00:00:00+09:00');
assert(
  needsNormalization({ integratedLufs: -15.8, truePeakDb: -1.5 }, BEFORE) === false,
  'before 2026-10-21 a -15.8 LUFS file stays inside the ±2 window (warn only)'
);
assert(
  needsNormalization({ integratedLufs: -15.8, truePeakDb: -1.5 }, AFTER) === true,
  'from 2026-10-21 00:00 KST the window is ±1, so -15.8 LUFS is normalized'
);
assert(
  loudnessTest.toleranceAt(BEFORE) === 2 && loudnessTest.toleranceAt(AFTER) === 1,
  'tolerance switches from 2 to 1 LU at 2026-10-21 00:00 KST'
);
assert(
  needsNormalization(null) === false,
  'no measurement (no audio stream) means passthrough, not normalization'
);

console.log('check-upload-loudness: OK');

// Eligibility gate for AUTO-HARVESTED sources only (approved 2026-08-10).
//
// Human-curated queue items are trusted and never gated - calibration over 15
// ground-truth sources showed the curated basket contains nothing for a
// category gate to cut (docs/source-eligibility-spec-2026-08-10.md §0). This
// gate exists for uncurated daily-harvest imports, where talking-head / static
// / face-led videos can enter. It runs in the metadata stage BEFORE the
// Gemini analysis, on the already-downloaded source, via the local signal
// probe (scripts/source_eligibility_probe.py: Silero VAD + YuNet + sampled
// motion, ~40s per source, zero API cost, sample-bounded regardless of length).
//
// Verdict thresholds (conservative starters - an ineligible verdict must be
// obviously right):
//   speech_ratio    > 0.35 -> talk-led        (our catalog measures 0~0.17)
//   face_dominant   > 0.20 -> face-led        (our catalog measures 0~0.03)
//   static_ratio    > 0.50 -> static content  (our catalog measures 0~0.08)
// Anything else - including a failed probe - passes (fail-open): the gate may
// only save analysis cost, never silently discard a workable source.
// Kill switch: SOURCE_ELIGIBILITY_GATE=0.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { resolveTool } = require('../utils/toolPaths');

const PROBE_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'source_eligibility_probe.py');
const PROBE_TIMEOUT_MS = 240000;

const SPEECH_RATIO_MAX = 0.35;
const FACE_DOMINANT_RATIO_MAX = 0.2;
const STATIC_RATIO_MAX = 0.5;

function isGateDisabled() {
  return ['0', 'false', 'off'].includes(
    String(process.env.SOURCE_ELIGIBILITY_GATE || '').trim().toLowerCase()
  );
}

async function runProbe(videoPath) {
  const tmpPath = path.join(os.tmpdir(), `eligibility_${crypto.randomBytes(4).toString('hex')}.json`);
  try {
    await new Promise((resolve, reject) => {
      execFile(
        resolveTool('python', { envKey: 'PYTHON_PATH' }),
        [PROBE_SCRIPT, videoPath, '--json', tmpPath],
        { timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (error) => (error ? reject(error) : resolve())
      );
    });
    return JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
  } finally {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
  }
}

// Returns { eligible, reasons: [], signals, gate: 'enforced'|'disabled'|'probe_failed' }.
async function evaluateSourceEligibility({ videoPath }) {
  if (isGateDisabled()) {
    return { eligible: true, reasons: [], signals: null, gate: 'disabled' };
  }
  let signals;
  try {
    signals = await runProbe(videoPath);
  } catch (error) {
    return {
      eligible: true, reasons: [], signals: null,
      gate: `probe_failed: ${String(error.message || error).slice(0, 120)}`
    };
  }
  const reasons = [];
  if (Number(signals.speech_ratio) > SPEECH_RATIO_MAX) {
    reasons.push(`speech_ratio ${signals.speech_ratio} > ${SPEECH_RATIO_MAX} (대사 중심)`);
  }
  if (Number(signals.face_dominant_ratio) > FACE_DOMINANT_RATIO_MAX) {
    reasons.push(`face_dominant_ratio ${signals.face_dominant_ratio} > ${FACE_DOMINANT_RATIO_MAX} (얼굴 주도)`);
  }
  if (Number(signals.static_ratio) > STATIC_RATIO_MAX) {
    reasons.push(`static_ratio ${signals.static_ratio} > ${STATIC_RATIO_MAX} (정적 영상)`);
  }
  return { eligible: reasons.length === 0, reasons, signals, gate: 'enforced' };
}

module.exports = {
  evaluateSourceEligibility,
  __test: {
    isGateDisabled,
    SPEECH_RATIO_MAX,
    FACE_DOMINANT_RATIO_MAX,
    STATIC_RATIO_MAX
  }
};

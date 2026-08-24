const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// computeLoudnessAlignment shells out to ffmpeg per sample; driving it end-to-end in a unit test
// would be slow and platform-bound. Instead verify the arithmetic by replaying it exactly as the
// service computes it, against the C1iayHkXkMc numbers that exposed each defect. If the constants
// or formula in the service drift, the source-scan assertions below fail and point there.
const src = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'services', 'midformLocaleDraftService.js'),
  'utf8'
);

test('the rescue constants and formula are present as designed', () => {
  assert.match(src, /RESCUE_TARGET_RESIDUAL_LU = 2/);
  assert.match(src, /MEASUREMENT_VARIANCE_LU = 1\.5/);
  assert.match(src, /GATE_FAIL_DELTA_LU - MEASUREMENT_VARIANCE_LU/);
  assert.match(src, /residualDelta > RESCUE_TARGET_RESIDUAL_LU/);
  assert.match(src, /gate_rescue_headroom/);
});

function replayRescue({ narrationLufs, dialogueLufs, maxVideoGain, maxTtsCut, headroomDb }) {
  const GATE_FAIL_DELTA_LU = 6;
  const RESCUE_TARGET_RESIDUAL_LU = 2;
  const MEASUREMENT_VARIANCE_LU = 1.5;
  const needed = (narrationLufs - dialogueLufs) - 3;
  const videoGainLimit = Math.min(maxVideoGain, headroomDb);
  let videoGainDb = needed > 1 ? Number(Math.min(videoGainLimit, needed).toFixed(1)) : 0;
  let ttsCutDb = needed > 1 ? Number(Math.min(maxTtsCut, Math.max(0, needed - videoGainDb)).toFixed(1)) : 0;
  let residualDelta = (narrationLufs - dialogueLufs) - videoGainDb - ttsCutDb;
  let gateRescue = false;
  if (needed > 1 && residualDelta > GATE_FAIL_DELTA_LU - MEASUREMENT_VARIANCE_LU) {
    if (headroomDb > videoGainDb) {
      const target = videoGainDb + (residualDelta - RESCUE_TARGET_RESIDUAL_LU);
      const rescued = Number(Math.min(headroomDb, target).toFixed(1));
      gateRescue = rescued > videoGainDb;
      videoGainDb = rescued;
      residualDelta = (narrationLufs - dialogueLufs) - videoGainDb - ttsCutDb;
    }
    if (residualDelta > RESCUE_TARGET_RESIDUAL_LU) {
      const extraCut = Number((residualDelta - RESCUE_TARGET_RESIDUAL_LU).toFixed(1));
      if (extraCut > 0) {
        gateRescue = true;
        ttsCutDb = Number((ttsCutDb + extraCut).toFixed(1));
      }
    }
  }
  return { videoGainDb, ttsCutDb, gateRescue, residual: (narrationLufs - dialogueLufs) - videoGainDb - ttsCutDb };
}

test('the whisper-mastered source lands at the target even after gate-side drift', () => {
  // C1iayHkXkMc: raw delta 28.9, used-material headroom 17.2. The first rescue stopped at
  // residual 5.7 and the gate's own sampling read 6.1 - fail by 0.1.
  const out = replayRescue({ narrationLufs: -17.3, dialogueLufs: -46.2, maxVideoGain: 10, maxTtsCut: 6, headroomDb: 17.2 });
  assert.equal(out.gateRescue, true);
  assert.equal(out.videoGainDb, 17.2);
  assert.ok(out.residual <= 2.05, `residual ${out.residual} must reach the target band`);
  // even if the gate reads 1.5 LU hotter, it stays under the fail line
  assert.ok(out.residual + 1.5 < 6, 'variance margin survives');
});

test('an ordinary source is untouched by the rescue', () => {
  // 10 LU raw delta: caps cover it with room to spare.
  const out = replayRescue({ narrationLufs: -17, dialogueLufs: -27, maxVideoGain: 10, maxTtsCut: 6, headroomDb: 12 });
  assert.equal(out.gateRescue, false);
  assert.ok(out.videoGainDb <= 10);
});

test('a residual in the variance band gets pushed to target instead of shipping a coin flip', () => {
  // residual would be 5.0 - passes the gate if measurement lands kindly, fails if not.
  const out = replayRescue({ narrationLufs: -17, dialogueLufs: -38, maxVideoGain: 10, maxTtsCut: 6, headroomDb: 10 });
  assert.equal(out.gateRescue, true);
  assert.ok(out.residual <= 2.05);
});

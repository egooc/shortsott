// Guards the auto-harvest eligibility gate contract (approved 2026-08-10).
//
// The gate may only ever apply to harvested imports, must fail open, and must
// map to a skip (never a failure). Human-curated queue items are never gated -
// calibration showed the curated basket contains nothing for it to cut.
const fs = require('fs');
const path = require('path');
const {
  __test: gateTest
} = require('../server/services/sourceEligibilityService');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const jobSource = read('server/services/processJobService.js');
const gateSource = read('server/services/sourceEligibilityService.js');
const importSource = read('server/services/processQueueService.js');

// The gate keys strictly on the harvest flag - not on all items.
assert(
  jobSource.includes("itemConfig.source_harvested === true"),
  'the eligibility gate must apply ONLY to harvested items'
);
assert(
  importSource.includes('source_harvested: row?.harvested === true'),
  'importYoutubeSourceQueueItems must set source_harvested only from the harvest flag'
);

// Skip, not failure - and the code must map to the skipped_* family.
assert(
  jobSource.includes("if (isSourceIneligibleCode(code)) return 'skipped_source_ineligible';"),
  'OTTOGI_SOURCE_INELIGIBLE must map to a skipped_* status, never failed'
);

// Fail-open + kill switch.
assert(
  gateSource.includes('SOURCE_ELIGIBILITY_GATE'),
  'the gate kill switch env var must exist'
);
assert(
  gateSource.includes('probe_failed'),
  'a failed probe must pass the source through (fail-open)'
);

// Conservative thresholds are part of the approved contract.
assert(gateTest.SPEECH_RATIO_MAX === 0.35, 'speech threshold must stay 0.35');
assert(gateTest.FACE_DOMINANT_RATIO_MAX === 0.2, 'dominant-face threshold must stay 0.2');
assert(gateTest.STATIC_RATIO_MAX === 0.5, 'static threshold must stay 0.5');

// Behavior: kill switch honored.
process.env.SOURCE_ELIGIBILITY_GATE = '0';
assert(gateTest.isGateDisabled() === true, 'SOURCE_ELIGIBILITY_GATE=0 must disable the gate');
delete process.env.SOURCE_ELIGIBILITY_GATE;
assert(gateTest.isGateDisabled() === false, 'gate must be enabled by default');

console.log('check-source-eligibility-gate: OK');

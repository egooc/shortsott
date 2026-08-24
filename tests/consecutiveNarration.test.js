const test = require('node:test');
const assert = require('node:assert');

const { _test } = require('../server/services/midformCompressionService');
const { consecutiveNarrationRuns } = _test;

function plan(...decisions) {
  return { timeline: decisions.map((d, i) => ({ slot_id: `s${i + 1}`, decision: d })) };
}
function fills(...narrations) {
  return { slot_fills: narrations.map((n, i) => ({ slot_id: `s${i + 1}`, narration: n })) };
}
const N = 'NARRATE';
const D = 'KEEP_DIALOGUE';

test('three narration slots in a row are flagged', () => {
  const runs = consecutiveNarrationRuns(fills('a', 'b', 'c'), plan(N, N, N));
  assert.deepEqual(runs, [['s1', 's2', 's3']]);
});

test('two in a row is the allowed maximum', () => {
  assert.deepEqual(consecutiveNarrationRuns(fills('a', 'b'), plan(N, N)), []);
});

test('dialogue between narrations breaks the run - that is the house shape', () => {
  const runs = consecutiveNarrationRuns(fills('a', '', 'b', '', 'c'), plan(N, D, N, D, N));
  assert.deepEqual(runs, []);
});

test('an EMPTY narration slot does not extend a run - nothing is heard there', () => {
  // s2 is a silent action beat between two narrations; the viewer gets a break.
  const runs = consecutiveNarrationRuns(fills('a', '', 'b'), plan(N, N, N));
  assert.deepEqual(runs, []);
});

test('a run at the very end of the timeline is still caught', () => {
  const runs = consecutiveNarrationRuns(fills('', 'a', 'b', 'c'), plan(D, N, N, N));
  assert.deepEqual(runs, [['s2', 's3', 's4']]);
});

test('two separate runs are both reported', () => {
  const runs = consecutiveNarrationRuns(
    fills('a', 'b', 'c', '', 'd', 'e', 'f'),
    plan(N, N, N, D, N, N, N)
  );
  assert.equal(runs.length, 2);
});

// Deliberately NOT wired into the fills-time throw. Enforcing it there was unsatisfiable: an
// empty slot breaks a run, so the model resolved the complaint by emptying one, which the
// empty-slot rule then rejected - with three consecutive NARRATE slots in the plan, no output
// could satisfy both (casebook 46). The run is a property of the plan; detection stays so it can
// be reported, and the fix belongs upstream.
test('the economy check does NOT throw on a run - the two rules would deadlock', () => {
  const problems = _test.narrationEconomyProblems(fills('가.', '나.', '다.'), plan(N, N, N), 'ko');
  assert.ok(!problems.some((p) => /back to back/.test(p)));
});

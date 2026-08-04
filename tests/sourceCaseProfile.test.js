const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');
const { profileSourceCase, buildSourceCaseGuidance } = _test;

// The casebook's judgement, computed: speech density and whether the most-replayed peak lands on
// speech decide the editing approach (midform/docs/source-casebook.md).
function cuesCovering(pairs) {
  return pairs.map(([s, e]) => ({ start_sec: s, end_sec: e, text: 'a spoken line here' }));
}

test('an Anger-Management-shaped source profiles short, dense, dialogue-peak', () => {
  const cues = cuesCovering([[0, 60], [61, 120], [121, 150]]);
  const heatmap = { items: [{ start_sec: 100, end_sec: 110, score: 0.9 }, { start_sec: 10, end_sec: 20, score: 0.3 }] };
  const p = profileSourceCase(cues, { duration: 163 }, heatmap);
  assert.equal(p.case_type, 'short_source+dialogue_dense+dialogue_peak');
  assert.ok(p.speech_density > 0.85);
});

test('a Breaking-Dawn-shaped source profiles sparse with an action peak', () => {
  const cues = cuesCovering([[0, 50], [60, 90]]);
  const heatmap = { items: [{ start_sec: 400, end_sec: 410, score: 0.95 }] };
  const p = profileSourceCase(cues, { duration: 529 }, heatmap);
  assert.equal(p.case_type, 'sparse_dialogue+action_peak');
  assert.equal(p.peak_is_dialogue, false);
});

test('sound-effect captions do not count as speech', () => {
  const cues = [
    { start_sec: 0, end_sec: 100, text: '[Music]' },
    { start_sec: 100, end_sec: 130, text: 'a real line' }
  ];
  const p = profileSourceCase(cues, { duration: 300 }, { items: [{ start_sec: 50, end_sec: 55, score: 1 }] });
  assert.ok(p.speech_density < 0.35, `music must not count, got ${p.speech_density}`);
  assert.equal(p.peak_is_dialogue, false, 'a peak over music is not a dialogue peak');
});

test('guidance names the case and matches its rules', () => {
  const dense = buildSourceCaseGuidance({ case_type: 'short_source+dialogue_dense+dialogue_peak', duration_sec: 163, speech_density: 0.9, peak_is_dialogue: true }).join(' ');
  assert.match(dense, /Chain preserved dialogue back to back/);
  assert.match(dense, /captioned hook/);
  assert.match(dense, /completeness beats length/i);
  const sparse = buildSourceCaseGuidance({ case_type: 'sparse_dialogue+action_peak', duration_sec: 529, speech_density: 0.2, peak_is_dialogue: false }).join(' ');
  assert.match(sparse, /speech-forward structure is impossible/);
  assert.match(sparse, /uncaptioned source-audio teaser/);
  assert.deepEqual(buildSourceCaseGuidance(null), []);
});

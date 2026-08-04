const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');
const { applyColdOpenVisualOverlapSafety } = _test;

// The Anger Management shape: the heatmap-peak beat (102.72-114.19) is reserved wall to wall by
// the dialogue that peaks there, so the in-beat shift cannot succeed and the teaser used to stay
// inside a preserved line.
const beats = new Map([
  ['beat_4', { beat_id: 'beat_4', start_sec: 86.92, end_sec: 102.72 }],
  ['beat_5', { beat_id: 'beat_5', start_sec: 102.72, end_sec: 114.19 }]
]);

function timelineWithTeaser(teaserStart, teaserEnd) {
  return [
    {
      slot_id: '1', role: 'cold_open', decision: 'NARRATE',
      visual_source_mode: 'source_audio_teaser', visual_source_beat_id: 'beat_5',
      visual_source_start_sec: teaserStart, visual_source_end_sec: teaserEnd,
      estimated_duration_sec: teaserEnd - teaserStart
    },
    { slot_id: '5', role: 'body_peak', decision: 'KEEP_DIALOGUE', start_sec: 86.92, end_sec: 97.5 },
    { slot_id: '6', role: 'body', decision: 'KEEP_DIALOGUE', start_sec: 102.72, end_sec: 114.19 }
  ];
}

test('a teaser whose beat is fully reserved moves to the nearest free window', () => {
  const result = applyColdOpenVisualOverlapSafety(timelineWithTeaser(105.95, 109.21), beats);
  const cold = result[0];
  const start = Number(cold.visual_source_start_sec);
  const end = Number(cold.visual_source_end_sec);
  assert.ok(end > start, 'the teaser survives');
  assert.ok(end - start >= 3 - 1e-6, 'and keeps at least the minimum length');
  for (const [rs, re] of [[86.92, 97.5], [102.72, 114.19]]) {
    assert.ok(end <= rs || start >= re, `teaser [${start},${end}] still overlaps [${rs},${re}]`);
  }
  // The nearest free footage is the tail of beat_4 (97.5-102.72), right before the peak.
  assert.ok(start >= 97.5 - 1e-6 && end <= 102.72 + 1e-6, `expected the beat_4 tail, got [${start},${end}]`);
});

test('a teaser with no overlap is untouched', () => {
  const result = applyColdOpenVisualOverlapSafety(timelineWithTeaser(98.0, 101.0), beats);
  assert.equal(Number(result[0].visual_source_start_sec), 98.0);
  assert.equal(Number(result[0].visual_source_end_sec), 101.0);
});

test('with every beat reserved the teaser is left for preflight to report', () => {
  const allReserved = [
    timelineWithTeaser(105.95, 109.21)[0],
    { slot_id: '5', role: 'body_peak', decision: 'KEEP_DIALOGUE', start_sec: 86.92, end_sec: 102.72 },
    { slot_id: '6', role: 'body', decision: 'KEEP_DIALOGUE', start_sec: 102.72, end_sec: 114.19 }
  ];
  const result = applyColdOpenVisualOverlapSafety(allReserved, beats);
  assert.equal(Number(result[0].visual_source_start_sec), 105.95, 'nothing silently invented');
});

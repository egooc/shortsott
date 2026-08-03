const assert = require('node:assert/strict');
const test = require('node:test');

const { buildBootstrapSlotMapAndScript } = require('../server/services/midformBootstrapAdapterService');

const toSec = (tc) => {
  const [h, m, s] = String(tc).split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};

function planWithLines(windows) {
  return {
    timeline: [{
      slot_id: 'slot_09',
      role: 'body',
      decision: 'KEEP_DIALOGUE',
      estimated_duration_sec: 10,
      dialogue_focus_lines: windows.map((_, i) => `line ${i + 1}`),
      dialogue_focus_quotes: windows.map((_, i) => `line ${i + 1}`),
      dialogue_line_windows: windows.map(([start, end], i) => ({ matched: true, line: `line ${i + 1}`, start_sec: start, end_sec: end }))
    }]
  };
}

const fillsFor = (n) => ({ slot_fills: [{ slot_id: 'slot_09', caption_kr_dialogue: Array.from({ length: n }, (_, i) => `자막 ${i + 1}`) }] });

function clipRanges(script) {
  return script.segments
    .filter((s) => s.segment_type === 'dialogue_quote')
    .flatMap((s) => (s.source_scenes || []).map((c) => [toSec(c.start), toSec(c.end)]))
    .sort((a, b) => a[0] - b[0]);
}

function assertNoOverlap(ranges) {
  for (let i = 1; i < ranges.length; i += 1) {
    assert.ok(
      ranges[i][0] >= ranges[i - 1][1] - 1e-6,
      `clip ${JSON.stringify(ranges[i])} starts inside ${JSON.stringify(ranges[i - 1])}`
    );
  }
}

// Both sides used to be clamped to the NEIGHBOUR'S SPEECH rather than to each other, so a
// post-roll and the next pre-roll expanded into the same gap: slot_09_L03 ran to 244.85 while
// L04 opened at 244.72, and the cross-segment overlap gate rejected the whole plan.
test('consecutive lines with a narrow gap produce non-overlapping clips', () => {
  const windows = [[240.0, 242.4], [242.5, 244.85], [244.72 + 0.28, 248.01], [500.25, 502.0]];
  const { script } = buildBootstrapSlotMapAndScript(planWithLines(windows), fillsFor(windows.length), { sourceDurationSec: 529.561 });
  assertNoOverlap(clipRanges(script));
});

test('a gap of a few hundredths still yields separate clips', () => {
  const windows = [[500.25, 502.0], [502.03, 505.138]];
  const { script } = buildBootstrapSlotMapAndScript(planWithLines(windows), fillsFor(windows.length), { sourceDurationSec: 529.561 });
  const ranges = clipRanges(script);
  assertNoOverlap(ranges);
  assert.equal(ranges.length, 2, 'both lines should still be cut');
  for (const [start, end] of ranges) assert.ok(end > start, 'and neither may collapse');
});

test('lines with room around them still get their padding', () => {
  const windows = [[100.0, 102.0], [140.0, 142.0]];
  const { script } = buildBootstrapSlotMapAndScript(planWithLines(windows), fillsFor(windows.length), { sourceDurationSec: 529.561 });
  const ranges = clipRanges(script);
  assertNoOverlap(ranges);
  assert.ok(ranges[0][0] < 100.0, 'a line with clear air keeps its pre-roll');
  assert.ok(ranges[0][1] > 102.0, 'and its post-roll');
});

test('every clip still contains the speech it belongs to', () => {
  const windows = [[240.0, 242.4], [242.5, 244.85], [245.0, 248.01]];
  const { script } = buildBootstrapSlotMapAndScript(planWithLines(windows), fillsFor(windows.length), { sourceDurationSec: 529.561 });
  const segments = script.segments.filter((s) => s.segment_type === 'dialogue_quote');
  for (const segment of segments) {
    const [speechStart, speechEnd] = segment.dialogue_speech_range_sec;
    const clip = segment.source_scenes[0];
    assert.ok(toSec(clip.start) <= speechStart + 1e-6, `clip starts after the speech for ${segment.segment_id}`);
    assert.ok(toSec(clip.end) >= speechEnd - 1e-6, `clip ends before the speech for ${segment.segment_id}`);
  }
});

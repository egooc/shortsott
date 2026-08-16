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

const { _test } = require('../server/services/midformCompressionService');

// Auto-caption cues overlap slightly, so two different lines shared a moment: the teaser ran to
// 171.57 while the next line opened at 171.32. Not duplicates, but the capcut gates reject any
// overlap at all.
test('two different lines that share a moment are split down the middle', () => {
  const timeline = [
    {
      slot_id: 'slot_001', role: 'cold_open', decision: 'KEEP_DIALOGUE',
      dialogue_line_windows: [{ matched: true, line: 'hook', start_sec: 166.83, end_sec: 171.57 }]
    },
    {
      slot_id: 'slot_006', role: 'body_peak', decision: 'KEEP_DIALOGUE',
      dialogue_line_windows: [{ matched: true, line: 'accusation', start_sec: 171.32, end_sec: 174.28 }]
    }
  ];
  const result = _test.separateOverlappingDialogueWindows(timeline);
  const a = result[0].dialogue_line_windows[0];
  const b = result[1].dialogue_line_windows[0];
  assert.ok(a.end_sec <= b.start_sec + 1e-6, `${a.end_sec} still runs into ${b.start_sec}`);
  assert.ok(a.end_sec > a.start_sec && b.end_sec > b.start_sec, 'neither line may invert');
  assert.equal(a.end_sec, 171.445, 'the contested span is halved');
});

test('windows that already sit apart are untouched', () => {
  const timeline = [{
    slot_id: 's', role: 'body', decision: 'KEEP_DIALOGUE',
    dialogue_line_windows: [
      { matched: true, line: 'a', start_sec: 10, end_sec: 12 },
      { matched: true, line: 'b', start_sec: 20, end_sec: 22 }
    ]
  }];
  const result = _test.separateOverlappingDialogueWindows(timeline);
  assert.deepEqual(result[0].dialogue_line_windows.map((w) => [w.start_sec, w.end_sec]), [[10, 12], [20, 22]]);
});

test('a short line is not shaved below readability', () => {
  const timeline = [
    { slot_id: 'a', role: 'body', decision: 'KEEP_DIALOGUE', dialogue_line_windows: [{ matched: true, line: 'long', start_sec: 100, end_sec: 106 }] },
    { slot_id: 'b', role: 'body', decision: 'KEEP_DIALOGUE', dialogue_line_windows: [{ matched: true, line: 'tiny', start_sec: 105.8, end_sec: 106.1 }] }
  ];
  const result = _test.separateOverlappingDialogueWindows(timeline);
  for (const item of result) {
    const w = item.dialogue_line_windows[0];
    assert.ok(w.end_sec > w.start_sec, `${item.slot_id} inverted`);
  }
});

// Lines in DIFFERENT slots never saw each other: the per-slot ordering only holds prev/next
// within one slot, so slot_001's post-roll ran to 171.72 while slot_006 opened at 171.34 even
// though their speech had already been split apart at 171.445.
test('clips from different slots do not overlap either', () => {
  const editPlan = {
    timeline: [
      {
        slot_id: 'slot_001', role: 'cold_open', decision: 'KEEP_DIALOGUE', estimated_duration_sec: 5,
        dialogue_focus_lines: ['hook'], dialogue_focus_quotes: ['hook'],
        dialogue_line_windows: [{ matched: true, line: 'hook', start_sec: 166.83, end_sec: 171.445 }]
      },
      {
        slot_id: 'slot_006', role: 'body_peak', decision: 'KEEP_DIALOGUE', estimated_duration_sec: 3,
        dialogue_focus_lines: ['accusation'], dialogue_focus_quotes: ['accusation'],
        dialogue_line_windows: [{ matched: true, line: 'accusation', start_sec: 171.445, end_sec: 174.28 }]
      }
    ]
  };
  const fills = {
    slot_fills: [
      { slot_id: 'slot_001', caption_kr_dialogue: ['훅'] },
      { slot_id: 'slot_006', caption_kr_dialogue: ['고발'] }
    ]
  };
  const { script } = buildBootstrapSlotMapAndScript(editPlan, fills, { sourceDurationSec: 529.561 });
  assertNoOverlap(clipRanges(script));
});

// The padding guards only fire when the neighbour is CLEAR of this line, so a pair that still
// overlaps when it reaches the adapter gets padded freely and ships overlapping video. Long Shot
// slot_010 arrived as 463.76~466.133 against 465.806~469.32, failed preflight, and the run fell
// back to an older compression plan. The adapter now separates the windows again, last, so a plan
// that reached it overlapping (hand edit, exchange restoration) can no longer produce this.
test('an edit plan that still overlaps when it reaches the adapter is separated before padding', () => {
  const { countOverlappingDialogueWindows } = require('../server/services/midformBootstrapAdapterService');
  const timeline = [{
    slot_id: 'slot_010', role: 'body', decision: 'KEEP_DIALOGUE', estimated_duration_sec: 6,
    dialogue_focus_lines: ['sunglasses', 'alopecia'], dialogue_focus_quotes: ['sunglasses', 'alopecia'],
    dialogue_line_windows: [
      { matched: true, line: 'sunglasses', start_sec: 463.76, end_sec: 466.133 },
      { matched: true, line: 'alopecia', start_sec: 465.806, end_sec: 469.32 }
    ]
  }];
  assert.equal(countOverlappingDialogueWindows(timeline), 1, 'the plan really does overlap');
  // Top-level export on purpose: the adapter imports it from here, and an internals-only export
  // meant the adapter threw "not a function" in the middle of a render instead of at load.
  const { separateOverlappingDialogueWindows } = require('../server/services/midformCompressionService');
  const separated = separateOverlappingDialogueWindows(timeline);
  assert.equal(countOverlappingDialogueWindows(separated), 0, 'and separation clears it');
  const fills = { slot_fills: [{ slot_id: 'slot_010', caption_kr_dialogue: ['선글라스', '탈모'] }] };
  const { script } = buildBootstrapSlotMapAndScript({ timeline: separated }, fills, { sourceDurationSec: 529.561 });
  assertNoOverlap(clipRanges(script));
});

// ">> [bell]" is a sound effect, not a line. The matcher can never find it in the transcript, so
// the slot it lands in is permanently not-ok and preflight rejects the plan.
test('sound-effect captions are not treated as dialogue', () => {
  const { isNonSpeechCaption } = _test;
  for (const effect of ['>> [bell]', '[bell]', '(applause)', '♪♪', '  >>  [ door creaks ] ', '']) {
    assert.equal(isNonSpeechCaption(effect), true, `${effect} should not be dialogue`);
  }
  for (const line of ['You made me feel special.', 'I think I love you.', 'Oh.', '>> I am sorry.']) {
    assert.equal(isNonSpeechCaption(line), false, `${line} is dialogue`);
  }
});

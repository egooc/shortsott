const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');
const { buildBootstrapSlotMapAndScript } = require('../server/services/midformBootstrapAdapterService');

// CapCut rejects overlapping VIDEO segments, not overlapping captions, but separating both
// together left every caption strictly serial: 42 segments, zero overlaps, 41 butted end to end.
// Two people talking over each other could never share the screen.
test('separation records the spoken moment before it pulls the clips apart', () => {
  const timeline = [
    {
      slot_id: 'a', role: 'body', decision: 'KEEP_DIALOGUE',
      dialogue_line_windows: [{ matched: true, line: 'first', start_sec: 10.0, end_sec: 13.0 }]
    },
    {
      slot_id: 'b', role: 'body', decision: 'KEEP_DIALOGUE',
      dialogue_line_windows: [{ matched: true, line: 'second', start_sec: 12.0, end_sec: 15.0 }]
    }
  ];
  const result = _test.separateOverlappingDialogueWindows(timeline);
  const first = result[0].dialogue_line_windows[0];
  const second = result[1].dialogue_line_windows[0];

  assert.ok(first.end_sec <= second.start_sec + 1e-6, 'the clips must not overlap');
  assert.equal(first.caption_end_sec, 13.0, 'the caption keeps the moment the line was spoken');
  assert.equal(second.caption_start_sec, 12.0);
  assert.ok(second.caption_start_sec < first.caption_end_sec, 'so the captions still overlap');
});

test('a caption spans its spoken length, not the shortened clip', () => {
  const editPlan = {
    timeline: [{
      slot_id: 'slot_01', role: 'body', decision: 'KEEP_DIALOGUE', estimated_duration_sec: 3,
      dialogue_focus_lines: ['line one'], dialogue_focus_quotes: ['line one'],
      dialogue_line_windows: [{
        matched: true, line: 'line one',
        start_sec: 10.0, end_sec: 11.5,
        caption_start_sec: 10.0, caption_end_sec: 13.0
      }]
    }]
  };
  const fills = { slot_fills: [{ slot_id: 'slot_01', caption_kr_dialogue: ['첫 줄'] }] };
  const { script } = buildBootstrapSlotMapAndScript(editPlan, fills, { sourceDurationSec: 120 });
  const segment = script.segments.find((s) => s.segment_type === 'dialogue_quote');
  const timing = segment.dialogue_timing_adjustment;

  assert.deepEqual(timing.caption_speech_range_sec, [10.0, 13.0]);
  assert.ok(timing.caption_duration_sec > 2.5, `caption should run ~3s, got ${timing.caption_duration_sec}`);
});

test('a window with no recorded caption time falls back to its clip', () => {
  const editPlan = {
    timeline: [{
      slot_id: 'slot_01', role: 'body', decision: 'KEEP_DIALOGUE', estimated_duration_sec: 2,
      dialogue_focus_lines: ['solo'], dialogue_focus_quotes: ['solo'],
      dialogue_line_windows: [{ matched: true, line: 'solo', start_sec: 20.0, end_sec: 22.0 }]
    }]
  };
  const fills = { slot_fills: [{ slot_id: 'slot_01', caption_kr_dialogue: ['혼자'] }] };
  const { script } = buildBootstrapSlotMapAndScript(editPlan, fills, { sourceDurationSec: 120 });
  const timing = script.segments.find((s) => s.segment_type === 'dialogue_quote').dialogue_timing_adjustment;
  assert.deepEqual(timing.caption_speech_range_sec, [20.0, 22.0]);
});

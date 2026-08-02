const assert = require('node:assert/strict');
const test = require('node:test');

const { buildBootstrapSlotMapAndScript } = require('../server/services/midformBootstrapAdapterService');

function parseTimecode(value) {
  const parts = String(value).split(':');
  return parts.length === 3
    ? Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2])
    : Number(parts[0]) * 60 + Number(parts[1]);
}

function editPlan() {
  return {
    timeline: [
      { slot_id: 'slot_01', beat_id: '1', role: 'cold_open', decision: 'NARRATE', start_sec: 0, end_sec: 6, estimated_duration_sec: 6 },
      { slot_id: 'slot_02', beat_id: '2', role: 'bridge', decision: 'NARRATE', start_sec: 10, end_sec: 60, estimated_duration_sec: 12 }
    ],
    duration_budget: { target_sec: 120, estimated_total_sec: 18 }
  };
}

function slotFills() {
  return {
    slot_fills: [
      { slot_id: 'slot_01', narration: '무슨 일이 벌어진 걸까요?', caption_kr: '무슨 일이 벌어진 걸까요?', caption_units: [] },
      { slot_id: 'slot_02', narration: '두 세력이 마주 섭니다. 물러설 곳은 없었죠.', caption_kr: '두 세력이 마주 섭니다.', caption_units: [] }
    ],
    upload_text: {
      title_candidates: ['왜 이렇게 됐을까?', '전쟁이 시작된 이유', '멈출 수 있었던 단 한 가지'],
      overlay_title: { top: '증거 제시', bottom: '전쟁 시작' },
      description: '설명',
      pinned_comment: '고정 댓글'
    }
  };
}

function narrationClipFor(script, segmentId) {
  const segment = script.segments.find((item) => item.segment_id === segmentId);
  const clip = (segment.source_scenes || [])[0];
  return [parseTimecode(clip.start), parseTimecode(clip.end)];
}

test('narration b-roll does not start or end inside an utterance', () => {
  // The window the picker would naturally take runs straight through this speech.
  const speechRanges = [[12, 20], [30, 42]];
  const { script } = buildBootstrapSlotMapAndScript(editPlan(), slotFills(), {
    sourceDurationSec: 600,
    speechRanges
  });

  const [start, end] = narrationClipFor(script, 'slot_02');
  for (const [speechStart, speechEnd] of speechRanges) {
    assert.ok(!(speechStart + 0.12 < start && start < speechEnd - 0.12),
      `clip starts ${start}s, inside speech ${speechStart}-${speechEnd}`);
    assert.ok(!(speechStart + 0.12 < end && end < speechEnd - 0.12),
      `clip ends ${end}s, inside speech ${speechStart}-${speechEnd}`);
  }
  assert.ok(end - start >= 3, `clip should stay usable, got ${end - start}s`);
});

test('b-roll is still produced when every window overlaps speech', () => {
  // Wall-to-wall speech: a slightly clipped shot beats no footage at all.
  const speechRanges = [[0, 600]];
  const { script } = buildBootstrapSlotMapAndScript(editPlan(), slotFills(), {
    sourceDurationSec: 600,
    speechRanges
  });
  const [start, end] = narrationClipFor(script, 'slot_02');
  assert.ok(end > start, 'a narration slot must still get footage');
});

test('b-roll selection is unchanged when no speech ranges are supplied', () => {
  const withoutSpeech = buildBootstrapSlotMapAndScript(editPlan(), slotFills(), { sourceDurationSec: 600 });
  const [start, end] = narrationClipFor(withoutSpeech.script, 'slot_02');
  assert.ok(end > start);
});

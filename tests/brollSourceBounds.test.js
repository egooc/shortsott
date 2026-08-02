const assert = require('node:assert/strict');
const test = require('node:test');

const { buildBootstrapSlotMapAndScript } = require('../server/services/midformBootstrapAdapterService');

const SOURCE_DURATION_SEC = 529.561;

function planWithClosingNarration(slotStart, slotEnd) {
  return {
    timeline: [
      {
        slot_id: 'slot_01',
        role: 'cold_open',
        decision: 'KEEP_DIALOGUE',
        estimated_duration_sec: 3,
        dialogue_focus_lines: ['a line'],
        dialogue_focus_quotes: ['a line'],
        dialogue_line_windows: [{ matched: true, line: 'a line', start_sec: 40.0, end_sec: 43.0 }]
      },
      {
        slot_id: 'slot_closing',
        role: 'closing',
        decision: 'NARRATE',
        start_sec: slotStart,
        end_sec: slotEnd,
        estimated_duration_sec: slotEnd - slotStart
      }
    ]
  };
}

const fills = () => ({
  slot_fills: [
    { slot_id: 'slot_01', caption_kr_dialogue: ['한 줄'] },
    { slot_id: 'slot_closing', narration: '통제하려 할수록 더 크게 망가집니다.' }
  ]
});

const toSec = (tc) => {
  const [h, m, s] = String(tc).split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};

function clipEnds(script) {
  return script.segments.flatMap((seg) => (seg.source_scenes || []).map((clip) => toSec(clip.end)));
}

// A closing recap asked for b-roll running to 531.280s of a 529.561s source and the clip was
// emitted verbatim, failing source_duration_covers_timestamps.
test('b-roll never runs past the end of the footage', () => {
  const { script } = buildBootstrapSlotMapAndScript(planWithClosingNarration(520.0, 540.0), fills(), {
    sourceDurationSec: SOURCE_DURATION_SEC
  });
  for (const end of clipEnds(script)) {
    assert.ok(end <= SOURCE_DURATION_SEC + 0.5, `a clip ends at ${end}, past the ${SOURCE_DURATION_SEC}s source`);
  }
});

test('a slot entirely past the end of the source yields no b-roll rather than an invalid clip', () => {
  const { script } = buildBootstrapSlotMapAndScript(planWithClosingNarration(560.0, 580.0), fills(), {
    sourceDurationSec: SOURCE_DURATION_SEC
  });
  for (const end of clipEnds(script)) {
    assert.ok(end <= SOURCE_DURATION_SEC + 0.5, `a clip ends at ${end}`);
  }
});

test('a narration slot inside the source still gets its footage', () => {
  const { script } = buildBootstrapSlotMapAndScript(planWithClosingNarration(300.0, 320.0), fills(), {
    sourceDurationSec: SOURCE_DURATION_SEC
  });
  const closing = script.segments.find((seg) => String(seg.parent_slot_id || seg.segment_id).includes('slot_closing'));
  assert.ok(closing, 'the closing slot should still produce a segment');
  assert.ok((closing.source_scenes || []).length > 0, 'and it should still get b-roll');
});

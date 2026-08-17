const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _test } = require('../server/services/midformCompressionService');

// Hand corrections used to be silently thrown away: finalizeEditPlan re-derives every dialogue slot's
// lines from its beat, and compress-apply regenerates every fill, so an edit the owner made to fix a
// broken recap came back broken on the next run and the fix looked like it had done nothing.

const BEATS = [{
  beat_id: 'B005',
  start_sec: 228.55,
  end_sec: 280.19,
  dramatic_weight: 4,
  dialogue_quality: 'mid',
  summary: 'Sonny holds firm and Jeff caves',
  key_dialogue: ['>> Nah, Jeff, I am not going to do that.', 'Stay with me on planet Earth here.'],
  anchor_dialogue: ['three years of second-rounders.']
}];

const TRANSCRIPT = [
  { start_sec: 228.56, end_sec: 230.16, text: '>> Nah, Jeff, I am not going to do that.' },
  { start_sec: 230.16, end_sec: 234.2, text: 'Stay with me on planet Earth here.' },
  { start_sec: 257.88, end_sec: 267.67, text: 'This is a good deal for both of us.' },
  { start_sec: 273.44, end_sec: 280.19, text: '>> Good, Jeff. You did good. Call it in.' }
];

function planWithAuthoredSlot(authored) {
  const lines = ['This is a good deal for both of us.', '>> Good, Jeff. You did good. Call it in.'];
  return {
    editorial_pattern: 'cold_open_callback',
    duration_budget: { target_sec: 170 },
    timeline: [
      {
        slot_id: 'slot_01', beat_id: 'B005', role: 'cold_open', decision: 'KEEP_DIALOGUE',
        estimated_duration_sec: 4, dialogue_focus_lines: ['Stay with me on planet Earth here.'],
        dialogue_focus_quotes: ['Stay with me on planet Earth here.'],
        dialogue_line_windows: [{ matched: true, line: 'Stay with me on planet Earth here.', start_sec: 230.16, end_sec: 234.2 }]
      },
      { slot_id: 'slot_02', beat_id: 'B005', role: 'bridge', decision: 'NARRATE', estimated_duration_sec: 5 },
      {
        slot_id: 'slot_06', beat_id: 'B005', role: 'body', decision: 'KEEP_DIALOGUE',
        estimated_duration_sec: 18,
        authored_lines: authored,
        dialogue_focus_lines: lines.slice(),
        dialogue_focus_quotes: lines.slice(),
        dialogue_line_windows: [
          { matched: true, line: lines[0], start_sec: 257.88, end_sec: 267.67 },
          { matched: true, line: lines[1], start_sec: 273.44, end_sec: 280.19 }
        ]
      }
    ]
  };
}

const linesOf = (plan, slotId) => {
  const item = (plan.timeline || []).find((slot) => slot.slot_id === slotId);
  return Array.isArray(item?.dialogue_focus_lines) ? item.dialogue_focus_lines : [];
};

test('an authored_lines slot keeps the lines it was given', () => {
  const finalized = _test.finalizeEditPlan(planWithAuthoredSlot(true), BEATS, TRANSCRIPT, 170);
  assert.deepEqual(linesOf(finalized, 'slot_06'), [
    'This is a good deal for both of us.',
    '>> Good, Jeff. You did good. Call it in.'
  ]);
});

test('without the flag the same slot is re-derived from its beat', () => {
  const finalized = _test.finalizeEditPlan(planWithAuthoredSlot(false), BEATS, TRANSCRIPT, 170);
  const lines = linesOf(finalized, 'slot_06');
  assert.notDeepEqual(lines, [
    'This is a good deal for both of us.',
    '>> Good, Jeff. You did good. Call it in.'
  ]);
});

test('an authored slot fill survives regeneration; the rest is replaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authored-fills-'));
  const file = path.join(dir, 'compression_slot_fills.json');
  fs.writeFileSync(file, JSON.stringify({
    slot_fills: [
      { slot_id: 'slot_06', authored: true, caption_kr_dialogue: ['손대지 마'], speakers: ['소니'] },
      { slot_id: 'slot_07', caption_kr_dialogue: ['옛 자막'], speakers: ['톰'] }
    ]
  }));

  const kept = _test.keepAuthoredSlotFills({
    slot_fills: [
      { slot_id: 'slot_06', caption_kr_dialogue: ['새로 생성된 자막'], speakers: ['코치'] },
      { slot_id: 'slot_07', caption_kr_dialogue: ['새 자막'], speakers: ['톰'] }
    ]
  }, file);

  const bySlot = new Map(kept.slot_fills.map((fill) => [fill.slot_id, fill]));
  assert.deepEqual(bySlot.get('slot_06').caption_kr_dialogue, ['손대지 마']);
  assert.deepEqual(bySlot.get('slot_07').caption_kr_dialogue, ['새 자막']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no authored fills means the generated set passes through untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authored-fills-'));
  const file = path.join(dir, 'compression_slot_fills.json');
  fs.writeFileSync(file, JSON.stringify({ slot_fills: [{ slot_id: 'slot_06', caption_kr_dialogue: ['옛것'] }] }));
  const generated = { slot_fills: [{ slot_id: 'slot_06', caption_kr_dialogue: ['새것'] }] };
  assert.deepEqual(_test.keepAuthoredSlotFills(generated, file), generated);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The teaser limit is checked against the sum of the lines that get cut, and the per-slot durations
// are recomputed AFTER clampColdOpenToTeaser runs - so a re-derived cold open came back over the limit
// (17.31s against 16s on The Housemaid night), validateEditPlan rejected the plan, and the source
// silently kept its previous one. Enforce it last, by giving lines back.
test('a cold open over the teaser limit gives lines back instead of failing the plan', () => {
  const win = (start, end, line) => ({ matched: true, start_sec: start, end_sec: end, line });
  const plan = {
    editorial_pattern: 'none',
    duration_budget: { target_sec: 170 },
    timeline: [
      {
        slot_id: 'slot_01', beat_id: 'B001', role: 'cold_open', decision: 'KEEP_DIALOGUE',
        estimated_duration_sec: 18,
        dialogue_focus_lines: ['one', 'two', 'three', 'four', 'five'],
        dialogue_focus_quotes: ['one', 'two', 'three', 'four', 'five'],
        dialogue_line_windows: [
          win(100, 104, 'one'), win(104, 108, 'two'), win(108, 112, 'three'),
          win(112, 116, 'four'), win(116, 120, 'five')
        ]
      },
      { slot_id: 'slot_02', beat_id: 'B001', role: 'bridge', decision: 'NARRATE', estimated_duration_sec: 6 }
    ]
  };
  const beats = [{ beat_id: 'B001', start_sec: 99, end_sec: 121, dramatic_weight: 3, key_dialogue: [], anchor_dialogue: [] }];
  const finalized = _test.finalizeEditPlan(plan, beats, [], 170);
  const cold = finalized.timeline.find((item) => item.role === 'cold_open');
  assert.ok(cold.estimated_duration_sec <= 16, `teaser must fit, got ${cold.estimated_duration_sec}`);
  assert.ok((cold.dialogue_line_windows || []).filter((entry) => entry.matched === true).length >= 1, 'and keep a line');
  // A small target so the toy plan is not also judged short - the teaser limit is what is under test.
  assert.doesNotThrow(() => _test.validateEditPlan(finalized, 20));
});

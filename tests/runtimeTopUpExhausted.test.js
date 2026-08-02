const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');

const { topUpTimelineToTargetRuntime } = _test;

// Six beats, all already in the plan, produced a 76s cut against a 180s target: the top-up only
// promoted beats nobody had used, so with none left it added nothing and the cut stayed short.
function beat(id, startSec, lines) {
  return {
    beat_id: id,
    start_sec: startSec,
    end_sec: startSec + 40,
    hook_potential: 4,
    dramatic_weight: 4,
    dialogue_quality: 'high',
    key_dialogue: lines.map((l) => l.text),
    anchor_dialogue: [lines[0].text]
  };
}

function transcriptOf(beats, lineMap) {
  const cues = [];
  for (const b of beats) {
    for (const line of lineMap[b.beat_id] || []) {
      cues.push({ start_sec: line.start, end_sec: line.end, text: line.text });
    }
  }
  return cues;
}

const LINES = {
  beat_01: [
    { text: 'You make them yourself?', start: 38.9, end: 40.6 },
    { text: 'A friend makes them for me.', start: 41.5, end: 44.1 },
    { text: 'And what a fine physician he was.', start: 47.3, end: 50.5 }
  ],
  beat_02: [
    { text: 'You cannot feel that at all?', start: 138.9, end: 141.6 },
    { text: 'Feel what exactly?', start: 142.5, end: 144.1 },
    { text: 'The whole left side of your body.', start: 147.3, end: 150.5 }
  ]
};

const beats = [beat('beat_01', 38.9, LINES.beat_01), beat('beat_02', 138.9, LINES.beat_02)];
const transcript = transcriptOf(beats, LINES);

test('a beat the plan only narrated has its dialogue played when nothing else is left', () => {
  const timeline = [
    { slot_id: '1', beat_id: 'beat_01', role: 'cold_open', decision: 'KEEP_DIALOGUE', start_sec: 38.9, end_sec: 44.1, estimated_duration_sec: 5.2, dialogue_line_windows: [{ matched: true, start_sec: 38.9, end_sec: 40.6 }] },
    { slot_id: '2', beat_id: 'beat_02', role: 'bridge', decision: 'NARRATE', start_sec: 138.9, end_sec: 178.9, estimated_duration_sec: 12 }
  ];
  const before = timeline.filter((i) => i.decision === 'KEEP_DIALOGUE').length;
  const toppedUp = topUpTimelineToTargetRuntime(timeline, beats, transcript, 180);
  const after = toppedUp.filter((i) => i.decision === 'KEEP_DIALOGUE').length;

  assert.ok(after > before, 'the narrated beat should now also be played as dialogue');
  const added = toppedUp.find((i) => i.dialogue_focus_source === 'runtime_topup_narrated_beat');
  assert.ok(added, 'the added slot should be marked so the reason is traceable');
  assert.equal(added.beat_id, 'beat_02');
  assert.ok((added.dialogue_focus_lines || []).length >= 1);
});

test('a beat already played as dialogue is not played twice', () => {
  const timeline = [
    { slot_id: '1', beat_id: 'beat_01', role: 'cold_open', decision: 'KEEP_DIALOGUE', start_sec: 38.9, end_sec: 44.1, estimated_duration_sec: 5.2, dialogue_line_windows: [{ matched: true, start_sec: 38.9, end_sec: 40.6 }] },
    { slot_id: '2', beat_id: 'beat_01', role: 'bridge', decision: 'NARRATE', start_sec: 38.9, end_sec: 78.9, estimated_duration_sec: 12 }
  ];
  const toppedUp = topUpTimelineToTargetRuntime(timeline, [beats[0]], transcript, 180);
  const fromBeat01 = toppedUp.filter((i) => i.beat_id === 'beat_01' && i.decision === 'KEEP_DIALOGUE');
  assert.equal(fromBeat01.length, 1, 'beat_01 was already spoken; it should not be added again');
});

test('a plan already at its target is left alone', () => {
  const timeline = [
    { slot_id: '1', beat_id: 'beat_01', role: 'cold_open', decision: 'KEEP_DIALOGUE', start_sec: 38.9, end_sec: 44.1, estimated_duration_sec: 5.2, dialogue_line_windows: [{ matched: true, start_sec: 38.9, end_sec: 44.1 }] },
    { slot_id: '2', beat_id: 'beat_02', role: 'bridge', decision: 'NARRATE', start_sec: 138.9, end_sec: 178.9, estimated_duration_sec: 17 }
  ];
  const toppedUp = topUpTimelineToTargetRuntime(timeline, beats, transcript, 20);
  assert.equal(toppedUp.length, timeline.length, 'nothing should be added to a plan already at target');
});

const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');

test('finalizeEditPlan survives an empty transcript with an all-NARRATE plan (game branch)', () => {
  const beats = [
    {
      beat_id: 'B001',
      start_sec: 0,
      end_sec: 45,
      summary: 'The player scouts the ruined castle and finds the hidden entrance.',
      key_dialogue: [],
      anchor_dialogue: [],
      dramatic_weight: 3,
      dialogue_quality: 'none',
      hook_potential: 3
    },
    {
      beat_id: 'B002',
      start_sec: 45,
      end_sec: 110,
      summary: 'The boss fight: three failed attempts, then the parry window is found.',
      key_dialogue: [],
      anchor_dialogue: [],
      dramatic_weight: 5,
      dialogue_quality: 'none',
      hook_potential: 5
    }
  ];
  const editPlan = {
    scene_type: 'action_escalation',
    dialogue_driven_scene: false,
    confrontation_scene: false,
    cold_open_selection: { beat_id: 'B002' },
    timeline: [
      { slot_id: 'slot_01', beat_id: 'B002', role: 'cold_open', decision: 'NARRATE', start_sec: 45, end_sec: 110, estimated_duration_sec: 6, visual_source_mode: 'source_audio_teaser', visual_source_beat_id: 'B002', visual_source_start_sec: 80, visual_source_end_sec: 86 },
      { slot_id: 'slot_02', beat_id: 'B001', role: 'bridge', decision: 'NARRATE', start_sec: 0, end_sec: 45, estimated_duration_sec: 12 },
      { slot_id: 'slot_03', beat_id: 'B002', role: 'body_peak', decision: 'NARRATE', start_sec: 45, end_sec: 110, estimated_duration_sec: 14 }
    ],
    duration_budget: { target_sec: 60 }
  };

  const finalized = _test.finalizeEditPlan(editPlan, beats, [], 60, 110);

  assert.ok(Array.isArray(finalized.timeline) && finalized.timeline.length >= 3);
  assert.ok(finalized.timeline.every((slot) => slot.decision !== 'KEEP_DIALOGUE'), 'no dialogue slots can exist without cues');
  assert.ok(finalized.timeline.some((slot) => slot.decision === 'NARRATE'));
});

test('validateBeats accepts dialogue-free beats bounded by footage when the transcript is empty', () => {
  const beatsObject = {
    beats: [
      { beat_id: 'B001', start_sec: 0, end_sec: 45, summary: 'scouting', key_dialogue: [], anchor_dialogue: [] },
      { beat_id: 'B002', start_sec: 45, end_sec: 110, summary: 'boss fight', key_dialogue: [], anchor_dialogue: [] }
    ]
  };

  const validated = _test.validateBeats(beatsObject, [], 110);
  assert.equal(validated.beats.length, 2);

  assert.throws(
    () => _test.validateBeats(beatsObject, [], 0),
    /outside the footage range/,
    'no footage bound and no cues must still reject out-of-range beats'
  );
});

test('insertActionBeatSlots promotes uncovered peaks to original-audio slots within the target budget', () => {
  const timeline = [
    { slot_id: 'slot_01', role: 'cold_open', decision: 'KEEP_DIALOGUE', start_sec: 80, end_sec: 83, estimated_duration_sec: 3, dialogue_line_windows: [{ matched: true, start_sec: 80, end_sec: 83 }] },
    { slot_id: 'slot_02', role: 'bridge', decision: 'NARRATE', start_sec: 15, end_sec: 26, estimated_duration_sec: 6, narration_estimated_duration_sec: 6, visual_source_start_sec: 15 },
    { slot_id: 'slot_03', role: 'body', decision: 'NARRATE', start_sec: 93, end_sec: 165, estimated_duration_sec: 10, narration_estimated_duration_sec: 10, visual_source_start_sec: 122 }
  ];
  const peaks = [
    { rank: 1, start_sec: 124, end_sec: 128, score: 1.8 },   // covered by slot_03's played window
    { rank: 2, start_sec: 140, end_sec: 144, score: 1.7 },   // uncovered -> promoted
    { rank: 3, start_sec: 150, end_sec: 154, score: 1.0 }    // uncovered -> promoted while budget lasts
  ];
  const beats = [{ beat_id: 'B003', start_sec: 93, end_sec: 165 }];

  const result = _test.insertActionBeatSlots(timeline, peaks, 40, 300, beats);
  const actions = result.filter((slot) => slot.visual_source_mode === 'source_audio_action');

  assert.equal(actions.length, 2, 'rank 1 already screens; ranks 2-3 get promoted');
  assert.ok(actions.every((slot) => slot.narration_estimated_duration_sec === 0));
  assert.ok(actions.every((slot) => slot.role === 'action_beat'));
  // chronological placement: both action beats land after slot_03 (their source is later)
  const ids = result.map((slot) => slot.slot_id);
  assert.ok(ids.indexOf('slot_action_2') > ids.indexOf('slot_03'));
  // budget ceiling respected: total estimated stays at or under the target
  const total = result.reduce((sum, slot) => sum + Number(slot.estimated_duration_sec || 0), 0);
  assert.ok(total <= 40.01, `total ${total} must stay under the 40s target`);
});

test('insertActionBeatSlots never inserts before the cold open and skips covered peaks', () => {
  const timeline = [
    { slot_id: 'slot_01', role: 'cold_open', decision: 'KEEP_DIALOGUE', start_sec: 200, end_sec: 204, estimated_duration_sec: 4, dialogue_line_windows: [{ matched: true, start_sec: 200, end_sec: 204 }] },
    { slot_id: 'slot_02', role: 'bridge', decision: 'NARRATE', start_sec: 10, end_sec: 60, estimated_duration_sec: 8, narration_estimated_duration_sec: 8, visual_source_start_sec: 30 }
  ];
  const peaks = [{ rank: 1, start_sec: 20, end_sec: 24, score: 2.0 }];

  const result = _test.insertActionBeatSlots(timeline, peaks, 60, 300, []);
  assert.equal(result[0].slot_id, 'slot_01', 'cold open stays first');
  const action = result.find((slot) => slot.visual_source_mode === 'source_audio_action');
  assert.ok(action, 'peak at 20s is outside the played narration window (30-38) and gets promoted');
  assert.ok(result.indexOf(action) > 0);
});

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

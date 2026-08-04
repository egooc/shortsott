const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');

// A scene hook carries no captions by design (action peaks). When the heatmap peak IS dialogue
// the teaser played spoken lines uncaptioned — the patriotism punchline opened the Anger
// Management cut inaudible to a Korean audience.
const transcript = [
  { start_sec: 58.0, end_sec: 62.0, text: 'just calm down I am calm I just want my headset' },
  { start_sec: 66.0, end_sec: 69.2, text: "I don't know where a headset ties into patriotism" },
  { start_sec: 121.3, end_sec: 124.5, text: "not guilty it's a no-brainer" }
];
const beats = [
  {
    beat_id: 'beat_2', start_sec: 53.7, end_sec: 69.28, hook_potential: 5, dramatic_weight: 5, dialogue_quality: 'high',
    key_dialogue: ['just calm down', "I don't know where a headset ties into patriotism"],
    anchor_dialogue: ["I don't know where a headset ties into patriotism"]
  },
  { beat_id: 'beat_6', start_sec: 121.27, end_sec: 133.44, hook_potential: 4, dramatic_weight: 4, dialogue_quality: 'high', key_dialogue: ["not guilty it's a no-brainer"], anchor_dialogue: ["not guilty it's a no-brainer"] }
];

function planWithSceneHook(teaserStart, teaserEnd) {
  return {
    cold_open_selection: { beat_id: 'beat_2', source: 'heatmap_peak' },
    timeline: [
      {
        slot_id: '1', beat_id: 'beat_2', role: 'cold_open', decision: 'NARRATE',
        visual_source_mode: 'source_audio_teaser', visual_source_beat_id: 'beat_2',
        visual_source_start_sec: teaserStart, visual_source_end_sec: teaserEnd,
        start_sec: teaserStart, end_sec: teaserEnd, estimated_duration_sec: teaserEnd - teaserStart
      },
      { slot_id: '2', beat_id: 'beat_6', role: 'bridge', decision: 'NARRATE', start_sec: 121.27, end_sec: 133.44, estimated_duration_sec: 10 }
    ],
    duration_budget: { target_sec: 90 },
    quality_check: {}
  };
}

test('a teaser landing on speech opens as captioned dialogue', () => {
  const finalized = _test.finalizeEditPlan(planWithSceneHook(66.0, 69.2), beats, transcript, 90);
  const cold = finalized.timeline.find((item) => item.role === 'cold_open');
  assert.equal(cold.decision, 'KEEP_DIALOGUE', 'the spoken teaser must flip to a dialogue hook');
  assert.equal(cold.visual_source_mode, 'source_dialogue_hook');
  assert.ok((cold.dialogue_focus_lines || []).length >= 1, 'and carry caption lines');
  assert.ok((cold.dialogue_line_windows || []).some((w) => w.matched === true), 'with resolved windows');
});

test('a teaser on genuinely silent footage stays an uncaptioned scene hook', () => {
  const finalized = _test.finalizeEditPlan(planWithSceneHook(80.0, 84.0), beats, transcript, 90);
  const cold = finalized.timeline.find((item) => item.role === 'cold_open');
  assert.equal(cold.decision, 'NARRATE');
  assert.equal(cold.visual_source_mode, 'source_audio_teaser');
});

test('a teaser over a sound-effect caption does not flip', () => {
  const cues = [...transcript, { start_sec: 80.5, end_sec: 82.0, text: '>> [bell]' }];
  const finalized = _test.finalizeEditPlan(planWithSceneHook(80.0, 84.0), beats, cues, 90);
  const cold = finalized.timeline.find((item) => item.role === 'cold_open');
  assert.equal(cold.decision, 'NARRATE', 'a bell is not dialogue');
});

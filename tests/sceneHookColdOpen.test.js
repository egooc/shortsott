const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');

const { selectColdOpenBeat, buildFallbackEditPlan, clampSceneHookWindow, validateBeats } = _test;

function buildBeats() {
  return [
    {
      beat_id: '1',
      start_sec: 40,
      end_sec: 60,
      hook_potential: 5,
      dramatic_weight: 5,
      dialogue_quality: 'high',
      summary: 'Alice says she has evidence and the enemy refuses to change their decision.',
      key_dialogue: ['I have evidence.', "Even when you see, you still won't change your decision."],
      anchor_dialogue: ["Even when you see, you still won't change your decision."]
    },
    {
      beat_id: '4',
      start_sec: 470,
      end_sec: 490,
      hook_potential: 4,
      dramatic_weight: 5,
      dialogue_quality: 'low',
      summary: 'The two armies collide in an all-out battle with no dialogue.',
      key_dialogue: [],
      anchor_dialogue: []
    }
  ];
}

function buildTranscript() {
  // Cues must span the full beat range (40-490) or validateBeats rejects the beats as
  // being outside the transcript.
  return [
    { start_sec: 40, end_sec: 43, text: 'Hold the line.' },
    { start_sec: 44, end_sec: 47, text: 'I have evidence.' },
    { start_sec: 48, end_sec: 53, text: "Even when you see, you still won't change your decision." },
    { start_sec: 54, end_sec: 60, text: 'Then it is decided.' },
    { start_sec: 470, end_sec: 474, text: '[battle sounds]' },
    { start_sec: 480, end_sec: 490, text: '[continued fighting]' }
  ];
}

const HEATMAP = {
  status: 'available',
  items: [
    { start_sec: 44, end_sec: 50, score: 0.4 },
    { start_sec: 476, end_sec: 482, score: 0.9 }
  ]
};

test('heatmap peak beat outranks a stronger dialogue hook beat for the cold open', () => {
  const selection = selectColdOpenBeat(buildBeats(), HEATMAP);
  assert.equal(selection.source, 'heatmap_peak');
  assert.equal(String(selection.beat.beat_id), '4');
  assert.equal(selection.heatmap_peak_start_sec, 476);
  assert.equal(selection.heatmap_peak_end_sec, 482);
});

test('clampSceneHookWindow shrinks long peaks around the center and keeps short peaks', () => {
  const clamped = clampSceneHookWindow(470, 490);
  assert.ok(clamped.end_sec - clamped.start_sec <= 6.001);
  assert.ok(Math.abs((clamped.start_sec + clamped.end_sec) / 2 - 480) < 0.01);
  const short = clampSceneHookWindow(476, 480);
  assert.equal(short.start_sec, 476);
  assert.equal(short.end_sec, 480);
  assert.equal(clampSceneHookWindow(10, 10), null);
});

test('non-dialogue heatmap peak becomes a source_audio_teaser scene hook and survives finalize', () => {
  const plan = buildFallbackEditPlan(buildBeats(), HEATMAP, 120, {}, buildTranscript());
  const cold = plan.timeline.find((item) => item.role === 'cold_open');
  assert.ok(cold, 'cold_open slot exists');
  assert.equal(cold.decision, 'NARRATE');
  assert.equal(cold.visual_source_mode, 'source_audio_teaser');
  assert.ok(Number(cold.visual_source_end_sec) > Number(cold.visual_source_start_sec));
  assert.ok(Number(cold.visual_source_end_sec) - Number(cold.visual_source_start_sec) <= 6.501);
  assert.ok(Number(cold.visual_source_start_sec) >= 470, 'window stays inside the peak beat area');
  assert.equal(cold.dialogue_focus_lines.length, 0);
});

test('a pure action beat with no dialogue passes beat validation', () => {
  const beats = buildBeats();
  const validated = validateBeats({ beats, quality_check: {} }, buildTranscript());
  const actionBeat = validated.beats.find((beat) => String(beat.beat_id) === '4');
  assert.deepEqual(actionBeat.key_dialogue, []);
  assert.deepEqual(actionBeat.anchor_dialogue, []);
});

test('a beat that has dialogue always ends up anchored', () => {
  // Anchors are auto-selected from key_dialogue when the model omits them, so relaxing
  // the empty-anchor rule for action beats must not let a dialogue beat go unanchored.
  const beats = buildBeats().map((beat) => (String(beat.beat_id) === '1' ? { ...beat, anchor_dialogue: [] } : beat));
  const validated = validateBeats({ beats, quality_check: {} }, buildTranscript());
  const dialogueBeat = validated.beats.find((beat) => String(beat.beat_id) === '1');
  assert.ok(dialogueBeat.anchor_dialogue.length > 0);
  for (const anchor of dialogueBeat.anchor_dialogue) assert.ok(dialogueBeat.key_dialogue.includes(anchor));
});

test('dialogue-led heatmap peak still opens with the peak beat dialogue', () => {
  const heatmap = { status: 'available', items: [{ start_sec: 44, end_sec: 50, score: 0.9 }] };
  const selection = selectColdOpenBeat(buildBeats(), heatmap);
  assert.equal(selection.source, 'heatmap_peak');
  assert.equal(String(selection.beat.beat_id), '1');
  const plan = buildFallbackEditPlan(buildBeats(), heatmap, 120, {}, buildTranscript());
  const cold = plan.timeline.find((item) => item.role === 'cold_open');
  assert.equal(cold.decision, 'KEEP_DIALOGUE');
  assert.notEqual(cold.visual_source_mode, 'source_audio_teaser');
});

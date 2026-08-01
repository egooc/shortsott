const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');
const { finalizeEditPlan } = _test;

// Two beats that argue, so the confrontation signals fire either way. What should decide
// the scene type is how much of the SOURCE is actually speech.
function beats() {
  return [
    {
      beat_id: '1',
      start_sec: 40,
      end_sec: 60,
      hook_potential: 5,
      dramatic_weight: 5,
      dialogue_quality: 'high',
      summary: 'She says she has evidence but he refuses to change his decision.',
      key_dialogue: ['I have evidence.', "You still won't change your decision."],
      anchor_dialogue: ['I have evidence.']
    },
    {
      beat_id: '2',
      start_sec: 70,
      end_sec: 95,
      hook_potential: 4,
      dramatic_weight: 5,
      dialogue_quality: 'high',
      summary: 'He refuses and the argument breaks down into a fight.',
      key_dialogue: ['It does not matter what you show me.', 'Then it is decided.'],
      anchor_dialogue: ['Then it is decided.']
    }
  ];
}

function editPlan() {
  return {
    cold_open_selection: { beat_id: '1', source: 'heatmap_peak' },
    timeline: [
      { slot_id: '1', beat_id: '1', role: 'cold_open', decision: 'KEEP_DIALOGUE', start_sec: 44, end_sec: 47, estimated_duration_sec: 3, dialogue_focus_lines: ['I have evidence.'], dialogue_focus_quotes: ['I have evidence.'] },
      { slot_id: '2', beat_id: '1', role: 'bridge', decision: 'NARRATE', start_sec: 48, end_sec: 58, estimated_duration_sec: 10 },
      { slot_id: '3', beat_id: '2', role: 'body_peak', decision: 'KEEP_DIALOGUE', start_sec: 71, end_sec: 75, estimated_duration_sec: 4, dialogue_focus_lines: ['Then it is decided.'], dialogue_focus_quotes: ['Then it is decided.'] }
    ],
    duration_budget: { target_sec: 120, estimated_total_sec: 17 },
    quality_check: {}
  };
}

function talkyTranscript() {
  // Nearly continuous speech across the span.
  const cues = [];
  for (let start = 40; start < 95; start += 5) {
    cues.push({ start_sec: start, end_sec: start + 4.5, text: start === 44 ? 'I have evidence.' : 'They keep arguing.' });
  }
  cues.push({ start_sec: 44, end_sec: 47, text: 'I have evidence.' });
  cues.push({ start_sec: 71, end_sec: 75, text: 'Then it is decided.' });
  return cues.sort((left, right) => left.start_sec - right.start_sec);
}

function actionTranscript() {
  // Same argument beats, but the source is mostly silent action around them.
  return [
    { start_sec: 44, end_sec: 47, text: 'I have evidence.' },
    { start_sec: 48, end_sec: 51, text: "You still won't change your decision." },
    { start_sec: 71, end_sec: 75, text: 'Then it is decided.' },
    { start_sec: 560, end_sec: 563, text: 'Fall back!' }
  ];
}

test('a speech-dense source is still classified as a dialogue confrontation', () => {
  const plan = finalizeEditPlan(editPlan(), beats(), talkyTranscript(), 120);
  assert.equal(plan.scene_type, 'dialogue_confrontation');
  assert.ok(plan.source_speech_ratio >= 0.2, `expected a dense speech ratio, got ${plan.source_speech_ratio}`);
});

test('an action-dominant source is not classified as a dialogue confrontation', () => {
  // This is what made an action recap fail the dialogue-oriented clarity gate and escalate
  // into a path that then rejected the source for having too little dialogue.
  const plan = finalizeEditPlan(editPlan(), beats(), actionTranscript(), 120);
  assert.notEqual(plan.scene_type, 'dialogue_confrontation');
  assert.ok(plan.source_speech_ratio < 0.2, `expected a sparse speech ratio, got ${plan.source_speech_ratio}`);
});

test('finalizeEditPlan reports the source speech ratio it classified on', () => {
  // Also pins the transcript-threading that a scope slip once broke at runtime.
  const plan = finalizeEditPlan(editPlan(), beats(), actionTranscript(), 120);
  assert.equal(typeof plan.source_speech_ratio, 'number');
  const withoutTranscript = finalizeEditPlan(editPlan(), beats(), [], 120);
  assert.equal(withoutTranscript.source_speech_ratio, null);
});

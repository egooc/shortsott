const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');

const transcript = [
  { id: 'early_accuse', start_sec: 20.0, end_sec: 21.8, speaker: 'Steve', text: 'You tried to kill the ad.' },
  { id: 'early_rebut', start_sec: 22.1, end_sec: 25.4, speaker: 'Sculley', text: "I didn't kill the ad Steve, I saved it." },
  { id: 'late_rebut', start_sec: 187.1, end_sec: 190.0, speaker: 'Sculley', text: 'Because it was the only thing protecting it.' }
];

const beats = [
  {
    beat_id: 'B001',
    start_sec: 18,
    end_sec: 40,
    summary: 'Steve accuses Sculley of trying to kill the ad, and Sculley rebuts the accusation.',
    key_dialogue: ['You tried to kill the ad.', "I didn't kill the ad Steve, I saved it."],
    anchor_dialogue: ['You tried to kill the ad.', "I didn't kill the ad Steve, I saved it."],
    dramatic_weight: 4,
    dialogue_quality: 'high',
    hook_potential: 4
  },
  {
    beat_id: 'B003',
    start_sec: 180,
    end_sec: 205,
    summary: 'Sculley gives a sharp late-context rebuttal that depends on the earlier ad argument.',
    key_dialogue: ['Because it was the only thing protecting it.'],
    anchor_dialogue: ['Because it was the only thing protecting it.'],
    dramatic_weight: 5,
    dialogue_quality: 'high',
    hook_potential: 5
  }
];

test('bestColdOpenCallbackBeat defaults to deterministic argmax with runner-ups preserved', () => {
  const selected = _test.bestColdOpenCallbackBeat(beats, transcript, '');

  assert.ok(selected, 'expected a selected candidate');
  assert.equal(selected.selection_mode, 'deterministic_argmax');
  assert.ok(Array.isArray(selected.runner_ups));
  assert.ok(selected.runner_ups.length >= 1, 'expected at least one runner-up in the pool');
});

test('a stored rerank choice pins the matching runner-up as the winner', () => {
  const first = _test.bestColdOpenCallbackBeat(beats, transcript, '');
  const runnerUp = first.runner_ups[0];

  const pinned = _test.bestColdOpenCallbackBeat(beats, transcript, '', {
    beat_id: runnerUp.beat_id,
    start_sec: runnerUp.start_sec,
    end_sec: runnerUp.end_sec
  });

  assert.equal(pinned.selection_mode, 'listwise_rerank');
  assert.equal(String(pinned.beat.beat_id), String(runnerUp.beat_id));
  assert.ok(Math.abs(Number(pinned.focus.start_sec) - Number(runnerUp.start_sec)) <= 0.9);
  // the former winner must now sit among the runner-ups (nothing is lost, only reordered)
  assert.ok(pinned.runner_ups.some((item) => String(item.beat_id) === String(first.beat.beat_id)));
});

test('a rerank choice that matches no surviving candidate falls back to argmax', () => {
  const first = _test.bestColdOpenCallbackBeat(beats, transcript, '');
  const drifted = _test.bestColdOpenCallbackBeat(beats, transcript, '', {
    beat_id: 'B999',
    start_sec: 999,
    end_sec: 1002
  });

  assert.equal(drifted.selection_mode, 'deterministic_argmax');
  assert.equal(String(drifted.beat.beat_id), String(first.beat.beat_id));
});

test('the planner-preference bias is suspended while a rerank choice is present', () => {
  // Preferring B003 normally adds +120 to its candidates; with a rerank choice present the
  // rerank decides and the bias must not fight it.
  const first = _test.bestColdOpenCallbackBeat(beats, transcript, '');
  const runnerUp = first.runner_ups[0];
  const pinned = _test.bestColdOpenCallbackBeat(beats, transcript, 'B003', {
    beat_id: runnerUp.beat_id,
    start_sec: runnerUp.start_sec,
    end_sec: runnerUp.end_sec
  });

  assert.equal(pinned.selection_mode, 'listwise_rerank');
  assert.equal(String(pinned.beat.beat_id), String(runnerUp.beat_id));
});

test('rerankColdOpenSelection is a no-op for plans without a candidate pool (flip path)', async () => {
  const plan = {
    cold_open_selection: {},
    timeline: [{ role: 'cold_open', decision: 'NARRATE', visual_source_mode: 'source_audio_teaser' }]
  };

  const result = await _test.rerankColdOpenSelection(plan, {}, beats, transcript, 90, 0);
  assert.equal(result, plan);
  assert.equal(result.cold_open_selection.rerank, undefined);
});

test('rerankColdOpenSelection honours the kill switch without touching the plan', async () => {
  process.env.MIDFORM_DISABLE_RERANK = '1';
  try {
    const plan = {
      cold_open_selection: { runner_ups: [{ beat_id: 'B001', start_sec: 20, end_sec: 25, lines: ['x'] }] },
      timeline: [{ role: 'cold_open', decision: 'KEEP_DIALOGUE', beat_id: 'B003', start_sec: 187, end_sec: 190, dialogue_focus_lines: ['y'] }]
    };
    const result = await _test.rerankColdOpenSelection(plan, {}, beats, transcript, 90, 0);
    assert.equal(result, plan);
    assert.equal(result.cold_open_selection.rerank, undefined);
  } finally {
    delete process.env.MIDFORM_DISABLE_RERANK;
  }
});

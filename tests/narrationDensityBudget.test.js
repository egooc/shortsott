'use strict';

// The density budget the acceptance gate measures, asserted before TTS is paid for.
// auto_template_6cd761ad8d planned at 6.9 sentences/min and shipped at 14.4: validateEditPlan
// ran on the planner's duration guesses, recalculateNarrationDurations then rewrote every
// NARRATE duration from the real narration text, and nothing re-checked the budget.

const assert = require('node:assert');
const test = require('node:test');
const { predictNarrationBudget, measuredNarrationSeconds, splitNarrationSentences } =
  require('../scripts/predict-narration-budget');

const narrate = (id, sec) => ({ slot_id: id, decision: 'NARRATE', role: 'body', estimated_duration_sec: sec });
const dialogue = (id, sec) => ({ slot_id: id, decision: 'KEEP_DIALOGUE', role: 'body', estimated_duration_sec: sec });
const fill = (id, narration) => ({ slot_id: id, narration });

test('a slot is counted once per sentence, not once per slot', () => {
  const plan = { timeline: [narrate('s1', 6)] };
  const fills = { slot_fills: [fill('s1', '그는 문을 연다. 안에는 아무도 없다.')] };
  assert.strictEqual(predictNarrationBudget(plan, fills).narration_sentences, 2);
});

test('an empty slot contributes its screen seconds but no sentence', () => {
  const plan = { timeline: [narrate('s1', 5), narrate('s2', 7)] };
  const fills = { slot_fills: [fill('s1', '그는 문을 연다.'), fill('s2', '')] };
  const budget = predictNarrationBudget(plan, fills);
  assert.strictEqual(budget.narration_sentences, 1);
  assert.ok(budget.projected_sec >= 7, 'the silent slot still occupies the cut');
});

test('DROP slots are outside the cut entirely', () => {
  const plan = { timeline: [narrate('s1', 5), { ...narrate('s2', 40), decision: 'DROP' }] };
  const fills = { slot_fills: [fill('s1', '그는 문을 연다.'), fill('s2', '이 문장은 잘렸다.')] };
  const budget = predictNarrationBudget(plan, fills);
  assert.strictEqual(budget.narration_sentences, 1);
  assert.ok(budget.projected_sec < 10);
});

test('kept dialogue dilutes density instead of adding to it', () => {
  const sentence = '그는 문을 열고 안으로 들어갔다.';
  const talky = predictNarrationBudget(
    { timeline: [narrate('s1', 4), narrate('s2', 4)] },
    { slot_fills: [fill('s1', sentence), fill('s2', sentence)] }
  );
  const balanced = predictNarrationBudget(
    { timeline: [narrate('s1', 4), dialogue('s2', 20), narrate('s3', 4)] },
    { slot_fills: [fill('s1', sentence), fill('s3', sentence)] }
  );
  assert.ok(balanced.sentences_per_min < talky.sentences_per_min);
  assert.ok(balanced.narration_share < talky.narration_share);
});

test('the calibrated estimator is the measured one, not the slot-sizing one', () => {
  // 4.8 chars/sec + 0.3s runs 27% long over 807 shipped sentences; sizing wants that margin,
  // a per-minute denominator must not have it.
  const chars = 58;
  const text = 'ㄱ'.repeat(chars);
  assert.ok(Math.abs(measuredNarrationSeconds(text) - chars / 5.8) < 0.01);
  assert.ok(measuredNarrationSeconds(text) < chars / 4.8 + 0.3);
});

test('a sentence with no terminator still counts as one', () => {
  assert.strictEqual(splitNarrationSentences('종결부호가 없다').length, 1);
  assert.strictEqual(predictNarrationBudget(
    { timeline: [narrate('s1', 4)] }, { slot_fills: [fill('s1', '종결부호가 없다')] }
  ).narration_sentences, 1);
});

test('the density a real leaked run shipped is visible before TTS', () => {
  // 17 sentences over a ~71s cut - the shape of auto_template_6cd761ad8d.
  const timeline = [];
  const fills = [];
  for (let i = 0; i < 17; i += 1) {
    timeline.push(narrate(`s${i}`, 4));
    fills.push(fill(`s${i}`, '그는 문을 열고 조용히 안으로 들어섰다.'));
  }
  const budget = predictNarrationBudget({ timeline }, { slot_fills: fills });
  assert.ok(budget.sentences_per_min > 10,
    `expected the gate ceiling to be exceeded, got ${budget.sentences_per_min}/min`);
});

test('a narrated action beat counts as narration, not as source audio', () => {
  // Classifying by visual_source_mode hid 6 of 16 narrated slots on auto_template_6cd761ad8d and
  // put its predicted density at 8.7/min for a cut the gate then measured at 13.9. What the gate
  // counts is whether the row speaks (caption_kind narration + tts_enabled), not its visual mode.
  const action = { slot_id: 's1', decision: 'NARRATE', role: 'body',
    visual_source_mode: 'source_audio_action', estimated_duration_sec: 4 };
  const spoken = predictNarrationBudget({ timeline: [action] },
    { slot_fills: [fill('s1', '선장은 선실에서 어깨를 붙잡습니다.')] });
  assert.strictEqual(spoken.narration_sentences, 1);
  assert.ok(spoken.narration_share > 0, 'a narrated action beat is narrated time');

  const silent = predictNarrationBudget({ timeline: [action] }, { slot_fills: [fill('s1', '')] });
  assert.strictEqual(silent.narration_sentences, 0);
  assert.strictEqual(silent.narration_share, 0);
});

test('a slot that plays its own window is as long as the window, not as its sentence', () => {
  // The teaser plays a fixed peak; a short sentence over it must not shrink the cut.
  const teaser = { slot_id: 's1', decision: 'NARRATE', role: 'cold_open',
    visual_source_mode: 'source_audio_teaser', estimated_duration_sec: 9 };
  const budget = predictNarrationBudget({ timeline: [teaser] }, { slot_fills: [fill('s1', '짧다.')] });
  assert.strictEqual(budget.projected_sec, 9);
});

test('the economy ceiling is the one its message states', () => {
  // 3.0 was the 2026-08-23 dialogue-led value. On 09-08 the message was rewritten to say 7.5 and
  // the comparison was left behind, so everything between the two tripped a rule it satisfied:
  // 47 of 135 recorded fills sets, 35%. Worse, the acceptance gate's own FLOOR is 3.5/min - a cut
  // dense enough to satisfy the gate could not pass this. The degrade is only a warning, but it
  // re-runs a structural-only pass that skips validateSlotFillsRuntime, so those runs reached TTS
  // with no budget check at all.
  const { narrationEconomyProblems } = require('../server/services/midformCompressionService');
  if (!narrationEconomyProblems) return;
  const plan = { duration_budget: { estimated_total_sec: 105 }, timeline: [] };
  const fills = (count) => ({ slot_fills: Array.from({ length: count },
    (_, index) => ({ slot_id: `S${index}`, narration: '문장 하나입니다.' })) });
  const density = (count) => (narrationEconomyProblems(fills(count), plan, 'ko') || [])
    .filter((problem) => /density/.test(problem));

  assert.strictEqual(density(6).length, 0, '3.4/min is above the GATE FLOOR and must not trip');
  assert.strictEqual(density(8).length, 0, '4.6/min - the density this run actually shipped');
  assert.strictEqual(density(14).length, 1, '8.0/min is genuinely wall-to-wall');
  assert.match(density(14)[0], /exceeds 7\.5/, 'the message must quote the threshold it used');
});

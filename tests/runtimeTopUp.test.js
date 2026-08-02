const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');
const { finalizeEditPlan } = _test;

function beat(id, start, end, hook, quality) {
  return {
    beat_id: id,
    start_sec: start,
    end_sec: end,
    hook_potential: hook,
    dramatic_weight: hook,
    dialogue_quality: quality,
    summary: `beat ${id}`,
    key_dialogue: quality === 'high' ? ['Say something.', 'Say something else.'] : [],
    anchor_dialogue: quality === 'high' ? ['Say something.'] : []
  };
}

function beats() {
  return [
    beat('1', 10, 60, 5, 'high'),
    beat('2', 70, 130, 4, 'low'),
    beat('3', 140, 220, 4, 'low'),
    beat('4', 230, 320, 3, 'low'),
    beat('5', 330, 430, 4, 'low'),
    beat('6', 440, 540, 5, 'low'),
    beat('7', 550, 600, 3, 'low')
  ];
}

function transcript() {
  const cues = [];
  for (let start = 10; start < 600; start += 20) {
    cues.push({ start_sec: start, end_sec: start + 3, text: 'Some line.' });
  }
  return cues;
}

// A short plan: the planner used two beats and left five on the floor.
function shortPlan() {
  return {
    cold_open_selection: { beat_id: '1', source: 'heatmap_peak' },
    timeline: [
      { slot_id: '1', beat_id: '1', role: 'cold_open', decision: 'NARRATE', start_sec: 10, end_sec: 16, estimated_duration_sec: 6 },
      { slot_id: '2', beat_id: '2', role: 'bridge', decision: 'NARRATE', start_sec: 70, end_sec: 130, estimated_duration_sec: 12 },
      { slot_id: '3', beat_id: '3', role: 'payoff', decision: 'NARRATE', start_sec: 140, end_sec: 220, estimated_duration_sec: 12 }
    ],
    duration_budget: { target_sec: 120, estimated_total_sec: 30 },
    quality_check: {}
  };
}

test('a plan that runs short is topped up from the beats it left unused', () => {
  const before = shortPlan();
  const plannedSec = before.timeline.reduce((sum, item) => sum + item.estimated_duration_sec, 0);
  const plan = finalizeEditPlan(before, beats(), transcript(), 120);
  const promoted = plan.timeline.filter((item) => item.runtime_topup);

  assert.ok(promoted.length > 0, 'expected unused beats to be promoted');
  assert.ok(plan.duration_budget.estimated_total_sec > plannedSec * 2,
    `expected the cut to grow well past its ${plannedSec}s plan, got ${plan.duration_budget.estimated_total_sec}s`);
});

test('top-up stops when the source runs out of beats rather than inventing slots', () => {
  // Seven beats cannot always add up to the target; promoting every one of them is the
  // most the planner can honestly do.
  const plan = finalizeEditPlan(shortPlan(), beats(), transcript(), 600);
  const usedBeatIds = new Set(plan.timeline.filter((item) => item.decision !== 'DROP').map((item) => item.beat_id));
  assert.equal(usedBeatIds.size, beats().length, 'every available beat should be in play');
  assert.ok(plan.duration_budget.estimated_total_sec < 600, 'runtime is bounded by the source');
});

test('promoted slots reuse unused beats and keep story order', () => {
  const plan = finalizeEditPlan(shortPlan(), beats(), transcript(), 120);
  const promoted = plan.timeline.filter((item) => item.runtime_topup);
  const originalBeatIds = new Set(['1', '2', '3']);
  for (const slot of promoted) {
    assert.ok(!originalBeatIds.has(slot.beat_id), `beat ${slot.beat_id} was already used`);
    assert.equal(slot.decision, 'NARRATE');
  }

  const slotIds = plan.timeline.map((item) => item.slot_id);
  assert.equal(new Set(slotIds).size, slotIds.length, 'slot ids must stay unique');

  // The opening stays first; everything after it runs in source order.
  assert.equal(plan.timeline[0].role, 'cold_open');
  const rest = plan.timeline.slice(1).map((item) => Number(item.start_sec));
  assert.deepEqual(rest, [...rest].sort((left, right) => left - right));
});

test('a plan that already reaches its target is left alone', () => {
  const plan = shortPlan();
  plan.timeline = [
    { slot_id: '1', beat_id: '1', role: 'cold_open', decision: 'NARRATE', start_sec: 10, end_sec: 16, estimated_duration_sec: 6 },
    { slot_id: '2', beat_id: '2', role: 'bridge', decision: 'NARRATE', start_sec: 70, end_sec: 130, estimated_duration_sec: 18 },
    { slot_id: '3', beat_id: '3', role: 'body', decision: 'NARRATE', start_sec: 140, end_sec: 220, estimated_duration_sec: 18 },
    { slot_id: '4', beat_id: '4', role: 'body', decision: 'NARRATE', start_sec: 230, end_sec: 320, estimated_duration_sec: 18 },
    { slot_id: '5', beat_id: '5', role: 'body', decision: 'NARRATE', start_sec: 330, end_sec: 430, estimated_duration_sec: 18 },
    { slot_id: '6', beat_id: '6', role: 'body_peak', decision: 'NARRATE', start_sec: 440, end_sec: 540, estimated_duration_sec: 18 },
    { slot_id: '7', beat_id: '7', role: 'payoff', decision: 'NARRATE', start_sec: 550, end_sec: 600, estimated_duration_sec: 18 }
  ];
  const finalized = finalizeEditPlan(plan, beats(), transcript(), 120);
  assert.equal(finalized.timeline.filter((item) => item.runtime_topup).length, 0);
});

test('an inflated dialogue duration cannot fake reaching the target', () => {
  // A preserved dialogue slot lasts exactly as long as its source lines, so claiming 90s
  // for a 6s window must not count as runtime.
  const plan = shortPlan();
  plan.timeline = [
    { slot_id: '1', beat_id: '1', role: 'cold_open', decision: 'NARRATE', start_sec: 10, end_sec: 16, estimated_duration_sec: 6 },
    {
      slot_id: '2',
      beat_id: '1',
      role: 'body_peak',
      decision: 'KEEP_DIALOGUE',
      start_sec: 20,
      end_sec: 26,
      estimated_duration_sec: 90,
      dialogue_focus_lines: ['Say something.'],
      dialogue_focus_quotes: ['Say something.']
    }
  ];
  const finalized = finalizeEditPlan(plan, beats(), transcript(), 120);
  assert.ok(finalized.timeline.filter((item) => item.runtime_topup).length > 0,
    'the inflated dialogue slot should not have satisfied the target');
});

test('a long stretch of narration gets a line from the scene in the middle', () => {
  // Asking the planner to alternate did not hold: dialogue landed in the first half and
  // the back half came back as one long explanation.
  const plan = {
    cold_open_selection: { beat_id: '1', source: 'heatmap_peak' },
    timeline: [
      { slot_id: '1', beat_id: '1', role: 'cold_open', decision: 'NARRATE', start_sec: 10, end_sec: 16, estimated_duration_sec: 6 },
      { slot_id: '2', beat_id: '2', role: 'body', decision: 'NARRATE', start_sec: 70, end_sec: 130, estimated_duration_sec: 18 },
      { slot_id: '3', beat_id: '3', role: 'body', decision: 'NARRATE', start_sec: 140, end_sec: 220, estimated_duration_sec: 18 },
      { slot_id: '4', beat_id: '4', role: 'payoff', decision: 'NARRATE', start_sec: 230, end_sec: 320, estimated_duration_sec: 18 }
    ],
    duration_budget: { target_sec: 120, estimated_total_sec: 60 },
    quality_check: {}
  };
  const dialogueBeats = beats().map((item) => ({
    ...item,
    dialogue_quality: 'high',
    key_dialogue: ['I have evidence.', 'Then it is decided.'],
    anchor_dialogue: ['I have evidence.']
  }));
  const cues = [];
  for (let start = 10; start < 600; start += 20) {
    cues.push({ start_sec: start, end_sec: start + 4, text: 'I have evidence.' });
  }

  const finalized = finalizeEditPlan(plan, dialogueBeats, cues, 120);
  const active = finalized.timeline.filter((item) => item.decision !== 'DROP');
  let run = 0;
  let longestRun = 0;
  for (const item of active) {
    if (item.decision === 'KEEP_DIALOGUE') { run = 0; continue; }
    run += Number(item.estimated_duration_sec || 0);
    longestRun = Math.max(longestRun, run);
  }
  assert.ok(active.some((item) => item.decision === 'KEEP_DIALOGUE'), 'the cut needs dialogue in it');
  assert.ok(longestRun <= 45, `narration should not carry the whole back half, longest run ${longestRun}s`);
});

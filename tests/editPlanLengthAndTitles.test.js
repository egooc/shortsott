const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');

const { validateEditPlan, validateSlotFillsRuntime, isCuriosityTitle } = _test;

function planOfDuration(totalSec, claimedTotalSec = totalSec) {
  const slotSec = (totalSec - 6) / 3;
  return {
    timeline: [
      { slot_id: '1', role: 'cold_open', decision: 'NARRATE', estimated_duration_sec: 6 },
      { slot_id: '2', role: 'bridge', decision: 'NARRATE', estimated_duration_sec: slotSec },
      { slot_id: '3', role: 'body', decision: 'NARRATE', estimated_duration_sec: slotSec },
      { slot_id: '4', role: 'payoff', decision: 'NARRATE', estimated_duration_sec: slotSec }
    ],
    duration_budget: { target_sec: 0, estimated_total_sec: claimedTotalSec }
  };
}

test('an edit plan that runs far under target is rejected', () => {
  // The real failure this guards: a 120s request came back as a 62s plan and shipped.
  assert.throws(() => validateEditPlan(planOfDuration(62), 120), /far too short/);
});

test('a short plan cannot pass by overstating duration_budget', () => {
  // The plan that slipped through in practice: slots summing to 84s while the budget
  // field claimed a healthy total.
  assert.throws(() => validateEditPlan(planOfDuration(84, 118), 120), /far too short/);
});

test('DROP slots do not count toward the runtime floor', () => {
  const plan = planOfDuration(110);
  plan.timeline.push({ slot_id: '5', role: 'body', decision: 'DROP', estimated_duration_sec: 40 });
  assert.ok(validateEditPlan(plan, 120));
  const shortPlan = planOfDuration(62);
  shortPlan.timeline.push({ slot_id: '5', role: 'body', decision: 'DROP', estimated_duration_sec: 60 });
  assert.throws(() => validateEditPlan(shortPlan, 120), /far too short/);
});

test('an edit plan close to target passes', () => {
  assert.ok(validateEditPlan(planOfDuration(110), 120));
  assert.ok(validateEditPlan(planOfDuration(130), 120));
});

test('length is only enforced when a target is supplied', () => {
  assert.ok(validateEditPlan(planOfDuration(62)));
  assert.ok(validateEditPlan(planOfDuration(62), 0));
});

test('a script whose narration speaks for far less than the target is rejected', () => {
  // The edit plan can claim 120s of slots while the written narration only speaks for 70s;
  // this is the check that catches the real runtime.
  const editPlan = {
    timeline: [
      { slot_id: '1', role: 'cold_open', decision: 'NARRATE', estimated_duration_sec: 6, visual_source_mode: 'source_audio_teaser' },
      { slot_id: '2', role: 'bridge', decision: 'NARRATE', estimated_duration_sec: 40 },
      { slot_id: '3', role: 'body', decision: 'KEEP_DIALOGUE', estimated_duration_sec: 8 },
      { slot_id: '4', role: 'payoff', decision: 'NARRATE', estimated_duration_sec: 40 }
    ]
  };
  const thinScript = {
    slot_fills: [
      { slot_id: '1', narration: '' },
      { slot_id: '2', narration: '두 진영이 대치합니다.' },
      { slot_id: '4', narration: '전쟁이 시작됐습니다.' }
    ]
  };
  assert.throws(() => validateSlotFillsRuntime(thinScript, editPlan, 120), /far too short/);

  const fullScript = {
    slot_fills: [
      { slot_id: '1', narration: '' },
      { slot_id: '2', narration: '가'.repeat(320) },
      { slot_id: '4', narration: '나'.repeat(320) }
    ]
  };
  assert.ok(validateSlotFillsRuntime(fullScript, editPlan, 120));
});

test('script runtime is only enforced when a target is supplied', () => {
  const editPlan = { timeline: [{ slot_id: '2', role: 'bridge', decision: 'NARRATE', estimated_duration_sec: 40 }] };
  const thin = { slot_fills: [{ slot_id: '2', narration: '짧습니다.' }] };
  assert.ok(validateSlotFillsRuntime(thin, editPlan, 0));
});

test('curiosity titles accept question forms and answer-promising nouns', () => {
  assert.ok(isCuriosityTitle('쫓던 보안관은 어쩌다 미끼가 됐을까?'));
  assert.ok(isCuriosityTitle('왜 그는 증거를 보고도 물러서지 않았을까'));
  // Noun-ending hooks are just as valid — this exact line used to be rejected.
  assert.ok(isCuriosityTitle('그녀가 보여준 미래가 오히려 전쟁을 불렀던 이유'));
  assert.ok(isCuriosityTitle('설원을 뒤덮은 전쟁의 결말'));
  assert.ok(isCuriosityTitle('아이를 둘러싼 오해의 정체'));
});

test('flat declarative summaries are still rejected as titles', () => {
  assert.ok(!isCuriosityTitle('두 진영이 전투를 벌였습니다'));
  assert.ok(!isCuriosityTitle('브레이킹 던 파트2 최종 전투 장면'));
  assert.ok(!isCuriosityTitle(''));
});

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

// Runtime is split between two stages: finalizeEditPlan tops a short plan up from unused
// beats, and this check only rejects a plan too short to top up. Rejecting merely-short
// plans here burned the retries and dropped the run onto the fallback planner instead.
test('a pathologically short edit plan is rejected', () => {
  assert.throws(() => validateEditPlan(planOfDuration(30), 120), /far too short/);
});

test('a merely short plan is left for the top-up rather than rejected', () => {
  assert.ok(validateEditPlan(planOfDuration(62), 120));
});

test('a short plan cannot pass by overstating duration_budget', () => {
  // The slots are summed; the budget field is not trusted.
  assert.throws(() => validateEditPlan(planOfDuration(30, 118), 120), /far too short/);
});

test('DROP slots do not count toward the runtime floor', () => {
  const plan = planOfDuration(110);
  plan.timeline.push({ slot_id: '5', role: 'body', decision: 'DROP', estimated_duration_sec: 40 });
  assert.ok(validateEditPlan(plan, 120));
  const shortPlan = planOfDuration(30);
  shortPlan.timeline.push({ slot_id: '5', role: 'body', decision: 'DROP', estimated_duration_sec: 90 });
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
  // The noun that promises the answer is an open set, and enumerating it kept rejecting
  // good hooks. Each of these was turned away by an earlier allow-list.
  assert.ok(isCuriosityTitle('그녀가 보여준 미래가 오히려 전쟁을 불렀던 이유'));
  assert.ok(isCuriosityTitle('뱀파이어들이 목숨을 건 최후의 전쟁을 시작한 진짜 계기'));
  assert.ok(isCuriosityTitle('설원을 뒤덮은 전쟁의 결말'));
  assert.ok(isCuriosityTitle('아이를 둘러싼 오해의 정체'));
  assert.ok(isCuriosityTitle('협상장을 뒤집은 한 마디'));
});

test('titles that close the gap are rejected', () => {
  // A finished statement answers itself...
  assert.ok(!isCuriosityTitle('두 진영이 전투를 벌였습니다'));
  assert.ok(!isCuriosityTitle('결국 전쟁이 시작됐다'));
  // ...and a label just describes the clip.
  assert.ok(!isCuriosityTitle('브레이킹 던 파트2 최종 전투 장면'));
  assert.ok(!isCuriosityTitle('최종 결전 하이라이트'));
  assert.ok(!isCuriosityTitle(''));
});

test('a plan that overshoots the target is rejected', () => {
  // A speech-dense source pushed the planner the other way: a 120s request came back as a
  // 303s plan built from whole conversations.
  assert.throws(() => validateEditPlan(planOfDuration(303), 120), /runs far too long/);
  assert.ok(validateEditPlan(planOfDuration(140), 120), 'a little over target is fine');
});

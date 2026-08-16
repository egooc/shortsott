const assert = require('node:assert/strict');
const test = require('node:test');

const { narrationReadsAsScreenDescription, fallbackNarrationSlots } = require('../server/services/midformRunArtifactsService');

// Housemaid shipped three narration lines that only said what was on screen. They came from pasting
// the vision judge's suggested_rewrite - which is evidence about the frame, not a sentence for the
// viewer - into the fills. The result reads as a caption track: the viewer is told what they are
// already looking at and has to infer the story themselves.
test('a line that only describes the frame is caught', () => {
  for (const line of [
    '두 여자가 넓은 부엌에서 이야기를 나눕니다.',
    '두 여자가 야외에 서 있습니다.',
    '피투성이 얼굴의 남성과 여성이 고통스러워하며 움직입니다.',
    '한 남자가 소파에 앉아 있습니다.',
  ]) {
    assert.equal(narrationReadsAsScreenDescription(line), true, line);
  }
});

test('narration that carries the story is left alone', () => {
  for (const line of [
    '해고 압박에 시달리던 단장 소니. 그는 모든 걸 걸기로 합니다.',
    '상대방은 그의 절박함을 간파하고, 말도 안 되는 조건을 내겁니다.',
    '두 사람은 돌이킬 수 없는 선을 넘었습니다.',
    '그 밤이 지나고, 남자는 피투성이가 된 채 발견됩니다.',
    '하지만 그 집의 안주인 역시, 누군가의 도움이 필요해 보였죠.',
  ]) {
    assert.equal(narrationReadsAsScreenDescription(line), false, line);
  }
});

test('a story sentence that happens to describe the frame still passes', () => {
  // "두 여자가 서 있다" is description; "그날 이후 두 여자는 같은 집에 서 있게 됩니다" is a turn that
  // uses the same picture. The story marker is what separates them.
  assert.equal(narrationReadsAsScreenDescription('그날 이후, 두 여자가 한 집에 서 있게 됩니다.'), false);
});

test('slots the planner filled from fallback metadata are reported', () => {
  const plan = {
    timeline: [
      { slot_id: 'slot_04', decision: 'NARRATE', reason: 'Fallback local planner selected this body beat from beat metadata and transcript focus.' },
      { slot_id: 'slot_05', decision: 'NARRATE', reason: 'Body peak continues the hook beat.' },
      { slot_id: 'slot_06', decision: 'KEEP_DIALOGUE', reason: 'Fallback local planner selected this beat.' },
    ],
  };
  assert.deepEqual(fallbackNarrationSlots(plan), ['slot_04']);
});

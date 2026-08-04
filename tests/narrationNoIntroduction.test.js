const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');
const { findNarrationNameplate } = _test;

const NAMES = ['대릴', '제니스', '로레인'];

// The real line that kept coming back: a role noun pinned to a name tells the viewer who someone
// is instead of letting them read it off the scene. The prompt rule against it held on one
// generation and not the next.
test('a nameplate is caught', () => {
  assert.ok(findNarrationNameplate('가난한 대학생 대릴은 돈을 벌기 위해 실험에 지원합니다.', NAMES));
  assert.ok(findNarrationNameplate('그의 여자친구 제니스가 들어옵니다.', NAMES));
  assert.ok(findNarrationNameplate('대릴은 감각이 사라져가는 대학생입니다.', NAMES));
});

test('narration that only locates the scene passes', () => {
  assert.equal(findNarrationNameplate('하룻밤이 지나고, 상황은 더 꼬입니다.', NAMES), '');
  assert.equal(findNarrationNameplate('며칠 뒤 병원에서 다시 마주칩니다.', NAMES), '');
  assert.equal(findNarrationNameplate('', NAMES), '');
});

test('a name may still appear without being introduced', () => {
  assert.equal(findNarrationNameplate('대릴은 그대로 쓰러집니다.', NAMES), '');
  assert.equal(findNarrationNameplate('제니스가 문을 닫고 나갑니다.', NAMES), '');
});

test('a role noun with nobody named is not a nameplate', () => {
  assert.equal(findNarrationNameplate('친구들이 잘못 짚기 시작합니다.', NAMES), '');
});

test('no names to check means nothing to flag', () => {
  assert.equal(findNarrationNameplate('가난한 대학생 대릴은 실험에 지원합니다.', []), '');
});

// When the captions never name someone the speaker alias IS a generic noun (여자, 남자), and any
// narration using that word as an ordinary noun read as a nameplate. This rejected the line
// "한 남자가 여자 집에 몰래 들어왔다가 딱 걸렸습니다" for introducing 여자.
test('a speaker whose name is itself a common noun cannot be introduced', () => {
  const generic = ['여자', '남자', '친구'];
  assert.equal(findNarrationNameplate('한 남자가 여자 집에 몰래 들어왔다가 딱 걸렸습니다.', generic), '');
  assert.equal(findNarrationNameplate('여자 친구가 들어옵니다.', generic), '');
});

test('a real name is still caught alongside generic ones', () => {
  assert.ok(findNarrationNameplate('가난한 대학생 대릴은 실험에 지원합니다.', ['여자', '대릴']));
});

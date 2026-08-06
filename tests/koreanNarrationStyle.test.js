const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');
const v = _test.validateKoreanNarrationStyle;

// The house guidebook's fatal failures, enforced in code (midform/docs/style-guide-ko.md).
test('viewer questions are banned outside the closing 여러분-quip', () => {
  assert.ok(v('과연 그는 수습할 수 있을까요?', [], false).length > 0);
  assert.ok(v('과연 어떻게 될까요? 끝났습니다.', [], true).length > 0, 'a mid-text question is banned even in the closing slot');
  assert.equal(v('상황은 끝났습니다. 여러분 헤드셋 달라던 사람이 왜 유죄인가요?', [], true).length, 0, 'the final 여러분-quip is the one exception');
});

test('banned endings, double reporting, and risk words are caught', () => {
  assert.ok(v('그게 문제였거든요.', [], false).length > 0);
  assert.ok(v('그가 말했습니다. 위험하다고요.', [], false).length > 0);
  assert.ok(v('그를 죽였습니다.', [], false).length > 0);
});

test('narration uses role nouns, not person names', () => {
  assert.ok(v('대릴은 그대로 쓰러졌습니다.', ['대릴'], false).length > 0);
  assert.equal(v('남자는 그대로 쓰러졌습니다.', ['남자'], false).length, 0, 'role-noun speakers are fine');
});

test('clean house-style narration passes untouched', () => {
  assert.equal(v('아무도 그의 말을 믿어주지 않았습니다. 이건 시작일 뿐이었죠.', [], true).length, 0);
  assert.equal(v('', [], false).length, 0);
});

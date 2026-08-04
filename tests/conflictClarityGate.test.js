const assert = require('node:assert/strict');
const test = require('node:test');

const { hasConflictCue } = require('../server/services/midformEditorialAcceptanceService');

// The gate was a topic-word list grown from earlier sources (미끼, 인질, 스낵), so it failed a
// well-built opening that simply used other words - and failed the whole run with it.
test('an opening built from confrontation moves passes without the old keywords', () => {
  const opening = '무슨 문제라도 있습니까? 승무원한테 요청했는데 계속 무시하잖아요. '
    + '손님, 저한테 언성 높이지 마세요. 언성 높인 적 없는데요. 진정하세요.';
  assert.equal(hasConflictCue(opening), true);
});

test('the openings the old list was built for still pass', () => {
  assert.equal(hasConflictCue('그녀가 왜 미끼가 됐는지 아무도 몰랐습니다.'), true);
  assert.equal(hasConflictCue('당신이 죽이려 했잖아. 난 죽인 게 아니야.'), true);
  assert.equal(hasConflictCue('두 진영이 위험한 표적을 두고 맞섭니다.'), true);
});

test('a flat scene-setting opening does not pass', () => {
  assert.equal(hasConflictCue('해가 지고 마을에 조용히 눈이 내렸습니다. 사람들이 집으로 돌아갑니다.'), false);
  assert.equal(hasConflictCue(''), false);
});

test('a single strong signal is enough', () => {
  assert.equal(hasConflictCue('유죄를 선고합니다.'), true, 'stakes alone');
  assert.equal(hasConflictCue('그게 아니라고요.'), true, 'denial alone');
  assert.equal(hasConflictCue('누가 그랬는지 아세요?'), true, 'a question alone');
});

const test = require('node:test');
const assert = require('node:assert');

const { _test } = require('../server/services/midformCompressionService');
const { validateSlotFillsDialogueCaptions } = _test;

// The generation contract is exactly three candidates, so every case starts from three. What is
// under test is what happens when some of them close the curiosity gap.
function fills(titles) {
  return {
    slot_fills: [],
    upload_text: {
      title_candidates: titles,
      description: 'd',
      pinned_comment: 'p',
      overlay_title: { top: '위', bottom: '아래' }
    }
  };
}
const EMPTY_PLAN = { timeline: [] };

const OPEN = '아로가 항복을 선언한 이유';
const OPEN_Q = '왜 그는 돌아섰을까?';
const CLOSED = '뱀파이어 제왕이 단 한 명의 증인 때문에 항복을 선언했다';
const CLOSED_2 = '벨라가 결국 떠났습니다';

test('a closed candidate is dropped while open ones survive', () => {
  const result = validateSlotFillsDialogueCaptions(fills([CLOSED, OPEN, OPEN_Q]), EMPTY_PLAN, 'ko');
  assert.deepEqual(result.upload_text.title_candidates, [OPEN, OPEN_Q]);
});

test('one survivor is enough - losing the source over a headline is the worse outcome', () => {
  const result = validateSlotFillsDialogueCaptions(fills([CLOSED, CLOSED_2, OPEN]), EMPTY_PLAN, 'ko');
  assert.deepEqual(result.upload_text.title_candidates, [OPEN]);
});

test('an all-open list is left exactly as it was', () => {
  const titles = [OPEN, OPEN_Q, '그가 사라진 계기'];
  const result = validateSlotFillsDialogueCaptions(fills(titles), EMPTY_PLAN, 'ko');
  assert.deepEqual(result.upload_text.title_candidates, titles);
});

test('an all-closed list still fails - there is nothing left to publish with', () => {
  assert.throws(
    () => validateSlotFillsDialogueCaptions(fills([CLOSED, CLOSED_2, '에드가 치료제를 찾았습니다']), EMPTY_PLAN, 'ko'),
    /leave the answer open/
  );
});

test('the failure names every rejected candidate, not just the first', () => {
  try {
    validateSlotFillsDialogueCaptions(fills([CLOSED, CLOSED_2, '에드가 치료제를 찾았습니다']), EMPTY_PLAN, 'ko');
    assert.fail('should have thrown');
  } catch (error) {
    assert.match(error.message, /항복을 선언했다/);
    assert.match(error.message, /벨라가 결국 떠났습니다/);
    assert.match(error.message, /에드가 치료제를 찾았습니다/);
  }
});

test('the three-candidate generation contract is still enforced before any salvage', () => {
  assert.throws(
    () => validateSlotFillsDialogueCaptions(fills([OPEN, OPEN_Q]), EMPTY_PLAN, 'ko'),
    /exactly 3/
  );
});

test('the rule is Korean-only; a ja list is not filtered', () => {
  const titles = ['なぜ彼は去ったのか', 'アロが降伏を宣言しました', '証人の正体'];
  const result = validateSlotFillsDialogueCaptions(fills(titles), EMPTY_PLAN, 'ja');
  assert.deepEqual(result.upload_text.title_candidates, titles);
});

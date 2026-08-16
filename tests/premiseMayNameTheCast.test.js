const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');
const validate = _test && _test.validateSlotFillsDialogueCaptions;

const base = {
  upload_text: {
    title_candidates: ['후보 하나', '후보 둘', '후보 셋'],
    overlay_title: { top: '위', bottom: '아래' },
    description: '설명',
    hashtags: ['#태그'],
    pinned_comment: '고정 댓글',
  },
};

const plan = { timeline: [] };

test('the premise line may say who these people are', (t) => {
  if (!validate) { t.skip('validator not exported'); return; }
  // Taken absolutely, the nameplate ban shipped recaps where a character simply appears and the
  // viewer never learns who they are - the owner could not follow the story at all.
  const fills = {
    ...base,
    slot_fills: [
      { slot_id: 'slot_02', narration: '가정부 밀리, 고용주 니나, 그리고 니나의 남편 앤드류.' },
      { slot_id: 'slot_09', caption_kr_dialogue: ['그럼 같이 갈까요?'], speakers: ['앤드류'] },
    ],
  };
  assert.doesNotThrow(() => validate(fills, plan, 'ko'));
});

test('a later slot still may not pin a role to a name', (t) => {
  if (!validate) { t.skip('validator not exported'); return; }
  const fills = {
    ...base,
    slot_fills: [
      { slot_id: 'slot_02', narration: '그 밤, 모든 것이 달라집니다.' },
      { slot_id: 'slot_07', narration: '그의 아내 니나는 초대를 받아들입니다.' },
      { slot_id: 'slot_09', caption_kr_dialogue: ['그럼 같이 갈까요?'], speakers: ['니나'] },
    ],
  };
  assert.throws(() => validate(fills, plan, 'ko'), /outside the premise line/);
});

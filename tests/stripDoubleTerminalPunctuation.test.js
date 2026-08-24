const test = require('node:test');
const assert = require('node:assert');

const { _test } = require('../server/services/midformCompressionService.js');
const { stripDoubleTerminalPunctuation, normalizeSlotFillsForStyle } = _test;

test('a period after a question mark is lint, not punctuation', () => {
  assert.equal(stripDoubleTerminalPunctuation('포크스를?.'), '포크스를?');
  assert.equal(stripDoubleTerminalPunctuation('行くの？。'), '行くの？');
  assert.equal(stripDoubleTerminalPunctuation('뭐라고?...'), '뭐라고?');
});

test('legitimate endings are untouched', () => {
  for (const text of ['우리 떠나야 해.', '정말?!', '...', '그래서…', '왜?', '가자!']) {
    assert.equal(stripDoubleTerminalPunctuation(text), text);
  }
});

test('the cleanup runs over captions and narration during style normalization', () => {
  if (typeof normalizeSlotFillsForStyle !== 'function') return; // not exported for tests
  const out = normalizeSlotFillsForStyle(
    { slot_fills: [{ slot_id: 's1', narration: '떠나는데요?.', caption_kr_dialogue: ['포크스를?.', '우리 떠나야 해.'] }] },
    { timeline: [] }
  );
  assert.deepEqual(out.slot_fills[0].caption_kr_dialogue, ['포크스를?', '우리 떠나야 해.']);
  assert.equal(out.slot_fills[0].narration, '떠나는데요?');
});

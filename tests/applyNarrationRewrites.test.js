const test = require('node:test');
const assert = require('node:assert');

const { chunkSentence, rewriteCaptionUnits, applyToFill } = require('../midform/scripts/apply_narration_rewrites');

// The whole point of splicing units rather than regenerating them: caption_units must still
// concatenate to the narration. A desync here shifts every subtitle after the edit.
function concat(units) {
  return units.join(' ').replace(/\s+/g, ' ').trim();
}

test('the rewritten units still spell the rewritten narration', () => {
  const fill = {
    slot_id: 'slot_008',
    narration: '벨라가 위험할 수 있다는 생각에 에드워드는 패닉에 빠집니다. 그리고는 다급하게 짐을 싸기 시작하는데요.',
    caption_units: ['벨라가 위험할 수 있다는 생각에', '에드워드는 패닉에 빠집니다.', '그리고는 다급하게', '짐을 싸기 시작하는데요.'],
    caption_kr: '벨라가 위험할 수 있다는 생각에 에드워드는 패닉에 빠집니다. 그리고는 다급하게 짐을 싸기 시작하는데요.'
  };
  const result = applyToFill(fill, '그리고는 다급하게 짐을 싸기 시작하는데요.', '한 여자와 남자가 걱정스러운 표정을 짓고 있습니다.');
  assert.ok(result.ok, result.reason);
  assert.equal(concat(result.fill.caption_units), result.fill.narration);
  assert.equal(result.fill.caption_kr, concat(result.fill.caption_units));
  // The sentence spanned two units; the untouched ones survive verbatim.
  assert.deepEqual(result.fill.caption_units.slice(0, 2), fill.caption_units.slice(0, 2));
  assert.ok(!result.fill.narration.includes('짐을 싸기'));
});

test('the slot is marked authored so compress-apply will not overwrite it', () => {
  const fill = { slot_id: 'slot_1', narration: '문이 열립니다.', caption_units: ['문이 열립니다.'] };
  const result = applyToFill(fill, '문이 열립니다.', '두 사람이 마주 섭니다.');
  assert.equal(result.fill.authored, true);
});

test('a sentence the narration does not contain is refused, not guessed at', () => {
  const fill = { slot_id: 'slot_1', narration: '문이 열립니다.', caption_units: ['문이 열립니다.'] };
  const result = applyToFill(fill, '창문이 깨집니다.', '두 사람이 마주 섭니다.');
  assert.equal(result.ok, false);
});

test('units that do not spell the sentence are refused rather than appended', () => {
  // Hand-edited fills can carry units that no longer add up to the narration. Appending the new
  // sentence there would leave the old text in the captions and the new text in the voiceover.
  const units = ['벨라가 위험할 수 있다는', '전혀 다른 자막입니다'];
  assert.equal(rewriteCaptionUnits(units, '그리고는 다급하게 짐을 싸기 시작하는데요.', '새 문장입니다.'), null);
});

test('a fill with no units at all gets the new sentence chunked from scratch', () => {
  const out = rewriteCaptionUnits([], '옛 문장.', '두 사람이 조용히 마주 보고 서 있습니다.');
  assert.ok(Array.isArray(out) && out.length >= 1);
  assert.equal(concat(out), '두 사람이 조용히 마주 보고 서 있습니다.');
});

test('chunks stay readable - no one-word scraps on their own line', () => {
  const units = chunkSentence('한 여자와 남자가 걱정스러운 표정을 짓고 있습니다.');
  assert.ok(units.length >= 2, 'a long sentence should be split');
  for (const unit of units) {
    assert.ok(unit.length >= 6, `unit too short to read: "${unit}"`);
    assert.ok(unit.length <= 22, `unit too long for one line: "${unit}"`);
  }
  assert.equal(concat(units), '한 여자와 남자가 걱정스러운 표정을 짓고 있습니다.');
});

test('a short sentence stays one unit', () => {
  assert.deepEqual(chunkSentence('문이 열립니다.'), ['문이 열립니다.']);
});

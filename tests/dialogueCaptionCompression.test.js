const assert = require('node:assert/strict');
const test = require('node:test');

const { compressDialogueCaptionText } = require('../server/services/midformBootstrapAdapterService');

// Quotation marks do ordinary emphasis work too. Taking the first quoted run unconditionally
// destroyed the line: the man's whole correction reached the screen as the single word 당신들,
// so the answer to the racism accusation was missing from the video.
test('emphasis quotes inside a line are kept', () => {
  const line = "아니, 잠깐만요. 그런 '당신들' 말고 '당신들'이요.";
  assert.equal(compressDialogueCaptionText(line), line);
});

test('reported speech is still reduced to the quote', () => {
  assert.equal(compressDialogueCaptionText('"당신이 죽이려 했잖아"라고 말합니다.'), '당신이 죽이려 했잖아');
  assert.equal(compressDialogueCaptionText('"난 아무 짓도 안 했어"'), '난 아무 짓도 안 했어');
});

test('a plain line passes through untouched', () => {
  assert.equal(compressDialogueCaptionText('무슨 문제라도 있습니까?'), '무슨 문제라도 있습니까?');
  assert.equal(compressDialogueCaptionText(''), '');
});

test('a quote carrying most of the line still wins over a short wrapper', () => {
  assert.equal(compressDialogueCaptionText('그는 "진정하세요" 라고'), '진정하세요');
});

const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');
const { splitMultiTurnDialogueLine } = _test;

// Auto-captions run several speakers together in one line, and the blob then takes ONE speaker
// and one colour: the man's correction after his slip was pinned on the officer, so his excuse
// never read as his.
test('a line holding a reaction and the reply to it splits in two', () => {
  const parts = splitMultiTurnDialogueLine("you people oh now wait a minute I don't mean you people I mean you people");
  assert.equal(parts.length, 2);
  assert.equal(parts[0], 'you people');
  assert.match(parts[1], /^oh now wait a minute/);
});

test('a single-turn line is left whole', () => {
  for (const line of [
    'what is it with you people',
    'sir I will not tolerate any racist behavior on the plane',
    'excuse me could I maybe get that headset please',
    // "sir" is a vocative inside one turn, not a boundary: splitting here broke a beat anchor
    // and failed the whole run.
    "I'm only going to say this one more time sir calm down",
    'just calm down I am calm I just want my headset'
  ]) {
    assert.deepEqual(splitMultiTurnDialogueLine(line), [line], `${line} must stay whole`);
  }
});

test('a boundary word at the very start is not a split point', () => {
  assert.deepEqual(splitMultiTurnDialogueLine('wait a minute what did you say'), ['wait a minute what did you say']);
});

test('a fragment too small to stand alone does not split', () => {
  assert.deepEqual(splitMultiTurnDialogueLine('no sir ok'), ['no sir ok']);
  assert.deepEqual(splitMultiTurnDialogueLine(''), ['']);
});

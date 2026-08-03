const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');
const { pickTeaserQuote } = _test;

// The old score was a question mark, a few Twilight-specific phrases, and raw length. On any
// other film only length counted, so the longest rambling line won: "Hi, Janice. I'm glad to see
// you, baby." opened the Senseless cut while the accusation sat in the middle.
test('an accusation beats a greeting', () => {
  const beat = {
    key_dialogue: [
      "Hi, Janice. I'm glad to see you, baby.",
      'You cheated on me with that piece of trash?'
    ]
  };
  assert.equal(pickTeaserQuote(beat), 'You cheated on me with that piece of trash?');
});

test('a long pleasantry does not beat a short denial', () => {
  const beat = {
    key_dialogue: [
      'Good morning, it is really very nice to see all of you here again today.',
      "I don't do heroin!"
    ]
  };
  assert.equal(pickTeaserQuote(beat), "I don't do heroin!");
});

test('a question still wins over a flat statement', () => {
  const beat = { key_dialogue: ['He went to the store.', 'What are they really?'] };
  assert.equal(pickTeaserQuote(beat), 'What are they really?');
});

test('a power line beats neutral description', () => {
  const beat = { key_dialogue: ['The room was quiet for a while.', 'I told you to stay away.'] };
  assert.equal(pickTeaserQuote(beat), 'I told you to stay away.');
});

test('a beat with no dialogue yields nothing', () => {
  assert.equal(pickTeaserQuote({ key_dialogue: [] }), '');
  assert.equal(pickTeaserQuote({}), '');
});

test('a single line is returned whatever it is', () => {
  assert.equal(pickTeaserQuote({ key_dialogue: ['Hello there.'] }), 'Hello there.');
});

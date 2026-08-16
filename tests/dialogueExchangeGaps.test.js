const assert = require('node:assert/strict');
const test = require('node:test');

const { fillDialogueExchangeGaps } = require('../server/services/midformCompressionService');

// Measured on the five recap sources: inside the spans the plan itself had chosen, only 33-47% of
// the spoken lines were captioned. The recap then played line-jump-line and the owner could not
// follow it. Keeping the exchange whole is what makes the picked lines mean anything.
const transcript = [
  { start_sec: 10.0, end_sec: 11.2, text: 'I need you to look into something.' },
  { start_sec: 11.4, end_sec: 12.6, text: 'What kind of something?' },
  { start_sec: 12.8, end_sec: 14.0, text: 'Tickets for a musical.' },
  { start_sec: 14.2, end_sec: 15.4, text: 'For you and your husband?' },
  { start_sec: 15.6, end_sec: 17.0, text: 'No. Just me.' },
];

test('the lines between the chosen ones come back', () => {
  const picked = ['I need you to look into something.', 'No. Just me.'];
  const { lines, added } = fillDialogueExchangeGaps(picked, transcript);
  assert.equal(added, 3);
  assert.deepEqual(lines, transcript.map((cue) => cue.text));
});

test('a single picked line has no exchange to restore', () => {
  const { lines, added } = fillDialogueExchangeGaps(['Tickets for a musical.'], transcript);
  assert.equal(added, 0);
  assert.deepEqual(lines, ['Tickets for a musical.']);
});

test('sound-effect cues are not turned into captions', () => {
  const withEffects = [
    { start_sec: 10.0, end_sec: 11.2, text: 'Say it again.' },
    { start_sec: 11.4, end_sec: 12.6, text: '[music]' },
    { start_sec: 12.8, end_sec: 13.2, text: '>>' },
    { start_sec: 13.4, end_sec: 15.0, text: 'I said what I said.' },
  ];
  const { lines } = fillDialogueExchangeGaps(['Say it again.', 'I said what I said.'], withEffects);
  assert.equal(lines.length, 2, 'only the two spoken lines survive');
  assert.ok(lines.some((line) => line.includes('Say it again.')));
  assert.ok(lines.some((line) => line.includes('I said what I said.')));
  assert.ok(!lines.some((line) => /\[music\]/.test(line)), 'no effect cue becomes a caption');
});

test('one runaway span cannot eat the whole recap', () => {
  const long = Array.from({ length: 40 }, (_, i) => ({
    start_sec: 10 + i, end_sec: 10.8 + i, text: `line number ${i} here.`,
  }));
  const { added } = fillDialogueExchangeGaps(['line number 0 here.', 'line number 39 here.'], long, 12);
  assert.equal(added, 12);
});

test('a line the plan picked outside the span is kept', () => {
  // Cold opens replay a line from later in the source; restoring an exchange must not drop it.
  const picked = ['I need you to look into something.', 'What kind of something?', 'Something from much later.'];
  const { lines } = fillDialogueExchangeGaps(picked, transcript);
  assert.ok(lines.includes('Something from much later.'));
});

test('cue fragments are glued into whole utterances', () => {
  // Auto-captions break a sentence across display chunks. Restoring them as separate "lines" gave
  // the caption writer half-thoughts to translate and it produced broken Korean and duplicates.
  const chunked = [
    { start_sec: 10.0, end_sec: 10.9, text: '>> Tell Nina that I' },
    { start_sec: 10.9, end_sec: 11.8, text: 'exchanged the tickets' },
    { start_sec: 11.8, end_sec: 12.6, text: 'for next week.' },
    { start_sec: 13.0, end_sec: 14.2, text: '>> No, I can not let you do that.' },
  ];
  const { lines } = fillDialogueExchangeGaps(['>> Tell Nina that I', '>> No, I can not let you do that.'], chunked);
  assert.ok(lines.some((line) => /exchanged the tickets for next week\./.test(line)),
    `chunks glued into one utterance, got ${JSON.stringify(lines)}`);
  assert.equal(lines.length, 2, 'one line per utterance, not per display chunk');
});

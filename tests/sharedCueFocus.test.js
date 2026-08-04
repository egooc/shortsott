const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');
const { collectDialogueFocus } = _test;

// One cue used to serve one line: whichever quote came first claimed it and every other line
// inside that cue was dropped. "just calm down" took the cue and the reply to it — the first
// beat of the running gag — vanished before any slot could ask for it.
const PACKED = [
  { start_sec: 55.84, end_sec: 58.76, text: "to me sir I wasn't raising my voice okay" },
  { start_sec: 58.76, end_sec: 61.68, text: 'just calm down I I am gum I just want my' },
  { start_sec: 61.68, end_sec: 63.48, text: 'headset sir our country is going through' }
];
const beat = { beat_id: 'b', start_sec: 53.7, end_sec: 66.96 };

test('two lines living in one cue both survive', () => {
  const focus = collectDialogueFocus(beat, PACKED, {
    quotes: ['just calm down', 'I I am gum I just want my headset']
  });
  assert.ok(focus, 'the beat must yield a focus');
  assert.equal(focus.lines.length, 2, `both lines must survive, got ${JSON.stringify(focus.lines)}`);
});

test('the same quote twice is still counted once', () => {
  const focus = collectDialogueFocus(beat, PACKED, {
    quotes: ['just calm down', 'just calm down']
  });
  assert.equal(focus.lines.length, 1);
});

test('a quote matching nothing is left out', () => {
  const focus = collectDialogueFocus(beat, PACKED, {
    quotes: ['just calm down', 'completely unrelated sentence about horses']
  });
  assert.equal(focus.lines.length, 1);
});

test('lines come back in the order they are spoken', () => {
  const focus = collectDialogueFocus(beat, PACKED, {
    quotes: ['I I am gum I just want my headset', "I wasn't raising my voice okay"]
  });
  assert.equal(focus.lines.length, 2);
  assert.match(focus.lines[0], /raising my voice/);
});

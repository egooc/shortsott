const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');

const win = (start, end, line) => ({ matched: true, start_sec: start, end_sec: end, line });
const slot = (windows) => [{ slot_id: 'slot_07', decision: 'KEEP_DIALOGUE', dialogue_line_windows: windows }];
const lines = (timeline) => timeline[0].dialogue_line_windows.map((entry) => entry.line);

// The Housemaid police interview: the caption between these two lines is the rolling re-display of
// both, so the recap said the same sentence three times in a row.
test('a re-display that straddles two lines is dropped', () => {
  const out = _test.dropRestatedWindows(slot([
    win(250.8, 256.519, '>> I I guess you know, he Well, he likes things to be a certain way.'),
    win(256.519, 258.64, 'he likes things to be a certain way. Everything perfect.'),
    win(258.64, 264.07, 'Everything perfect.')
  ]));
  assert.deepEqual(lines(out), [
    '>> I I guess you know, he Well, he likes things to be a certain way.',
    'Everything perfect.'
  ]);
});

// A character repeating themselves is the scene, not a caption artifact: the repeat is not glued to
// the next line's opening words, so it has to survive.
test('a line a character really repeats is kept', () => {
  const out = _test.dropRestatedWindows(slot([
    win(424.0, 427.0, 'So did you know?'),
    win(427.0, 428.1, 'Did you know?'),
    win(428.1, 431.0, 'That the tooth was missing.')
  ]));
  assert.equal(lines(out).length, 3);
});

test('windows in normal succession are untouched', () => {
  const out = _test.dropRestatedWindows(slot([
    win(10, 12, 'First thing said here.'),
    win(12, 14, 'Second thing said here.'),
    win(14, 16, 'Third thing said here.')
  ]));
  assert.equal(lines(out).length, 3);
});

test('a two-word fragment is never dropped as a restatement', () => {
  const out = _test.dropRestatedWindows(slot([
    win(10, 12, 'I know what you did last night.'),
    win(12, 13, 'I know'),
    win(13, 15, 'what you did.')
  ]));
  assert.equal(lines(out).length, 3);
});

// The other shape: the caption re-displays only the tail of the line just spoken, as its own cue.
test('a tail re-displayed right after its own line is dropped', () => {
  const out = _test.dropRestatedWindows(slot([
    win(532.08, 533.0, '>> No. Will Callahan is our future.'),
    win(533.0, 535.2, 'Will Callahan is our future.'),
    win(536.0, 539.0, '$30 million, Sonny.')
  ]));
  assert.deepEqual(lines(out), ['>> No. Will Callahan is our future.', '$30 million, Sonny.']);
});

test('a character repeating themselves is not a tail re-display', () => {
  const out = _test.dropRestatedWindows(slot([
    win(424.32, 426.96, '>> Yeah, did you know that?'),
    win(426.96, 428.16, '>> Did you?'),
    win(428.16, 433.5, 'That a tooth was gone.')
  ]));
  assert.equal(lines(out).length, 3);
});

test('a tail spoken again much later stays', () => {
  const out = _test.dropRestatedWindows(slot([
    win(100, 103, 'I am taking Callahan with the first pick.'),
    win(140, 142, 'taking Callahan with the first pick.')
  ]));
  assert.equal(lines(out).length, 2);
});

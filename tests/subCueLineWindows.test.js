const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');
const { resolveDialogueLineWindows } = _test;

// The 1:21 cue of the Anger Management source: one 9.4s cue holding five lines. Every line
// matching it received the whole cue as its window, the windows collided, and all but one line
// was flagged and dropped — the user read the missing lines straight off the finished draft.
const PACKED_CUE = {
  start_sec: 81.0,
  end_sec: 90.4,
  text: 'attendant the flight attendant keeps ignore me when I ask calm down I am calm what is it with you people you people oh'
};

test('several lines packed into one cue each get their own slice', () => {
  const lines = [
    'the flight attendant keeps ignore me when I ask',
    'calm down',
    'I am calm',
    'what is it with you people'
  ];
  const resolution = resolveDialogueLineWindows([PACKED_CUE], 80.0, 91.0, lines, 91.0, 95.0);
  const windows = resolution.windows.filter((w) => w.matched === true);
  assert.equal(windows.length, 4, `all four lines must survive, got ${windows.length}`);
  for (let i = 1; i < windows.length; i += 1) {
    assert.ok(windows[i].start_sec >= windows[i - 1].end_sec - 1e-6,
      `windows must not overlap: ${JSON.stringify(windows[i - 1])} vs ${JSON.stringify(windows[i])}`);
  }
  for (const w of windows) {
    assert.ok(w.start_sec >= 80.9 && w.end_sec <= 90.5, `slice must stay inside the cue, got [${w.start_sec},${w.end_sec}]`);
  }
});

test('the slices follow the order the words are spoken', () => {
  const lines = ['calm down', 'the flight attendant keeps ignore me when I ask'];
  const resolution = resolveDialogueLineWindows([PACKED_CUE], 80.0, 91.0, lines, 91.0, 95.0);
  const byLine = Object.fromEntries(resolution.windows.filter((w) => w.matched).map((w) => [w.line, w]));
  assert.ok(byLine['the flight attendant keeps ignore me when I ask'].start_sec
    < byLine['calm down'].start_sec, 'the earlier phrase must get the earlier slice');
});

test('a line that IS the whole cue keeps the whole cue', () => {
  const cue = { start_sec: 10.0, end_sec: 13.0, text: 'you tried to kill it' };
  const resolution = resolveDialogueLineWindows([cue], 9.0, 14.0, ['you tried to kill it'], 14.0, 20.0);
  const w = resolution.windows.find((x) => x.matched);
  assert.ok(w.start_sec <= 10.1 && w.end_sec >= 12.9, `expected the full cue, got [${w.start_sec},${w.end_sec}]`);
});

// A line split across a cue boundary starts mid-sentence in the second cue: "…I don't / know
// where a headset ties into patriotism". Head matching failed, the whole cue was claimed, it
// collided with the hook's slice of the same cue, and the punchline fell out of the cut.
test('a line split across a cue boundary is sliced by its tail', () => {
  const cue = {
    start_sec: 66.0,
    end_sec: 73.5,
    text: 'know where a headset ties into patriotism is there a problem here sir I I don\'t think so can you come to the'
  };
  const resolution = resolveDialogueLineWindows(
    [cue], 65.0, 74.0,
    ["I don't know where a headset ties into patriotism", 'is there a problem here sir'],
    74.0, 80.0
  );
  const windows = resolution.windows.filter((w) => w.matched === true);
  assert.equal(windows.length, 2, 'both the punchline and the question must survive');
  const punch = windows.find((w) => /patriotism/.test(w.line));
  const question = windows.find((w) => /problem/.test(w.line));
  assert.ok(punch.end_sec <= question.start_sec + 1e-6, 'the punchline plays before the question');
});

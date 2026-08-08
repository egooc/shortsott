const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');

test('pre-roll claims at most half of the actual silence gap before the line', () => {
  const transcript = [
    { start_sec: 8.0, end_sec: 9.8, text: 'completely unrelated earlier line' },
    { start_sec: 10.0, end_sec: 12.0, text: 'you tried to kill the ad' }
  ];
  const resolution = _test.resolveDialogueLineWindows(transcript, 5, 14, ['you tried to kill the ad'], 14);
  const win = resolution.windows.find((w) => w.matched === true);

  assert.ok(win);
  // gap to the previous cue is 0.2s -> lead-in is 0.1s, not the full 0.7s pre-roll
  assert.ok(Math.abs(Number(win.start_sec) - 9.9) <= 0.02, `start ${win.start_sec} should be ~9.9`);
});

test('pre-roll stays full when the silence before the line is wide', () => {
  const transcript = [
    { start_sec: 2.0, end_sec: 3.0, text: 'far away line' },
    { start_sec: 10.0, end_sec: 12.0, text: 'you tried to kill the ad' }
  ];
  const resolution = _test.resolveDialogueLineWindows(transcript, 5, 14, ['you tried to kill the ad'], 14);
  const win = resolution.windows.find((w) => w.matched === true);

  assert.ok(win);
  assert.ok(Math.abs(Number(win.start_sec) - 9.3) <= 0.02, `start ${win.start_sec} should be ~9.3 (full 0.7s pre-roll)`);
});

test('a packed cue sliced mid-cue gets no lead-in: speech spans the boundary', () => {
  const transcript = [
    { start_sec: 10.0, end_sec: 16.0, text: 'keeps ignoring me when I ask calm down I am calm what is it with you people' }
  ];
  const resolution = _test.resolveDialogueLineWindows(transcript, 8, 18, ['what is it with you people'], 18);
  const win = resolution.windows.find((w) => w.matched === true);

  assert.ok(win);
  // the slice begins mid-cue; earlier words run right up to it, so no pre-roll at all
  assert.ok(Number(win.start_sec) >= Number(win.raw_start_sec) - 0.011, `start ${win.start_sec} must not lead into the packed cue (raw ${win.raw_start_sec})`);
});

test('a line whose tail spills into the next contiguous cue extends to the sentence boundary', () => {
  const transcript = [
    { start_sec: 10.0, end_sec: 12.0, text: "son we live in a world that has" },
    { start_sec: 12.1, end_sec: 14.0, text: 'walls and those walls have to be guarded' }
  ];
  const lines = ['we live in a world that has walls'];
  const resolution = _test.resolveDialogueLineWindows(transcript, 8, 18, lines, 18);
  const win = resolution.windows.find((w) => w.matched === true);

  assert.ok(win);
  // "walls" lives at the head of the second cue; the raw end must reach into it instead of
  // cutting the sentence at 12.0
  assert.ok(Number(win.raw_end_sec) > 12.05, `raw_end ${win.raw_end_sec} should extend into the next cue`);
  assert.ok(Number(win.raw_end_sec) < 13.0, `raw_end ${win.raw_end_sec} should only take the matched tail, not the whole next cue`);
});

test('word snap moves window edges to word boundaries within tolerance only', () => {
  const timeline = [{
    decision: 'KEEP_DIALOGUE',
    dialogue_line_windows: [
      { matched: true, line: 'you tried to kill it', start_sec: 10.0, end_sec: 12.5 },
      { matched: true, line: 'far from any word', start_sec: 30.0, end_sec: 33.0 }
    ]
  }];
  const words = { words: [
    { w: 'you', start_sec: 10.22, end_sec: 10.4 },
    { w: 'it', start_sec: 12.1, end_sec: 12.31 }
  ] };

  const snapped = _test.snapDialogueWindowsToWords(timeline, words);
  const [near, far] = snapped[0].dialogue_line_windows;

  assert.equal(near.word_snapped, true);
  assert.ok(Math.abs(near.start_sec - (10.22 - 0.04)) <= 0.011, `start ${near.start_sec}`);
  assert.ok(Math.abs(near.end_sec - (12.31 + 0.06)) <= 0.011, `end ${near.end_sec}`);
  assert.equal(far.word_snapped, undefined, 'a window nowhere near a word keeps cue timing');
  assert.equal(far.start_sec, 30.0);
});

test('word snap never collapses a window and no-ops without word data', () => {
  const timeline = [{
    decision: 'KEEP_DIALOGUE',
    dialogue_line_windows: [{ matched: true, line: 'x', start_sec: 10.0, end_sec: 10.4 }]
  }];
  const words = { words: [
    { w: 'a', start_sec: 10.3, end_sec: 10.34 },
    { w: 'b', start_sec: 10.05, end_sec: 10.1 }
  ] };

  const snapped = _test.snapDialogueWindowsToWords(timeline, words);
  const win = snapped[0].dialogue_line_windows[0];
  assert.ok(Number(win.end_sec) - Number(win.start_sec) >= 0.2, 'window must not collapse');

  assert.equal(_test.snapDialogueWindowsToWords(timeline, null), timeline);
  assert.equal(_test.snapDialogueWindowsToWords(timeline, { words: [] }), timeline);
});

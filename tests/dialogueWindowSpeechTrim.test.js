const assert = require('node:assert/strict');
const test = require('node:test');

const { trimDialogueWindowsToSpeech } = require('../server/services/midformBootstrapAdapterService');

function planWithWindow(start, end) {
  return {
    timeline: [
      {
        slot_id: 'slot_3',
        decision: 'KEEP_DIALOGUE',
        dialogue_line_windows: [{ matched: true, line: 'a spoken line', start_sec: start, end_sec: end }]
      }
    ]
  };
}

function windowOf(plan) {
  const win = plan.timeline[0].dialogue_line_windows[0];
  return [win.start_sec, win.end_sec];
}

test('a caption cue that lingers after the words stop is trimmed to the speech', () => {
  // The real shape: an auto-caption cue ends when the caption leaves the screen, so a short
  // line was recorded as a 12s window and its subtitle sat on screen for all of it.
  const plan = planWithWindow(15.46, 27.46);
  const result = trimDialogueWindowsToSpeech(plan, [[15.5, 17.6], [30.0, 34.0]]);

  assert.equal(result.trimmed, 1);
  const [start, end] = windowOf(plan);
  assert.ok(start >= 15.46 && start <= 15.6, `start ${start}`);
  assert.ok(end <= 17.7, `end should follow the speech, got ${end}`);
});

test('a window that already matches its speech is left alone', () => {
  const plan = planWithWindow(10.39, 13.42);
  const result = trimDialogueWindowsToSpeech(plan, [[10.4, 13.4]]);
  assert.equal(result.trimmed, 0);
  assert.deepEqual(windowOf(plan), [10.39, 13.42]);
});

test('trimming never leaves a window too short to read', () => {
  // A single blip of detected speech must not collapse a line to a fraction of a second.
  const plan = planWithWindow(20.0, 26.0);
  trimDialogueWindowsToSpeech(plan, [[22.0, 22.2]]);
  const [start, end] = windowOf(plan);
  assert.deepEqual([start, end], [20.0, 26.0], 'window should be left intact rather than collapsed');
});

test('a window with no detected speech inside it is left alone', () => {
  const plan = planWithWindow(40.0, 44.0);
  const result = trimDialogueWindowsToSpeech(plan, [[10.0, 12.0], [60.0, 62.0]]);
  assert.equal(result.trimmed, 0);
  assert.deepEqual(windowOf(plan), [40.0, 44.0]);
});

test('with no speech ranges at all nothing is touched', () => {
  const plan = planWithWindow(15.46, 27.46);
  const result = trimDialogueWindowsToSpeech(plan, []);
  assert.equal(result.trimmed, 0);
  assert.deepEqual(windowOf(plan), [15.46, 27.46]);
});

test('unmatched windows and non-dialogue slots are skipped', () => {
  const plan = {
    timeline: [
      { slot_id: 'slot_1', decision: 'NARRATE', dialogue_line_windows: [{ matched: true, start_sec: 1, end_sec: 30 }] },
      { slot_id: 'slot_2', decision: 'KEEP_DIALOGUE', dialogue_line_windows: [{ matched: false, start_sec: 1, end_sec: 30 }] }
    ]
  };
  const result = trimDialogueWindowsToSpeech(plan, [[1.0, 2.0]]);
  assert.equal(result.trimmed, 0);
});

const assert = require('node:assert/strict');
const test = require('node:test');

const { trimDialogueWindowsToSpeech } = require('../server/services/midformBootstrapAdapterService');

function planWithWindow(start, end) {
  return {
    timeline: [
      {
        slot_id: 'slot_3',
        decision: 'KEEP_DIALOGUE',
        dialogue_line_windows: [{ matched: true, line: 'I brought you the evidence you asked for', start_sec: start, end_sec: end }]
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

test('a window longer than the words could take is capped by word count', () => {
  // Silence detection finds no pauses under a continuous score, so a five-word line can
  // still come back as a nine-second window. The word count is independent of the audio.
  const plan = {
    timeline: [{
      slot_id: 'slot_3',
      decision: 'KEEP_DIALOGUE',
      dialogue_line_windows: [{ matched: true, line: 'let me show you brother', start_sec: 17.2, end_sec: 26.6 }]
    }]
  };
  trimDialogueWindowsToSpeech(plan, [[17.2, 26.6]]);
  const win = plan.timeline[0].dialogue_line_windows[0];
  const duration = win.end_sec - win.start_sec;
  assert.ok(duration < 5, `five words cannot take ${duration}s`);
  assert.ok(duration >= 0.8, 'but the line still needs to be readable');
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

test('a window running past the end of the video is cut back to it', () => {
  // The transcript utterance keeps these numbers verbatim, so clamping the padded clip
  // later never reaches it: a window ended 1.7s past a 529s source.
  const plan = {
    timeline: [{
      slot_id: 'slot_9',
      decision: 'KEEP_DIALOGUE',
      dialogue_line_windows: [{ matched: true, line: 'a line near the very end', start_sec: 527.0, end_sec: 531.28 }]
    }]
  };
  trimDialogueWindowsToSpeech(plan, [], 529.561);
  const win = plan.timeline[0].dialogue_line_windows[0];
  assert.ok(win.end_sec <= 529.561, `window must end inside the source, got ${win.end_sec}`);
  assert.ok(win.end_sec > win.start_sec);
});

test('a window that starts past the end is left for the caller rather than inverted', () => {
  const plan = {
    timeline: [{
      slot_id: 'slot_9',
      decision: 'KEEP_DIALOGUE',
      dialogue_line_windows: [{ matched: true, line: 'beyond', start_sec: 529.4, end_sec: 531.0 }]
    }]
  };
  trimDialogueWindowsToSpeech(plan, [], 529.561);
  const win = plan.timeline[0].dialogue_line_windows[0];
  assert.ok(win.end_sec > win.start_sec, 'never produce an inverted window');
});

const assert = require('node:assert/strict');
const test = require('node:test');

const { clampDialogueWindowsToOwnCue, extendShortDialogueWindows } = require('../server/services/midformBootstrapAdapterService');

function planWith(line, start, end) {
  return {
    timeline: [
      {
        slot_id: 'slot_1',
        decision: 'KEEP_DIALOGUE',
        dialogue_line_windows: [{ matched: true, line, start_sec: start, end_sec: end, caption_start_sec: start, caption_end_sec: end }]
      }
    ]
  };
}

test('a window straddling a foreign cue is clamped to its own line, dropping the other voice', () => {
  // Draft Day cold open: one 8s window over three utterances, captioned only the last line.
  // The transcript (post word-timing split) has a cue per utterance.
  const transcript = [
    { start_sec: 336.7, end_sec: 339.0, text: 'I made you a fair offer and you told me to enjoy my pancakes.' },
    { start_sec: 339.6, end_sec: 342.0, text: "You think I'm going to give you my next three number one picks?" },
    { start_sec: 342.4, end_sec: 344.9, text: "You're panicking, Sonny, and I intend to take advantage of that." }
  ];
  const plan = planWith("You're panicking, Sonny, and I intend to take advantage of that.", 336.7, 344.96);
  const result = clampDialogueWindowsToOwnCue(plan, transcript);

  assert.equal(result.clamped, 1);
  const win = plan.timeline[0].dialogue_line_windows[0];
  // Clamped to the "you're panicking" cue only — the fair-offer and three-picks audio is gone.
  assert.ok(win.start_sec >= 342.3 && win.start_sec <= 342.5, `start clamped, got ${win.start_sec}`);
  assert.ok(win.end_sec >= 344.8 && win.end_sec <= 345.0, `end clamped, got ${win.end_sec}`);
});

test('a long line spanning several own cues keeps all of them (only foreign cues drop)', () => {
  // "I'm going to pick Bo, Tom, unless you want him more, and if so, let's make a deal." is split
  // across two cues; a leading foreign line bleeds into the window. Keep BOTH own cues, drop only
  // the foreign one - clamping to a single best cue would cut "I'm going to pick Bo, Tom".
  const transcript = [
    { start_sec: 407.0, end_sec: 408.0, text: 'No time for that.' },
    { start_sec: 408.07, end_sec: 409.7, text: "I'm going to pick Bo, Tom, unless you want" },
    { start_sec: 409.7, end_sec: 411.9, text: "him more, and if so, let's make a deal." }
  ];
  const plan = planWith("I'm going to pick Bo, Tom, unless you want him more, and if so, let's make a deal.", 407.2, 411.9);
  const result = clampDialogueWindowsToOwnCue(plan, transcript);

  assert.equal(result.clamped, 1);
  const win = plan.timeline[0].dialogue_line_windows[0];
  assert.ok(win.start_sec >= 408.0 && win.start_sec <= 408.2, `start keeps first own cue, got ${win.start_sec}`);
  assert.ok(win.end_sec >= 411.8 && win.end_sec <= 412.0, `end keeps last own cue, got ${win.end_sec}`);
});

test('a window already inside a single cue is left untouched', () => {
  const transcript = [
    { start_sec: 100.0, end_sec: 104.0, text: 'This is one clean line spoken by one person.' }
  ];
  const plan = planWith('This is one clean line spoken by one person.', 100.2, 103.8);
  const result = clampDialogueWindowsToOwnCue(plan, transcript);

  assert.equal(result.clamped, 0);
  const win = plan.timeline[0].dialogue_line_windows[0];
  assert.equal(win.start_sec, 100.2);
  assert.equal(win.end_sec, 103.8);
});

test('an unconfident text match is not clamped (never guesses a foreign cue is the owner)', () => {
  const transcript = [
    { start_sec: 10.0, end_sec: 12.0, text: 'Completely unrelated words here.' },
    { start_sec: 12.0, end_sec: 14.0, text: 'Another different sentence entirely.' }
  ];
  const plan = planWith('The captioned line shares nothing with either cue.', 10.5, 13.5);
  const result = clampDialogueWindowsToOwnCue(plan, transcript);

  assert.equal(result.clamped, 0);
});

test('a caption YouTube collapsed onto one timestamp is floored to speaking time, bounded by the next line', () => {
  // "Okay, I'm ready to do this, Tom." (8 words) recorded as a 0.9s window -> only the last word is
  // audible. Floor it to ~wordCount/3.2s so the whole line plays; the next selected clip is far off.
  const plan = {
    timeline: [
      {
        slot_id: 's1',
        decision: 'KEEP_DIALOGUE',
        dialogue_line_windows: [
          { matched: true, line: "Okay, I'm ready to do this, Tom.", start_sec: 304.5, end_sec: 305.4 },
          { matched: true, line: 'much later line', start_sec: 320.0, end_sec: 322.0 }
        ]
      }
    ]
  };
  const result = extendShortDialogueWindows(plan, 600);
  assert.equal(result.extended, 1);
  const win = plan.timeline[0].dialogue_line_windows[0];
  assert.ok(win.end_sec - win.start_sec >= 2.1, `floored to speaking time, got ${win.end_sec - win.start_sec}`);
});

test('the floor never runs a clip into the next selected line', () => {
  const plan = {
    timeline: [
      {
        slot_id: 's1',
        decision: 'KEEP_DIALOGUE',
        dialogue_line_windows: [
          { matched: true, line: 'seven word line right here now ok', start_sec: 100.0, end_sec: 100.9 },
          { matched: true, line: 'the next speaker starts talking', start_sec: 101.4, end_sec: 103.0 }
        ]
      }
    ]
  };
  extendShortDialogueWindows(plan, 600);
  const win = plan.timeline[0].dialogue_line_windows[0];
  assert.ok(win.end_sec <= 101.4, `stops before next line, got ${win.end_sec}`);
});

test('a clip already long enough for its words is left alone', () => {
  const plan = {
    timeline: [
      {
        slot_id: 's1',
        decision: 'KEEP_DIALOGUE',
        dialogue_line_windows: [{ matched: true, line: 'three word line', start_sec: 10.0, end_sec: 13.0 }]
      }
    ]
  };
  const result = extendShortDialogueWindows(plan, 600);
  assert.equal(result.extended, 0);
  assert.equal(plan.timeline[0].dialogue_line_windows[0].end_sec, 13.0);
});

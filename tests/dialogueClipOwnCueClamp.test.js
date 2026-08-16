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

// Draft Day slot_005: "How can I help you?" is spoken from 298.12, but its caption cue only opens
// at 299.12 because ">> Sonny." still holds the screen. Re-anchoring the window to that cue cut the
// clip into the line's third word. A start measured from the audio outranks a caption boundary.
test('a start measured from the audio is not pulled back to a late caption cue', () => {
  const transcript = [
    { start_sec: 297.76, end_sec: 299.12, text: 'Sonny.' },
    { start_sec: 299.12, end_sec: 302.55, text: 'How can I help you?' }
  ];
  const plan = planWith('How can I help you?', 298.05, 302.555);
  plan.timeline[0].dialogue_line_windows[0].timing_source = 'measured';
  clampDialogueWindowsToOwnCue(plan, transcript);

  const win = plan.timeline[0].dialogue_line_windows[0];
  assert.equal(win.start_sec, 298.05, `measured start kept, got ${win.start_sec}`);
});

test('without that measurement the same window is still clamped off the foreign cue', () => {
  const transcript = [
    { start_sec: 297.76, end_sec: 299.12, text: 'Sonny.' },
    { start_sec: 299.12, end_sec: 302.55, text: 'How can I help you?' }
  ];
  const plan = planWith('How can I help you?', 298.05, 302.555);
  clampDialogueWindowsToOwnCue(plan, transcript);

  assert.equal(plan.timeline[0].dialogue_line_windows[0].start_sec, 299.12);
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

test('the floor stops at the next voice instead of swallowing it', () => {
  // Long Shot shipped this: a 1.5s window for an eleven-word caption was floored to 6.1s and ran
  // straight over the line spoken between its two halves, so that speech played with no caption of
  // its own. The floor may only borrow silence, never another utterance.
  const plan = {
    timeline: [{
      slot_id: 'slot_008',
      decision: 'KEEP_DIALOGUE',
      dialogue_line_windows: [
        { line: 'We just re-upped... we have another maybe 4 or 5 hours.', matched: true, start_sec: 399.94, end_sec: 401.4 },
        { line: 'Yeah. Why?', matched: true, start_sec: 407.4, end_sec: 409.6 },
      ],
    }],
  };
  const transcript = [
    { start_sec: 399.13, end_sec: 400.31, text: 'We just re-upped.' },
    { start_sec: 400.91, end_sec: 402.79, text: 'You kept saying you wanted to take more, so we did.' },
    { start_sec: 403.09, end_sec: 406.05, text: 'So we have another maybe four or five hours.' },
    { start_sec: 407.4, end_sec: 409.6, text: 'Yeah. Why?' },
  ];
  extendShortDialogueWindows(plan, 600, transcript);
  const win = plan.timeline[0].dialogue_line_windows[0];
  // The window already reaches into the other speaker here, which is the clamp's problem; what the
  // floor must not do is make it worse by growing across that voice to reach its word-count target.
  assert.equal(win.end_sec, 401.4, 'the floor refuses to grow over another utterance');
});

test('the floor still fills silence when no other voice is in the way', () => {
  const plan = {
    timeline: [{
      slot_id: 'slot_01',
      decision: 'KEEP_DIALOGUE',
      dialogue_line_windows: [
        { line: 'Okay, I am ready to do this, Tom.', matched: true, start_sec: 302.6, end_sec: 302.8 },
      ],
    }],
  };
  const transcript = [
    { start_sec: 302.6, end_sec: 302.8, text: 'Okay, I am ready to do this, Tom.' },
    { start_sec: 312.0, end_sec: 314.0, text: 'Our next two number one picks.' },
  ];
  extendShortDialogueWindows(plan, 600, transcript);
  assert.ok(plan.timeline[0].dialogue_line_windows[0].end_sec > 304.5, 'a collapsed cue is still floored');
});

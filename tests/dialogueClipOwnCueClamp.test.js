const assert = require('node:assert/strict');
const test = require('node:test');

const { clampDialogueWindowsToOwnCue } = require('../server/services/midformBootstrapAdapterService');

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

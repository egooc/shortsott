const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');

// The owner directive: classify and fit in code, not by hand-tailoring each source. Each pass here
// encodes a surgery this session performed manually on the Housemaid ending.

test('a cold-open window inflated by a rolling cue is capped at its spoken estimate', () => {
  const out = _test.capColdOpenWindowsToSpokenEstimate([{
    slot_id: 'slot_01', role: 'cold_open', decision: 'KEEP_DIALOGUE',
    start_sec: 488.71, end_sec: 502.31,
    dialogue_line_windows: [{ matched: true, line: "Can't run. I'm Pearl, remember?", start_sec: 488.71, end_sec: 502.31 }]
  }]);
  const win = out[0].dialogue_line_windows[0];
  assert.ok(win.end_sec < 493.0, `window capped near speech, got ${win.end_sec}`);
  assert.ok(out[0].end_sec <= win.end_sec + 2.7, 'slot keeps only the reaction room');
});

test('a window already sized to its words is untouched', () => {
  const out = _test.capColdOpenWindowsToSpokenEstimate([{
    slot_id: 'slot_01', role: 'cold_open', decision: 'KEEP_DIALOGUE',
    start_sec: 100, end_sec: 105,
    dialogue_line_windows: [{ matched: true, line: 'ten words are spoken in this window right about here', start_sec: 100, end_sec: 104.5 }]
  }]);
  assert.equal(out[0].dialogue_line_windows[0].end_sec, 104.5);
});

test('a 119s jump between kept dialogue slots gets an auto seam', () => {
  const beats = [
    { beat_id: 'B7', start_sec: 278, end_sec: 297, summary: 'police interview ends' },
    { beat_id: 'B8', start_sec: 353, end_sec: 392, summary: 'the funeral eulogy' },
    { beat_id: 'B9', start_sec: 414, end_sec: 446, summary: 'the mother-in-law confronts Nina' }
  ];
  const out = _test.insertSceneJumpSeams([
    { slot_id: 'slot_08', beat_id: 'B7', role: 'body', decision: 'KEEP_DIALOGUE', start_sec: 277, end_sec: 297 },
    { slot_id: 'slot_10', beat_id: 'B9', role: 'body', decision: 'KEEP_DIALOGUE', start_sec: 416, end_sec: 446 }
  ], beats);
  assert.equal(out.length, 3);
  const seam = out[1];
  assert.equal(seam.decision, 'NARRATE');
  assert.equal(seam.auto_seam, true);
  assert.ok(seam.reason.includes('mother-in-law'), 'the seam reason names the upcoming beat');
  assert.ok(seam.reason.includes('funeral'), 'and carries the skipped beat');
});

test('a small jump gets no seam', () => {
  const out = _test.insertSceneJumpSeams([
    { slot_id: 'a', beat_id: 'B1', role: 'body', decision: 'KEEP_DIALOGUE', start_sec: 100, end_sec: 120 },
    { slot_id: 'b', beat_id: 'B2', role: 'body', decision: 'KEEP_DIALOGUE', start_sec: 150, end_sec: 170 }
  ], []);
  assert.equal(out.length, 2);
});

test('an unpaid hook gets its payoff built from the beat, skipping the hook line itself', () => {
  const beats = [{
    beat_id: 'B10', start_sec: 485, end_sec: 510, dramatic_weight: 4,
    key_dialogue: ['I told you to run.', "Can't run. I'm Pearl, remember?", 'Make a life for yourself.'],
    anchor_dialogue: []
  }];
  const transcript = [
    { start_sec: 486.96, end_sec: 488.72, text: 'I told you to run.' },
    { start_sec: 488.72, end_sec: 490.56, text: ">> Can't run." },
    { start_sec: 490.56, end_sec: 506.19, text: "I'm Pearl, remember?" },
    { start_sec: 506.2, end_sec: 533.39, text: '>> Make a life for yourself.' }
  ];
  const out = _test.buildHookPayoffIfMissing([
    { slot_id: 'slot_01', beat_id: 'B10', role: 'cold_open', decision: 'KEEP_DIALOGUE',
      dialogue_line_windows: [{ matched: true, line: "Can't run. I'm Pearl, remember?", start_sec: 488.72, end_sec: 491.4 }] },
    { slot_id: 'slot_05', beat_id: 'B6', role: 'body', decision: 'KEEP_DIALOGUE', start_sec: 200, end_sec: 220 },
    { slot_id: 'slot_closing', beat_id: 'B12', role: 'closing', decision: 'NARRATE', start_sec: 560, end_sec: 580 }
  ], beats, transcript);
  const payoff = out.find((item) => item.auto_hook_payoff === true);
  assert.ok(payoff, 'payoff slot built');
  assert.equal(payoff.replay_of_slot_id, 'slot_01');
  const lines = payoff.dialogue_line_windows.map((win) => win.line);
  assert.ok(lines.includes('I told you to run.'));
  assert.ok(lines.includes('Make a life for yourself.'));
  assert.ok(!lines.some((line) => line.includes('Pearl')), 'the hook line itself is not replayed');
  // The giant 27s cue must not become a 27s window.
  const farewell = payoff.dialogue_line_windows.find((win) => win.line.includes('Make a life'));
  assert.ok(farewell.end_sec - farewell.start_sec < 4, `word-estimated window, got ${(farewell.end_sec - farewell.start_sec).toFixed(2)}s`);
  // And it sits before the closing slot.
  assert.ok(out.findIndex((item) => item === payoff) < out.findIndex((item) => item.slot_id === 'slot_closing'));
});

test('a hook already paid gets no duplicate payoff', () => {
  const out = _test.buildHookPayoffIfMissing([
    { slot_id: 'slot_01', beat_id: 'B10', role: 'cold_open', decision: 'KEEP_DIALOGUE', dialogue_line_windows: [] },
    { slot_id: 'slot_09', beat_id: 'B10', role: 'payoff', decision: 'KEEP_DIALOGUE' }
  ], [{ beat_id: 'B10', start_sec: 0, end_sec: 10, key_dialogue: [] }], []);
  assert.equal(out.length, 2);
});

// Comprehension seams: no dialogue run longer than ~45s of played time without a re-anchor.
test('a long dialogue run gets a re-anchor seam at its widest source gap', () => {
  const mk = (id, start, end) => ({
    slot_id: id, beat_id: 'B1', role: 'body', decision: 'KEEP_DIALOGUE',
    start_sec: start, end_sec: end,
    dialogue_line_windows: [{ matched: true, line: 'x '.repeat(20).trim(), start_sec: start, end_sec: end }]
  });
  // Three 20s slots = 60s run; the widest gap (40s) sits between b and c.
  const out = _test.insertComprehensionSeams([
    mk('a', 100, 120), mk('b', 125, 145), mk('c', 185, 205)
  ], [{ beat_id: 'B1', start_sec: 90, end_sec: 210, summary: 'the confrontation continues' }]);
  const seam = out.find((item) => item.auto_seam === true);
  assert.ok(seam, 'seam inserted');
  assert.equal(out.indexOf(seam), 2, 'at the widest gap (between b and c)');
  assert.ok(seam.reason.includes('Re-anchor'), 'reason instructs a re-anchor');
});

test('a wall-to-wall scene with no honest gap gets no seam', () => {
  const mk = (id, start, end) => ({
    slot_id: id, beat_id: 'B1', role: 'body', decision: 'KEEP_DIALOGUE',
    start_sec: start, end_sec: end,
    dialogue_line_windows: [{ matched: true, line: 'y '.repeat(20).trim(), start_sec: start, end_sec: end }]
  });
  const out = _test.insertComprehensionSeams([
    mk('a', 100, 120), mk('b', 121, 141), mk('c', 142, 162)
  ], []);
  assert.ok(!out.some((item) => item.auto_seam === true), 'no seam without source room');
});

test('the protected peak gets a pre-peak seam when entered cold', () => {
  const mk = (id, start, end, extra = {}) => ({
    slot_id: id, beat_id: 'B1', role: 'body', decision: 'KEEP_DIALOGUE',
    start_sec: start, end_sec: end,
    dialogue_line_windows: [{ matched: true, line: 'short line here', start_sec: start, end_sec: end }],
    ...extra
  });
  const out = _test.insertComprehensionSeams([
    mk('a', 100, 106), mk('peak', 200, 215, { protected_peak: true, role: 'payoff' })
  ], [{ beat_id: 'B1', start_sec: 90, end_sec: 220, summary: 'the reveal' }]);
  const seam = out.find((item) => item.auto_seam === true);
  assert.ok(seam, 'pre-peak seam inserted');
  assert.equal(out.indexOf(seam), out.findIndex((item) => item.protected_peak === true) - 1, 'right before the peak');
  assert.ok(seam.reason.includes('UNRESOLVED'), 'the seam carries the suspension instruction');
});

test('a re-run never stacks a seam on an existing seam slot', () => {
  const mk = (id, start, end, extra = {}) => ({
    slot_id: id, beat_id: 'B1', role: 'body', decision: 'KEEP_DIALOGUE',
    start_sec: start, end_sec: end,
    dialogue_line_windows: [{ matched: true, line: 'y '.repeat(30).trim(), start_sec: start, end_sec: end }],
    ...extra
  });
  // slot_c_reanchor is a seam from a previous run that a later pass mutated into
  // dialogue (the allin regression): it may never become an anchor point again.
  const out = _test.insertComprehensionSeams([
    mk('a', 100, 125),
    mk('c_reanchor', 140, 168, { auto_seam: true }),
    mk('c', 180, 210)
  ], []);
  assert.ok(!out.some((item) => /_reanchor_reanchor$/.test(String(item.slot_id))), 'no stacked seam');
});

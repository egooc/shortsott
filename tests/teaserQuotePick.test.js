const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');
const { pickTeaserQuote } = _test;

// The old score was a question mark, a few Twilight-specific phrases, and raw length. On any
// other film only length counted, so the longest rambling line won: "Hi, Janice. I'm glad to see
// you, baby." opened the Senseless cut while the accusation sat in the middle.
test('an accusation beats a greeting', () => {
  const beat = {
    key_dialogue: [
      "Hi, Janice. I'm glad to see you, baby.",
      'You cheated on me with that piece of trash?'
    ]
  };
  assert.equal(pickTeaserQuote(beat), 'You cheated on me with that piece of trash?');
});

test('a long pleasantry does not beat a short denial', () => {
  const beat = {
    key_dialogue: [
      'Good morning, it is really very nice to see all of you here again today.',
      "I don't do heroin!"
    ]
  };
  assert.equal(pickTeaserQuote(beat), "I don't do heroin!");
});

test('a question still wins over a flat statement', () => {
  const beat = { key_dialogue: ['He went to the store.', 'What are they really?'] };
  assert.equal(pickTeaserQuote(beat), 'What are they really?');
});

test('a power line beats neutral description', () => {
  const beat = { key_dialogue: ['The room was quiet for a while.', 'I told you to stay away.'] };
  assert.equal(pickTeaserQuote(beat), 'I told you to stay away.');
});

test('a beat with no dialogue yields nothing', () => {
  assert.equal(pickTeaserQuote({ key_dialogue: [] }), '');
  assert.equal(pickTeaserQuote({}), '');
});

test('a single line is returned whatever it is', () => {
  assert.equal(pickTeaserQuote({ key_dialogue: ['Hello there.'] }), 'Hello there.');
});

// The cold open used anchor_dialogue in the order the beat listed it, so the opening line was
// whichever came first in the scene — a greeting — and pickTeaserQuote was never reached.
test('the cold open leads with the strongest anchor, not the earliest', () => {
  const { coldOpenDialogueFocusForBeat } = _test;
  const beat = {
    beat_id: 'b1', start_sec: 160, end_sec: 200, hook_potential: 5, dialogue_quality: 'high',
    key_dialogue: ["Hi, Janice. I'm glad to see you, baby.", 'You cheated on me with that piece of trash?'],
    anchor_dialogue: ["Hi, Janice. I'm glad to see you, baby.", 'You cheated on me with that piece of trash?']
  };
  const transcript = [
    { start_sec: 166.8, end_sec: 171.4, text: "Hi, Janice. I'm glad to see you, baby." },
    { start_sec: 171.5, end_sec: 174.2, text: 'You cheated on me with that piece of trash?' }
  ];
  const focus = coldOpenDialogueFocusForBeat(beat, transcript);
  assert.ok(focus, 'the beat should still yield a teaser');
  assert.equal(focus.quotes[0], 'You cheated on me with that piece of trash?');
});

test('a teaser keeps at most two lines', () => {
  const { coldOpenDialogueFocusForBeat } = _test;
  const beat = {
    beat_id: 'b2', start_sec: 10, end_sec: 40, hook_potential: 5, dialogue_quality: 'high',
    anchor_dialogue: ['You lied to me!', "I didn't do anything.", 'Hey, good morning everyone.']
  };
  const transcript = [
    { start_sec: 12, end_sec: 14, text: 'You lied to me!' },
    { start_sec: 15, end_sec: 17, text: "I didn't do anything." },
    { start_sec: 18, end_sec: 20, text: 'Hey, good morning everyone.' }
  ];
  const focus = coldOpenDialogueFocusForBeat(beat, transcript);
  assert.ok(focus);
  assert.equal(focus.quotes.length, 2);
  assert.ok(!focus.quotes.includes('Hey, good morning everyone.'), 'the pleasantry is dropped');
});

// The cold-open slot comes from the edit-plan model with its own dialogue_focus_lines, used
// verbatim, so scoring inside the beat helpers never reached it. finalizeEditPlan is the one
// place every plan passes through.
test('finalize opens the cut on the strongest line even when the model listed it second', () => {
  const { leadColdOpenWithStrongestLine } = _test;
  const timeline = [{
    slot_id: 'slot_001', role: 'cold_open', decision: 'KEEP_DIALOGUE',
    start_sec: 166.83, end_sec: 174.28,
    dialogue_focus_lines: ["Hi, Janice. I'm glad to see you, baby.", 'You cheated on me with that piece of trash?'],
    dialogue_focus_quotes: ["Hi, Janice. I'm glad to see you, baby.", 'You cheated on me with that piece of trash?'],
    dialogue_line_windows: [
      { matched: true, line: "Hi, Janice. I'm glad to see you, baby.", start_sec: 166.83, end_sec: 171.44 },
      { matched: true, line: 'You cheated on me with that piece of trash?', start_sec: 171.44, end_sec: 174.28 }
    ]
  }];
  const result = leadColdOpenWithStrongestLine(timeline);
  assert.equal(result[0].dialogue_focus_lines[0], 'You cheated on me with that piece of trash?');
  assert.equal(result[0].dialogue_line_windows.filter((w) => w.matched === true).length, 1);
  assert.equal(result[0].cold_open_reordered, true);
});

test('a cold open already leading with its strongest line is untouched', () => {
  const { leadColdOpenWithStrongestLine } = _test;
  const timeline = [{
    slot_id: 'slot_001', role: 'cold_open', decision: 'KEEP_DIALOGUE',
    dialogue_focus_lines: ['You lied to me!', 'I did not.'],
    dialogue_focus_quotes: ['You lied to me!', 'I did not.'],
    dialogue_line_windows: [
      { matched: true, line: 'You lied to me!', start_sec: 10, end_sec: 12 },
      { matched: true, line: 'I did not.', start_sec: 12.5, end_sec: 14 }
    ]
  }];
  const result = leadColdOpenWithStrongestLine(timeline);
  assert.equal(result[0].dialogue_focus_lines.length, 2);
  assert.ok(!result[0].cold_open_reordered);
});

test('a narrated cold open is left alone', () => {
  const { leadColdOpenWithStrongestLine } = _test;
  const timeline = [{ slot_id: '1', role: 'cold_open', decision: 'NARRATE', estimated_duration_sec: 5 }];
  assert.deepEqual(leadColdOpenWithStrongestLine(timeline), timeline);
});

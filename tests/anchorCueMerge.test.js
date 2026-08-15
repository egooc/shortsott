const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');
const { mergeAnchorCuesInTranscript } = _test;

// Auto-captions smear a signature line across several cues (repeats, prefixes, mid-word
// ellipses), so a beat anchor never exact-matches a cue and KEEP_DIALOGUE deadlocks. The
// merge collapses the run of cues that together contain the anchor into one clean cue.
test('a smeared anchor spanning several cues collapses into one anchor cue', () => {
  const beats = [{
    beat_id: 'b1', start_sec: 118, end_sec: 134,
    anchor_dialogue: ['today is not to the day you will die']
  }];
  const transcript = [
    { start_sec: 125.7, end_sec: 128.2, text: 'Defiance today is not to the day you' },
    { start_sec: 128.2, end_sec: 129.0, text: 'will' },
    { start_sec: 129.0, end_sec: 132.9, text: 'die of that I am sure you have the' }
  ];
  const out = mergeAnchorCuesInTranscript(transcript, beats);
  const anchorCue = out.find((c) => c.text === 'today is not to the day you will die');
  assert.ok(anchorCue, 'anchor cue exists as one cue');
  assert.equal(anchorCue.start_sec, 125.7);
  assert.equal(anchorCue.end_sec, 132.9);
});

test('a repeated-word smear still yields a single anchor cue', () => {
  const beats = [{ beat_id: 'b2', start_sec: 118, end_sec: 125, anchor_dialogue: ['such is life'] }];
  const transcript = [{ start_sec: 120.6, end_sec: 123.4, text: 'such is life such is life can you' }];
  const out = mergeAnchorCuesInTranscript(transcript, beats);
  assert.ok(out.some((c) => c.text === 'such is life'));
});

test('the merge takes the smallest span holding the anchor, not the earliest reachable start', () => {
  // Real failure (Draft Day, 2026-08-16): the scan merged from the EARLIEST cue that could still
  // reach the anchor within its 6-cue window, so four unrelated lines in front of it were swallowed
  // into the anchor cue. The dialogue window then opened 13s before the line was spoken and the
  // slot's other dialogue lines disappeared inside the merged cue.
  const beats = [{
    beat_id: 'b5', start_sec: 135, end_sec: 158,
    anchor_dialogue: ["Just to be clear here, you're threatening to fire me, right?"]
  }];
  const transcript = [
    { start_sec: 139.72, end_sec: 141.64, text: '>> You can help me by making a splash and' },
    { start_sec: 141.64, end_sec: 143.64, text: "if you can't do it, then" },
    { start_sec: 143.64, end_sec: 147.91, text: 'I have to do it and' },
    { start_sec: 147.92, end_sec: 152.91, text: "I don't want to have to do that, Sonny." },
    { start_sec: 152.92, end_sec: 153.76, text: ">> Just to be clear here, you're" },
    { start_sec: 153.76, end_sec: 157.949, text: 'threatening to fire me, right?' }
  ];
  const out = mergeAnchorCuesInTranscript(transcript, beats);
  const anchorCue = out.find((c) => c.text.startsWith('Just to be clear'));
  assert.ok(anchorCue, 'anchor cue exists');
  assert.equal(anchorCue.start_sec, 152.92, 'starts where the anchor is actually spoken');
  assert.equal(anchorCue.end_sec, 157.949);
  assert.ok(out.some((c) => c.text.includes('making a splash')), 'the preceding lines survive');
  assert.ok(out.some((c) => c.text.includes("don't want to have to do that")), 'and so does the line before the anchor');
});

test('an anchor already present as one cue is left untouched (idempotent)', () => {
  const beats = [{ beat_id: 'b3', start_sec: 0, end_sec: 10, anchor_dialogue: ['I am the one who knocks'] }];
  const transcript = [{ start_sec: 1, end_sec: 3, text: 'I am the one who knocks' }];
  const out = mergeAnchorCuesInTranscript(transcript, beats);
  assert.equal(out, transcript, 'no merge, same reference returned');
});

test('a transcript with no matching anchor is returned unchanged', () => {
  const beats = [{ beat_id: 'b4', start_sec: 0, end_sec: 10, anchor_dialogue: ['a line not in the cues'] }];
  const transcript = [{ start_sec: 1, end_sec: 3, text: 'completely different words here' }];
  const out = mergeAnchorCuesInTranscript(transcript, beats);
  assert.equal(out, transcript);
});

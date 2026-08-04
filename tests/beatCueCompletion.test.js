const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');
const { completeBeatDialogueFromCues } = _test;

// Beat extraction quoted a fragment of a cue and dropped the rest, so the man's reply to the
// order was gone before any slot could ask for it. Nothing downstream can recover material the
// beats never carried.
test('the rest of a partly-quoted cue is restored to the beat', () => {
  const beats = [{
    beat_id: 'beat_2', start_sec: 53.7, end_sec: 69.28,
    key_dialogue: ['just calm down', "I wasn't raising my voice okay"]
  }];
  const transcript = [
    { start_sec: 55.84, end_sec: 58.76, text: "to me sir I wasn't raising my voice okay" },
    { start_sec: 58.76, end_sec: 61.68, text: 'just calm down I I am gum I just want my' }
  ];
  const [beat] = completeBeatDialogueFromCues(beats, transcript);
  assert.equal(beat.key_dialogue.length, 3);
  assert.match(beat.key_dialogue[2], /I just want my/);
  assert.match(beat.key_dialogue[2], /^I I am/, 'the cue spelling is kept, not the normalised form');
});

test('a cue already quoted in full gains nothing', () => {
  const beats = [{ beat_id: 'b', start_sec: 0, end_sec: 10, key_dialogue: ['hello there friend'] }];
  const [beat] = completeBeatDialogueFromCues(beats, [{ start_sec: 1, end_sec: 3, text: 'hello there friend' }]);
  assert.deepEqual(beat.key_dialogue, ['hello there friend']);
});

test('a remainder too short to be a line is ignored', () => {
  const beats = [{ beat_id: 'b', start_sec: 0, end_sec: 10, key_dialogue: ['we need to leave right now'] }];
  const [beat] = completeBeatDialogueFromCues(beats, [{ start_sec: 1, end_sec: 4, text: 'we need to leave right now ok' }]);
  assert.deepEqual(beat.key_dialogue, ['we need to leave right now']);
});

test('cues outside the beat and sound effects are skipped', () => {
  const beats = [{ beat_id: 'b', start_sec: 0, end_sec: 10, key_dialogue: ['stay where you are'] }];
  const transcript = [
    { start_sec: 40, end_sec: 44, text: 'stay where you are and do not move at all' },
    { start_sec: 2, end_sec: 4, text: '[Music]' }
  ];
  const [beat] = completeBeatDialogueFromCues(beats, transcript);
  assert.deepEqual(beat.key_dialogue, ['stay where you are']);
});

test('a beat with no dialogue is untouched', () => {
  const beats = [{ beat_id: 'action', start_sec: 0, end_sec: 10, key_dialogue: [] }];
  assert.deepEqual(completeBeatDialogueFromCues(beats, [{ start_sec: 1, end_sec: 3, text: 'anything at all here' }])[0].key_dialogue, []);
});

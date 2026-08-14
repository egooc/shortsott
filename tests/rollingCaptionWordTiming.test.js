const assert = require('node:assert/strict');
const test = require('node:test');

const { parseVtt } = require('../server/services/midformCompressionService');

function cueContaining(cues, needle) {
  return cues.find((cue) => cue.text.toLowerCase().includes(needle));
}

test('a cue whose block start precedes its word-timing tags is snapped to when the words are spoken', () => {
  // The real failure: YouTube auto-caption dedup handed a line the timestamp of an earlier block it
  // rolled through, so the clip was cut ~15s before the words were actually spoken and played a
  // different scene under the caption. The per-word <timestamp> tags know the truth.
  const vtt = [
    'WEBVTT',
    '',
    '00:00:05.000 --> 00:00:30.000',
    '<00:00:25.000><c>The</c><00:00:25.300><c> crucial</c><00:00:25.600><c> quote</c><00:00:25.900><c> here</c>',
    ''
  ].join('\n');

  const cues = parseVtt(vtt);
  const cue = cueContaining(cues, 'crucial quote');
  assert.ok(cue, 'crucial quote cue exists');
  // Snapped forward from the 5.0 block start to ~25.0 where the words are tagged, not left at 5.0.
  assert.ok(cue.start_sec >= 24.5 && cue.start_sec <= 25.5, `start snapped to word tags, got ${cue.start_sec}`);
  assert.ok(cue.end_sec > cue.start_sec, 'end stays after start');
});

test('a cue whose words are tagged at its block start is left untouched', () => {
  // Guard must not disturb a normally-timed line: its first word tag already matches the block start,
  // so the < 1.5s gain never trips the snap.
  const vtt = [
    'WEBVTT',
    '',
    '00:00:40.000 --> 00:00:45.000',
    '<00:00:40.100><c>Perfectly</c><00:00:40.400><c> normal</c><00:00:40.700><c> line</c>',
    ''
  ].join('\n');

  const cues = parseVtt(vtt);
  const cue = cueContaining(cues, 'perfectly normal line');
  assert.ok(cue, 'normal cue exists');
  assert.ok(cue.start_sec >= 39.9 && cue.start_sec <= 40.2, `start unchanged, got ${cue.start_sec}`);
});

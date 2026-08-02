const assert = require('node:assert/strict');
const test = require('node:test');

const { parseVtt } = require('../server/services/midformCompressionService');

function vtt(blocks) {
  return `WEBVTT\n\n${blocks.map(([start, end, text]) => `${start} --> ${end}\n${text}`).join('\n\n')}\n`;
}

test('rolling auto-captions are collapsed so each cue holds only its new words', () => {
  // YouTube repeats the previous cue's tail and appends a few words. Without collapsing
  // them, no cue contains a whole sentence, so quoted dialogue matches nothing and the
  // scene gets narrated instead of preserved.
  const cues = parseVtt(vtt([
    ['00:00:10.000', '00:00:12.000', 'my dear dear Alice'],
    ['00:00:12.000', '00:00:14.000', 'my dear dear Alice we are glad'],
    ['00:00:14.000', '00:00:16.000', 'we are glad to see you here'],
    ['00:00:16.000', '00:00:18.000', 'I have evidence the child']
  ]));

  assert.deepEqual(cues.map((cue) => cue.text), [
    'my dear dear Alice',
    'we are glad',
    'to see you here',
    'I have evidence the child'
  ]);
  for (const cue of cues) assert.ok(cue.end_sec > cue.start_sec);
  for (let index = 1; index < cues.length; index += 1) {
    assert.ok(cues[index].start_sec >= cues[index - 1].start_sec, 'cues stay in order');
  }
});

test('a cue that only repeats the previous one extends it instead of adding a line', () => {
  const cues = parseVtt(vtt([
    ['00:00:10.000', '00:00:12.000', 'hold the line'],
    ['00:00:12.000', '00:00:15.000', 'hold the line']
  ]));
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'hold the line');
  assert.equal(cues[0].end_sec, 15);
});

test('ordinary non-rolling captions are left untouched', () => {
  const cues = parseVtt(vtt([
    ['00:00:10.000', '00:00:12.000', 'I have evidence.'],
    ['00:00:12.500', '00:00:15.000', 'It changes nothing.']
  ]));
  assert.deepEqual(cues.map((cue) => cue.text), ['I have evidence.', 'It changes nothing.']);
  assert.equal(cues[1].start_sec, 12.5);
});

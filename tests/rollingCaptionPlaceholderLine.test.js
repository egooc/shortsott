const assert = require('node:assert/strict');
const test = require('node:test');

const { parseVtt } = require('../server/services/midformCompressionService');

function cueContaining(cues, needle) {
  return cues.find((cue) => cue.text.toLowerCase().includes(needle));
}

// YouTube's rolling captions emit a block as: the already-settled line, then the line currently
// being spoken with per-word tags. When the settled slot is empty it is written as a line holding a
// single SPACE - not an empty line. Treating that placeholder as the end of the block threw away the
// tagged line, so the sentence only entered the transcript at the later 10ms "settle" block: the cue
// collapsed to 0.2s and sat seconds after the words were actually spoken. The clip built from it
// then played the wrong audio and the viewer heard only the tail of the line.
test('a whitespace-only placeholder line does not end the cue block', () => {
  const vtt = [
    'WEBVTT',
    '',
    '00:07:33.430 --> 00:07:33.440 align:start position:0%',
    ' ',
    ' ',
    '',
    '00:07:33.440 --> 00:07:35.870 align:start position:0%',
    ' ',
    '&gt;&gt; Just<00:07:33.600><c> made</c><00:07:33.720><c> a</c><00:07:33.760><c> trade</c><00:07:34.040><c> with</c><00:07:34.120><c> the</c><00:07:34.200><c> Seahawks.</c>',
    '',
    '00:07:35.870 --> 00:07:35.880 align:start position:0%',
    '&gt;&gt; Just made a trade with the Seahawks.',
    ' ',
    '',
    '00:07:35.880 --> 00:07:40.150 align:start position:0%',
    '&gt;&gt; Just made a trade with the Seahawks.',
    '&gt;&gt; For?',
    ''
  ].join('\n');

  const cues = parseVtt(vtt);
  const cue = cueContaining(cues, 'seahawks');
  assert.ok(cue, 'the spoken line survives parsing');
  // Spoken at 453.44 (07:33.44), not at the 455.87 settle block it used to be pinned to.
  assert.ok(cue.start_sec >= 453.3 && cue.start_sec <= 453.6, `start is when it was spoken, got ${cue.start_sec}`);
  assert.ok(cue.end_sec - cue.start_sec > 1, `cue keeps a speakable span, got ${(cue.end_sec - cue.start_sec).toFixed(2)}s`);

  const next = cueContaining(cues, 'for?');
  assert.ok(next, 'the following line still parses');
  assert.ok(next.start_sec >= cue.end_sec - 0.01, 'lines stay in order');
});

test('a whitespace-only separator between blocks does not swallow the next cue', () => {
  // Reading past the placeholder means the scan can arrive at the NEXT cue's timing line. Consuming
  // it there made that block parse as a continuation, and its lines disappeared from the transcript
  // entirely - the first cut of this fix silently ate three dialogue lines this way.
  const vtt = [
    'WEBVTT',
    '',
    '00:02:19.720 --> 00:02:21.640 align:start position:0%',
    'first spoken line',
    ' ',
    '00:02:21.640 --> 00:02:23.640 align:start position:0%',
    'second spoken line',
    ' ',
    '00:02:23.640 --> 00:02:27.910 align:start position:0%',
    'third spoken line',
    ''
  ].join('\n');

  const cues = parseVtt(vtt);
  for (const needle of ['first spoken line', 'second spoken line', 'third spoken line']) {
    assert.ok(cueContaining(cues, needle), `${needle} survives parsing`);
  }
  assert.ok(cueContaining(cues, 'second spoken line').start_sec >= 139.7, 'the second cue keeps its own start');
});

test('a truly empty line still ends the cue block', () => {
  const vtt = [
    'WEBVTT',
    '',
    '00:00:10.000 --> 00:00:12.000',
    'first line',
    '',
    '00:00:12.000 --> 00:00:14.000',
    'second line',
    ''
  ].join('\n');

  const cues = parseVtt(vtt);
  assert.equal(cues.length, 2, 'two separate cues');
  assert.equal(cues[0].text, 'first line');
  assert.equal(cues[1].text, 'second line');
});

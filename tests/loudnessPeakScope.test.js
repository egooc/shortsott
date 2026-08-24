const test = require('node:test');
const assert = require('node:assert');

const { _test } = require('../server/services/midformLocaleDraftService.js');
const { timecodeToSec, collectUsedSourceWindows } = _test;

test('timecodes parse in every shape the pipeline writes them', () => {
  assert.equal(timecodeToSec(12.5), 12.5);
  assert.equal(timecodeToSec('12.5'), 12.5);
  assert.equal(timecodeToSec('00:14.683'), 14.683);
  assert.equal(timecodeToSec('00:02:13.200'), 133.2);
  assert.equal(timecodeToSec('01:00:00'), 3600);
  assert.ok(Number.isNaN(timecodeToSec('')));
  assert.ok(Number.isNaN(timecodeToSec('abc')));
  assert.ok(Number.isNaN(timecodeToSec(null)));
});

test('the used-window list covers speech ranges, locale clips and scene clips', () => {
  const windows = collectUsedSourceWindows({
    segments: [
      { dialogue_speech_range_sec: [133.2, 136.218] },
      { source_clips: [{ start: '00:14.683', end: '00:26.080' }] },
      { source_scenes: [{ start: '00:02:13.200', end: '00:02:16.318' }] }
    ]
  });
  // the speech range and its scene clip abut/overlap and merge into one span
  assert.deepEqual(windows, [[14.683, 26.08], [133.2, 136.318]]);
});

test('abutting windows merge so a span is probed once', () => {
  const windows = collectUsedSourceWindows({
    segments: [
      { source_clips: [{ start: 10, end: 12 }, { start: 12.3, end: 14 }, { start: 20, end: 22 }] }
    ]
  });
  assert.deepEqual(windows, [[10, 14], [20, 22]]);
});

test('sub-frame slivers and unparseable clips are ignored', () => {
  const windows = collectUsedSourceWindows({
    segments: [
      { source_clips: [{ start: 5, end: 5.1 }, { start: 'x', end: 9 }, { start: 30, end: 31 }] }
    ]
  });
  assert.deepEqual(windows, [[30, 31]]);
});

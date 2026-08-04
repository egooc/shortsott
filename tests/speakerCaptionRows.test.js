const assert = require('node:assert/strict');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Captions used to run strictly serially on one track - 42 segments, zero overlaps, 41 butted
// end to end - so splitting them onto two rows changed nothing: nothing was ever simultaneous.
// Two lanes, each owning a text track: order only has to hold within a lane.
function probe(snippet) {
  const script = [
    'import importlib.util, sys, json',
    "spec = importlib.util.spec_from_file_location('cdraft', 'scripts/capcut_draft.py')",
    'm = importlib.util.module_from_spec(spec)',
    "sys.modules['cdraft'] = m",
    'try:',
    '    spec.loader.exec_module(m)',
    'except SystemExit:',
    '    pass',
    snippet
  ].join('\n');
  const out = execFileSync('python', ['-c', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

const lanesFor = (aliases) => probe([
  'import json as _j',
  `aliases = _j.loads(${JSON.stringify(JSON.stringify(aliases))})`,
  'entries = [{"caption_kind": ("narration" if a is None else "dialogue"), "speaker_alias": (a or "")} for a in aliases]',
  'lanes = m.assign_midform_speaker_rows(entries)',
  'base = m.MIDFORM_CAPTION_Y',
  'ys = [m.midform_caption_row_y(e["caption_kind"], l, base) for e, l in zip(entries, lanes)]',
  'print(_j.dumps({"base": base, "lanes": lanes, "ys": ys, "laneCount": len(m.MIDFORM_CAPTION_LANE_OFFSETS)}))'
].join('\n'));

test('narration shares its line with whoever answers, the opener sits below', () => {
  const r = lanesFor([null, 'A', 'B']);
  assert.equal(r.ys[0], r.base, 'narration keeps its line');
  assert.equal(r.lanes[1], 1, 'the first speaker of the exchange takes the lower lane');
  assert.equal(r.lanes[2], 0, 'the reply shares the narration line');
  assert.ok(r.ys[1] < r.base);
});

test('only two lanes exist however many speakers there are', () => {
  const r = lanesFor(['A', 'B', 'C', 'D', 'E']);
  assert.equal(r.laneCount, 2);
  assert.equal(new Set(r.ys).size, 2, `captions must not walk down the frame: ${r.ys}`);
});

test('consecutive lines from one person keep their lane', () => {
  const r = lanesFor(['A', 'A', 'B']);
  assert.equal(r.lanes[0], r.lanes[1]);
  assert.notEqual(r.lanes[1], r.lanes[2]);
});

test('narration resets the exchange so the next speaker opens again', () => {
  const r = lanesFor(['A', 'B', null, 'B', 'A']);
  assert.equal(r.lanes[2], 0, 'narration is always lane 0');
  assert.equal(r.lanes[3], 1, 'the first speaker after narration opens the new exchange');
  assert.equal(r.lanes[4], 0, 'and the next one answers on the narration line');
});

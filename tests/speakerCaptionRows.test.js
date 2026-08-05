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

// Lanes used to mean turn order, so a person moved rows between exchanges: the colour stayed
// right but the eye lost them mid-conversation. A lane belongs to a PERSON now.
test('a two-hander keeps each speaker on their own row throughout', () => {
  const r = lanesFor(['A', 'B', 'A', 'B', 'A']);
  assert.equal(r.lanes[0], r.lanes[2], 'A never moves');
  assert.equal(r.lanes[2], r.lanes[4]);
  assert.equal(r.lanes[1], r.lanes[3], 'B never moves');
  assert.notEqual(r.lanes[0], r.lanes[1], 'and they sit on different rows');
});

test('the speaker who opens an exchange takes the lower row', () => {
  const r = lanesFor([null, 'A', 'B']);
  assert.equal(r.ys[0], r.base, 'narration keeps its line');
  assert.equal(r.lanes[1], 1, 'the opener sits below');
  assert.equal(r.lanes[2], 0, 'the answer shares the narration line');
});

test('with three voices only the one who returns latest gives up its row', () => {
  // Two rows cannot hold three people, so somebody must move; look ahead so it is whoever
  // speaks again last, never someone still active in the exchange.
  const r = lanesFor(['A', 'B', 'C', 'C', 'B', 'A']);
  assert.equal(r.lanes[2], r.lanes[3], 'C, who speaks twice in a row, does not move');
  assert.equal(r.lanes[1], r.lanes[4], 'B keeps its row across the interruption');
});

test('only two lanes exist however many speakers there are', () => {
  const r = lanesFor(['A', 'B', 'C', 'D', 'E']);
  assert.equal(r.laneCount, 2);
  assert.equal(new Set(r.ys).size, 2, `captions must not walk down the frame: ${r.ys}`);
});


const assert = require('node:assert/strict');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Narration keeps the established caption line; dialogue uses the two rows under it, alternating
// as the speaker changes. Giving every speaker a fixed row walked the captions down the frame
// once a scene had four or five people in it.
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

const YS_FOR = (aliases) => probe([
  'import json as _j',
  `aliases = _j.loads(${JSON.stringify(JSON.stringify(aliases))})`,
  'entries = [{"caption_kind": ("narration" if a is None else "dialogue"), "speaker_alias": (a or "")} for a in aliases]',
  'rows = m.assign_midform_speaker_rows(entries)',
  'base = m.MIDFORM_CAPTION_Y',
  'ys = [m.midform_caption_row_y(e["caption_kind"], r, base) for e, r in zip(entries, rows)]',
  'print(json.dumps({"base": base, "ys": ys, "rowCount": len(m.MIDFORM_SPEAKER_ROW_OFFSETS)}))'
].join('\n'));

test('narration stays put and a reply lands opposite the line it answers', () => {
  const r = YS_FOR([null, 'A', 'B']);
  assert.equal(r.ys[0], r.base, 'narration must not move');
  assert.ok(r.ys[1] < r.base, 'dialogue sits below the narration line');
  assert.notEqual(r.ys[1], r.ys[2], 'the reply takes the other row');
});

test('only two rows are ever used, however many speakers there are', () => {
  const r = YS_FOR(['A', 'B', 'C', 'D', 'E', 'F']);
  assert.equal(r.rowCount, 2);
  assert.equal(new Set(r.ys).size, 2, `captions must not walk down the frame: ${r.ys}`);
});

test('consecutive lines from one person keep their row', () => {
  const r = YS_FOR(['A', 'A', 'B', 'A']);
  assert.equal(r.ys[0], r.ys[1], 'the same speaker does not jump rows');
  assert.notEqual(r.ys[1], r.ys[2], 'a new speaker flips');
  assert.notEqual(r.ys[2], r.ys[3], 'and flips back');
});

test('a dialogue caption with no speaker falls back to the base line', () => {
  const r = probe([
    'base = m.MIDFORM_CAPTION_Y',
    'print(json.dumps({"y": m.midform_caption_row_y("dialogue", None, base), "base": base}))'
  ].join('\n'));
  assert.equal(r.y, r.base);
});

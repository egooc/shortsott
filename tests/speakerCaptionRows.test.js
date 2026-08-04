const assert = require('node:assert/strict');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Two speakers talking at once used to force the plan to split slots, or one caption to be
// shifted off its line. Narration keeps the established caption line; each speaker gets a row
// beneath it, so a shared moment can show both rows at once.
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
  const out = execFileSync('python', ['-c', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8'
  });
  return JSON.parse(out.trim().split('\n').pop());
}

test('narration keeps the base line and each speaker gets a row below it', () => {
  const result = probe([
    'entries = [',
    '  {"caption_kind": "narration", "speaker_alias": ""},',
    '  {"caption_kind": "dialogue", "speaker_alias": "A"},',
    '  {"caption_kind": "dialogue", "speaker_alias": "B"},',
    '  {"caption_kind": "dialogue", "speaker_alias": "A"},',
    ']',
    'rows = m.assign_midform_speaker_rows(entries)',
    'base = m.MIDFORM_CAPTION_Y',
    'ys = [m.midform_caption_row_y(e["caption_kind"], rows.get(e["speaker_alias"]), base) for e in entries]',
    'print(json.dumps({"base": base, "ys": ys, "rows": rows}))'
  ].join('\n'));

  assert.equal(result.ys[0], result.base, 'narration must not move');
  assert.ok(result.ys[1] < result.base, 'a speaker row sits below the narration line');
  assert.notEqual(result.ys[1], result.ys[2], 'two speakers must not share a row');
  assert.equal(result.ys[1], result.ys[3], 'the same speaker keeps their row');
});

test('rows cycle when a scene has more speakers than rows', () => {
  const result = probe([
    'entries = [{"caption_kind": "dialogue", "speaker_alias": a} for a in ["A", "B", "C", "D"]]',
    'rows = m.assign_midform_speaker_rows(entries)',
    'base = m.MIDFORM_CAPTION_Y',
    'ys = [m.midform_caption_row_y("dialogue", rows[a], base) for a in ["A", "B", "C", "D"]]',
    'print(json.dumps({"ys": ys, "count": len(m.MIDFORM_SPEAKER_ROW_OFFSETS)}))'
  ].join('\n'));

  assert.equal(new Set(result.ys.slice(0, result.count)).size, result.count, 'every row is used first');
  assert.equal(result.ys[result.count], result.ys[0], 'only then does it wrap');
});

test('a dialogue caption with no speaker falls back to the base line', () => {
  const result = probe([
    'base = m.MIDFORM_CAPTION_Y',
    'print(json.dumps({"y": m.midform_caption_row_y("dialogue", None, base), "base": base}))'
  ].join('\n'));
  assert.equal(result.y, result.base);
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Caption units carried no timing at all, so capcut_draft.py divided each clip evenly by chunk
// count and laid the pieces end to end - which is why no two captions could ever share a moment,
// however many lanes existed.
function probe(snippet) {
  const script = [
    'import importlib.util, sys, json',
    "spec = importlib.util.spec_from_file_location('asm', 'midform/scripts/assemble_slot_draft_input.py')",
    'm = importlib.util.module_from_spec(spec)',
    "sys.modules['asm'] = m",
    'try:',
    '    spec.loader.exec_module(m)',
    'except SystemExit:',
    '    pass',
    snippet
  ].join('\n');
  const out = execFileSync('python', ['-c', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

const spansFor = (chunks, span) => probe([
  'import json as _j',
  `chunks = _j.loads(${JSON.stringify(JSON.stringify(chunks))})`,
  `span = _j.loads(${JSON.stringify(JSON.stringify(span))})`,
  'seg = {"dialogue_timing_adjustment": {"caption_speech_range_sec": span, "visual_range_sec": [span[0] - 0.5, span[1]]}}',
  'print(_j.dumps(m.caption_chunk_spans(seg, chunks)))'
].join('\n'));

// Owner doctrine (2026-08-08): chunk STARTS follow reading pace from the moment the line
// begins - never spread proportionally across the window, because auto-caption cues run far
// longer than the words and the later chunk then appears seconds after the voice stopped.
// The window length only bounds the tail: the LAST chunk holds to the window end.
test('chunk starts follow reading pace; the window only feeds the final hold', () => {
  const spans = spansFor(['첫 조각입니다', '두 번째 조각', '셋'], [10.0, 13.0]);
  assert.equal(spans.length, 3);
  assert.equal(spans[0][0], 10.0, 'the first chunk starts when the line does');
  assert.equal(spans[2][1], 13.0, 'the last chunk ends when the line does');
  assert.ok(spans[0][1] > spans[1][0] - 1e-6 && spans[0][1] <= spans[1][0] + 1e-6, 'chunks are contiguous');
  const readingSec = (text) => Math.max(0.6, text.length / 8);
  assert.ok(Math.abs(spans[1][0] - (10.0 + readingSec('첫 조각입니다'))) < 0.35,
    `second chunk must appear at reading pace, got ${spans[1][0]}`);
  assert.ok(spans[2][1] - spans[2][0] >= 0.6, 'the final chunk holds the remaining window');
});

test('chunks of one line never overlap each other', () => {
  const spans = spansFor(['가나다라마', '바사아자차', '카타파하'], [20.0, 26.0]);
  for (let i = 1; i < spans.length; i += 1) {
    assert.ok(spans[i][0] >= spans[i - 1][1] - 1e-6, `${JSON.stringify(spans[i])} overlaps ${JSON.stringify(spans[i - 1])}`);
  }
});

test('every chunk stays inside its own spoken window', () => {
  const spans = spansFor(['하나', '둘', '셋', '넷'], [5.0, 7.0]);
  for (const [start, end] of spans) {
    assert.ok(start >= 5.0 - 1e-6 && end <= 7.0 + 1e-6, `[${start},${end}] escaped the window`);
    assert.ok(end > start, 'a chunk must have positive duration');
  }
});

test('a segment with no timing falls back to the old behaviour', () => {
  const result = probe([
    'print(__import__("json").dumps(m.caption_chunk_spans({}, ["a", "b"])))'
  ].join('\n'));
  assert.deepEqual(result, [null, null]);
});

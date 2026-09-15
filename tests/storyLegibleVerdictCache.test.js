'use strict';

// story_legible re-rolls: pipeline-reference records the same sentences going PASS -> FAIL -> PASS
// across rebuild rounds with nothing in the cut changed, and 13 of 26 non-visual acceptance
// failures name this gate. The frame judge already solved the same problem with a pass-only
// verdict cache; this asserts story_legible now caches on the same terms.

const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVICE = path.join(__dirname, '..', 'server', 'services', 'midformRunArtifactsService.js');

function workspaceWith(narration) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storycache-'));
  const draftDir = path.join(dir, 'draft_ko');
  fs.mkdirSync(draftDir, { recursive: true });
  fs.writeFileSync(path.join(draftDir, 'edit_manifest.json'), JSON.stringify({
    total_video_duration_sec: 60,
    segments: narration.map((text, index) => ({
      segment_id: `slot_${index}`, caption_id: `c${index}`, segment_type: 'recap',
      caption_kind: 'narration', tts_enabled: true, narration: text,
      timeline_start_sec: index * 5, timeline_end_sec: index * 5 + 5, duration_sec: 5
    }))
  }), 'utf8');
  return { dir, draftDir };
}

test('the cache keys on the shipped text, so an edit always gets a fresh judgment', () => {
  const source = fs.readFileSync(SERVICE, 'utf8');
  const start = source.indexOf('const shippedNarrationDigest =');
  assert.ok(start > 0, 'shippedNarrationDigest must exist');
  const body = source.slice(start, source.indexOf('\n  try {', start));
  const digestOf = new Function('fs', 'path', 'crypto', 'readJson',
    `${body} return shippedNarrationDigest;`)(fs, path, require('crypto'),
    (file) => JSON.parse(fs.readFileSync(file, 'utf8')));

  const a = workspaceWith(['그는 문을 연다.', '안에는 아무도 없다.']);
  const same = workspaceWith(['그는 문을 연다.', '안에는 아무도 없다.']);
  const edited = workspaceWith(['그는 문을 연다.', '안에는 시체가 있었다.']);

  assert.strictEqual(digestOf(a.draftDir), digestOf(same.draftDir),
    'identical shipped text must reuse the verdict');
  assert.notStrictEqual(digestOf(a.draftDir), digestOf(edited.draftDir),
    'a rewritten sentence must be judged again');
  assert.strictEqual(digestOf(workspaceWith([]).draftDir), '',
    'an empty cut is never cached');

  for (const w of [a, same, edited]) fs.rmSync(w.dir, { recursive: true, force: true });
});

test('only PASS is written to the cache', () => {
  const source = fs.readFileSync(SERVICE, 'utf8');
  assert.ok(/if \(digest && entry\.verdict === 'PASS'\)/.test(source),
    'a FAIL verdict must never be cached - fixed text has to be re-judged');
  assert.ok(/if \(cached && cached\.verdict === 'PASS'\)/.test(source),
    'only a cached PASS may short-circuit the judge');
});

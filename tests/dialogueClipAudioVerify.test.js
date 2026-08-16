const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'midform', 'scripts', 'verify_dialogue_clips.js');

function run(manifest, alignment) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipverify-'));
  const manifestPath = path.join(dir, 'edit_manifest.json');
  const alignmentPath = path.join(dir, 'alignment.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(alignmentPath, JSON.stringify(alignment));
  const result = spawnSync(process.execPath, [SCRIPT, manifestPath, alignmentPath], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const clip = (id, start, end) => ({
  segment_id: id,
  source_utterance_id: id,
  segment_type: 'dialogue_quote',
  source_clips: [{ start, end }],
});

const line = (uttId, text, words, extra = {}) => ({
  utt_id: uttId,
  line: text,
  status: 'aligned',
  start_sec: words[0].s,
  end_sec: words[words.length - 1].e,
  confident_word_ratio: 1,
  weak_tokens: false,
  ambiguous: false,
  words,
  ...extra,
});

test('a clip that opens after its line is over fails', () => {
  // The owner's original report: the scene shows someone speaking, but the clip starts once the
  // words are already gone, so only the tail is audible and the caption has to be guessed.
  const { status, out } = run(
    { segments: [clip('slot_01_L01', '00:00:10.000', '00:00:12.000')] },
    { lines: [line('slot_01_L01', 'I told you to run', [
      { w: 'i', s: 6.0, e: 6.2 }, { w: 'told', s: 6.3, e: 6.6 },
      { w: 'you', s: 6.7, e: 6.9 }, { w: 'to', s: 7.0, e: 7.1 }, { w: 'run', s: 7.2, e: 7.6 },
    ])] },
  );
  assert.equal(status, 1, 'exits non-zero so a caller can gate on it');
  assert.match(out, /FAIL containment slot_01_L01/);
});

test('a line finished by the next clip is not a defect', () => {
  // Back-to-back exchanges are cut so the next clip carries the rest of the line. Judging each clip
  // alone made every rapid-fire scene look broken.
  const { status, out } = run(
    {
      segments: [
        clip('slot_02_L01', '00:00:05.900', '00:00:06.900'),
        clip('slot_02_L02', '00:00:06.900', '00:00:08.000'),
      ],
    },
    {
      lines: [
        line('slot_02_L01', 'we need to talk about it', [
          { w: 'we', s: 6.0, e: 6.2 }, { w: 'need', s: 6.3, e: 6.6 },
          { w: 'to', s: 6.7, e: 6.8 }, { w: 'talk', s: 7.0, e: 7.3 },
          { w: 'about', s: 7.4, e: 7.6 }, { w: 'it', s: 7.7, e: 7.9 },
        ]),
        line('slot_02_L02', 'not now', [{ w: 'not', s: 7.95, e: 7.98 }]),
      ],
    },
  );
  assert.equal(status, 0);
  assert.doesNotMatch(out, /FAIL \w+ slot/, 'no finding is raised (the summary line always prints a FAIL count)');
});

test('a boundary inside a word is reported as a mid-word cut', () => {
  const { status, out } = run(
    { segments: [clip('slot_03_L01', '00:00:06.000', '00:00:07.150')] },
    { lines: [line('slot_03_L01', 'stop pretending', [
      { w: 'stop', s: 6.0, e: 6.4 }, { w: 'pretending', s: 6.5, e: 7.4 },
    ])] },
  );
  assert.equal(status, 0, 'a chopped syllable is a warning, not a gate failure');
  assert.match(out, /mid_word_cut slot_03_L01.*pretending/);
});

test('two clips replaying the same audio fail', () => {
  const { status, out } = run(
    {
      segments: [
        clip('slot_04_L01', '00:00:06.000', '00:00:09.000'),
        clip('slot_04_L02', '00:00:07.000', '00:00:10.000'),
      ],
    },
    {
      lines: [
        line('slot_04_L01', 'say that again', [
          { w: 'say', s: 6.1, e: 6.4 }, { w: 'that', s: 6.5, e: 6.8 }, { w: 'again', s: 6.9, e: 7.4 },
        ]),
        line('slot_04_L02', 'i said what i said', [
          { w: 'i', s: 7.5, e: 7.7 }, { w: 'said', s: 7.8, e: 8.1 },
          { w: 'what', s: 8.2, e: 8.5 }, { w: 'i', s: 8.6, e: 8.7 }, { w: 'said', s: 8.8, e: 9.4 },
        ]),
      ],
    },
  );
  assert.equal(status, 1);
  assert.match(out, /duplicate_audio/);
});

test('alignment we do not trust never accuses the plan', () => {
  // Low-confidence, ambiguous and two-word alignments have all been caught pointing at a repeat of
  // the same phrase elsewhere in the source. They may warn; they may not fail a build.
  const { status, out } = run(
    { segments: [clip('slot_05_L01', '00:00:10.000', '00:00:12.000')] },
    { lines: [line('slot_05_L01', 'thirty million', [
      { w: 'thirty', s: 6.0, e: 6.4 }, { w: 'million', s: 6.5, e: 6.9 },
    ], { confident_word_ratio: 0.4, ambiguous: true, weak_tokens: true })] },
  );
  assert.equal(status, 0);
  assert.doesNotMatch(out, /FAIL \w+ slot/, 'no finding is raised (the summary line always prints a FAIL count)');
});

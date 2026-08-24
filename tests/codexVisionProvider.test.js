const test = require('node:test');
const assert = require('node:assert');

const gemini = require('../server/services/geminiMidformService');
const codex = require('../server/services/gptMidformCliService');

test('the provider defaults to vertex so nothing changes until it is set', () => {
  const before = process.env.MIDFORM_VISION_LLM;
  delete process.env.MIDFORM_VISION_LLM;
  try {
    assert.equal(gemini.visionProvider(), 'vertex');
  } finally {
    if (before === undefined) delete process.env.MIDFORM_VISION_LLM;
    else process.env.MIDFORM_VISION_LLM = before;
  }
});

test('the switch is case and whitespace tolerant - an env var is typed by a human', () => {
  const before = process.env.MIDFORM_VISION_LLM;
  try {
    process.env.MIDFORM_VISION_LLM = '  Codex ';
    assert.equal(gemini.visionProvider(), 'codex');
  } finally {
    if (before === undefined) delete process.env.MIDFORM_VISION_LLM;
    else process.env.MIDFORM_VISION_LLM = before;
  }
});

// The brief was tuned line by line against real misjudgements. Both providers must read the same
// words, or they are different judges and the difference shows up as drifting verdicts.
test('the frame-judge brief is one shared text, not a per-provider copy', () => {
  const brief = gemini.buildFrameJudgeInstructions('벨라가 달려듭니다');
  assert.ok(brief.length > 3000, 'the tuned brief should not have been trimmed');
  assert.match(brief, /Default to MATCH/);
  assert.match(brief, /suggested_rewrite/);
});

test('the brief tells the model which language to answer in', () => {
  assert.match(gemini.buildFrameJudgeInstructions('벨라가 달려듭니다'), /write suggested_rewrite in Korean/);
  assert.match(gemini.buildFrameJudgeInstructions('ベラが襲いかかる'), /write suggested_rewrite in Japanese/);
  assert.match(gemini.buildFrameJudgeInstructions('Bella lunges'), /write suggested_rewrite in the original language/);
});

// Dialogue is taken from the transcript, never read off the screen by the model: a paraphrase here
// would end up under every downstream check that compares narration to what was said.
test('scene dialogue comes from transcript rows that overlap the window', () => {
  const transcript = [
    { start_sec: 1, end_sec: 3, text: '첫 줄', id: 'u1' },
    { start_sec: 8, end_sec: 9, text: '둘째', id: 'u2' }
  ];
  assert.deepEqual(codex.dialogueForWindow(transcript, 0, 7), { text: '첫 줄', utt_refs: ['u1'] });
  assert.deepEqual(codex.dialogueForWindow(transcript, 7, 14), { text: '둘째', utt_refs: ['u2'] });
});

test('a window with no speech gets an empty string, not a guess', () => {
  const transcript = [{ start_sec: 1, end_sec: 3, text: '첫 줄', id: 'u1' }];
  assert.deepEqual(codex.dialogueForWindow(transcript, 30, 37), { text: '', utt_refs: [] });
});

test('a line straddling the window boundary is included', () => {
  const transcript = [{ start_sec: 6.5, end_sec: 7.5, text: '걸친 줄', id: 'u1' }];
  assert.equal(codex.dialogueForWindow(transcript, 0, 7).text, '걸친 줄');
  assert.equal(codex.dialogueForWindow(transcript, 7, 14).text, '걸친 줄');
});

test('rows without usable timing are skipped rather than crashing the map', () => {
  const transcript = [{ text: 'no timing' }, { start_sec: 1, end_sec: 2, text: '있음', id: 'u1' }];
  assert.equal(codex.dialogueForWindow(transcript, 0, 7).text, '있음');
});

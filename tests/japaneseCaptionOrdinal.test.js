const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformLocaleDraftService');

// The _L number counts planned lines including the ones that never matched a cue, while the caption
// list holds one entry per line that plays. Reading captions by the raw _L number ran off the end of
// the list and the whole Japanese locale was skipped (Housemaid night slot_06_L07, slot_07_L07).
const baseScript = {
  segments: [
    { segment_id: 'slot_06_L01', segment_type: 'dialogue_quote', caption_text: '첫 줄', tts_enabled: false },
    { segment_id: 'slot_06_L07', segment_type: 'dialogue_quote', caption_text: '마지막 줄', tts_enabled: false }
  ]
};

test('a dialogue segment reads its caption by ordinal, not by the L number', () => {
  const fills = { slot_fills: [{ slot_id: 'slot_06', caption_kr_dialogue: ['一行目', '最後の行'] }] };
  const script = _test.buildJapaneseScript(baseScript, fills);
  assert.deepEqual(script.segments.map((segment) => segment.caption_text), ['一行目', '最後の行']);
});

test('a genuinely untranslated line is still reported', () => {
  const fills = { slot_fills: [{ slot_id: 'slot_06', caption_kr_dialogue: ['一行目', ''] }] };
  assert.throws(() => _test.buildJapaneseScript(baseScript, fills), /missing text/);
});

test('a ko-empty dialogue line may stay empty in ja', () => {
  const script = _test.buildJapaneseScript(
    { segments: [{ segment_id: 'slot_06_L01', segment_type: 'dialogue_quote', caption_text: '', tts_enabled: false }] },
    { slot_fills: [{ slot_id: 'slot_06', caption_kr_dialogue: [''] }] }
  );
  assert.equal(script.segments[0].caption_text, '');
});

// A KEEP_DIALOGUE slot can still leave an empty narration segment in the ko script; treating that as
// untranslated skipped the entire Japanese locale over a segment with nothing in it.
test('an empty ko narration segment does not skip the locale', () => {
  const script = _test.buildJapaneseScript(
    { segments: [{ segment_id: 'slot_01', segment_type: 'recap', narration: '', caption_text: '' }] },
    { slot_fills: [{ slot_id: 'slot_01', narration: '', caption_kr: '' }] }
  );
  assert.equal(script.segments[0].narration, '');
});

test('a ko narration with text still demands a ja translation', () => {
  assert.throws(() => _test.buildJapaneseScript(
    { segments: [{ segment_id: 'slot_02', segment_type: 'recap', narration: '그날 밤이었습니다.', caption_text: '그날 밤이었습니다.' }] },
    { slot_fills: [{ slot_id: 'slot_02', narration: '', caption_kr: '' }] }
  ), /missing text/);
});

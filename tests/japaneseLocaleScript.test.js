const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformLocaleDraftService');
const { buildJapaneseScript } = _test;

function baseScript() {
  return {
    script_id: 'compression_bootstrap',
    title_block: { full_title: '증거도 소용없던 전쟁', overlay_title: { top: '증거 제시', bottom: '전쟁 시작' } },
    metadata: { title_candidates: ['증거도 소용없던 전쟁'] },
    segments: [
      { segment_id: '1', segment_type: 'scene_hook', narration: '', caption_text: '', tts_enabled: false },
      { segment_id: '2', segment_type: 'recap', narration: '두 세력이 대치합니다.', caption_text: '두 세력이 대치합니다.', tts_enabled: true },
      { segment_id: '3_L01', segment_type: 'dialogue_quote', parent_slot_id: '3', translated_caption_ko: '소용없겠군요.', caption_text: '소용없겠군요.', tts_enabled: false },
      { segment_id: '3_L02', segment_type: 'dialogue_quote', parent_slot_id: '3', translated_caption_ko: '결정은 안 바뀝니다.', caption_text: '결정은 안 바뀝니다.', tts_enabled: false }
    ]
  };
}

function japaneseFills() {
  return {
    slot_fills: [
      { slot_id: '2', narration: '二つの勢力がにらみ合います。', caption_kr: '二つの勢力がにらみ合います。', caption_units: [] },
      { slot_id: '3', narration: '', caption_kr: '', caption_units: [], caption_kr_dialogue: ['見せても無駄でしょう。', '決断は変わらない。'] }
    ],
    upload_text: {
      title_candidates: ['証拠すら止められなかった戦いの理由', 'なぜ彼は退かなかったのか？', '最後の対決の結末'],
      overlay_title: { top: '証拠提示', bottom: '開戦' },
      description: '説明文です。',
      pinned_comment: '固定コメントです。'
    }
  };
}

test('buildJapaneseScript replaces narration and dialogue captions with Japanese', () => {
  const script = buildJapaneseScript(baseScript(), japaneseFills());
  const byId = Object.fromEntries(script.segments.map((segment) => [segment.segment_id, segment]));

  assert.equal(script.locale, 'ja');
  assert.equal(byId['2'].narration, '二つの勢力がにらみ合います。');
  assert.equal(byId['2'].caption_text, '二つの勢力がにらみ合います。');
  // Each dialogue line takes its own caption from the matching index, not the whole slot.
  assert.equal(byId['3_L01'].caption_text, '見せても無駄でしょう。');
  assert.equal(byId['3_L02'].caption_text, '決断は変わらない。');
  assert.equal(byId['3_L01'].translated_caption_ko, '見せても無駄でしょう。');
});

test('buildJapaneseScript leaves the wordless scene hook untouched', () => {
  const script = buildJapaneseScript(baseScript(), japaneseFills());
  const hook = script.segments.find((segment) => segment.segment_id === '1');
  assert.equal(hook.narration, '');
  assert.equal(hook.caption_text, '');
  assert.equal(hook.tts_enabled, false);
});

test('buildJapaneseScript carries the Japanese title block through', () => {
  const script = buildJapaneseScript(baseScript(), japaneseFills());
  assert.equal(script.title_block.overlay_title.top, '証拠提示');
  assert.equal(script.title_block.overlay_title.bottom, '開戦');
  assert.equal(script.title_block.full_title, '証拠すら止められなかった戦いの理由');
  assert.equal(script.metadata.title_candidates.length, 3);
});

test('buildJapaneseScript refuses to ship a script with untranslated slots', () => {
  // A missing slot would silently leave Korean text in the "Japanese" cut, which is the
  // exact failure this locale had before.
  const fills = japaneseFills();
  fills.slot_fills = fills.slot_fills.filter((fill) => fill.slot_id !== '2');
  assert.throws(() => buildJapaneseScript(baseScript(), fills), /missing text for segments/);

  const blankDialogue = japaneseFills();
  blankDialogue.slot_fills[1].caption_kr_dialogue = ['見せても無駄でしょう。'];
  assert.throws(() => buildJapaneseScript(baseScript(), blankDialogue), /missing text for segments/);
});

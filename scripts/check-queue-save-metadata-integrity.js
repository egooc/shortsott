const fs = require('fs');
const path = require('path');
const {
  QUEUE_ROOT,
  addQueueItem,
  saveQueue,
  removeQueueItem
} = require('../server/services/processQueueService');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readItemConfig(itemId) {
  const configPath = path.join(QUEUE_ROOT, itemId, 'item_config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function makeMetadata(locale) {
  return {
    detected_subject: locale === 'ko-KR' ? 'Korean process' : 'Japanese process',
    scene_transitions: [
      {
        scene_id: 'scene_001',
        start_sec: 0,
        end_sec: 4,
        transition_at_sec: 4,
        visual_summary: 'structured scene'
      }
    ],
    shortform_candidate_windows: [
      { rank: 1, start_sec: 1, end_sec: 9, hook: 'structured hook' }
    ],
    highlight_candidates: [
      { rank: 1, scene_id: 'scene_001', semantic_key: 'structured-candidate' }
    ],
    recommended_highlight_window: {
      start_sec: 1,
      end_sec: 9,
      selected_scene_ids: ['scene_001']
    },
    highlight_metadata_ja: {
      upload_title: '構造化タイトル',
      caption: '構造化キャプション'
    },
    highlight_metadata_ko: {
      upload_title: '구조화 제목',
      caption: '구조화 캡션'
    }
  };
}

function makeItem(itemId, locale) {
  const guide = makeMetadata(locale);
  return {
    item_id: itemId,
    target_locale: locale,
    source_video: 'source_clean.mp4',
    source_url: `https://example.test/${itemId}`,
    upload_title: `${itemId} source title`,
    metadata_status: 'success',
    metadata_generated_at: '2026-08-01T00:00:00.000Z',
    analysis_status: 'success',
    ottogi_guide_output: guide,
    gemini_scene_transitions: guide.scene_transitions,
    shortform_candidate_windows: guide.shortform_candidate_windows,
    highlight_candidates: guide.highlight_candidates,
    recommended_highlight_window: guide.recommended_highlight_window,
    highlight_metadata_ja: guide.highlight_metadata_ja,
    highlight_metadata_ko: guide.highlight_metadata_ko
  };
}

function protectedSnapshot(config) {
  return {
    ottogi_guide_output: config.ottogi_guide_output,
    gemini_scene_transitions: config.gemini_scene_transitions,
    shortform_candidate_windows: config.shortform_candidate_windows,
    highlight_candidates: config.highlight_candidates,
    recommended_highlight_window: config.recommended_highlight_window,
    highlight_metadata_ja: config.highlight_metadata_ja,
    highlight_metadata_ko: config.highlight_metadata_ko,
    metadata_status: config.metadata_status,
    metadata_generated_at: config.metadata_generated_at,
    analysis_status: config.analysis_status
  };
}

function run() {
  const suffix = `${Date.now()}_${process.pid}`;
  const itemIds = [`queue_save_jp_${suffix}`, `queue_save_ko_${suffix}`, `queue_save_new_${suffix}`];

  try {
    const jp = makeItem(itemIds[0], 'ja-JP');
    const ko = makeItem(itemIds[1], 'ko-KR');
    addQueueItem({ item_id: jp.item_id, item_config: jp });
    addQueueItem({ item_id: ko.item_id, item_config: ko });

    const jpBefore = readItemConfig(jp.item_id);
    const koBefore = readItemConfig(ko.item_id);

    saveQueue({
      queue_items: [
        {
          item_id: jp.item_id,
          target_locale: 'ko-KR',
          ottogi_guide_output: {},
          highlight_candidates: null,
          metadata_status: ''
        },
        {
          item_id: ko.item_id,
          target_locale: 'ja-JP'
        }
      ]
    });

    const jpAfter = readItemConfig(jp.item_id);
    const koAfter = readItemConfig(ko.item_id);
    assert(jpAfter.target_locale === 'ko-KR', 'JP item locale patch was not applied');
    assert(koAfter.target_locale === 'ja-JP', 'KO item locale patch was not applied');
    assert(JSON.stringify(protectedSnapshot(jpAfter)) === JSON.stringify(protectedSnapshot(jpBefore)), 'JP metadata changed during stale save');
    assert(JSON.stringify(protectedSnapshot(koAfter)) === JSON.stringify(protectedSnapshot(koBefore)), 'KO metadata changed during stale save');

    saveQueue({
      queue_items: [
        { item_id: jp.item_id, target_locale: 'ja-JP', ottogi_guide_output: null },
        { item_id: ko.item_id, target_locale: 'ko-KR', ottogi_guide_output: {} }
      ]
    });
    const repeatedJp = readItemConfig(jp.item_id);
    const repeatedKo = readItemConfig(ko.item_id);
    assert(JSON.stringify(protectedSnapshot(repeatedJp)) === JSON.stringify(protectedSnapshot(jpBefore)), 'JP metadata changed after repeated locale save');
    assert(JSON.stringify(protectedSnapshot(repeatedKo)) === JSON.stringify(protectedSnapshot(koBefore)), 'KO metadata changed after repeated locale save');

    saveQueue({
      queue_items: [
        { item_id: itemIds[2], target_locale: 'ja-JP' }
      ]
    });
    const newItem = readItemConfig(itemIds[2]);
    assert(newItem.target_locale === 'ja-JP', 'new item was not created through queue save');
    assert(!newItem.ottogi_guide_output, 'new item unexpectedly received metadata');

    console.log('PASS queue save metadata integrity: dynamic item_config persistence verified');
  } finally {
    for (const itemId of itemIds) {
      removeQueueItem(itemId);
    }
  }
}

try {
  run();
} catch (error) {
  console.error(`FAIL queue save metadata integrity: ${error.message}`);
  process.exitCode = 1;
}

const fs = require('fs');
const path = require('path');
const {
  __test: queueTest
} = require('../server/services/processQueueService');
const {
  __test: metadataTest
} = require('../server/services/processMetadataService');
const {
  __test: uploadTest
} = require('../server/services/youtubeUploadService');

const root = path.resolve(__dirname, '..');
const uploadProfilesPath = path.join(root, 'server', 'data', 'youtube_upload_profiles.json');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assertContains(file, text, message) {
  const source = read(file);
  if (!source.includes(text)) {
    throw new Error(`${message}\nMissing in ${file}: ${text}`);
  }
}

function assertNotContains(file, text, message) {
  const source = read(file);
  if (source.includes(text)) {
    throw new Error(`${message}\nForbidden in ${file}: ${text}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function shortformMixedItem() {
  return {
    item_id: 'shortform_mixed_contract',
    target_duration_sec: 39,
    video_metadata: { duration_sec: 39 },
    ottogi_guide_output: {
      shortform_candidate_windows: [
        {
          window_id: 'full_cycle_bad_candidate',
          start_sec: 0,
          end_sec: 39,
          duration_sec: 39,
          hook_score: 99,
          purpose: 'FULL_CYCLE_REPETITIVE',
          process_coverage: 'FULL_PROCESS',
          selected_scene_ids: ['scene_01']
        }
      ],
      scene_transitions: [
        {
          scene_id: 'scene_01',
          start_sec: 0,
          end_sec: 10,
          transition_at_sec: 10,
          visual_summary: 'opening setup',
          visual_hook_score: 3,
          repetition_potential: 3,
          motion_intensity: 'low'
        },
        {
          scene_id: 'scene_02',
          start_sec: 20,
          end_sec: 24,
          transition_at_sec: 22,
          visual_summary: 'pressing impact hook',
          visual_hook_score: 10,
          repetition_potential: 9,
          motion_intensity: 'high',
          change_type: 'action_change'
        }
      ]
    }
  };
}

function shortformWithGeminiHook() {
  const item = shortformMixedItem();
  item.ottogi_guide_output.hook_clip_10s = {
    start_sec: 20,
    end_sec: 24,
    duration_sec: 4,
    visual_hook: 'pressing impact hook',
    why_this_clip: 'strongest hand-machine impact moment',
    selected_scene_ids: ['scene_02']
  };
  item.ottogi_guide_output.recommended_highlight_window = {
    start_sec: 20,
    end_sec: 24,
    duration_sec: 4,
    selected_scene_ids: ['scene_02']
  };
  return item;
}

function testShortformHighlightUsesSingleHookScene() {
  const window = queueTest.pickHighlightWindow(shortformWithGeminiHook(), 10);
  assert(window.single_process_only === true, 'Shortform JP Highlight must force single_process_only.');
  assert(window.selection_strategy === 'gemini_single_process_visual_hook_window', 'Shortform JP Highlight must use Gemini best-hook strategy when Gemini provides one.');
  assert(window.selected_scene_ids.length === 1 && window.selected_scene_ids[0] === 'scene_02', 'Shortform JP Highlight must choose the strongest hook scene, not a full-cycle candidate.');
  assert(window.start_sec === 20 && window.end_sec === 24, 'Shortform JP Highlight must preserve Gemini best-hook timestamps.');
  assert(window.duration_sec <= 10, 'Shortform JP Highlight must stay within the highlight duration cap.');
}

function testShortformHighlightRejectsFullCycleCandidates() {
  const windows = queueTest.pickHighlightWindows(shortformWithGeminiHook(), 10, 2);
  assert(windows.length >= 1, 'Shortform JP Highlight should still find at least one valid hook window.');
  assert(windows.every((window) => window.duration_sec < 39), 'Full-cycle process windows must not be returned as JP Highlight candidates.');
  assert(windows.every((window) => window.single_process_only === true), 'JP Highlight candidate windows must stay single-process only.');
}

function testShortformHighlightValidationRequiresGeminiBestHook() {
  const guide = {
    source_type: 'shortform',
    source_workflow_mode: 'shortform_direct',
    target_duration_sec: 39,
    short_description_ko: '뜨거운 쇠를 두드리는 단조 공정입니다.',
    recommended_titles_ko: Array.from({ length: 5 }, (_, index) => ({ title: `단조 공정 ${index + 1} #worker #process #metalworking #forging #manufacturing`, hashtags: ['#worker', '#process', '#metalworking', '#forging', '#manufacturing'] })),
    report_description_ko: '## 1. 작업 개요\n뜨거운 쇠를 두드리는 단조 공정입니다.',
    explainer_text_ko: '뜨거운 쇠를 반복해서 두드려 형태와 강도를 만드는 과정입니다.',
    highlight_metadata: {
      variant_type: 'highlight',
      caption_mode: 'long_bottom_explainer',
      onscreen_caption_block: '熱い鉄を力強く叩き、形が変わる瞬間を見せるハイライトです。火花と金属の動きが短い時間で伝わる見どころです。'
    },
    highlight_metadata_ko: {
      variant_type: 'highlight',
      caption_mode: 'long_bottom_explainer',
      onscreen_caption_block: '뜨거운 쇠를 강하게 두드려 형태가 바뀌는 순간을 보여주는 하이라이트입니다.'
    },
    scene_transitions: shortformMixedItem().ottogi_guide_output.scene_transitions
  };
  let threw = false;
  try {
    metadataTest.validateGuide(guide, {
      skipFullValidation: true,
      skipHighlightValidation: false,
      skipMidformValidation: true
    });
  } catch (error) {
    threw = Array.isArray(error.details?.missing)
      && error.details.missing.includes('missing_standard_shortform_best_hook_window');
  }
  assert(threw, 'Standard shortform JP Highlight validation must fail without a Gemini best-hook window.');
}

function testJapaneseHighlightMetadataRejectsKoreanText() {
  const guide = metadataTest.enforcePublicMetadataLanguage({
    detected_subject_ko: '병따개 제작',
    detected_subject_ja: '栓抜きづくり',
    highlight_explainer_text: '金属が押されて形になる瞬間です。',
    highlight_metadata: {
      variant_type: 'highlight',
      upload_title: '병따개 제작の流れを短く見る',
      short_description: '병따개 제작の流れを短く見る工程です。',
      summary_caption: '병따개 제작の流れです。',
      onscreen_caption_block: '병따개 제작の流れを短く見る場面です。',
      report_description: '1. 作業概要\n병따개 제작の流れを紹介します。',
      recommended_titles: [
        { title: '병따개 제작の流れを短く見る #worker #process #factory' }
      ],
      hashtags: ['#worker', '#process']
    },
    highlight_metadata_ko: {
      variant_type: 'highlight',
      upload_title: '병따개 제작 과정',
      short_description: '병따개 제작의 핵심 장면입니다.',
      summary_caption: '병따개 제작 장면입니다.',
      onscreen_caption_block: '병따개 제작 과정에서 가장 눈에 띄는 장면입니다.',
      report_description: '1. 작업 개요\n병따개 제작 과정입니다.'
    },
    full_metadata_ko: {
      upload_title: '병따개 제작 과정',
      short_description: '병따개 제작의 핵심 장면입니다.',
      summary_caption: '병따개 제작 장면입니다.',
      report_description: '1. 작업 개요\n병따개 제작 과정입니다.'
    }
  });
  const publicText = [
    guide.highlight_metadata.upload_title,
    guide.highlight_metadata.short_description,
    guide.highlight_metadata.summary_caption,
    guide.highlight_metadata.onscreen_caption_block,
    guide.highlight_metadata.report_description,
    ...guide.highlight_metadata.recommended_titles.map((item) => item.title)
  ].join('\n');
  assert(!/[가-힣]/u.test(publicText), 'JP Highlight public metadata must not contain Korean text.');
}

function testQueueHighlightPublicTitlesRejectHangulSubject() {
  const baseGuide = {
    video_metadata: { duration_sec: 20 },
    detected_subject: '병따개 제작',
    highlight_metadata: {
      variant_type: 'highlight',
      upload_title: '병따개 제작の流れを短く見る',
      onscreen_caption_block: '熱い金属を叩いて形を整える場面です。',
      short_description: '熱い金属を叩いて形を整える場面です。',
      report_description: '熱い金属を叩いて形を整える場面です。',
      recommended_titles: [
        { category: 'concise', title: '병따개 제작の流れを短く見る #worker #process', hashtags: ['#worker', '#process'] },
        { category: 'concise', title: '병따개 제작が形になる瞬間 #worker #process', hashtags: ['#worker', '#process'] },
        { category: 'hook', title: '職人と機械で進む병따개 제작 #worker #process', hashtags: ['#worker', '#process'] }
      ],
      hashtags: ['#worker', '#process']
    },
    highlight_metadata_ko: {
      variant_type: 'highlight',
      upload_title: '병따개 제작이 만들어지는 흐름',
      onscreen_caption_block: '병따개 제작 과정에서 가장 눈에 띄는 장면입니다.',
      short_description: '병따개 제작 과정입니다.',
      report_description: '병따개 제작 과정입니다.',
      recommended_titles: [
        { category: '간결형', title: '병따개 제작이 만들어지는 흐름 #worker #process', hashtags: ['#worker', '#process'] }
      ]
    },
    scene_transitions: [
      {
        scene_id: 'scene_001',
        start_sec: 0,
        end_sec: 3,
        scene_specific_explanation_ja: '熱い金属を叩いて形を整える場面です。',
        distinct_action: 'hammering',
        visual_hook_score: 9,
        motion_intensity: 'high'
      }
    ]
  };
  const guide = queueTest.buildHighlightCandidateGuide(baseGuide, {
    start_sec: 0,
    end_sec: 3,
    duration_sec: 3,
    selected_scene_ids: ['scene_001'],
    reason: 'single hook scene'
  }, 1, 1, '병따개 제작の流れを短く見る');
  const publicTitles = [
    guide.highlight_metadata.upload_title,
    ...guide.highlight_metadata.recommended_titles.map((item) => item.title)
  ].join('\n');
  assert(!/[가-힣]/u.test(publicTitles), 'Queue-built JP Highlight public titles must not contain Hangul subject leakage.');
  const reviewTitles = [
    guide.highlight_metadata_ko.upload_title,
    ...guide.highlight_metadata_ko.recommended_titles.map((item) => item.title)
  ].join('\n');
  assert(/[가-힣]/u.test(reviewTitles), 'Korean review-only titles must remain allowed in highlight_metadata_ko.');
}

function testHighlightOnlyOutputCountPolicy() {
  assert(queueTest.highlightOutputCountForItem({ source_type: 'shortform', video_metadata: { duration_sec: 23.9 } }) === 1, 'Shortform under 24s must produce 1 JP Highlight.');
  assert(queueTest.highlightOutputCountForItem({ source_type: 'shortform', video_metadata: { duration_sec: 24 } }) === 2, 'Shortform 24s or longer must produce 2 JP Highlights.');
  assert(queueTest.highlightOutputCountForItem({ source_type: 'longform', source_workflow_mode: 'longform_to_shorts', video_metadata: { duration_sec: 240 } }) === 5, 'Longform must produce 5 JP Highlights.');
}

function testLocale66BatchValidation() {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    source_url: `https://www.youtube.com/watch?v=${String(index + 1).padStart(11, 'A')}`,
    target_locale: index < 6 ? 'ja-JP' : 'ko-KR'
  }));
  const result = queueTest.validateLocale66Rows(rows, { stage: 'contract_test' });
  assert(result.total === 12, 'locale batch validation must report the batch size it was given.');
  assert(result.counts['ja-JP'] === 6 && result.counts['ko-KR'] === 6, 'locale batch validation must report the JP/KO split it was given.');

  let duplicateBlocked = null;
  try {
    queueTest.validateLocale66Rows([
      ...rows.slice(0, 11),
      { ...rows[0], target_locale: 'ko-KR' }
    ], { stage: 'contract_test_duplicate' });
  } catch (error) {
    duplicateBlocked = error;
  }
  assert(duplicateBlocked?.code === 'LOCALE_6_6_BATCH_INVALID', 'locale_6_6 validation must block duplicated canonical YouTube sources.');

  // Batch size is free: 11, 13, or any other count must pass.
  const elevenItems = queueTest.validateLocale66Rows(rows.slice(0, 11), { stage: 'contract_test_count_11' });
  assert(elevenItems.total === 11, 'locale batch validation must accept a batch that is not 12 items.');

  const thirteenItems = queueTest.validateLocale66Rows([
    ...rows,
    { source_url: 'https://www.youtube.com/watch?v=ZZZZZZZZZ13', target_locale: 'ja-JP' }
  ], { stage: 'contract_test_count_13' });
  assert(thirteenItems.total === 13, 'locale batch validation must accept more than 12 items.');

  // The JP/KO ratio is free too.
  const skewedRatio = queueTest.validateLocale66Rows(rows.map((row, index) => ({
    ...row,
    target_locale: index < 7 ? 'ja-JP' : 'ko-KR'
  })), { stage: 'contract_test_ratio' });
  assert(skewedRatio.counts['ja-JP'] === 7 && skewedRatio.counts['ko-KR'] === 5, 'locale batch validation must accept an uneven JP/KO split.');

  let emptyBlocked = null;
  try {
    queueTest.validateLocale66Rows([], { stage: 'contract_test_empty' });
  } catch (error) {
    emptyBlocked = error;
  }
  assert(emptyBlocked?.code === 'LOCALE_6_6_BATCH_INVALID', 'locale batch validation must still block an empty batch.');

  const canonicalRows = rows.map((row, index) => ({ ...row, source_url: `https://www.youtube.com/watch?v=${String(index + 20).padStart(11, 'B')}` }));
  const duplicateId = 'VIDEO_ID001';
  canonicalRows[0] = { source_url: `https://www.youtube.com/watch?v=${duplicateId}`, target_locale: 'ja-JP' };
  canonicalRows[1] = { source_url: `https://youtu.be/${duplicateId}`, target_locale: 'ja-JP' };
  canonicalRows[6] = { source_url: `https://www.youtube.com/shorts/${duplicateId}`, target_locale: 'ko-KR' };
  canonicalRows[7] = { source_url: `https://m.youtube.com/watch?v=${duplicateId}`, target_locale: 'ko-KR' };
  let canonicalDuplicateBlocked = null;
  try {
    queueTest.validateLocale66Rows(canonicalRows, { stage: 'contract_test_canonical_urls' });
  } catch (error) {
    canonicalDuplicateBlocked = error;
  }
  assert(canonicalDuplicateBlocked?.code === 'LOCALE_6_6_BATCH_INVALID', 'watch, youtu.be, shorts, and m.youtube URLs for the same video must be treated as one canonical source.');

  const missingLocaleRows = rows.map((row, index) => index < 6
    ? { source_url: row.source_url }
    : row);
  const missingLocaleResult = queueTest.validateLocale66Rows(missingLocaleRows, { stage: 'contract_test_missing_locale' });
  assert(missingLocaleResult.counts['ja-JP'] === 6, 'Missing target_locale must default to ja-JP in locale validation.');
}

function locale66QueueItem(itemId, targetLocale, sourceIndex) {
  const videoId = `LC66${String(sourceIndex).padStart(7, '0')}`;
  return {
    item_id: itemId,
    item_config: {
      item_id: itemId,
      target_locale: targetLocale,
      source_url: `https://www.youtube.com/watch?v=${videoId}`,
      canonical_source_key: `youtube:${videoId}`,
      source_type: 'shortform',
      source_workflow_mode: 'shortform_direct',
      video_metadata: { duration_sec: 18 }
    }
  };
}

function testLocale66ExecutionSubsetRegression() {
  const localePairs = [
    ['item_001', 'ja-JP'],
    ['item_002', 'ja-JP'],
    ['item_003', 'ja-JP'],
    ['item_004', 'ja-JP'],
    ['item_005', 'ko-KR'],
    ['item_006', 'ja-JP'],
    ['item_007', 'ko-KR'],
    ['item_008', 'ja-JP'],
    ['item_009', 'ko-KR'],
    ['item_010', 'ko-KR'],
    ['item_011', 'ko-KR'],
    ['item_012', 'ko-KR']
  ];
  const queueItems = localePairs.map(([itemId, targetLocale], index) => locale66QueueItem(itemId, targetLocale, index + 1));
  const validationIds = localePairs.map(([itemId]) => itemId);
  const failedMetadataIds = ['item_002', 'item_004', 'item_008', 'item_011'];
  const executionIds = validationIds.filter((itemId) => !failedMetadataIds.includes(itemId));

  const plan = queueTest.validateLocale66ExecutionPlan(queueItems, {
    locale_validation_item_ids: validationIds,
    execution_item_ids: executionIds
  });

  assert(plan.total === 12, 'locale_6_6 execution plan must validate the original 12-item batch.');
  assert(plan.counts['ja-JP'] === 6 && plan.counts['ko-KR'] === 6, 'locale_6_6 execution plan must preserve JP 6 / KO 6 validation.');
  assert(plan.execution_subset_count === 8, 'locale_6_6 execution plan must execute only the 8 metadata-ready items.');
  assert(JSON.stringify(plan.execution_item_ids) === JSON.stringify(executionIds), 'locale_6_6 execution IDs must match the metadata-ready subset.');
  assert(JSON.stringify(plan.skipped_item_ids) === JSON.stringify(failedMetadataIds), 'locale_6_6 skipped IDs must be the 4 metadata-failed items.');
  assert(plan.validation_items.length === 12, 'locale_6_6 report plan must keep all original validation items.');
  assert(plan.execution_items.length === 8, 'locale_6_6 report plan must separate the 8 execution items from validation items.');

  const skipped = new Set(plan.validation_items.filter((item) => !item.will_execute).map((item) => item.item_id));
  failedMetadataIds.forEach((itemId) => {
    assert(skipped.has(itemId), `${itemId} must be recorded as skipped, not sent to draft.`);
  });
  executionIds.forEach((itemId) => {
    const item = plan.execution_items.find((row) => row.item_id === itemId);
    assert(item, `${itemId} must be recorded as draft-ready.`);
    const expectedBuilder = item.target_locale === 'ko-KR'
      ? 'createKoreanHighlightDraftForItem'
      : 'createHighlightDraftForItem';
    assert(item.highlight_builder === expectedBuilder, `${itemId} must route to the ${expectedBuilder} builder.`);
  });

  const item006 = plan.validation_items.find((item) => item.item_id === 'item_006');
  const item007 = plan.validation_items.find((item) => item.item_id === 'item_007');
  assert(item006.target_locale === 'ja-JP', 'JP item locale must be preserved in the execution plan.');
  assert(item007.target_locale === 'ko-KR', 'KO item locale must be preserved in the execution plan.');

  let subsetBlocked = null;
  try {
    queueTest.validateLocale66ExecutionPlan(queueItems, {
      locale_validation_item_ids: validationIds.filter((itemId) => itemId !== 'item_001'),
      execution_item_ids: executionIds
    });
  } catch (error) {
    subsetBlocked = error;
  }
  assert(subsetBlocked?.code === 'LOCALE_6_6_EXECUTION_INVALID', 'Execution IDs outside the validation IDs must be blocked.');

  const extraQueueItems = [
    ...queueItems,
    ...Array.from({ length: 12 }, (_, index) => locale66QueueItem(`other_${String(index + 1).padStart(3, '0')}`, index < 6 ? 'ja-JP' : 'ko-KR', index + 101))
  ];
  let arbitraryValidationBlocked = null;
  try {
    queueTest.validateLocale66ExecutionPlan(extraQueueItems, {
      locale_validation_item_ids: Array.from({ length: 12 }, (_, index) => `other_${String(index + 1).padStart(3, '0')}`),
      execution_item_ids: executionIds
    });
  } catch (error) {
    arbitraryValidationBlocked = error;
  }
  assert(arbitraryValidationBlocked?.code === 'LOCALE_6_6_EXECUTION_INVALID', 'An arbitrary different 12-item locale batch must not validate draft execution for this job subset.');
}

function testKoreanHighlightFolderNamesStayDistinct() {
  const queueSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'processQueueService.js'), 'utf8');
  assert(
    queueSource.includes('const koreanHighlightOrdinalSuffix = totalHighlights > 1'),
    'Korean highlight drafts must add an ordinal suffix so two highlights from one source do not share a folder name.'
  );
  assert(
    !queueSource.includes('preserveHighlightOutputFolder'),
    'Folder collisions must be prevented by naming, not by renaming an already-written draft folder.'
  );
}

function testLocaleHighlightOutputCountPolicy() {
  const cases = [
    [{ target_locale: 'ko-KR', source_type: 'longform', source_workflow_mode: 'longform_to_shorts', video_metadata: { duration_sec: 240 } }, 5, 'KO longform must produce 5 Highlights.'],
    [{ target_locale: 'ko-KR', source_type: 'shortform', video_metadata: { duration_sec: 24 } }, 2, 'KO shortform 24s or longer must produce 2 Highlights.'],
    [{ target_locale: 'ko-KR', source_type: 'shortform', video_metadata: { duration_sec: 23.9 } }, 1, 'KO shortform under 24s must produce 1 Highlight.'],
    [{ target_locale: 'ja-JP', source_type: 'longform', source_workflow_mode: 'longform_to_shorts', video_metadata: { duration_sec: 240 } }, 5, 'JP longform must keep producing 5 Highlights.'],
    [{ target_locale: 'ja-JP', source_type: 'shortform', video_metadata: { duration_sec: 24 } }, 2, 'JP shortform 24s or longer must keep producing 2 Highlights.'],
    [{ target_locale: 'ja-JP', source_type: 'shortform', video_metadata: { duration_sec: 23.9 } }, 1, 'JP shortform under 24s must keep producing 1 Highlight.']
  ];
  cases.forEach(([item, expected, message]) => {
    assert(queueTest.highlightOutputCountForItem(item) === expected, message);
  });
}

function testKoreanUploadMetadataAndProfileContracts() {
  const text = [
    '# OTTOGI_METADATA_PACKAGE',
    '',
    '<!-- METADATA_VARIANT: ko_highlight -->',
    '<!-- METADATA_LANGUAGE: ko -->',
    '## KOREAN_HIGHLIGHT_METADATA',
    '',
    '### SCREEN_CAPTION',
    '금속이 눌리며 형태가 바뀌는 핵심 장면입니다.',
    '',
    '### TITLE_CANDIDATES',
    '1. 금속이 변하는 순간 #공정 #제조 #금속 #하이라이트 #작업',
    '',
    '### REPORT_DESCRIPTION',
    '이 영상은 금속이 압력으로 변형되는 순간을 한국어 공개 설명으로 보여줍니다.',
    '',
    '<!-- REVIEW_VARIANT: highlight -->',
    '검수용 텍스트입니다.'
  ].join('\n');
  const parsed = uploadTest.parseMetadataText(text, 'fallback title', 'ko_highlight');
  assert(parsed.variant === 'ko_highlight', 'KO metadata parse must preserve ko_highlight variant.');
  assert(/금속이 변하는 순간/u.test(parsed.title), 'KO public title must be parsed from the ko_highlight metadata section.');
  assert(/한국어 공개 설명/u.test(parsed.description), 'KO public description must be parsed from the ko_highlight public metadata section.');
  assert(!/검수용/u.test(parsed.description), 'Review-only text must not leak into KO public upload description.');
  assert(uploadTest.detectUploadVariant('20260731_120000-001-KH-metal-final.mp4') === 'ko_highlight', 'KH filename must be detected as ko_highlight.');
  assert(uploadTest.detectUploadVariant('20260731_120000-001-H-metal-final.mp4') === 'highlight', 'JP H filename must remain highlight, not ko_highlight.');

  const previousProfiles = fs.existsSync(uploadProfilesPath) ? fs.readFileSync(uploadProfilesPath, 'utf8') : null;
  try {
    fs.mkdirSync(path.dirname(uploadProfilesPath), { recursive: true });
    fs.writeFileSync(uploadProfilesPath, JSON.stringify({
      activeProfileId: 'jp_hl_contract',
      profiles: [
        { id: 'jp_hl_contract', name: 'JP Highlight', purpose: 'jp_highlight' },
        { id: 'ko_hl_contract', name: 'KO Highlight', purpose: 'ko_highlight' }
      ]
    }, null, 2) + '\n', 'utf8');
    uploadTest.assertUploadItemsMatchProfiles([{ uploadProfileId: 'ko_hl_contract', variant: 'ko_highlight', title: 'KO Highlight' }]);
    let mismatchBlocked = null;
    try {
      uploadTest.assertUploadItemsMatchProfiles([{ uploadProfileId: 'jp_hl_contract', variant: 'ko_highlight', title: 'KO Highlight' }]);
    } catch (error) {
      mismatchBlocked = error;
    }
    assert(mismatchBlocked?.code === 'UPLOAD_PROFILE_VARIANT_MISMATCH', 'JP Highlight profile must reject ko_highlight upload items.');
  } finally {
    if (previousProfiles == null) {
      if (fs.existsSync(uploadProfilesPath)) fs.unlinkSync(uploadProfilesPath);
    } else {
      fs.writeFileSync(uploadProfilesPath, previousProfiles, 'utf8');
    }
  }
}

function testSceneLevelUniquenessDoesNotRequireFixedTimeGap() {
  const item = shortformWithGeminiHook();
  item.ottogi_guide_output.hook_clip_10s = {
    start_sec: 0,
    end_sec: 4,
    duration_sec: 4,
    visual_hook: 'first press',
    why_this_clip: 'rank one impact',
    selected_scene_ids: ['scene_a']
  };
  item.ottogi_guide_output.recommended_highlight_window = {
    start_sec: 0,
    end_sec: 4,
    duration_sec: 4,
    selected_scene_ids: ['scene_a']
  };
  item.ottogi_guide_output.shortform_candidate_windows = [
    {
      window_id: 'rank_2_nearby_distinct_scene',
      start_sec: 4.5,
      end_sec: 8.5,
      duration_sec: 4,
      hook_score: 8,
      purpose: 'VISUAL_HOOK',
      process_coverage: 'SINGLE_ACTION_CYCLE',
      selected_scene_ids: ['scene_b']
    }
  ];
  const windows = queueTest.pickHighlightWindows(item, 10, 2);
  assert(windows.length === 2, 'Distinct scene-level highlights must not be rejected by an arbitrary fixed time gap.');
  assert(windows[0].selected_scene_ids[0] === 'scene_a' && windows[1].selected_scene_ids[0] === 'scene_b', 'Highlight uniqueness must be based on scene identity.');
}

function testMultipleHighlightMetadataDiffersBySceneWindow() {
  const baseGuide = {
    video_metadata: { duration_sec: 40 },
    highlight_metadata: {
      variant_type: 'highlight',
      caption_mode: 'long_bottom_explainer',
      upload_title: '鍛造工程ができるまで',
      onscreen_caption_block: '高温の金属がプレス機で形を変える工程全体の説明です。',
      short_description: '高温の金属がプレス機で形を変える工程全体の説明です。',
      report_description: '工程全体の説明です。',
      recommended_titles: [
        { category: 'hook', title: '火花が散る鍛造の瞬間', hashtags: ['#process'] },
        { category: 'hook', title: '金属が平たく広がる工程', hashtags: ['#process'] },
        { category: 'hook', title: '鍛造工程の見どころ', hashtags: ['#process'] },
        { category: 'hook', title: '作業の流れで見る鍛造', hashtags: ['#process'] },
        { category: 'hook', title: '金属加工の変化を観察', hashtags: ['#process'] }
      ],
      hashtags: ['#process']
    },
    highlight_metadata_ko: {
      variant_type: 'highlight',
      caption_mode: 'long_bottom_explainer',
      onscreen_caption_block: '뜨거운 금속이 프레스기로 변하는 전체 공정 설명입니다.',
      short_description: '뜨거운 금속이 프레스기로 변하는 전체 공정 설명입니다.',
      report_description: '전체 공정 설명입니다.'
    },
    shortform_candidate_windows: [
      {
        window_id: 'spark_hammering',
        start_sec: 4,
        end_sec: 10,
        visual_hook: 'glowing hot metal is hammered and throws bright sparks',
        why_this_clip: 'sparks and aggressive hammering refine the metal bar',
        process_coverage: 'KEY_STEP',
        reason: 'sparks hammering refining',
        selected_scene_ids: ['scene_opening_press']
      },
      {
        window_id: 'initial_flattening',
        start_sec: 30,
        end_sec: 36,
        visual_hook: 'hot metal is initially flattened and spreads under the press',
        why_this_clip: 'initial flattening and spreading under the press',
        process_coverage: 'INITIAL_TRANSFORMATION',
        reason: 'initial flattening spreading',
        selected_scene_ids: ['scene_late_trim']
      }
    ],
    scene_transitions: [
      {
        scene_id: 'scene_opening_press',
        start_sec: 4,
        end_sec: 10,
        visual_summary: 'opening press flattens hot metal',
        scene_specific_explanation_ja: '赤い金属を叩くたびに火花が散り、形が整っていく場面です。',
        scene_specific_explanation_ko: '붉은 금속을 두드릴 때마다 불꽃이 튀고 형태가 다듬어지는 장면입니다.',
        distinct_action: 'spark hammering',
        material_or_tool_focus: 'hot metal and hammer',
        visual_change: 'sparks and refining shape',
        focus_target: 'hot metal press',
        visual_hook_score: 9,
        motion_intensity: 'high'
      },
      {
        scene_id: 'scene_late_trim',
        start_sec: 30,
        end_sec: 36,
        visual_summary: 'late blade trims the shaped metal edge',
        scene_specific_explanation_ja: 'プレスで金属が平たく広がり、厚みが変わる場面です。',
        scene_specific_explanation_ko: '프레스 아래에서 금속이 납작하게 퍼지고 두께가 바뀌는 장면입니다.',
        distinct_action: 'initial flattening',
        material_or_tool_focus: 'press and hot metal',
        visual_change: 'flattening and spreading',
        focus_target: 'cutting blade',
        visual_hook_score: 8,
        motion_intensity: 'high'
      }
    ]
  };
  const h01 = queueTest.buildHighlightCandidateGuide(baseGuide, {
    start_sec: 4,
    end_sec: 10,
    duration_sec: 6,
    selected_scene_ids: ['scene_opening_press'],
    reason: 'opening press impact'
  }, 1, 2, '鍛造工程ができるまで H01');
  const h02 = queueTest.buildHighlightCandidateGuide(baseGuide, {
    start_sec: 30,
    end_sec: 36,
    duration_sec: 6,
    selected_scene_ids: ['scene_late_trim'],
    reason: 'late cutting trim'
  }, 2, 2, '鍛造工程ができるまで H02');

  assert(h01.highlight_metadata.upload_title === '火花が散る鍛造の瞬間', 'Highlight 1 public upload title must use title candidate rank 1 without H01 suffix.');
  assert(h02.highlight_metadata.upload_title === '金属が平たく広がる工程', 'Highlight 2 public upload title must use title candidate rank 2 without H02 suffix.');
  assert(!/H0[12]/.test(`${h01.highlight_metadata.upload_title}\n${h02.highlight_metadata.upload_title}`), 'Public upload titles must not rely on H01/H02 suffixes.');
  assert(h01.highlight_metadata.onscreen_caption_block !== h02.highlight_metadata.onscreen_caption_block, 'Each JP Highlight output must get a scene/window-specific Japanese caption block.');
  assert(h01.highlight_metadata.report_description !== h02.highlight_metadata.report_description, 'Each JP Highlight output must get a scene/window-specific metadata description.');
  assert(/火花|叩|ハンマー/u.test(h01.highlight_metadata.onscreen_caption_block), 'H01 caption must include spark/hammering semantics.');
  assert(/平たく|広が|厚み/u.test(h02.highlight_metadata.onscreen_caption_block), 'H02 caption must include flattening/spreading semantics.');
  assert(queueTest.highlightMetadataBodiesAreDistinct([h01.highlight_metadata, h02.highlight_metadata]), 'Highlight bodies must be distinct after normalization.');
  assert(h01.highlight_candidate_metadata_cue.semantic_key !== h02.highlight_candidate_metadata_cue.semantic_key, 'Different scene actions should produce different semantic keys.');
}

function testHighlightDuplicateGuardRejectsLabelTimeOnlyDifference() {
  const duplicated = [
    {
      onscreen_caption_block: 'H01は27〜30秒の後半で素材に強い圧力が加わり形が変わる場面です。',
      summary_caption: 'H01は27〜30秒の後半で素材に強い圧力が加わり形が変わる場面です。',
      report_description: 'H01 候補 27〜30秒 後半 圧力変形'
    },
    {
      onscreen_caption_block: 'H02は6〜12秒の序盤で素材に強い圧力が加わり形が変わる場面です。',
      summary_caption: 'H02は6〜12秒の序盤で素材に強い圧力が加わり形が変わる場面です。',
      report_description: 'H02 候補 6〜12秒 序盤 圧力変形'
    }
  ];
  assert(!queueTest.highlightMetadataBodiesAreDistinct(duplicated), 'Label/time/stage-only differences must be rejected.');
}

function testGenericSceneExplanationDetector() {
  assert(queueTest.isGenericSceneExplanation('工程の動き'), 'Generic Japanese scene summaries must be detected.');
  assert(queueTest.isGenericSceneExplanation('공정의 움직임에 주목'), 'Generic Korean scene summaries must be detected.');
  assert(!queueTest.isGenericSceneExplanation('赤い金属を叩くたびに火花が散る場面です。'), 'Concrete scene explanations must pass.');
}

function testDuplicateCandidateMetadataBlocksGeneration() {
  const itemConfig = {
    item_id: 'duplicate_generic_highlight_case',
    target_duration_sec: 240,
    video_metadata: { duration_sec: 240 },
    source_classification: { duration_sec: 240 },
    ottogi_guide_output: {
      video_metadata: { duration_sec: 240 },
      highlight_metadata: {
        upload_title: '製造ハイライト',
        onscreen_caption_block: '素材、道具、機械の位置関係が変わる場面を切り出しています。',
        summary_caption: '素材、道具、機械の位置関係が変わる場面を切り出しています。',
        report_description: '素材、道具、機械の位置関係が変わる場面を切り出しています。',
        recommended_titles: [
          { title: '工場の工程の流れを短く見る', hashtags: ['#process'] },
          { title: '工場の工程が形になる瞬間', hashtags: ['#process'] }
        ],
        hashtags: ['#process']
      },
      scene_transitions: [
        { scene_id: 'scene_001', start_sec: 20, end_sec: 44, visual_summary: '工程の変化を確認する区間です。', caption_text: '工程の動き' },
        { scene_id: 'scene_002', start_sec: 70, end_sec: 94, visual_summary: '工程の変化を確認する区間です。', caption_text: '工程の動き' }
      ]
    }
  };
  const windows = [
    { start_sec: 20, end_sec: 30, duration_sec: 10, selected_scene_ids: ['scene_001'], reason: 'scene_ranked_highlight_candidate' },
    { start_sec: 70, end_sec: 80, duration_sec: 10, selected_scene_ids: ['scene_002'], reason: 'scene_ranked_highlight_candidate' }
  ];
  let blocked = null;
  try {
    queueTest.assertHighlightCandidateMetadataDistinct(itemConfig, windows);
  } catch (error) {
    blocked = error;
  }
  assert(blocked && blocked.code === 'OTTOGI_HIGHLIGHT_METADATA_DUPLICATE_BODY', 'Duplicate generic highlight metadata must block generation before draft creation.');
}

function testEachHighlightWindowGetsItsOwnTitle() {
  // Gemini returns one hook title per candidate window. Two highlights cut from
  // different actions must not receive interchangeable titles - which is what
  // indexing into recommended_titles used to produce.
  const metadata = {
    recommended_titles: [{ category: 'hook', title: 'エアコン修理の全工程', hashtags: ['#エアコン修理'] }],
    highlight_candidate_titles: [
      { start_sec: 36, end_sec: 40, title: '炎で銅管をろう付け！修理が決まる瞬間', hashtags: ['#ろう付け'] },
      { start_sec: 31, end_sec: 36, title: '壊れた銅管を切断！原因を断つ一手', hashtags: ['#切断'] }
    ]
  };

  const brazing = queueTest.rankedTitleCandidate(metadata, {}, 1, '', { start_sec: 36, end_sec: 40 });
  const cutting = queueTest.rankedTitleCandidate(metadata, {}, 2, '', { start_sec: 31, end_sec: 36 });
  assert(brazing.includes('ろう付け'), `brazing window must get its own title, got: ${brazing}`);
  assert(cutting.includes('切断'), `cutting window must get its own title, got: ${cutting}`);
  assert(brazing !== cutting, 'two highlight windows must not share a title');

  // A window with no matching candidate entry falls back to the representative title
  // rather than borrowing another cut's title.
  const unmatched = queueTest.rankedTitleCandidate(metadata, {}, 1, '', { start_sec: 0, end_sec: 6 });
  assert(
    !unmatched.includes('ろう付け') && !unmatched.includes('切断'),
    `an unmatched window must not borrow another cut's title, got: ${unmatched}`
  );

  assert(queueTest.candidateTitleForWindow(metadata, { start_sec: 36, end_sec: 40 })?.title.includes('ろう付け'),
    'candidateTitleForWindow must match on overlap');
  assert(queueTest.candidateTitleForWindow({}, { start_sec: 36, end_sec: 40 }) === null,
    'no candidate titles means no match');
}

function testPublicHighlightDescriptionHasNoInternalNotes() {
  const queueSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'processQueueService.js'), 'utf8');
  assert(
    !queueSource.includes('이 문단은 로컬 검수용이며'),
    'the local-review note must not be written into the public upload description'
  );
  assert(
    queueSource.includes('function publicCandidateReason'),
    'selector strategy ids must be filtered out of the public description'
  );
  // formatMetadataReportDescription collapses whitespace and only restores line
  // breaks for headings it knows, so the highlight headings must be listed.
  assert(
    queueSource.includes('|하이라이트') && queueSource.includes('|ハイライト'),
    'highlight section headings must be registered so the description keeps its line breaks'
  );
}

function testKoreanHighlightAlsoMatchesTitlesByWindow() {
  const base = {
    highlight_metadata: { recommended_titles: [{ category: 'hook', title: 'JA representative', hashtags: [] }], upload_title: 'JA representative', highlight_candidate_titles: [] },
    highlight_metadata_ko: {
      recommended_titles: [{ category: 'hook', title: '대표 KO 제목', hashtags: [] }],
      upload_title: '대표 KO 제목',
      highlight_candidate_titles: [
        { start_sec: 7, end_sec: 14, title: '비상사태 발생! 의문의 기포', hashtags: ['#에어컨고장'] },
        { start_sec: 36, end_sec: 40, title: '신의 손길! 불꽃 토치 용접', hashtags: ['#토치용접'] }
      ]
    },
    video_metadata: { duration_sec: 47 }
  };
  const first = queueTest.buildHighlightCandidateGuide(base, { start_sec: 7, end_sec: 14 }, 1, 2, '');
  const second = queueTest.buildHighlightCandidateGuide(base, { start_sec: 36, end_sec: 40 }, 2, 2, '');
  assert(first.highlight_metadata_ko.upload_title.includes('기포'), 'KO highlight must take the title written for its own window: ' + first.highlight_metadata_ko.upload_title);
  assert(second.highlight_metadata_ko.upload_title.includes('토치'), 'second KO window must take its own title: ' + second.highlight_metadata_ko.upload_title);
  assert(first.highlight_metadata_ko.upload_title !== second.highlight_metadata_ko.upload_title, 'two KO highlights of one source must not share a title');
  assert(first.highlight_metadata_ko.upload_title, 'upload_title must be populated so the draft folder does not fall back to the stale item title');
  const unmatched = queueTest.buildHighlightCandidateGuide(base, { start_sec: 27, end_sec: 30 }, 1, 2, '');
  assert(!unmatched.highlight_metadata_ko.upload_title.includes('기포') && !unmatched.highlight_metadata_ko.upload_title.includes('토치'), 'an unmatched KO window must not borrow another cut title');
}

function testSourceDurationDoesNotFallBackToOutputTarget() {
  // item_005 is a 47s source with target_duration_sec 30 and no video_metadata.
  // Treating the output target as the source length clamped every window past 30s
  // away, so the 36~41s torch window Gemini ranked and titled was unreachable.
  const itemConfig = {
    item_id: 'duration_fallback_fixture',
    source_type: 'shortform',
    source_workflow_mode: 'shortform_direct',
    target_duration_sec: 30,
    source_classification: { duration_sec: 47 },
    ottogi_guide_output: {
      recommended_highlight_window: { start_sec: 6, end_sec: 14 },
      scene_transitions: [],
      shortform_candidate_windows: [
        { window_id: 'highlight_01', start_sec: 6, end_sec: 14, hook_score: 0.9, visual_hook: '泡', purpose: '視聴者の興味を引く' },
        { window_id: 'highlight_02', start_sec: 36, end_sec: 41, hook_score: 0.85, visual_hook: '溶接', purpose: '修理技術を示す' }
      ]
    }
  };

  const windows = queueTest.pickHighlightWindows(itemConfig, 10, 2);
  assert(windows.length === 2, `expected two windows, got ${windows.length}`);
  const tail = windows.find((w) => w.start_sec >= 30);
  assert(tail, `a window past the 30s output target must stay reachable, got ${JSON.stringify(windows.map((w) => `${w.start_sec}-${w.end_sec}`))}`);
  assert(
    Math.abs(tail.start_sec - 36) < 1 && Math.abs(tail.end_sec - 41) < 1,
    `the nominated 36~41s window must survive intact, got ${tail.start_sec}-${tail.end_sec}`
  );
}

function testNominatedCandidatesAndSourceLengthAreProtected() {
  const queueSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'processQueueService.js'), 'utf8');
  assert(
    queueSource.includes('nominatedHighlightCandidates.has(candidate)'),
    'windows Gemini nominated as highlight candidates must not be re-screened by purpose keywords'
  );
  assert(
    queueSource.includes('function sourceDurationSecForItem'),
    'source duration must come from one helper, not an ad-hoc target_duration_sec fallback'
  );
  assert(
    /QUEUE_SERVER_OWNED_FIELDS[\s\S]{0,80}video_metadata/.test(queueSource),
    'video_metadata must be server-owned so a queue save cannot wipe the real source length'
  );
}

function testItemUploadTitleComesFromTheLocaleHighlight() {
  const queueSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'processQueueService.js'), 'utf8');
  assert(
    queueSource.includes('const localeHighlightMetadata = itemIsKorean'),
    'item-level upload_title must be derived from the highlight metadata of the item locale'
  );
  assert(
    !queueSource.includes('const uploadTitle = sanitizeKoreanProductionText(selectedTitle?.title'),
    'item-level upload_title must no longer be taken from full_metadata_ko, which this workflow never produces'
  );
}

function testProcessSpanFilterOnlyRejectsRealWholeProcessWindows() {
  // item_010's 49~54s window was dropped because its reason read "the punchline of
  // the story" - substring matching on free prose. Losing it pushed the second
  // highlight onto a scene fallback with no explanation, which produced a duplicate
  // template caption and failed the whole item.
  const keep = [
    { reason: 'This clip delivers the punchline of the story, showing the confusion.' },
    { purpose: 'To show the successful execution of the prank.' },
    { visual_hook: 'A whole cake being decorated' }
  ];
  keep.forEach((candidate) => {
    assert(
      !queueTest.isProcessSpanHighlightCandidate(candidate),
      `ordinary prose must not read as a whole-process window: ${JSON.stringify(candidate)}`
    );
  });

  const reject = [
    { window_type: 'summary' },
    { type: 'full_process' },
    { selection_strategy: 'story' },
    { purpose: 'Covers the full process from start to finish.' },
    { process_coverage: '工程全体を通して見せる' },
    { reason: '전체 공정을 요약해서 보여줍니다.' }
  ];
  reject.forEach((candidate) => {
    assert(
      queueTest.isProcessSpanHighlightCandidate(candidate),
      `an explicit whole-process window must still be rejected: ${JSON.stringify(candidate)}`
    );
  });
}

function testHighlightCaptionsUseGeminiPerWindowExplanations() {
  // The cue templates describe generic manufacturing motion. A delivery-prank source
  // got "刃や工具が素材に入り、形が分かれていく" on both highlights, which is both wrong
  // and identical, so the duplicate-body guard failed the item.
  const baseGuide = {
    shortform_candidate_windows: [
      {
        start_sec: 41,
        end_sec: 47,
        hook_score: 0.98,
        visual_hook: 'The delivery person pulls out a TV remote',
        scene_specific_explanation_ja: '配達員が突然復讐のアイデアを思いつき、不機嫌な顧客の前でさりげなくリュックサックからテレビのリモコンを取り出す、物語のクライマックス部分です。',
        scene_specific_explanation_ko: '배달원이 갑자기 복수 아이디어를 떠올리고, 불친절한 손님 앞에서 슬며시 백팩에서 TV 리모컨을 꺼내는 이야기의 클라이맥스 부분입니다.'
      },
      {
        start_sec: 49,
        end_sec: 54,
        hook_score: 0.95,
        reason: 'This clip delivers the punchline of the story.',
        scene_specific_explanation_ja: '配達員が満足げな表情で立ち去り、その後ろでテレビが消える。それを目の当たりにした顧客が困惑する場面です。',
        scene_specific_explanation_ko: '배달원이 만족스러운 표정으로 떠나고, 그 뒤에서 TV가 꺼집니다. 이를 목격한 손님이 당황하는 장면입니다.'
      }
    ],
    // The selected window itself carries no explanation - it must be borrowed by overlap.
    recommended_highlight_window: { start_sec: 41, end_sec: 47 }
  };

  const first = queueTest.buildHighlightCandidateGuide(baseGuide, { start_sec: 41, end_sec: 47 }, 1, 2, '');
  const second = queueTest.buildHighlightCandidateGuide(baseGuide, { start_sec: 49, end_sec: 54 }, 2, 2, '');

  const firstJa = first.highlight_metadata.onscreen_caption_block;
  const secondJa = second.highlight_metadata.onscreen_caption_block;
  assert(firstJa.includes('リモコン'), `the 41~47s caption must describe that window, got: ${firstJa}`);
  assert(secondJa.includes('テレビが消える'), `the 49~54s caption must describe that window, got: ${secondJa}`);
  assert(firstJa !== secondJa, 'two highlights of one source must not share a caption block');
  assert(!firstJa.includes('刃や工具'), 'a generic manufacturing template must not describe a non-manufacturing source');

  const firstKo = first.highlight_metadata_ko.onscreen_caption_block;
  const secondKo = second.highlight_metadata_ko.onscreen_caption_block;
  assert(firstKo.includes('리모컨'), `the Korean caption must follow the same window, got: ${firstKo}`);
  assert(firstKo !== secondKo, 'Korean caption blocks must differ per window too');
}

function main() {
  const queueService = 'server/services/processQueueService.js';
  const metadataService = 'server/services/processMetadataService.js';
  const jobService = 'server/services/processJobService.js';
  const phaseUi = 'client/src/pages/Phase5Draft.jsx';

  assertContains(
    phaseUi,
    "highlight: 'highlight_only'",
    'Phase 2 Highlight button must keep requesting the highlight-only mode.'
  );

  assertContains(
    queueService,
    "return 'highlight_only';",
    'Active Phase 2 draft variant mode must stay JP Highlight-only and must not promote longform into Full generation.'
  );

  assertContains(
    queueService,
    "capcut_template_draft_name: selectVariantCapcutTemplateDraftName(queueConfig, 'jp_highlight')",
    'JP Highlight drafts must keep using the JP Highlight sample template.'
  );

  assertContains(
    queueService,
    "caption_mode: 'long_bottom_explainer'",
    'JP Highlight drafts must keep the long bottom explainer caption mode.'
  );

  assertContains(
    queueService,
    "visual_template: 'jp_highlight'",
    'JP Highlight drafts must keep the highlight visual template.'
  );

  assertContains(
    queueService,
    'upload_description: highlightMetadata.report_description || highlightMetadata.short_description || \'\'',
    'JP Highlight draft config must not inherit Korean Full upload_description from the base config.'
  );

  assertContains(
    queueService,
    "style_profile: 'highlight_explainer'",
    'JP Highlight captions must keep the highlight explainer style profile.'
  );

  assertContains(
    queueService,
    'stripHighlightScreenInternalNotes',
    'JP Highlight captions must strip internal notes before draft generation.'
  );

  assertContains(
    metadataService,
    'isHighlightOnlyShortform',
    'Shortform highlight analysis must keep its lightweight highlight-only path.'
  );

  assertContains(
    metadataService,
    'public upload metadata only when the source target_locale is ko-KR',
    'Gemini/Vertex Highlight prompt must describe highlight_metadata_ko as public metadata for ko-KR targets, not review-only only.'
  );

  assertNotContains(
    queueService,
    "queueConfig.capcut_template_draft_name,\n      variantDefaults.jp_highlight",
    'JP Highlight template selection must not fall back through the generic/full template before the highlight sample.'
  );

  assertContains(
    queueService,
    'const wantsFullDraft = false;',
    'Full Draft generation must remain inactive in active Phase 2 queue generation.'
  );

  assertContains(
    queueService,
    'const wantsMidformDraft = false;',
    'Midform generation must remain inactive in active Phase 2 queue generation.'
  );

  assertContains(
    jobService,
    "batch_mode: options.batch_mode || job.batch_mode || ''",
    'Process job retry must preserve locale_6_6 batch_mode unless explicitly overridden.'
  );

  assertContains(
    queueService,
    'locale_validation_item_ids = null',
    'locale batch draft continuation must validate the original batch, not only metadata-ready draft items.'
  );

  assertContains(
    jobService,
    'locale_validation_item_ids: job.item_ids || []',
    'Process job draft continuation must pass original job item_ids for locale batch validation.'
  );

  assertNotContains(
    queueService,
    "errors.push('총 12개 source item을 선택해 주세요.')",
    'Locale batch size must stay free - no fixed 12-item requirement.'
  );

  assertNotContains(
    queueService,
    "counts['ja-JP'] !== 6 || counts['ko-KR'] !== 6",
    'Locale batch JP/KO split must stay free - no fixed 6/6 requirement.'
  );

  // No usable Gemini/Vision candidates is reported and skipped, never turned into a
  // draft-stage exception and never filled in with generic/local fallback windows.
  assertContains(
    queueService,
    "row.highlight_skip_code = 'OTTOGI_HIGHLIGHT_CANDIDATES_UNAVAILABLE'",
    'Missing highlight candidates must skip the item with a reason, for longform and shortform alike.'
  );

  assertNotContains(
    queueService,
    "error.code = 'OTTOGI_LONGFORM_HIGHLIGHT_CANDIDATES_REQUIRED'",
    'Draft generation must not throw on missing longform candidates - it reports and skips.'
  );

  assertContains(
    metadataService,
    "'OTTOGI_LONGFORM_HIGHLIGHT_CANDIDATES_REQUIRED'",
    'Analysis-side strictness must stay: longform still refuses generic/local fallback candidates.'
  );

  assertContains(
    jobService,
    "const METADATA_NO_CANDIDATES_STATUS = 'skipped_no_highlight_candidates'",
    'A missing-candidates analysis result must carry a skip status, not a failed_* status.'
  );

  assertContains(
    phaseUi,
    'disabled={localeLocked}',
    'Phase 2 locale selector must lock running or completed queue items.'
  );

  testShortformHighlightUsesSingleHookScene();
  testShortformHighlightRejectsFullCycleCandidates();
  testShortformHighlightValidationRequiresGeminiBestHook();
  testJapaneseHighlightMetadataRejectsKoreanText();
  testQueueHighlightPublicTitlesRejectHangulSubject();
  testHighlightOnlyOutputCountPolicy();
  testLocale66BatchValidation();
  testLocale66ExecutionSubsetRegression();
  testKoreanHighlightFolderNamesStayDistinct();
  testLocaleHighlightOutputCountPolicy();
  testKoreanUploadMetadataAndProfileContracts();
  testSceneLevelUniquenessDoesNotRequireFixedTimeGap();
  testMultipleHighlightMetadataDiffersBySceneWindow();
  testHighlightDuplicateGuardRejectsLabelTimeOnlyDifference();
  testGenericSceneExplanationDetector();
  testDuplicateCandidateMetadataBlocksGeneration();

  testEachHighlightWindowGetsItsOwnTitle();
  testProcessSpanFilterOnlyRejectsRealWholeProcessWindows();
  testHighlightCaptionsUseGeminiPerWindowExplanations();
  testKoreanHighlightAlsoMatchesTitlesByWindow();
  testItemUploadTitleComesFromTheLocaleHighlight();
  testSourceDurationDoesNotFallBackToOutputTarget();
  testNominatedCandidatesAndSourceLengthAreProtected();
  testPublicHighlightDescriptionHasNoInternalNotes();
  console.log('shortform highlight contract ok');
}

main();

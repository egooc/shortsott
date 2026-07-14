const {
  __test: {
    applyMetadataFieldRepair,
    applyLocalMetadataFallbacks,
    enforcePublicMetadataLanguage,
    normalizeGuide,
    assertRepairNormalizationDidNotCollapse,
    OTTOGI_METADATA_FIELD_REPAIR_SCHEMA,
    OTTOGI_FULL_CAPTION_SCRIPT_REPAIR_SCHEMA
  }
} = require('../server/services/processMetadataService');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeRepairScript() {
  return [
    '이게 뭔지 아세요?',
    '금속 망치를',
    '만드는 과정',
    '먼저 손잡이를',
    '주먹에 끼워요',
    '단단히 고정',
    '흔들림 없이',
    '힘을 맞추고',
    '표면을 갈아요',
    '모서리를 다듬고',
    '손으로 확인',
    '기계로 정리',
    '작은 흠도',
    '그냥 넘기지',
    '않고 맞춰요',
    '반복할수록',
    '형태가 살아나고',
    '마지막 광택이',
    '완성도를 높여요',
    '정밀함이 남고',
    '손기술이 보여요'
  ].map((text, index) => ({
    scene_id: `script_${String(index + 1).padStart(3, '0')}`,
    role: index === 0 ? 'hook' : index >= 19 ? 'closing' : 'technical_context',
    text,
    source_basis: index % 2 === 0 ? 'visual evidence from video' : 'scene timing basis'
  }));
}

function testFullKoRepairSurvivesNormalize() {
  const guide = {
    detected_subject: '주먹 모양 금속 망치',
    scene_transitions: [
      {
        scene_id: 'scene_001',
        start_sec: 0,
        end_sec: 3,
        transition_at_sec: 3,
        visual_summary: '손잡이를 금속 망치 머리에 끼우는 장면',
        caption_text: '工程の動き',
        caption_text_ko: '손잡이를 끼워요',
        screen_captions_ja: ['工程の動き'],
        screen_captions_ko: ['손잡이를 끼워요']
      }
    ]
  };
  const repairResult = { full_caption_script_ko: makeRepairScript() };
  const applied = applyMetadataFieldRepair(guide, repairResult);
  const appliedCount = Array.isArray(applied.full_caption_script_ko) ? applied.full_caption_script_ko.length : 0;
  const repairSourcedCount = (applied.full_caption_script_ko || [])
    .filter((item) => item.source_basis === 'full_caption_script_repair')
    .length;
  const normalized = normalizeGuide(applied, 'https://www.youtube.com/shorts/MjUWTcr0FlY', 45);
  const normalizedCount = Array.isArray(normalized.full_caption_script_ko) ? normalized.full_caption_script_ko.length : 0;

  assert(appliedCount >= 20, `expected repair to apply at least 20 items, got ${appliedCount}`);
  assert(repairSourcedCount === appliedCount, `expected repair source marker to be preserved on all items, got ${repairSourcedCount}/${appliedCount}`);
  assert(normalizedCount >= 20, `expected repair script to survive normalize, got ${appliedCount}→${normalizedCount}`);
}

function testRepairLossGuard() {
  let threw = false;
  try {
    assertRepairNormalizationDidNotCollapse({
      field: 'full_caption_script_ko',
      beforeCount: 21,
      afterCount: 0
    });
  } catch (error) {
    threw = error.code === 'REPAIR_NORMALIZE_LOSS' || error.errorCode === 'REPAIR_NORMALIZE_LOSS';
  }
  assert(threw, 'expected REPAIR_NORMALIZE_LOSS for 21→0 collapse');
}

function testMetadataRepairSchemaIsThin() {
  const schemaText = JSON.stringify(OTTOGI_METADATA_FIELD_REPAIR_SCHEMA);
  assert(schemaText.includes('repaired_fields'), 'metadata repair schema must expose repaired_fields');
  assert(!schemaText.includes('full_metadata_ko'), 'metadata repair schema must not embed full metadata objects');
  assert(!schemaText.includes('full_caption_script_ko'), 'metadata repair schema must not embed caption script arrays');
  assert(OTTOGI_FULL_CAPTION_SCRIPT_REPAIR_SCHEMA.properties.full_caption_script_ko.maxItems === 24, 'full script repair schema should cap maxItems at 24');
}

function testLocalMetadataReportFallbacksRemoveLanguageContamination() {
  const guide = {
    detected_subject: '녹 제거 브러시 제작',
    full_metadata_ko: {
      short_description: '버려진 브러시를 새 도구로 만드는 과정입니다.',
      report_description: 'DIY metal brush tool fabrication의 핵심 흐름과 工程手順을 설명합니다. PPE를 착용하십시오.'
    },
    highlight_metadata: {
      short_description: '古いブラシが新しい工具に変わる瞬間です。',
      report_description: '古いブラシを再利用する工程です。PPEを着用してください。'
    },
    highlight_metadata_ko: {
      short_description: '낡은 브러시가 새 도구로 바뀌는 순간입니다.',
      report_description: 'DIY metal brush tool fabrication의 핵심 흐름과 工程手順을 설명합니다. PPE를 착용하십시오.'
    }
  };
  const repaired = applyLocalMetadataFallbacks(guide, [
    { scene_id: 'metadata', field: 'full_metadata_ko.report_description' },
    { scene_id: 'metadata', field: 'highlight_metadata.report_description' },
    { scene_id: 'metadata', field: 'highlight_metadata_ko.report_description' }
  ]);
  const joined = [
    repaired.full_metadata_ko.report_description,
    repaired.highlight_metadata.report_description,
    repaired.highlight_metadata_ko.report_description
  ].join('\n');
  assert(!/[A-Za-z]{3,}/u.test(joined), 'expected report fallbacks to remove long English tokens');
  assert(!/工程手順/u.test(repaired.full_metadata_ko.report_description), 'expected Korean report fallback to remove Japanese headings');
  assert(/作業概要/u.test(repaired.highlight_metadata.report_description), 'expected Japanese report fallback sections');
  assert(/작업 개요/u.test(repaired.highlight_metadata_ko.report_description), 'expected Korean report fallback sections');
}

function publicTextValues(metadata = {}) {
  const values = [];
  ['upload_title', 'short_description', 'summary_caption', 'report_description', 'onscreen_caption_block'].forEach((field) => {
    if (metadata?.[field]) values.push(String(metadata[field]));
  });
  (metadata?.recommended_titles || []).forEach((item) => {
    if (item?.title) values.push(String(item.title).replace(/[#＃][A-Za-z0-9_-]+/g, ''));
  });
  return values;
}

function testPublicMetadataLanguageEnforcementRebuildsContaminatedFields() {
  const guide = {
    short_description_ko: 'Wire brush making의 핵심 흐름입니다.',
    explainer_text_ko: 'metal bending 과정을 설명합니다.',
    full_caption_script_ko: [
      { text: '이게 뭔지 아세요?' },
      { text: '낡은 도구가' },
      { text: '새롭게 바뀌어요' }
    ],
    full_metadata_ko: {
      short_description: 'metal bending 과정을 설명합니다.',
      report_description: '## 1. 작업 개요 metal bending의 핵심 흐름입니다.',
      recommended_titles: [
        { title: 'metal bending #worker #process #tools', hashtags: ['#worker', '#process', '#tools'] }
      ]
    },
    highlight_metadata: {
      short_description: '古いブラシをDIYで作る工程です。',
      report_description: 'DIY工程を紹介します。',
      recommended_titles: [
        { title: 'DIY工具づくり #worker #process #tools', hashtags: ['#worker', '#process', '#tools'] }
      ]
    },
    highlight_metadata_ko: {
      short_description: 'Wire brush making의 핵심 흐름입니다.',
      report_description: '## 1. 작업 개요 Wire brush making의 핵심 흐름입니다.',
      recommended_titles: [
        { title: '효율성 UP! 녹 제거 브러시 DIY 튜토리얼 #worker #process #efficiency', hashtags: ['#worker', '#process', '#efficiency'] }
      ]
    }
  };
  const enforced = enforcePublicMetadataLanguage(guide);
  const values = [
    enforced.short_description_ko,
    enforced.explainer_text_ko,
    enforced.report_description_ko,
    ...publicTextValues(enforced.full_metadata_ko),
    ...publicTextValues(enforced.highlight_metadata),
    ...publicTextValues(enforced.highlight_metadata_ko)
  ].join('\n').replace(/[#＃][A-Za-z0-9_-]+/g, '');
  assert(!/[A-Za-z]{2,}/u.test(values), `expected public metadata to be Latin-free, got: ${values}`);
  assert(enforced.highlight_metadata_ko.recommended_titles.length >= 5, 'expected Korean highlight review titles to be rebuilt');
  assert(enforced.highlight_metadata.recommended_titles.length >= 5, 'expected Japanese highlight titles to be rebuilt');
}

function main() {
  testFullKoRepairSurvivesNormalize();
  testRepairLossGuard();
  testMetadataRepairSchemaIsThin();
  testLocalMetadataReportFallbacksRemoveLanguageContamination();
  testPublicMetadataLanguageEnforcementRebuildsContaminatedFields();
  console.log('metadata repair guards ok');
}

main();

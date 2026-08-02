const {
  __test: {
    applyMetadataFieldRepair,
    buildFallbackReport,
    repairPublicTitles,
    hasLongLatinWord,
    normalizeLocalizedHashtags,
    koreanSubjectParticle,
    deterministicDescription,
    applyLocalMetadataFallbacks,
    collectJapaneseCaptionIssues,
    enforcePublicMetadataLanguage,
    isKoreanFullScriptStyleRegenerationIssue,
    collectKoreanFullRepairGateIssues,
    metadataSchemaForMetadataVariantMode,
    reviewSchemaForMetadataVariantMode,
    selectKoreanFullHookType,
    normalizeGuide,
    assertRepairNormalizationDidNotCollapse,
    OTTOGI_HIGHLIGHT_METADATA_ONLY_SCHEMA,
    OTTOGI_REVIEW_SCHEMA,
    OTTOGI_HIGHLIGHT_ONLY_REVIEW_SCHEMA,
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

function makeRegenerationScript() {
  return [
    '처음엔 그냥',
    '금속 막대지만',
    '어떻게 변할까요',
    '곧 답을 알게 돼요',
    '먼저 공구 안에',
    '정확히 자리를',
    '잡아줘야 해요',
    '0.1mm만 틀어져도',
    '원형이 흔들려요',
    '천천히 힘을 주고',
    '막대가 휘어지며',
    '링 형태가 보여요',
    '여기서 중요한 건',
    '한 번에 꺾지 않고',
    '압력을 나누는 것',
    '잘못 구부리면',
    '전체가 틀어져요',
    '한 바퀴를 지나',
    '금속 링이 됩니다',
    '분리할 때도',
    '모양을 확인하고',
    '작은 부품 하나가',
    '정확히 완성돼요'
  ].map((text, index) => ({
    scene_id: `regen_${String(index + 1).padStart(3, '0')}`,
    role: index === 0 ? 'hook' : index >= 21 ? 'closing' : (index % 5 === 0 ? 'scene_observation' : 'technical_context'),
    text,
    source_basis: 'full_caption_script_regeneration'
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

function testHighlightOnlySchemasDoNotRequireFullDraftFields() {
  const metadataSchema = metadataSchemaForMetadataVariantMode('highlight_only');
  const reviewSchema = reviewSchemaForMetadataVariantMode('highlight_only');
  const metadataSchemaText = JSON.stringify(metadataSchema);
  const reviewSchemaText = JSON.stringify(reviewSchema);

  assert(metadataSchema === OTTOGI_HIGHLIGHT_METADATA_ONLY_SCHEMA, 'highlight-only metadata must use the highlight-only schema');
  assert(reviewSchema === OTTOGI_HIGHLIGHT_ONLY_REVIEW_SCHEMA, 'highlight-only review must use the highlight-only schema');
  assert(reviewSchemaForMetadataVariantMode('all') === OTTOGI_REVIEW_SCHEMA, 'full-capable review modes must use the standard loose review schema');
  assert(!metadataSchemaText.includes('full_caption_script_ko'), 'highlight-only metadata schema must not request Korean Full script fields');
  assert(!metadataSchemaText.includes('full_metadata_ko'), 'highlight-only metadata schema must not request Korean Full metadata fields');
  assert(!reviewSchemaText.includes('full_caption_script_ko'), 'highlight-only review schema must not request Korean Full script fields');
  assert(!reviewSchemaText.includes('full_metadata_ko'), 'highlight-only review schema must not request Korean Full metadata fields');
}

function testKoreanFullRepairGateAllowsConnectedClauses() {
  const connectedScript = [
    '처음엔 금속 막대처럼 보여도요',
    '이건 형태를 다시 잡는 공정이에요',
    '먼저 공구 안에 넣고',
    '흔들리면 안 되니까',
    '손으로 위치를 잡아줘요',
    '힘을 한 번에 주지 않고',
    '압력을 나눠야 해요',
    '잘못 구부리면',
    '전체 기준이 틀어져요',
    '기계가 눌러도',
    '방향이 먼저 맞아야 하고',
    '표면이 천천히 돌아가면서',
    '원형이 조금씩 살아나요',
    '중간마다 확인하고',
    '작은 오차를 바로 잡아요',
    '같은 움직임을 반복하면서',
    '정밀함이 조금씩 쌓여요',
    '분리할 때도 모양을 보고',
    '끝까지 기준을 지켜요',
    '작은 부품 하나가 정확히 완성돼요'
  ].map((text, index) => ({
    scene_id: `scene_${String((index % 4) + 1).padStart(2, '0')}`,
    role: index === 0 ? 'hook' : index >= 18 ? 'closing' : 'technical_context',
    text,
    source_basis: 'test_connected_clause_gate'
  }));

  const issues = collectKoreanFullRepairGateIssues(connectedScript);
  assert(!issues.length, `expected connected Korean clauses to pass repair gate, got ${JSON.stringify(issues)}`);
}

function testKoreanFullStyleIssuesRequireRegeneration() {
  const script = [
    ['hook', '이게 뭔지 아세요?'],
    ['process_purpose', '작은 볼트를'],
    ['process_purpose', '맞추는 공정이에요'],
    ['technical_context', '먼저 위치를 확인함'],
    ['scene_observation', '작업자가 잡아줘요'],
    ['method', '기계가 압착합니다'],
    ['quality_reason', '흔들림을 확인합니다'],
    ['technical_context', '방향을 확인합니다'],
    ['scene_observation', '플라이어로 잡고'],
    ['quality_reason', '여기서 중요한 건'],
    ['method', '힘보다 방향이에요'],
    ['progress', '조금씩 맞춰가요'],
    ['scene_observation', '표면을 다시 보고'],
    ['technical_context', '정밀하게 맞춰요'],
    ['quality_reason', '품질이 달라져요'],
    ['progress', '같은 움직임이'],
    ['scene_observation', '반복해서 이어지고'],
    ['emotional_expression', '정밀함이 쌓여요'],
    ['closing', '마지막 형태가'],
    ['closing', '완성도를 높여요']
  ].map(([role, text], index) => ({
    scene_id: `script_${String(index + 1).padStart(3, '0')}`,
    role,
    text,
    source_basis: 'test_style_guard'
  }));

  const issues = collectJapaneseCaptionIssues({
    short_description_ko: '작은 볼트를 맞추는 공정입니다.',
    explainer_text_ko: '작은 부품을 정밀하게 맞추는 과정을 설명합니다.',
    full_caption_script_ko: script,
    full_metadata_ko: {
      caption_mode: 'scene_based_short_subtitles',
      onscreen_subtitles: script.map((item) => item.text),
      short_description: '작은 볼트를 맞추는 공정입니다.',
      summary_caption: '정밀하게 부품을 맞추는 과정입니다.',
      report_description: '## 1. 작업 개요\n작은 볼트를 맞추는 공정입니다.',
      upload_title: '작은 볼트 정밀 조립 #worker #process #tools #machinework #craftsmanship',
      recommended_titles: [
        { title: '작은 볼트 정밀 조립 #worker #process #tools #machinework #craftsmanship', hashtags: ['#worker', '#process', '#tools', '#machinework', '#craftsmanship'] }
      ]
    }
  }, {
    includeFull: true,
    includeHighlight: false,
    includeMidform: false,
    includeScenes: false,
    includeKorean: true,
    includeJapanese: false
  });

  const styleIssues = issues.filter(isKoreanFullScriptStyleRegenerationIssue);
  assert(styleIssues.some((issue) => issue.issue_type === 'ko_full_banned_exact_opening'), 'expected exact 이게 뭔지 아세요 opening to require KO full regeneration');
  assert(styleIssues.some((issue) => issue.issue_type === 'ko_full_report_style_ending'), 'expected ~함/~됨 ending to require KO full regeneration');
  assert(styleIssues.some((issue) => issue.issue_type === 'ko_full_consecutive_hamnida'), 'expected three consecutive 합니다 endings to require KO full regeneration');
}

function testKoreanFullHookSelectionAndPayoffGuards() {
  const moneyHook = selectKoreanFullHookType({
    seed: 'job_a:item_1',
    sourceText: '버려진 고철을 재활용해서 새 도구로 만드는 과정'
  });
  const dangerHook = selectKoreanFullHookType({
    seed: 'job_a:item_2',
    sourceText: '뜨거운 용접 불꽃과 절단 작업이 보이는 위험 공정'
  });
  assert(moneyHook.type === 'money', `expected money hook for reusable/value source, got ${moneyHook.type}`);
  assert(dangerHook.type === 'danger', `expected danger hook for risky source, got ${dangerHook.type}`);

  const noPayoffScript = [
    ['hook', '처음엔 낯설어 보여도'],
    ['process_purpose', '순서가 중요해요'],
    ['technical_context', '기준을 맞추고'],
    ['scene_observation', '손으로 잡아줘요'],
    ['method', '힘을 나눠줘요'],
    ['quality_reason', '흔들리면 안 돼요'],
    ['technical_context', '정확하게 눌러요'],
    ['scene_observation', '기계가 움직여요'],
    ['quality_reason', '오차가 줄어요'],
    ['method', '방향을 맞춰요'],
    ['progress', '조금씩 이어져요'],
    ['scene_observation', '표면을 확인해요'],
    ['technical_context', '기준을 다시 봐요'],
    ['quality_reason', '품질이 달라져요'],
    ['progress', '같은 흐름으로'],
    ['scene_observation', '반복해서 맞춰요'],
    ['emotional_expression', '정밀함이 쌓여요'],
    ['quality_reason', '실수하면 틀어져요'],
    ['closing', '마지막 기준이'],
    ['closing', '완성도를 만들어요']
  ].map(([role, text], index) => ({ scene_id: `script_${index + 1}`, role, text }));
  const noPayoffIssues = collectJapaneseCaptionIssues({
    detected_subject: '볼트 조립',
    short_description_ko: '볼트 조립 공정입니다.',
    explainer_text_ko: '볼트 조립 과정을 설명합니다.',
    full_caption_script_ko: noPayoffScript,
    full_metadata_ko: {
      caption_mode: 'scene_based_short_subtitles',
      onscreen_subtitles: noPayoffScript.map((item) => item.text),
      short_description: '볼트 조립 공정입니다.',
      summary_caption: '볼트 조립 과정을 설명합니다.',
      report_description: '## 1. 작업 개요\n볼트 조립 공정입니다.',
      upload_title: '볼트 조립 공정 #worker #process #tools #machinework #craftsmanship',
      recommended_titles: [{ title: '볼트 조립 공정 #worker #process #tools #machinework #craftsmanship', hashtags: ['#worker', '#process', '#tools', '#machinework', '#craftsmanship'] }]
    }
  }, { includeFull: true, includeHighlight: false, includeMidform: false, includeScenes: false, includeKorean: true, includeJapanese: false });
  assert(noPayoffIssues.some((issue) => issue.issue_type === 'ko_full_hook_without_payoff'), 'expected hidden-identity hook without subject payoff to require regeneration');

  const decorativeScript = noPayoffScript.map((item) => ({ ...item }));
  decorativeScript[1].text = '정성껏 다듬고';
  decorativeScript[2].text = '섬세하게 맞춰요';
  decorativeScript[3].text = '볼트를 잡아줘요';
  const decorativeIssues = collectJapaneseCaptionIssues({
    detected_subject: '볼트 조립',
    short_description_ko: '볼트 조립 공정입니다.',
    explainer_text_ko: '볼트 조립 과정을 설명합니다.',
    full_caption_script_ko: decorativeScript,
    full_metadata_ko: {
      caption_mode: 'scene_based_short_subtitles',
      onscreen_subtitles: decorativeScript.map((item) => item.text),
      short_description: '볼트 조립 공정입니다.',
      summary_caption: '볼트 조립 과정을 설명합니다.',
      report_description: '## 1. 작업 개요\n볼트 조립 공정입니다.',
      upload_title: '볼트 조립 공정 #worker #process #tools #machinework #craftsmanship',
      recommended_titles: [{ title: '볼트 조립 공정 #worker #process #tools #machinework #craftsmanship', hashtags: ['#worker', '#process', '#tools', '#machinework', '#craftsmanship'] }]
    }
  }, { includeFull: true, includeHighlight: false, includeMidform: false, includeScenes: false, includeKorean: true, includeJapanese: false });
  assert(decorativeIssues.some((issue) => issue.issue_type === 'ko_full_consecutive_decorative_lines'), 'expected consecutive decorative-only lines to require regeneration');
}

function testKoreanFullRegenerationSourceBasisIsDistinct() {
  const guide = { detected_subject: '볼트 조립' };
  const applied = applyMetadataFieldRepair(guide, { full_caption_script_ko: makeRepairScript() }, {
    fullKoreanScriptSourceBasis: 'full_caption_script_regeneration'
  });
  const sources = (applied.full_caption_script_ko || []).map((item) => item.source_basis);
  assert(sources.length >= 20, 'expected regenerated script to apply');
  assert(sources.every((source) => source === 'full_caption_script_regeneration'), 'expected regeneration source marker, not repair marker');
}

function testFullKoRegenerationSurvivesNormalize() {
  const guide = {
    detected_subject: '금속 링',
    scene_transitions: [
      {
        scene_id: 'scene_001',
        start_sec: 0,
        end_sec: 3,
        transition_at_sec: 3,
        visual_summary: '금속 막대를 수동 벤딩 공구에 넣는 장면',
        caption_text: '工程の動き',
        caption_text_ko: '금속 막대를 넣어요',
        screen_captions_ja: ['工程の動き'],
        screen_captions_ko: ['금속 막대를 넣어요']
      }
    ]
  };
  const applied = applyMetadataFieldRepair(guide, { full_caption_script_ko: makeRegenerationScript() }, {
    fullKoreanScriptSourceBasis: 'full_caption_script_regeneration'
  });
  const appliedCount = Array.isArray(applied.full_caption_script_ko) ? applied.full_caption_script_ko.length : 0;
  const regenerationSourcedCount = (applied.full_caption_script_ko || [])
    .filter((item) => item.source_basis === 'full_caption_script_regeneration')
    .length;
  const normalized = normalizeGuide(applied, 'https://www.youtube.com/shorts/metal-ring', 14);
  const normalizedCount = Array.isArray(normalized.full_caption_script_ko) ? normalized.full_caption_script_ko.length : 0;
  const normalizedRegenerationSourcedCount = (normalized.full_caption_script_ko || [])
    .filter((item) => item.source_basis === 'full_caption_script_regeneration')
    .length;

  assert(appliedCount >= 20, `expected regeneration to apply at least 20 items, got ${appliedCount}`);
  assert(regenerationSourcedCount === appliedCount, `expected regeneration source marker on all applied items, got ${regenerationSourcedCount}/${appliedCount}`);
  assert(normalizedCount >= 20, `expected regeneration script to survive normalize, got ${appliedCount}→${normalizedCount}`);
  assert(normalizedRegenerationSourcedCount === normalizedCount, `expected regeneration source marker after normalize, got ${normalizedRegenerationSourcedCount}/${normalizedCount}`);
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
  ].join('\n').replace(/[#＃][\p{L}\p{N}_-]+/gu, '');
  // Latin loanword abbreviations (DIY, AC, CNC ...) are legitimate inside JP/KR
  // prose. What must not survive is English wording such as 'Wire brush making'.
  assert(!hasLongLatinWord(values), `expected public metadata to carry no English prose, got: ${values}`);
  assert(enforced.highlight_metadata_ko.recommended_titles.length === 1, 'Korean highlight keeps exactly one upload title');
  assert(enforced.highlight_metadata.recommended_titles.length === 1, 'Japanese highlight keeps exactly one upload title');
}

function testPublicJapaneseHighlightTitlesRemoveHangul() {
  const guide = {
    detected_subject_ko: '병따개 제작',
    detected_subject_ja: '栓抜きづくり',
    highlight_metadata: {
      upload_title: '병따개 제작の流れを短く見る',
      short_description: '熱い金属を叩く工程です。',
      summary_caption: '熱い金属を叩く工程です。',
      onscreen_caption_block: '熱い金属を叩く工程です。',
      report_description: '## 1. 作業概要\n熱い金属を叩く工程です。',
      recommended_titles: [
        { title: '병따개 제작の流れを短く見る #worker #process', hashtags: ['#worker', '#process'] },
        { title: '職人と機械で進む병따개 제작 #worker #process', hashtags: ['#worker', '#process'] }
      ]
    },
    highlight_metadata_ko: {
      upload_title: '병따개 제작이 만들어지는 흐름',
      short_description: '병따개 제작 과정입니다.',
      summary_caption: '병따개 제작 과정입니다.',
      onscreen_caption_block: '병따개 제작 과정입니다.',
      report_description: '## 1. 작업 개요\n병따개 제작 과정입니다.',
      recommended_titles: [
        { title: '병따개 제작이 만들어지는 흐름 #worker #process', hashtags: ['#worker', '#process'] }
      ]
    }
  };
  const enforced = enforcePublicMetadataLanguage(guide);
  const publicTitles = [
    enforced.highlight_metadata.upload_title,
    ...enforced.highlight_metadata.recommended_titles.map((item) => item.title)
  ].join('\n');
  assert(!/[가-힣]/u.test(publicTitles), `expected Japanese public highlight titles to be Hangul-free, got: ${publicTitles}`);
  const reviewTitles = [
    enforced.highlight_metadata_ko.upload_title,
    ...enforced.highlight_metadata_ko.recommended_titles.map((item) => item.title)
  ].join('\n');
  assert(/[가-힣]/u.test(reviewTitles), 'expected Korean review-only titles to keep Hangul');
}

function testReportDescriptionNeverJamsASentenceIntoASubjectSlot() {
  // Real 2026-08-01 item_005 summary. Passing this as the subject used to render
  // "...보여줍니다.이 어떤 순서로 변화하는지 보여주는 공정 영상입니다."
  const summaryKo = '숙련된 기술자가 에어컨 냉매 누출을 능숙하게 확인하고 수리하는 모습을 보세요. 영상은 물에 잠긴 에어컨 코일에서 거품을 통해 누출을 발견하고, 이어서 구리 파이프를 정밀하게 절단하고 브레이징하여 완벽하게 수리하는 과정을 보여줍니다.';
  const summaryJa = 'エアコンの冷媒漏れは性能低下や故障の原因に。この動画では、熟練の技術者が水槽を使って漏れ箇所を特定し、古い銅管を精密に切断・除去します。';

  const ko = buildFallbackReport(summaryKo, summaryKo, true);
  assert(!/[다요]\.(이|가|의|은|는)\s/u.test(ko), `Korean report must not glue a particle onto a finished sentence: ${ko}`);
  assert(!/보여줍니다\.이 /u.test(ko), 'the exact 2026-08-01 defect must not reappear');
  assert(ko.includes(summaryKo), 'the real summary must survive as the overview section, not be discarded');

  const ja = buildFallbackReport(summaryJa, summaryJa, false);
  assert(!/。が(?:どのような|形に)/u.test(ja), `Japanese report must not glue a particle onto a finished sentence: ${ja}`);
  assert(ja.includes(summaryJa), 'the real Japanese summary must survive as the overview section');

  // Repair path: no usable description, so the template must still be grammatical.
  const repaired = buildFallbackReport(summaryKo, '', true);
  assert(/^1\. 작업 개요\n[^\n]+\n2\./u.test(repaired), 'repair-path overview must be a single clean sentence');
  assert(!repaired.includes(summaryKo), 'repair path must use a short subject, not the whole summary');

  assert(koreanSubjectParticle('절단 공정') === '이', 'final-consonant subject takes 이');
  assert(koreanSubjectParticle('기계') === '가', 'open-syllable subject takes 가');

  const seeded = deterministicDescription(summaryKo, true);
  assert(!seeded.includes(summaryKo), 'deterministicDescription must clamp its noun slot');
  assert(seeded.length < 60, `deterministicDescription must stay short, got ${seeded.length}`);
}

function testKoreanHighlightRebuildsFromHighlightSeedsNotFullDraftSeeds() {
  // Shape of the real 2026-08-01 item_005 guide: the full-draft Korean fields carry
  // generic process wording, and only highlight_explainer_text_ko names what the
  // highlight actually shows. Latin titles force the language rebuild path.
  const contaminated = [{ category: '간결형', title: 'Air conditioner repair site', hashtags: ['#worker'] }];
  const guide = {
    detected_subject: 'Air conditioner repair',
    short_description_ko: '소재가 가공되고 형태를 바꾸며 제품에 가까워지는 공정을 소개합니다.',
    explainer_text_ko: '소재가 가공되고 형태를 바꾸며 제품에 가까워지는 공정을 소개합니다.',
    highlight_explainer_text_ko: '숙련된 기술자가 낡은 동관을 정밀하게 절단 및 제거하고 새 부품을 용접합니다.',
    highlight_hook_captions_ko: ['동관을 절단하는 순간'],
    full_metadata_ko: { recommended_titles: contaminated, hashtags: ['#worker'] },
    highlight_metadata_ko: { recommended_titles: contaminated, hashtags: ['#worker'] },
    highlight_metadata: { recommended_titles: contaminated, hashtags: ['#worker'] }
  };

  const out = enforcePublicMetadataLanguage(guide);
  const highlightTitles = (out.highlight_metadata_ko.recommended_titles || []).map((item) => item.title).join('\n');
  const fullTitles = (out.full_metadata_ko.recommended_titles || []).map((item) => item.title).join('\n');

  assert(
    highlightTitles.includes('절단'),
    `KO highlight titles must be seeded from highlight_explainer_text_ko, got: ${highlightTitles}`
  );
  assert(
    !fullTitles.includes('절단'),
    `KO full titles must stay seeded from the full-draft fields, got: ${fullTitles}`
  );
  assert(
    highlightTitles !== fullTitles,
    'KO highlight and KO full must not collapse onto the same rebuilt title set'
  );
  assert(!/[A-Za-z]{2,}/u.test(stripHashtagsForTest(highlightTitles)), 'rebuilt KO highlight titles must not keep Latin subjects');
}

function stripHashtagsForTest(value) {
  return String(value || '').replace(/[#＃][\p{L}\p{N}_-]+/gu, '');
}

function testUploadTitleIsGeminisHookTitleNotATemplate() {
  // 2026-08-01 item_005: Gemini returned Japanese hook titles, one contaminated
  // entry replaced them all with "<subject>ができるまで", and Phase 3 uploads
  // recommended_titles[0]. Only the first title is ever used, so it must be the
  // model's own hook line whenever one is usable.
  const hook = 'エアコン漏れ、職人技で復活！泡立つ水槽で漏れを発見';
  const repaired = repairPublicTitles({
    recommended_titles: [
      { category: 'hook', title: 'Air conditioner repair overview', hashtags: ['#DIY'] },
      { category: 'hook', title: hook, hashtags: ['#エアコン修理', '#冷媒漏れ'] }
    ],
    hashtags: ['#エアコン修理']
  }, 'エアコンの銅管を精密に切断・除去', false);

  assert(repaired.length === 1, `only one title is uploaded, got ${repaired.length}`);
  assert(
    repaired[0].title.includes(hook),
    `recommended_titles[0] must be the model hook title, got: ${repaired[0].title}`
  );
  assert(
    !/Air conditioner repair/u.test(repaired[0].title),
    'the contaminated title must not become the upload title'
  );
  assert(
    !/ができるまで|が形になる瞬間/u.test(repaired[0].title),
    'a usable model title must never be replaced by a deterministic template'
  );

  // Everything unusable is still the one case where a template is acceptable.
  const allBad = repairPublicTitles({
    recommended_titles: [{ category: 'hook', title: 'Air conditioner repair', hashtags: [] }],
    hashtags: []
  }, 'エアコンの銅管を精密に切断・除去', false);
  assert(allBad.length === 1, 'a fully contaminated list must still yield one usable title');
  assert(!/Air conditioner/u.test(allBad[0].title), 'no contaminated title may survive');
}

function testHashtagsStayInTheTitleLanguage() {
  const ja = normalizeLocalizedHashtags(['#エアコン修理', '#冷媒漏れ', '#職人技'], false);
  assert(ja.length === 3, `Japanese hashtags must survive, got ${JSON.stringify(ja)}`);
  assert(ja.includes('#エアコン修理'), 'model hashtags must be kept verbatim');
  assert(!ja.includes('#worker') && !ja.includes('#process'), 'generic English tags must not be force-injected');

  const ko = normalizeLocalizedHashtags(['#에어컨수리', '#냉매누출'], true);
  assert(ko.includes('#에어컨수리'), 'Korean hashtags must survive');
  assert(!ko.includes('#worker'), 'generic English tags must not be force-injected');

  // Hashtags must not bleed between the two channels.
  const mixed = ['#製造工程', '#제조공정', '#DIY'];
  const koFiltered = normalizeLocalizedHashtags(mixed, true);
  const jaFiltered = normalizeLocalizedHashtags(mixed, false);
  assert(!koFiltered.some((tag) => /[぀-ヿ一-鿿]/u.test(tag)), 'Korean hashtags must not inherit Japanese tags: ' + JSON.stringify(koFiltered));
  assert(!jaFiltered.some((tag) => /[가-힣]/u.test(tag)), 'Japanese hashtags must not inherit Korean tags: ' + JSON.stringify(jaFiltered));
  assert(koFiltered.includes('#DIY') && jaFiltered.includes('#DIY'), 'shared Latin tags stay in both locales');

  // Only an empty list falls back, and the fallback is in the target language.
  const emptyJa = normalizeLocalizedHashtags([], false);
  const emptyKo = normalizeLocalizedHashtags([], true);
  assert(emptyJa.length > 0 && !/[A-Za-z]/u.test(emptyJa.join('')), `JA fallback must be Japanese, got ${JSON.stringify(emptyJa)}`);
  assert(emptyKo.length > 0 && !/[A-Za-z]/u.test(emptyKo.join('')), `KO fallback must be Korean, got ${JSON.stringify(emptyKo)}`);
}

function testLatinLoanwordsAreNotTreatedAsEnglishContamination() {
  // 2026-08-02 item_005 failed validation twice on this exact sentence: Gemini
  // writes エアコン as ACコイル, which is how the word is actually written in
  // Japanese, and the Latin guard rejected the whole metadata package.
  const allowed = [
    'ACコイルを水中に沈め、泡が示す場所から漏れを特定します。',
    '에어컨 AC 코일을 물에 담가 누수를 확인합니다.',
    'DIY修理のASMR動画です。',
    'CNC旋盤とPVCパイプの加工工程。'
  ];
  allowed.forEach((text) => {
    assert(!hasLongLatinWord(text), `loanword abbreviation must not count as English: ${text}`);
  });

  // The guard still has to catch real English leaking into JP/KR metadata.
  const blocked = [
    'Watch a skilled technician fix an AC leak.',
    'Air conditioner repairの流れ',
    'ACコイル repair工程'
  ];
  blocked.forEach((text) => {
    assert(hasLongLatinWord(text), `English prose must still be rejected: ${text}`);
  });
}

function main() {
  testFullKoRepairSurvivesNormalize();
  testRepairLossGuard();
  testMetadataRepairSchemaIsThin();
  testHighlightOnlySchemasDoNotRequireFullDraftFields();
  testKoreanFullRepairGateAllowsConnectedClauses();
  testKoreanFullStyleIssuesRequireRegeneration();
  testKoreanFullHookSelectionAndPayoffGuards();
  testKoreanFullRegenerationSourceBasisIsDistinct();
  testFullKoRegenerationSurvivesNormalize();
  testLocalMetadataReportFallbacksRemoveLanguageContamination();
  testPublicMetadataLanguageEnforcementRebuildsContaminatedFields();
  testPublicJapaneseHighlightTitlesRemoveHangul();
  testReportDescriptionNeverJamsASentenceIntoASubjectSlot();
  testKoreanHighlightRebuildsFromHighlightSeedsNotFullDraftSeeds();
  testUploadTitleIsGeminisHookTitleNotATemplate();
  testHashtagsStayInTheTitleLanguage();
  testLatinLoanwordsAreNotTreatedAsEnglishContamination();
  console.log('metadata repair guards ok');
}

main();

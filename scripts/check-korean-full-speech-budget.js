const {
  __test: metadataTest
} = require('../server/services/processMetadataService');
const {
  __test: queueTest
} = require('../server/services/processQueueService');
const fs = require('fs');
const os = require('os');
const path = require('path');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeScript(texts) {
  return texts.map((text, index) => ({
    scene_id: `script_${String(index + 1).padStart(3, '0')}`,
    role: index === 0 ? 'hook' : index >= texts.length - 2 ? 'closing' : (index % 5 === 0 ? 'scene_observation' : 'technical_context'),
    text,
    source_basis: 'speech_budget_check'
  }));
}

function baseGuide(script, budget) {
  return {
    detected_subject: '정밀 금속 부품',
    duration_sec: budget.target_duration_sec,
    korean_full_speech_budget: budget,
    scene_transitions: [
      { scene_id: 'scene_01', start_sec: 0, end_sec: 5, transition_at_sec: 5, visual_summary: '첫 장면', caption_text_ko: '첫 장면' },
      { scene_id: 'scene_02', start_sec: 5, end_sec: 12, transition_at_sec: 12, visual_summary: '둘째 장면', caption_text_ko: '둘째 장면' },
      { scene_id: 'scene_03', start_sec: 12, end_sec: 24, transition_at_sec: 24, visual_summary: '셋째 장면', caption_text_ko: '셋째 장면' }
    ],
    short_description_ko: '정밀 금속 부품을 만드는 공정입니다.',
    explainer_text_ko: '금속 부품을 기준에 맞춰 정밀하게 만드는 과정을 설명합니다.',
    full_caption_script_ko: script,
    full_metadata_ko: {
      caption_mode: 'scene_based_short_subtitles',
      onscreen_subtitles: script.map((item) => item.text),
      short_description: '정밀 금속 부품을 만드는 공정입니다.',
      summary_caption: '금속 부품을 기준에 맞춰 정밀하게 만드는 과정입니다.',
      report_description: '1. 작업 개요\n정밀 금속 부품을 만드는 공정입니다.',
      upload_title: '정밀 금속 부품 제조 #worker #process #metalwork #machinework #craftsmanship',
      recommended_titles: [
        { title: '정밀 금속 부품 제조 #worker #process #metalwork #machinework #craftsmanship', hashtags: ['#worker', '#process', '#metalwork', '#machinework', '#craftsmanship'] }
      ]
    }
  };
}

function makeAnchoredScript(texts, sceneIds = ['scene_01', 'scene_02', 'scene_03']) {
  return texts.map((text, index) => ({
    scene_id: sceneIds[index % sceneIds.length],
    role: index === 0 ? 'hook' : index >= texts.length - 2 ? 'closing' : (index % 5 === 0 ? 'scene_observation' : 'technical_context'),
    text,
    source_basis: 'scene_anchor_check'
  }));
}

function budgetIssuesFor(script, budget) {
  return metadataTest.collectJapaneseCaptionIssues(baseGuide(script, budget), {
    includeFull: true,
    includeHighlight: false,
    includeMidform: false,
    includeScenes: false,
    includeKorean: true,
    includeJapanese: false,
    durationSec: budget.target_duration_sec
  }).filter((issue) => /^ko_full_speech_budget_/u.test(issue.issue_type || ''));
}

function testBudgetMath() {
  // Re-baselined 2026-08-12: the measured 6.03775 chars/sec (midform-parity
  // voice settings) shipped at HEAD but these expectations still assumed the
  // old 7.12 rate.
  const budget = metadataTest.calculateKoreanFullSpeechBudget({ targetDurationSec: 30, prerollSec: 2, marginSec: 1.5 });
  assert(budget.available_sec === 26.5, `expected available_sec 26.5, got ${budget.available_sec}`);
  assert(budget.target_chars === 144, `expected target_chars floor(26.5*6.03775*.9)=144, got ${budget.target_chars}`);
  assert(budget.min_chars === 108, `expected 75% min 108, got ${budget.min_chars}`);
  assert(budget.max_chars === 158, `expected 110% max 158, got ${budget.max_chars}`);
}

function testJapaneseBudgetMath() {
  // ja_full lane (2026-08-12): 5.5 chars/sec initial estimate, /16 sentence
  // divisor; the KO budget path must stay untouched by the language knob.
  const budget = metadataTest.calculateKoreanFullSpeechBudget({ targetDurationSec: 30, prerollSec: 2, marginSec: 1.5, language: 'ja' });
  assert(budget.language === 'ja', `expected language ja, got ${budget.language}`);
  assert(budget.chars_per_sec === 5.5, `expected JA 5.5 chars/sec, got ${budget.chars_per_sec}`);
  assert(budget.target_chars === Math.floor(26.5 * 5.5 * 0.9), `expected JA target chars, got ${budget.target_chars}`);
  const koBudget = metadataTest.calculateKoreanFullSpeechBudget({ targetDurationSec: 30, prerollSec: 2, marginSec: 1.5 });
  assert(koBudget.chars_per_sec === 6.03775, `KO chars/sec must stay 6.03775, got ${koBudget.chars_per_sec}`);
}

function testPromptBudgetInjection() {
  const budget = metadataTest.calculateKoreanFullSpeechBudget({ targetDurationSec: 30, prerollSec: 2, marginSec: 1.5, sentenceCount: 22 });
  const lines = metadataTest.koreanFullSpeechBudgetPromptLines(budget);
  const joined = lines.join('\n');
  assert(joined.includes('이 영상 30초. 원고 총 144자 ±10%, 문장 22개 내외.'), 'expected Korean prompt budget sentence');
  assert(joined.includes('hard lower signal 108 Korean chars'), 'expected lower-budget validation line');
  assert(joined.includes('hard upper 158 Korean chars'), 'expected upper-budget validation line');
}

function testSceneBudgetPromptInjection() {
  const lines = metadataTest.koreanFullSceneSpeechBudgetPromptLines([
    { scene_id: 'scene_01', start_sec: 0, end_sec: 5.75 },
    { scene_id: 'scene_02', start_sec: 5.75, end_sec: 13 }
  ]);
  const joined = lines.join('\n');
  assert(joined.includes('각 장면의 원고 분량 가이드'), 'expected scene budget heading');
  assert(joined.includes('scene_01 (5.75초): 약 31자 이내'), 'expected scene_01 budget line');
  assert(joined.includes('scene_02 (7.25초): 약 39자 이내'), 'expected scene_02 budget line');
  assert(joined.includes('한 장면에 배정된 full_caption_script_ko 문장들의 한글 가시 글자 합'), 'expected per-scene sum guard');
}

function testBudgetValidationIssues() {
  const budget = metadataTest.calculateKoreanFullSpeechBudget({ targetDurationSec: 30, prerollSec: 2, marginSec: 1.5 });
  const overScript = makeScript(Array.from({ length: 22 }, (_, index) => (
    index === 0 ? '처음엔 평범하지만요' : '정밀한 기준을 맞춰요'
  )));
  const underScript = makeScript(Array.from({ length: 20 }, (_, index) => (
    index === 0 ? '처음엔요' : index >= 18 ? '완성돼요' : '맞춰요'
  )));
  const overIssues = budgetIssuesFor(overScript, budget);
  const underIssues = budgetIssuesFor(underScript, budget);
  assert(overIssues.some((issue) => issue.issue_type === 'ko_full_speech_budget_over' && issue.style_regeneration_required === true), 'expected over-budget issue to require regeneration');
  assert(underIssues.some((issue) => issue.issue_type === 'ko_full_speech_budget_under' && issue.style_regeneration_required === true), 'expected under-budget issue to require regeneration');
}

function testSceneAnchorValidationIssues() {
  const budget = metadataTest.calculateKoreanFullSpeechBudget({ targetDurationSec: 30, prerollSec: 2, marginSec: 1.5 });
  const validScript = makeAnchoredScript(Array.from({ length: 20 }, (_, index) => (
    index === 0 ? '처음엔 작아요' : index >= 18 ? '정밀하게 끝나요' : '기준을 맞춰요'
  )));
  const invalidScript = validScript.map((item, index) => index === 3 ? { ...item, scene_id: 'scene_99' } : item);
  const legacyScript = makeScript(Array.from({ length: 20 }, (_, index) => (
    index === 0 ? '처음엔 작아요' : index >= 18 ? '정밀하게 끝나요' : '기준을 맞춰요'
  )));
  const invalidIssues = metadataTest.collectJapaneseCaptionIssues(baseGuide(invalidScript, budget), {
    includeFull: true,
    includeHighlight: false,
    includeMidform: false,
    includeScenes: false,
    includeKorean: true,
    includeJapanese: false,
    durationSec: budget.target_duration_sec
  });
  const legacyIssues = metadataTest.collectJapaneseCaptionIssues(baseGuide(legacyScript, budget), {
    includeFull: true,
    includeHighlight: false,
    includeMidform: false,
    includeScenes: false,
    includeKorean: true,
    includeJapanese: false,
    durationSec: budget.target_duration_sec
  });
  assert(invalidIssues.some((issue) => issue.issue_type === 'ko_full_invalid_anchor_scene_id'), 'expected invalid explicit scene_id issue');
  assert(!legacyIssues.some((issue) => issue.issue_type === 'ko_full_invalid_anchor_scene_id'), 'legacy script_### IDs should remain fallback-compatible');
}

function testTimelineGuard() {
  const itemConfig = {
    target_duration_sec: 24,
    ottogi_guide_output: {
      korean_full_speech_budget: metadataTest.calculateKoreanFullSpeechBudget({ targetDurationSec: 24 }),
      full_caption_script_ko: makeScript(['처음엔 작아요', '기준을 맞춰요', '정밀하게 끝나요'])
    }
  };
  let threw = false;
  try {
    queueTest.assertKoreanFullTtsFitsVideoTimeline({
      itemId: 'item_guard_test',
      itemConfig,
      draftConfig: { target_duration_sec: 24 },
      ttsFiles: [
        { duration_sec: 13, text: '긴 문장 하나' },
        { duration_sec: 13.8, text: '긴 문장 둘' }
      ],
      plan: { sentence_count: 2 }
    });
  } catch (error) {
    threw = error.code === 'FULL_DRAFT_TTS_DURATION_EXCEEDS_VIDEO_TIMELINE'
      && error.details.actual_tts_sec === 26.8
      && error.details.video_timeline_sec === 24;
  }
  assert(threw, 'expected FULL_DRAFT_TTS_DURATION_EXCEEDS_VIDEO_TIMELINE guard to fire');
}

function testSyncEvidenceFields() {
  const itemConfig = {
    target_duration_sec: 24,
    ottogi_guide_output: {
      korean_full_speech_budget: metadataTest.calculateKoreanFullSpeechBudget({ targetDurationSec: 24 }),
      full_caption_script_ko: makeScript(['처음엔 작아요', '기준을 맞춰요', '정밀하게 끝나요'])
    }
  };
  const evidence = queueTest.buildKoreanFullSyncEvidence({
    itemConfig,
    draftConfig: { target_duration_sec: 24 },
    ttsFiles: [
      { duration_sec: 3.2, text: '처음엔 작아요' },
      { duration_sec: 3.4, text: '기준을 맞춰요' }
    ],
    plan: { sentence_count: 2 },
    syncDecision: 'fits_video_timeline'
  });
  [
    'speech_budget_chars',
    'generated_script_chars',
    'estimated_speech_sec',
    'actual_tts_sec',
    'actual_tts_raw_sum_sec',
    'actual_tts_occupied_timeline_sec',
    'actual_tts_vs_budget_delta_sec',
    'actual_tts_vs_budget_ratio',
    'video_timeline_sec',
    'tolerance_sec',
    'sync_decision',
    'sentence_count'
  ].forEach((field) => assert(Object.prototype.hasOwnProperty.call(evidence, field), `missing sync evidence field ${field}`));
  assert(evidence.actual_tts_sec === 6.6, `expected actual_tts_sec 6.6, got ${evidence.actual_tts_sec}`);
  assert(evidence.actual_tts_raw_sum_sec === 6.6, `expected raw sum 6.6, got ${evidence.actual_tts_raw_sum_sec}`);
  assert(evidence.actual_tts_occupied_timeline_sec === 6.6, `expected occupied timeline 6.6, got ${evidence.actual_tts_occupied_timeline_sec}`);
  assert(evidence.video_timeline_sec === 24, `expected video_timeline_sec 24, got ${evidence.video_timeline_sec}`);
  // 19 visible chars / 6.03775 chars-per-sec (re-baselined 2026-08-12 with
  // the measured rate; was 19 / 7.12).
  assert(evidence.actual_tts_vs_budget_delta_sec === 3.453132, `expected budget delta 3.453132, got ${evidence.actual_tts_vs_budget_delta_sec}`);
}

function testAnchoredTimelineGuardUsesOccupiedEnd() {
  const itemConfig = {
    target_duration_sec: 24,
    ottogi_guide_output: {
      korean_full_speech_budget: metadataTest.calculateKoreanFullSpeechBudget({ targetDurationSec: 24 }),
      scene_transitions: [
        { scene_id: 'scene_01', start_sec: 0, end_sec: 8 },
        { scene_id: 'scene_02', start_sec: 8, end_sec: 24 }
      ],
      full_caption_script_ko: [
        { scene_id: 'scene_01', role: 'hook', text: '처음엔 작아요' },
        { scene_id: 'scene_02', role: 'closing', text: '기준을 맞춰요' }
      ]
    }
  };
  const plan = {
    sentence_count: 2,
    anchor_simulation: {
      sentence_timeline: [
        { caption_id: 'tts_sent_001', actual_end_sec: 10.5 },
        { caption_id: 'tts_sent_002', actual_end_sec: 26.2 }
      ]
    }
  };
  let threw = false;
  try {
    queueTest.assertKoreanFullTtsFitsVideoTimeline({
      itemId: 'item_occupied_guard_test',
      itemConfig,
      draftConfig: { target_duration_sec: 24, korean_full_actual_video_timeline_sec: 24 },
      ttsFiles: [
        { duration_sec: 3.2, text: '처음엔 작아요' },
        { duration_sec: 3.4, text: '기준을 맞춰요' }
      ],
      plan
    });
  } catch (error) {
    threw = error.code === 'FULL_DRAFT_TTS_DURATION_EXCEEDS_VIDEO_TIMELINE'
      && error.details.actual_tts_sec === 26.2
      && error.details.actual_tts_raw_sum_sec === 6.6
      && error.details.video_timeline_sec === 24;
  }
  assert(threw, 'expected occupied timeline guard to fire from anchor simulation end');
}

function testAnchorPlanAndSimulation() {
  const itemConfig = {
    target_duration_sec: 24,
    ottogi_guide_output: {
      scene_transitions: [
        { scene_id: 'scene_01', start_sec: 0, end_sec: 5 },
        { scene_id: 'scene_02', start_sec: 5, end_sec: 12 }
      ],
      full_caption_script_ko: [
        { scene_id: 'scene_01', role: 'hook', text: '처음엔 작아요' },
        { scene_id: 'scene_02', role: 'closing', text: '기준을 맞춰요' }
      ]
    }
  };
  const plan = queueTest.buildKoreanFullDraftTtsPlan({ itemId: 'item_anchor_test', itemConfig, draftConfig: { target_duration_sec: 24 } });
  assert(plan.sentenceUnits[0].anchor_scene_id === 'scene_01', 'expected first sentence anchor scene_01');
  assert(plan.sentenceUnits[1].anchor_start_sec === 5, 'expected second sentence anchor start 5');
  assert(plan.captionUnits.every((unit) => Object.prototype.hasOwnProperty.call(unit, 'anchor_source')), 'expected caption units to carry anchor fields');
  assert(plan.anchor_simulation.enabled === true, 'expected anchor simulation enabled');

  const legacyPlan = queueTest.buildKoreanFullDraftTtsPlan({
    itemId: 'item_anchor_legacy_test',
    itemConfig: {
      target_duration_sec: 24,
      ottogi_guide_output: {
        scene_transitions: itemConfig.ottogi_guide_output.scene_transitions,
        full_caption_script_ko: makeScript(['처음엔 작아요', '기준을 맞춰요'])
      }
    },
    draftConfig: { target_duration_sec: 24 }
  });
  assert(legacyPlan.anchor_simulation.enabled === false, 'legacy script IDs should not create anchors');
  assert(legacyPlan.sentenceUnits.every((unit) => unit.anchor_source === 'continuous_fallback_no_scene_anchor'), 'legacy sentence units should fallback continuous');
}

function testAnchorSimulationDriftGate() {
  const simulation = queueTest.simulateAnchoredSentencePlacement([
    { id: 'tts_sent_001', text: '가가가가가가가가가가가가가가가가가가가가', anchor_scene_id: 'scene_01', anchor_scene_index: 0, anchor_start_sec: 0, anchor_end_sec: 5, anchor_source: 'explicit_scene_id' },
    { id: 'tts_sent_002', text: '나나나나나나나나나나나나나나나나나나나나', anchor_scene_id: 'scene_02', anchor_scene_index: 1, anchor_start_sec: 0.5, anchor_end_sec: 3, anchor_source: 'explicit_scene_id' }
  ]);
  assert(simulation.block_real_tts === true, 'expected drift simulation to block real TTS');
  assert(simulation.drift_metric === 'scene_invasion_after_anchor_end', `unexpected drift metric ${simulation.drift_metric}`);
  assert(simulation.max_scene_invasion_sec > 1.5, `expected max scene invasion > 1.5, got ${simulation.max_scene_invasion_sec}`);
}

function makeValidFullScript(sceneIds = ['scene_01', 'scene_02', 'scene_03']) {
  return [
    '이게 왜 중요한지 먼저 보여요.',
    '기준을 하나씩 다시 맞추는 단계예요.',
    '작은 차이도 결과를 크게 바꾸죠.',
    '그래서 흐름을 천천히 다시 잡아요.',
    '기계가 움직여도 사람 손이 확인해요.',
    '중간 점검이 전체 품질을 끝까지 지켜요.',
    '작은 부품도 같은 기준으로 다시 봐요.',
    '이 반복이 결국 오차를 더 줄여주죠.',
    '순서가 흔들리면 결과도 같이 흔들려요.',
    '여기서 중요한 건 힘을 일정하게 주는 거예요.',
    '작업 속도보다 기준 유지가 더 중요하죠.',
    '사람이 한 번 더 보며 작은 차이를 잡아요.',
    '맞물리는 위치도 끝까지 세심하게 봐요.',
    '한 번의 확인이 다음 단계를 안정시켜요.',
    '정확한 고정이 마지막 품질을 남겨요.',
    '조립 흐름도 차분하게 이어져야 해요.',
    '이 정밀함이 결국 안전한 결과를 만들어요.',
    '작은 어긋남도 바로 다시 맞춰야 해요.',
    '마지막 순간까지 기준을 놓치지 않아요.',
    '좋은 마무리가 전체 완성도를 지켜요.'
  ].map((text, index) => ({
    scene_id: sceneIds[index % sceneIds.length],
    role: index === 0 ? 'hook' : index >= 18 ? 'closing' : 'technical_context',
    text
  }));
}

async function testFullDraftRegenerationStageArtifacts() {
  const budget = metadataTest.calculateKoreanFullSpeechBudget({ targetDurationSec: 30, prerollSec: 2, marginSec: 1.5 });
  const guide = baseGuide(makeAnchoredScript([
    '처음엔 작아요',
    '기준을 맞춰요',
    '공정을 설명해요',
    '작은 조각만',
    '남아 있어요',
    '끝나요'
  ], ['scene_01', 'scene_01', 'scene_02', 'scene_02', 'scene_03', 'scene_03']), budget);
  const stagesDir = path.join(os.tmpdir(), `full-draft-stages-${Date.now()}`);
  const fakeGenerateRepairJson = async (_prompt, _schema, phase) => {
    if (phase === 'full_caption_script_regeneration') {
      return {
        full_caption_script_ko: makeValidFullScript()
      };
    }
    if (phase === 'full_caption_script_repair') {
      return {
        full_caption_script_ko: makeValidFullScript()
      };
    }
    throw new Error(`unexpected phase ${phase}`);
  };

  try {
    try {
      await metadataTest.validateOrRepairJapaneseCaptions({
        guide,
        generateRepairJson: fakeGenerateRepairJson,
        sourceUrl: 'https://example.com/video',
        filename: 'fixture.mp4',
        durationSec: budget.target_duration_sec,
        validationOptions: {
          skipFullValidation: false,
          skipHighlightValidation: true,
          skipMidformValidation: true
        },
        fullDraftStagesDir: stagesDir,
        initialStageRawResponse: {
          sceneGuide: { scene_transitions: guide.scene_transitions },
          metadataGuide: { full_caption_script_ko: [] },
          reviewGuide: null
        }
      });
    } catch {
      // Observability test: stage artifacts must be written even when the synthetic fixture remains invalid.
    }
    ['01_initial_generation.json', '02_regeneration.json', '03_repair.json'].forEach((name) => {
      const target = path.join(stagesDir, name);
      assert(fs.existsSync(target), `expected stage artifact ${name}`);
      const payload = JSON.parse(fs.readFileSync(target, 'utf8'));
      assert(Object.prototype.hasOwnProperty.call(payload, 'char_count'), `expected char_count in ${name}`);
      assert(Object.prototype.hasOwnProperty.call(payload, 'validation'), `expected validation block in ${name}`);
    });
    assert(fs.existsSync(path.join(stagesDir, '01_initial_generation.raw.json')), 'expected raw initial-generation artifact');
    assert(fs.existsSync(path.join(stagesDir, '02_regeneration.raw.json')), 'expected raw regeneration artifact');
    assert(fs.existsSync(path.join(stagesDir, '03_repair.raw.json')), 'expected raw repair artifact');
  } finally {
    if (fs.existsSync(stagesDir)) {
      fs.rmSync(stagesDir, { recursive: true, force: true });
    }
  }
}

function testSkipFullDraftShortformMetadataMode() {
  const effectiveMode = metadataTest.coerceStandardMetadataVariantModeForSource({
    metadataVariantMode: 'all',
    durationSec: 19.8,
    sourceType: 'shortform',
    sourceWorkflowMode: 'shortform_direct'
  });
  assert(effectiveMode === 'highlight_only', `expected short skip item to coerce to highlight_only, got ${effectiveMode}`);

  const sceneGuide = {
    scene_transitions: [
      { scene_id: 'scene_01', start_sec: 0, end_sec: 4, visual_summary: '첫 장면', caption_text_ko: '첫 장면' },
      { scene_id: 'scene_02', start_sec: 4, end_sec: 9, visual_summary: '둘째 장면', caption_text_ko: '둘째 장면' }
    ]
  };
  const metadataPrompt = metadataTest.buildMetadataPrompt({
    sourceUrl: 'https://example.com/video',
    filename: 'shortform.mp4',
    durationSec: 19.8,
    sceneGuide,
    sourceType: 'shortform',
    sourceWorkflowMode: 'shortform_direct',
    metadataVariantMode: effectiveMode
  });
  const reviewPrompt = metadataTest.buildReviewPrompt({
    sourceUrl: 'https://example.com/video',
    filename: 'shortform.mp4',
    durationSec: 19.8,
    draftGuide: { scene_transitions: sceneGuide.scene_transitions, highlight_metadata: {}, highlight_metadata_ko: {} },
    sourceType: 'shortform',
    sourceWorkflowMode: 'shortform_direct',
    metadataVariantMode: effectiveMode
  });
  assert(!metadataPrompt.includes('full_caption_script_ko'), 'highlight-only shortform metadata prompt should not request full_caption_script_ko');
  assert(!reviewPrompt.includes('full_caption_script_ko'), 'highlight-only shortform review prompt should not validate full_caption_script_ko');
}

async function main() {
  testBudgetMath();
  testJapaneseBudgetMath();
  testPromptBudgetInjection();
  testSceneBudgetPromptInjection();
  testBudgetValidationIssues();
  testSceneAnchorValidationIssues();
  testTimelineGuard();
  testSyncEvidenceFields();
  testAnchorPlanAndSimulation();
  testAnchorSimulationDriftGate();
  testAnchoredTimelineGuardUsesOccupiedEnd();
  testSkipFullDraftShortformMetadataMode();
  await testFullDraftRegenerationStageArtifacts();
  console.log('Korean full speech budget and timeline guard checks passed');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

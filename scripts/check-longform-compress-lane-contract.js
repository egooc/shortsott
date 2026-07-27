const {
  __test: queueTest
} = require('../server/services/processQueueService');
const {
  __test: metadataTest
} = require('../server/services/processMetadataService');
const fs = require('fs');
const path = require('path');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function itemWithDuration(durationSec, extra = {}) {
  return {
    item_id: `contract_${durationSec}`,
    video_metadata: { duration_sec: durationSec },
    target_duration_sec: durationSec,
    ottogi_guide_output: {
      scene_transitions: [
        {
          scene_id: 'scene_01',
          start_sec: 0,
          end_sec: Math.min(durationSec, 12),
          transition_at_sec: Math.min(durationSec, 12),
          visual_summary: 'process opening',
          visual_hook_score: 8,
          repetition_potential: 8,
          human_presence: true,
          motion_intensity: 'high'
        },
        {
          scene_id: 'scene_02',
          start_sec: Math.min(durationSec, 30),
          end_sec: Math.min(durationSec, 48),
          transition_at_sec: Math.min(durationSec, 48),
          visual_summary: 'process hook',
          visual_hook_score: 9,
          repetition_potential: 9,
          human_presence: true,
          motion_intensity: 'high'
        }
      ],
      shortform_candidate_windows: [
        { window_id: 'hook_1', start_sec: 10, end_sec: 30, hook_score: 95, purpose: 'visual_hook', selected_scene_ids: ['scene_01'] },
        { window_id: 'hook_2', start_sec: 80, end_sec: 104, hook_score: 75, purpose: 'visual_hook', selected_scene_ids: ['scene_02'] },
        { window_id: 'hook_3', start_sec: 112, end_sec: 132, hook_score: 70, purpose: 'visual_hook', selected_scene_ids: ['scene_03'] },
        { window_id: 'hook_4', start_sec: 140, end_sec: 160, hook_score: 65, purpose: 'visual_hook', selected_scene_ids: ['scene_04'] },
        { window_id: 'hook_5', start_sec: 170, end_sec: 194, hook_score: 60, purpose: 'visual_hook', selected_scene_ids: ['scene_05'] }
      ]
    },
    ...extra
  };
}

function visionHookCandidate(index, startSec, endSec, action = 'press') {
  const labels = {
    press: ['hot press impact', '熱い素材をプレスで押し込み、厚みが一気に変わる場面です。', 'pressing', 'press machine', 'thickness change'],
    cut: ['blade cutting pass', '刃が素材に入り、断面がはっきり現れる切断場面です。', 'cutting', 'cutting blade', 'clean separation'],
    pour: ['liquid pour flow', '液体が型へ流れ込み、表面の形が変わっていく注入場面です。', 'pouring', 'mold and liquid', 'surface flow'],
    grind: ['surface grinding sparks', '回転工具で表面を削り、細かな火花と質感の変化が見える場面です。', 'grinding', 'rotary tool', 'surface texture'],
    assemble: ['part assembly snap', '部品同士が噛み合い、形が完成へ近づく組み立て場面です。', 'assembling', 'parts and jig', 'joined shape']
  };
  const [visualHook, sceneJa, distinctAction, focus, visualChange] = labels[action] || labels.press;
  return {
    window_id: `vision_hook_${String(index).padStart(2, '0')}`,
    start_sec: startSec,
    end_sec: endSec,
    duration_sec: Number((endSec - startSec).toFixed(3)),
    source_time_basis: 'absolute_original_seconds',
    selected_scene_ids: [`scene_${String(index).padStart(3, '0')}`],
    purpose: 'visual_hook',
    visual_hook: visualHook,
    why_this_clip: `${visualHook} shows a concrete source-observed action cycle with visible material change.`,
    first_second_hook: `The ${distinctAction} action starts immediately in frame.`,
    edit_note: `Keep the natural cycle from ${startSec}s to ${endSec}s without montage compression.`,
    scene_specific_explanation_ja: sceneJa,
    distinct_action: distinctAction,
    material_or_tool_focus: focus,
    visual_change: visualChange,
    hook_score: 10 - index,
    tempo_score: 5,
    tension_score: 4,
    transformation_score: 5,
    framing_score: 4,
    flow_score: 4,
    cycle_time_sec: 4,
    appears_sped_up: false,
    human_visibility: 'HANDS_ONLY',
    reason: `Vision observed ${distinctAction} scene with a clear ${visualChange}.`
  };
}

function goodVisionCandidateGuide(count = 5) {
  const actions = ['press', 'cut', 'pour', 'grind', 'assemble'];
  return {
    source_time_basis: 'absolute_original_seconds',
    hook_candidates: Array.from({ length: count }, (_, index) => visionHookCandidate(index + 1, index * 30 + 10, index * 30 + 22, actions[index % actions.length])),
    story_candidates: [],
    midform_candidates: []
  };
}

function testLaneThresholdDoesNotChangeOutputMode() {
  const shortDecision = queueTest.decideOutputModeForItem(itemWithDuration(92));
  assert(shortDecision.source_lane === queueTest.SOURCE_LANE_STANDARD_SHORTFORM, '92s source must stay on the standard shortform lane');
  assert(queueTest.effectiveDraftVariantModeForItem('all', itemWithDuration(92)) === 'highlight_only', 'active Phase 2 mode must be JP Highlight-only for standard shortform');
  assert(shortDecision.skip_midform_draft === true, 'standard shortform source must skip midform under the KR Full + JP Highlight contract');

  const boundaryDecision = queueTest.decideOutputModeForItem(itemWithDuration(queueTest.LONGFORM_COMPRESS_LANE_MIN_SOURCE_SEC));
  assert(boundaryDecision.source_lane === queueTest.SOURCE_LANE_STANDARD_SHORTFORM, 'threshold boundary must be exclusive so 120s does not unexpectedly switch lanes');

  const longDecision = queueTest.decideOutputModeForItem(itemWithDuration(121));
  assert(longDecision.source_lane === queueTest.SOURCE_LANE_LONGFORM_COMPRESS, '121s source must be marked eligible for longform compression');
  assert(queueTest.effectiveDraftVariantModeForItem('all', itemWithDuration(121)) === 'highlight_only', 'active Phase 2 mode must be JP Highlight-only for longform compression');
  assert(longDecision.skip_midform_draft === true, 'longform-compress lane must not request midform output');
}

function testExplicitLongformStaysHighlightOnly() {
  const explicitLongform = itemWithDuration(92, {
    source_type: 'longform',
    source_workflow_mode: 'longform_to_shorts'
  });
  const lane = queueTest.decideSourceLaneForItem(explicitLongform);
  assert(lane.source_lane === queueTest.SOURCE_LANE_LONGFORM_COMPRESS, 'explicit longform flag must mark the compression lane even below duration threshold');

  const effectiveHighlightMode = queueTest.effectiveDraftVariantModeForItem('highlight_only', explicitLongform);
  assert(effectiveHighlightMode === 'highlight_only', 'longform highlight-only must not promote into Full generation');

  const effectiveMidformMode = queueTest.effectiveDraftVariantModeForItem('midform_only', explicitLongform);
  assert(effectiveMidformMode === 'highlight_only', 'midform-only requests must be coerced to JP Highlight-only under the active policy');
}

function testFiveHighlightSelectionStillWorks() {
  const windows = queueTest.pickHighlightWindows(itemWithDuration(240, {
    source_type: 'longform',
    source_workflow_mode: 'longform_to_shorts'
  }), 24, 5);
  assert(windows.length === 5, `expected five highlight windows, got ${windows.length}`);
  assert(windows.every((window, index) => window.highlight_index === index + 1), 'highlight windows must keep highlight_index sequencing');
  assert(windows.every((window) => window.highlight_total === 5), 'highlight windows must keep highlight_total=5');
  assert(windows.every((window, index) => windows.every((other, otherIndex) => index === otherIndex || window.end_sec <= other.start_sec || other.end_sec <= window.start_sec)), 'highlight windows must not overlap');
}

function testAuxSourceDoesNotBleedIntoHighlightOrMidform() {
  const queueSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'processQueueService.js'), 'utf8');
  assert(queueSource.includes("aux_source_url: '',\n    aux_source_video: '',\n    target_duration_sec: window.duration_sec"), 'Highlight draft config must clear aux source fields before draft creation');
  assert(queueSource.includes('const wantsMidformDraft = false;'), 'Batch generation must not request midform drafts');
  assert(queueSource.includes('const shouldGenerateMidformDraft = false'), 'Midform draft creation must remain unreachable under the current contract');
}

function testFullDraftGenerationIsPolicyDisabled() {
  const queueSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'processQueueService.js'), 'utf8');
  assert(queueSource.includes('const wantsFullDraft = false;'), 'Active Phase 2 batch generation must not request Full drafts');
  assert(queueSource.includes('Full Draft generation is policy-disabled'), 'Full disabled status must be explicit in batch reports');
}

function testLongformCreatesFiveJpHighlights() {
  const windows = queueTest.pickHighlightWindows(itemWithDuration(240, {
    source_type: 'longform',
    source_workflow_mode: 'longform_to_shorts'
  }), 24, 5);
  assert(windows.length === 5, `expected five JP Highlight windows, got ${windows.length}`);
  assert(windows.every((window) => window.highlight_total === 5), 'five JP Highlight windows must be numbered as one ranked set');
}

function testLongformMetadataPromptsUseSourceContext() {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'processQueue.js'), 'utf8');
  const metadataSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'processMetadataService.js'), 'utf8');
  assert(routeSource.includes('function buildAnalysisSourceContext'), 'Metadata analysis callers must preserve Phase 1 source context');
  assert(routeSource.includes('source_discovery'), 'Metadata analysis source context must prefer source_discovery fields');
  assert(routeSource.includes('sourceContext: buildAnalysisSourceContext(itemConfig)'), 'Metadata analysis must pass sourceContext into Gemini');
  assert(metadataSource.includes('function sourceContextPromptLines'), 'Longform metadata prompts must render source context lines');
  assert(metadataSource.includes('Original YouTube Title'), 'Longform prompts must include the original YouTube title');
  assert(metadataSource.includes('Do not invent unrelated topics'), 'Longform final prompts must forbid unrelated subject drift');
}

function testLongformDoesNotUseLocalFallbackCandidatesForDrafts() {
  const queueSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'processQueueService.js'), 'utf8');
  const metadataSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'processMetadataService.js'), 'utf8');
  const runLongformStart = metadataSource.indexOf('async function runLongformGeminiPipeline');
  const runStandardStart = metadataSource.indexOf('async function runStandardGeminiPipeline');
  const runLongformSource = metadataSource.slice(runLongformStart, runStandardStart);
  assert(runLongformStart >= 0 && runStandardStart > runLongformStart, 'Longform pipeline source must be inspectable');
  assert(!runLongformSource.includes('buildLocalLongformCandidateGuide('), 'Longform pipeline must not create duration-based local candidate guides');
  assert(metadataSource.includes('function isLocalLongformCandidateGuide'), 'Existing local-preprocessed longform guides must be detected and ignored');
  assert(queueSource.includes('function isLocalOrFallbackLongformGuide'), 'Queue generation must detect local-preprocessed longform guides before draft selection');
  assert(queueSource.includes('isLocalOrFallbackLongformGuide(itemConfig.ottogi_guide_output || {})'), 'Longform draft selection must reject local-preprocessed item guides');
  assert(queueSource.includes('if (longformSource) return picked.length >= requestedCount ? picked : [];'), 'Longform Highlight must return only a complete real candidate set before evenly spaced fallback generation');
  assert(!queueSource.includes('fallback_full_highlight_candidate_scene'), 'KR Full backbone must not synthesize fallback candidate scenes for draft generation');
  assert(queueSource.includes('longform highlight draft blocked: no Gemini/Vision-backed highlight candidates available'), 'Longform Highlight must fail when no Gemini/Vision-backed candidates exist');
}

function testItem017StyleGenericLongformReturnsNoWindows() {
  const genericLongform = {
    item_id: 'item017_style_generic_longform',
    source_type: 'longform',
    source_workflow_mode: 'longform_to_shorts',
    target_duration_sec: 1176,
    video_metadata: { duration_sec: 1176 },
    source_classification: { duration_sec: 1176 },
    ottogi_guide_output: {
      hook_clip_10s: {
        start_sec: 8,
        end_sec: 24,
        duration_sec: 16,
        visual_hook: 'local candidate 1',
        why_this_clip: 'local segment probe fallback'
      },
      shortform_candidate_windows: [
        {
          start_sec: 8,
          end_sec: 24,
          duration_sec: 16,
          reason: 'local segment 1: visually active window inside 0-120s',
          visual_hook: 'local candidate 1',
          opening_type: 'local_segment_probe',
          purpose: 'visual_hook'
        }
      ],
      hook_candidates: [
        {
          start_sec: 8,
          end_sec: 24,
          duration_sec: 16,
          reason: 'local segment 1: visually active window inside 0-120s',
          visual_hook: 'local candidate 1',
          opening_type: 'local_segment_probe'
        }
      ],
      scene_transitions: [
        {
          scene_id: 'scene_001',
          start_sec: 0,
          end_sec: 5,
          transition_at_sec: 5,
          visual_summary: '工程の変化を確認する区間です。',
          caption_text: '工程の動き',
          caption_text_ko: '공정의 움직임에 주목',
          change_type: 'forced_3_second_rule',
          confidence: 'low'
        }
      ]
    }
  };
  const windows = queueTest.pickHighlightWindows(genericLongform, 24, 5);
  assert(windows.length === 0, `item_017-style generic/local longform candidates must be blocked, got ${windows.length}`);
}

function testLongformStrictVisionCandidateValidation() {
  const validated = metadataTest.validateLongformCandidateGuide(goodVisionCandidateGuide(5), 240, { strictHighlightCandidates: true });
  assert(validated.longform_candidate_schema_version === metadataTest.LONGFORM_VISION_CANDIDATE_SCHEMA_VERSION, 'validated longform candidates must carry the schema version marker');
  assert(validated.vision_backed_candidates === true, 'strict longform validation must mark candidates as Vision-backed');
  assert(validated.hook_candidates.length === 5, `expected 5 valid Vision-backed hook candidates, got ${validated.hook_candidates.length}`);
  assert(!validated.fallback_windows_applied.length, 'strict longform validation must not synthesize fallback windows');
}

function testLongformStrictValidationRejectsLocalFallback() {
  const localGuide = {
    source_time_basis: 'absolute_original_seconds',
    hook_candidates: [
      {
        start_sec: 8,
        end_sec: 24,
        duration_sec: 16,
        visual_hook: 'local candidate 1',
        reason: 'local segment 1: visually active window inside 0-120s',
        opening_type: 'local_segment_probe',
        selected_scene_ids: ['scene_001']
      }
    ],
    story_candidates: [],
    midform_candidates: []
  };
  let error = null;
  try {
    metadataTest.validateLongformCandidateGuide(localGuide, 1176, { strictHighlightCandidates: true });
  } catch (caught) {
    error = caught;
  }
  assert(error, 'strict longform validation must reject local fallback candidates');
  assert(error.code === 'OTTOGI_LONGFORM_HIGHLIGHT_CANDIDATES_REQUIRED', `expected candidates-required code, got ${error.code}`);
}

function testLongformStrictValidationRejectsTooFewCandidates() {
  let error = null;
  try {
    metadataTest.validateLongformCandidateGuide(goodVisionCandidateGuide(4), 240, { strictHighlightCandidates: true });
  } catch (caught) {
    error = caught;
  }
  assert(error, 'strict longform validation must reject fewer than five candidates');
  assert(error.details?.valid_hook_candidates_count === 4, `expected 4 valid hooks in error details, got ${error.details?.valid_hook_candidates_count}`);
}

function testLongformExistingLocalGuideForcesRescan() {
  const localExistingGuide = {
    local_preprocessed: true,
    local_candidate_strategy: { type: 'duration_segmented_prepass' },
    hook_candidates: [
      { start_sec: 8, end_sec: 24, visual_hook: 'local candidate 1', reason: 'local segment 1', opening_type: 'local_segment_probe' }
    ]
  };
  const reused = metadataTest.buildLongformCandidateGuideFromExisting(localExistingGuide, 1176);
  assert(reused === null, 'local-preprocessed longform guide must force a Vision rescan');
}

function testLongformQueueRequiresFiveValidWindows() {
  const fourCandidateItem = itemWithDuration(240, {
    source_type: 'longform',
    source_workflow_mode: 'longform_to_shorts',
    ottogi_guide_output: {
      shortform_candidate_windows: goodVisionCandidateGuide(4).hook_candidates
    }
  });
  const windows = queueTest.pickHighlightWindows(fourCandidateItem, 24, 5);
  assert(windows.length === 0, `longform queue must fail closed when fewer than five valid windows exist, got ${windows.length}`);
}

function main() {
  testLaneThresholdDoesNotChangeOutputMode();
  testExplicitLongformStaysHighlightOnly();
  testFiveHighlightSelectionStillWorks();
  testAuxSourceDoesNotBleedIntoHighlightOrMidform();
  testFullDraftGenerationIsPolicyDisabled();
  testLongformCreatesFiveJpHighlights();
  testLongformMetadataPromptsUseSourceContext();
  testLongformDoesNotUseLocalFallbackCandidatesForDrafts();
  testItem017StyleGenericLongformReturnsNoWindows();
  testLongformStrictVisionCandidateValidation();
  testLongformStrictValidationRejectsLocalFallback();
  testLongformStrictValidationRejectsTooFewCandidates();
  testLongformExistingLocalGuideForcesRescan();
  testLongformQueueRequiresFiveValidWindows();
  console.log('longform compress lane contract ok');
}

main();

const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const { GoogleAuth } = require('google-auth-library');
const { createHttpError } = require('./errorService');
const { loadPrompt } = require('./promptService');
const { computeCutSelectionTier } = require('../utils/cutSelectionTier');

const GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_VERTEX_LOCATION = 'global';
const DEFAULT_MULTIMODAL_MEDIA_RESOLUTION = 'MEDIA_RESOLUTION_LOW';
const FILE_POLL_INTERVAL_MS = 5000;
const FILE_POLL_MAX_RETRIES = 180;
const GEMINI_GENERATE_MAX_ATTEMPTS = 3;
const GEMINI_GENERATE_RETRY_BASE_MS = 10000;
const GEMINI_LONGFORM_FINAL_MAX_ATTEMPTS = 5;
const GEMINI_LONGFORM_FINAL_RETRY_BASE_MS = 60000;
const GEMINI_REQUEST_HEARTBEAT_MS = 25000;
const GEMINI_REQUEST_TIMEOUT_MS = 6 * 60 * 1000;
const SHORTFORM_HIGHLIGHT_GEMINI_TIMEOUT_MS = 3 * 60 * 1000;
const LOCAL_LONGFORM_CANDIDATE_MIN_DURATION_SEC = 180;
const LOCAL_LONGFORM_SEGMENT_SEC = 120;
const LOCAL_LONGFORM_SEGMENT_OVERLAP_SEC = 15;
const LOCAL_LONGFORM_HOOK_DURATION_SEC = 16;
const LOCAL_LONGFORM_STORY_DURATION_SEC = 60;
const LOCAL_LONGFORM_MIDFORM_DURATION_SEC = 120;
const ULTRA_LONGFORM_ANALYSIS_HORIZON_SEC = 1800;
const SHORT_DESCRIPTION_SOFT_MAX = 260;
const MIDFORM_CAPTION_MIN_ITEMS_120S = 30;
const MIDFORM_CAPTION_MAX_ITEMS_120S = 45;
const MIDFORM_CAPTION_SPLIT_COUNT = 2;
const KOREAN_FULL_SPEECH_CHARS_PER_SEC = 5.0;
const KOREAN_FULL_SPEECH_SAFETY_RATIO = 0.90;
const KOREAN_FULL_SPEECH_DEFAULT_MARGIN_SEC = 1.5;
const KOREAN_FULL_SPEECH_DEFAULT_SENTENCE_COUNT = 22;
const YOUTUBE_URL_RE = /^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i;

const KOREAN_FULL_HOOK_TYPES = Object.freeze({
  money: Object.freeze({
    type: 'money',
    label: '돈/가치 훅',
    instruction: '재료나 폐자재가 가치 있는 도구/부품으로 바뀌는 관점으로 시작하세요.',
    examples: ['버려질 줄 알았던 게', '돈 되는 부품으로', '다시 살아나는 과정']
  }),
  danger: Object.freeze({
    type: 'danger',
    label: '위험/실수 훅',
    instruction: '실수하면 흔들림, 파손, 화상, 절단, 오차가 생기는 리스크 관점으로 시작하세요.',
    examples: ['여기서 삐끗하면', '작은 오차 하나가', '전체를 망칠 수 있어요']
  }),
  transformation: Object.freeze({
    type: 'transformation',
    label: '변화/정체 훅',
    instruction: '처음에는 정체가 덜 보이지만 곧 무엇으로 바뀌는지 회수하는 변화 관점으로 시작하세요.',
    examples: ['처음엔 평범해 보여도', '이 재료가 곧', '형태를 바꿔요']
  }),
  precision: Object.freeze({
    type: 'precision',
    label: '정밀/이유 훅',
    instruction: '왜 순서와 기준을 맞춰야 하는지 정밀도 관점으로 시작하세요.',
    examples: ['순서가 중요한 이유는', '기준이 조금만 틀어져도', '결과가 달라져요']
  })
});

const KOREAN_FULL_HOOK_ROTATION = Object.freeze(['transformation', 'precision', 'money', 'danger']);

const OUTPUT_CONFIG = Object.freeze({
  highlight: Object.freeze({
    lang: 'ja',
    metadataKey: 'highlight_metadata',
    reviewMetadataKey: 'highlight_metadata_ko',
    captionMode: 'long_bottom_explainer',
    label: 'JP Highlight'
  }),
  full_draft: Object.freeze({
    lang: 'ko',
    metadataKey: 'full_metadata_ko',
    scriptKey: 'full_caption_script_ko',
    captionMode: 'scene_based_short_subtitles',
    label: 'KR Full',
    caption: Object.freeze({
      safeMaxChars: 16,
      promptTargetMinChars: 5,
      promptTargetMaxChars: 14
    })
  })
});

const LANGUAGE_CAPTION_CONFIG = Object.freeze({
  ja: Object.freeze({ safeMaxChars: 14 }),
  ko: Object.freeze({ safeMaxChars: OUTPUT_CONFIG.full_draft.caption.safeMaxChars })
});

function outputLanguageForVariant(variant = 'full') {
  return variant === 'full' ? OUTPUT_CONFIG.full_draft.lang : OUTPUT_CONFIG.highlight.lang;
}

function captionSafeMaxChars(language = 'ja') {
  return LANGUAGE_CAPTION_CONFIG[language]?.safeMaxChars || LANGUAGE_CAPTION_CONFIG.ja.safeMaxChars;
}

function roundSeconds(value = 0) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Number(number.toFixed(3)) : 0;
}

function countKoreanVisibleCharsNoSpaces(value = '') {
  return [...String(value || '').replace(/\s+/g, '')]
    .filter((char) => /[가-힣]/u.test(char))
    .length;
}

function countKoreanFullScriptVisibleChars(script = []) {
  const texts = (Array.isArray(script) ? script : [])
    .map((item) => (item && typeof item === 'object' ? item.text : item))
    .map((text) => String(text || ''))
    .filter(Boolean);
  return countKoreanVisibleCharsNoSpaces(texts.join(''));
}

function calculateKoreanFullSpeechBudget({
  targetDurationSec = 0,
  prerollSec = 0,
  marginSec = KOREAN_FULL_SPEECH_DEFAULT_MARGIN_SEC,
  sentenceCount = KOREAN_FULL_SPEECH_DEFAULT_SENTENCE_COUNT
} = {}) {
  const targetDuration = Math.max(0, Number(targetDurationSec || 0));
  const preroll = Math.max(0, Number(prerollSec || 0));
  const margin = Math.max(0, Number(marginSec || 0));
  const availableSec = Math.max(0, targetDuration - preroll - margin);
  const targetChars = Math.max(1, Math.floor(availableSec * KOREAN_FULL_SPEECH_CHARS_PER_SEC * KOREAN_FULL_SPEECH_SAFETY_RATIO));
  return {
    target_duration_sec: roundSeconds(targetDuration),
    preroll_sec: roundSeconds(preroll),
    margin_sec: roundSeconds(margin),
    available_sec: roundSeconds(availableSec),
    chars_per_sec: KOREAN_FULL_SPEECH_CHARS_PER_SEC,
    safety_ratio: KOREAN_FULL_SPEECH_SAFETY_RATIO,
    target_chars: targetChars,
    min_chars: Math.max(1, Math.floor(targetChars * 0.75)),
    max_chars: Math.max(1, Math.floor(targetChars * 1.10)),
    target_sentence_count: Math.max(1, Math.round(Number(sentenceCount || KOREAN_FULL_SPEECH_DEFAULT_SENTENCE_COUNT)))
  };
}

function durationFromWindow(value = {}) {
  if (!value || typeof value !== 'object') return 0;
  const explicit = Number(value.duration_sec || value.duration || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const start = Number(value.start_sec || value.start || 0);
  const end = Number(value.end_sec || value.end || 0);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : 0;
}

function isLegacyScriptSceneId(value = '') {
  return /^script[_-]\d+/u.test(String(value || '').trim());
}

function sceneTransitionIdSet(guide = {}) {
  return new Set((Array.isArray(guide?.scene_transitions) ? guide.scene_transitions : [])
    .map((scene) => String(scene?.scene_id || '').trim())
    .filter(Boolean));
}

function sceneTransitionPromptSummary(scenes = [], limit = 12) {
  return (Array.isArray(scenes) ? scenes : [])
    .slice(0, limit)
    .map((scene) => ({
      scene_id: scene.scene_id,
      start_sec: scene.start_sec,
      end_sec: scene.end_sec,
      visual_summary: scene.visual_summary,
      caption_text_ko: scene.caption_text_ko,
      scene_role: scene.scene_role,
      focus_target: scene.focus_target
    }))
    .filter((scene) => scene.scene_id);
}

function koreanFullSceneSpeechBudgetPromptLines(scenes = [], limit = 16) {
  const normalizedScenes = (Array.isArray(scenes) ? scenes : [])
    .slice(0, limit)
    .map((scene) => {
      const sceneId = String(scene?.scene_id || '').trim();
      const startSec = Number(scene?.start_sec || 0);
      const endSec = Number(scene?.end_sec || 0);
      const explicitDuration = Number(scene?.duration_sec || scene?.duration || 0);
      const durationSec = Number.isFinite(explicitDuration) && explicitDuration > 0
        ? explicitDuration
        : (Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec ? endSec - startSec : 0);
      if (!sceneId || !Number.isFinite(durationSec) || durationSec <= 0) return null;
      return {
        scene_id: sceneId,
        duration_sec: roundSeconds(durationSec),
        max_chars: Math.max(1, Math.floor(durationSec * KOREAN_FULL_SPEECH_CHARS_PER_SEC * KOREAN_FULL_SPEECH_SAFETY_RATIO))
      };
    })
    .filter(Boolean);
  if (!normalizedScenes.length) return [];
  return [
    '- 각 장면의 원고 분량 가이드:',
    ...normalizedScenes.map((scene) => `  ${scene.scene_id} (${scene.duration_sec}초): 약 ${scene.max_chars}자 이내`),
    '- 한 장면에 배정된 full_caption_script_ko 문장들의 한글 가시 글자 합이 그 장면 가이드를 넘지 않게 쓰세요.',
    '- 이 장면별 가이드는 1차 방어입니다. 최종 dry-run 시뮬레이션에서 장면 앵커 drift가 크면 실제 TTS 호출이 차단됩니다.'
  ];
}

function koreanFullSpeechBudgetFromGuide(guide = {}, durationSec = 0) {
  const existing = guide?.korean_full_speech_budget;
  if (existing && typeof existing === 'object' && Number(existing.target_chars) > 0) {
    return calculateKoreanFullSpeechBudget({
      targetDurationSec: existing.target_duration_sec || existing.targetDurationSec || durationSec,
      prerollSec: existing.preroll_sec || existing.prerollSec || 0,
      marginSec: existing.margin_sec || existing.marginSec || KOREAN_FULL_SPEECH_DEFAULT_MARGIN_SEC,
      sentenceCount: existing.target_sentence_count || existing.sentenceCount || KOREAN_FULL_SPEECH_DEFAULT_SENTENCE_COUNT
    });
  }
  const targetDurationSec = durationFromWindow(guide?.story_clip_40s)
    || durationFromWindow(guide?.recommended_full_window)
    || durationFromWindow(guide?.full_source_window)
    || Number(guide?.target_duration_sec || guide?.duration_sec || durationSec || 0);
  return calculateKoreanFullSpeechBudget({ targetDurationSec });
}

function koreanFullSpeechBudgetPromptLines(budget = {}) {
  const normalized = calculateKoreanFullSpeechBudget({
    targetDurationSec: budget.target_duration_sec,
    prerollSec: budget.preroll_sec,
    marginSec: budget.margin_sec,
    sentenceCount: budget.target_sentence_count
  });
  return [
    `- Korean Full prompt budget (model-facing): 이 영상 ${normalized.target_duration_sec}초. 원고 총 ${normalized.target_chars}자 ±10%, 문장 ${normalized.target_sentence_count}개 내외.`,
    `- Korean Full speech budget: this video is ${normalized.target_duration_sec}s. Write about ${normalized.target_chars} Korean visible characters total, with an acceptable prompt target of ±10%.`,
    `- Korean Full validation budget: hard lower signal ${normalized.min_chars} Korean chars, hard upper ${normalized.max_chars} Korean chars. Count Korean visible characters only, excluding spaces.`,
    `- Korean Full sentence plan: aim for about ${normalized.target_sentence_count} caption items. Keep each item short, but do not underwrite the narration below the budget.`
  ];
}

const OTTOGI_VARIANT_METADATA_SCHEMA = {
  type: 'object',
  properties: {
    short_description: { type: 'string' },
    summary_caption: { type: 'string' },
    variant_type: { type: 'string' },
    caption_mode: { type: 'string' },
    onscreen_subtitles: { type: 'array', items: { type: 'string' } },
    onscreen_caption_block: { type: 'string' },
    recommended_titles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          title: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } }
        },
        required: ['category', 'title', 'hashtags']
      }
    },
    report_description: { type: 'string' },
    upload_title: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } }
  },
  required: ['short_description', 'recommended_titles', 'report_description', 'summary_caption', 'caption_mode']
};

function buildVariantMetadataSchema(variant = 'full') {
  const schema = JSON.parse(JSON.stringify(OTTOGI_VARIANT_METADATA_SCHEMA));
  if (variant === 'highlight') {
    schema.required = [
      ...new Set([
        ...schema.required,
        'variant_type',
        'onscreen_caption_block',
        'upload_title',
        'hashtags'
      ])
    ];
  }
  return schema;
}

const OTTOGI_METADATA_SCHEMA = {
  type: 'object',
  properties: {
    short_description_200: { type: 'string' },
    short_description_ko: { type: 'string' },
    recommended_titles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          title: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } }
        },
        required: ['category', 'title', 'hashtags']
      }
    },
    recommended_titles_ko: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          title: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } }
        },
        required: ['category', 'title', 'hashtags']
      }
    },
    report_description: { type: 'string' },
    report_description_ko: { type: 'string' },
    explainer_text: { type: 'string' },
    explainer_text_ko: { type: 'string' },
    highlight_explainer_text: { type: 'string' },
    highlight_explainer_text_ko: { type: 'string' },
    full_metadata: OTTOGI_VARIANT_METADATA_SCHEMA,
    full_metadata_ko: OTTOGI_VARIANT_METADATA_SCHEMA,
    highlight_metadata: OTTOGI_VARIANT_METADATA_SCHEMA,
    highlight_metadata_ko: OTTOGI_VARIANT_METADATA_SCHEMA,
    midform_metadata: OTTOGI_VARIANT_METADATA_SCHEMA,
    midform_metadata_ko: OTTOGI_VARIANT_METADATA_SCHEMA,
    full_caption_script_ja: {
      type: 'array',
      minItems: 20,
      items: {
        type: 'object',
        properties: {
          scene_id: { type: 'string' },
          role: { type: 'string' },
          text: { type: 'string' },
          source_basis: { type: 'string' }
        },
        required: ['scene_id', 'role', 'text']
      }
    },
    full_caption_script_ko: {
      type: 'array',
      minItems: 20,
      items: {
        type: 'object',
        properties: {
          scene_id: { type: 'string' },
          role: { type: 'string' },
          text: { type: 'string' },
          source_basis: { type: 'string' }
        },
        required: ['scene_id', 'role', 'text']
      }
    },
    midform_caption_script_ja: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          scene_id: { type: 'string' },
          role: { type: 'string' },
          text: { type: 'string' },
          source_basis: { type: 'string' }
        },
        required: ['scene_id', 'role', 'text']
      }
    },
    midform_caption_script_ko: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          scene_id: { type: 'string' },
          role: { type: 'string' },
          text: { type: 'string' },
          source_basis: { type: 'string' }
        },
        required: ['scene_id', 'role', 'text']
      }
    },
    highlight_hook_captions_ja: { type: 'array', items: { type: 'string' } },
    highlight_hook_captions_ko: { type: 'array', items: { type: 'string' } },
    regional_editing_strategy: { type: 'object' },
    variant_strategy: { type: 'object' },
    four_part_scene_observation: {
      type: 'object',
      properties: {
        ki: { type: 'string' },
        seung: { type: 'string' },
        jeon: { type: 'string' },
        gyeol: { type: 'string' },
        key_scenes: { type: 'array', items: { type: 'string' } },
        onscreen_numbers: { type: 'array', items: { type: 'string' } },
        onomatopoeia: { type: 'array', items: { type: 'string' } }
      }
    },
    shorts_strategy_analysis: {
      type: 'object',
      properties: {
        framework_hint: { type: 'string' },
        framework_reason: { type: 'string' },
        emotion_info_hint: { type: 'string' },
        recommended_emotion_pct: { type: 'number' },
        recommended_info_pct: { type: 'number' },
        duplication_risk: { type: 'string' },
        duplication_reason: { type: 'string' },
        differentiation_note: { type: 'string' },
        recommended_emphasis: { type: 'string' }
      }
    },
    source_type: { type: 'string' },
    source_workflow_mode: { type: 'string' },
    shortform_candidate_windows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          window_id: { type: 'string' },
          start_sec: { type: 'number' },
          end_sec: { type: 'number' },
          purpose: { type: 'string' },
          hook_score: { type: 'number' },
          process_coverage: { type: 'string' },
          crop_hint: { type: 'string' },
          reason: { type: 'string' },
          cycle_time_sec: { type: 'number' },
          appears_sped_up: { type: 'boolean' },
          human_visibility: { type: 'string' }
        }
      }
    },
    hook_clip_10s: { type: 'object' },
    story_clip_40s: { type: 'object' },
    midform_clip_120s: { type: 'object' },
    recommended_full_window: { type: 'object' },
    recommended_highlight_window: { type: 'object' },
    recommended_midform_window: { type: 'object' },
    detected_subject: { type: 'string' },
    safety_note: { type: 'string' },
    source_url: { type: 'string' },
    scene_transitions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          scene_id: { type: 'string' },
          start_sec: { type: 'number' },
          end_sec: { type: 'number' },
          transition_at_sec: { type: 'number' },
          visual_summary: { type: 'string' },
          caption_text: { type: 'string' },
          caption_text_ko: { type: 'string' },
          screen_captions_ja: { type: 'array', items: { type: 'string' } },
          screen_captions_ko: { type: 'array', items: { type: 'string' } },
          change_type: { type: 'string' },
          confidence: { type: 'string' },
          focus_target: { type: 'string' },
          focus_zone: { type: 'string' },
          recommended_camera_move: { type: 'string' },
          motion_intensity: { type: 'string' },
          visual_hook_score: { type: 'integer' },
          visual_hook_type: { type: 'string' },
          curiosity_reason: { type: 'string' },
          repetition_potential: { type: 'integer' },
          mechanical_rhythm: { type: 'string' },
          tempo_score: { type: 'integer' },
          tension_score: { type: 'integer' },
          transformation_score: { type: 'integer' },
          framing_score: { type: 'integer' },
          flow_score: { type: 'integer' },
          a_grade_score: { type: 'integer' },
          scene_role: { type: 'string' },
          human_presence: { type: 'boolean' },
          process_focus_priority: { type: 'string' },
          cycle_time_sec: { type: 'number' },
          appears_sped_up: { type: 'boolean' },
          human_visibility: { type: 'string' }
        },
        required: [
          'scene_id',
          'start_sec',
          'end_sec',
          'transition_at_sec',
          'visual_summary',
          'caption_text',
          'focus_zone',
          'recommended_camera_move',
          'motion_intensity',
          'visual_hook_score',
          'curiosity_reason',
          'repetition_potential',
          'human_presence'
        ]
      }
    }
  },
  required: [
    'short_description_200',
    'short_description_ko',
    'recommended_titles',
    'recommended_titles_ko',
    'report_description',
    'report_description_ko',
    'explainer_text',
    'explainer_text_ko',
    'scene_transitions'
  ]
};

const OTTOGI_SCENE_SCHEMA = {
  type: 'object',
  properties: {
    detected_subject: { type: 'string' },
    source_type: { type: 'string' },
    source_workflow_mode: { type: 'string' },
    shortform_candidate_windows: OTTOGI_METADATA_SCHEMA.properties.shortform_candidate_windows,
    hook_clip_10s: { type: 'object' },
    story_clip_40s: { type: 'object' },
    recommended_full_window: { type: 'object' },
    recommended_highlight_window: { type: 'object' },
    scene_transitions: OTTOGI_METADATA_SCHEMA.properties.scene_transitions,
    highlight_hook_captions_ja: { type: 'array', items: { type: 'string' } },
    highlight_hook_captions_ko: { type: 'array', items: { type: 'string' } }
  },
  required: ['scene_transitions']
};

const LONGFORM_CANDIDATE_SCHEMA = {
  type: 'object',
  properties: {
    source_time_basis: { type: 'string' },
    hook_candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start_sec: { type: 'number' },
          end_sec: { type: 'number' },
          duration_sec: { type: 'number' },
          visual_hook: { type: 'string' },
          opening_type: { type: 'string' },
          hook_score: { type: 'number' },
          tempo_score: { type: 'number' },
          tension_score: { type: 'number' },
          transformation_score: { type: 'number' },
          framing_score: { type: 'number' },
          flow_score: { type: 'number' },
          reason: { type: 'string' },
          risk: { type: 'string' },
          cycle_time_sec: { type: 'number' },
          appears_sped_up: { type: 'boolean' },
          human_visibility: { type: 'string' }
        },
        required: ['start_sec', 'end_sec', 'duration_sec', 'visual_hook', 'reason']
      }
    },
    story_candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start_sec: { type: 'number' },
          end_sec: { type: 'number' },
          duration_sec: { type: 'number' },
          story_flow: { type: 'string' },
          opening_type: { type: 'string' },
          hook_score: { type: 'number' },
          process_coverage_score: { type: 'number' },
          reason: { type: 'string' },
          risk: { type: 'string' }
        },
        required: ['start_sec', 'end_sec', 'duration_sec', 'story_flow', 'reason']
      }
    },
    midform_candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start_sec: { type: 'number' },
          end_sec: { type: 'number' },
          duration_sec: { type: 'number' },
          process_flow: { type: 'string' },
          opening_type: { type: 'string' },
          atmosphere_score: { type: 'number' },
          process_coverage_score: { type: 'number' },
          reason: { type: 'string' },
          risk: { type: 'string' }
        },
        required: ['start_sec', 'end_sec', 'duration_sec', 'process_flow', 'reason']
      }
    }
  },
  required: ['source_time_basis', 'hook_candidates', 'story_candidates']
};

const LONGFORM_HOOK_SCHEMA = {
  type: 'object',
  properties: {
    hook_clip_10s: {
      type: 'object',
      properties: {
        start_sec: { type: 'number' },
        end_sec: { type: 'number' },
        duration_sec: { type: 'number' },
        source_time_basis: { type: 'string' },
        visual_hook: { type: 'string' },
        why_this_clip: { type: 'string' },
        first_second_hook: { type: 'string' },
        edit_note: { type: 'string' }
      },
      required: ['start_sec', 'end_sec', 'duration_sec', 'source_time_basis', 'visual_hook', 'why_this_clip']
    }
  },
  required: ['hook_clip_10s']
};

const LONGFORM_STORY_SCHEMA = {
  type: 'object',
  properties: {
    story_clip_40s: {
      type: 'object',
      properties: {
        start_sec: { type: 'number' },
        end_sec: { type: 'number' },
        duration_sec: { type: 'number' },
        source_time_basis: { type: 'string' },
        story_structure: {
          type: 'object',
          properties: {
            hook: { type: 'string' },
            reveal: { type: 'string' },
            process: { type: 'string' },
            climax: { type: 'string' },
            ending: { type: 'string' }
          }
        },
        why_this_window: { type: 'string' },
        relationship_to_hook_clip: { type: 'string' }
      },
      required: ['start_sec', 'end_sec', 'duration_sec', 'source_time_basis', 'why_this_window']
    }
  },
  required: ['story_clip_40s']
};

const OTTOGI_METADATA_ONLY_SCHEMA = {
  type: 'object',
  properties: {
    short_description_200: { type: 'string' },
    short_description_ko: { type: 'string' },
    recommended_titles: OTTOGI_METADATA_SCHEMA.properties.recommended_titles,
    recommended_titles_ko: OTTOGI_METADATA_SCHEMA.properties.recommended_titles_ko,
    report_description: { type: 'string' },
    report_description_ko: { type: 'string' },
    explainer_text: { type: 'string' },
    explainer_text_ko: { type: 'string' },
    highlight_explainer_text: { type: 'string' },
    highlight_explainer_text_ko: { type: 'string' },
    full_metadata: OTTOGI_VARIANT_METADATA_SCHEMA,
    full_metadata_ko: OTTOGI_VARIANT_METADATA_SCHEMA,
    highlight_metadata: OTTOGI_VARIANT_METADATA_SCHEMA,
    highlight_metadata_ko: OTTOGI_VARIANT_METADATA_SCHEMA,
    full_caption_script_ko: OTTOGI_METADATA_SCHEMA.properties.full_caption_script_ko,
    regional_editing_strategy: { type: 'object' },
    variant_strategy: { type: 'object' },
    detected_subject: { type: 'string' },
    safety_note: { type: 'string' },
    source_url: { type: 'string' }
  },
  required: ['short_description_ko', 'recommended_titles_ko', 'report_description_ko', 'explainer_text_ko', 'full_metadata_ko', 'full_caption_script_ko']
};

const OTTOGI_REVIEW_SCHEMA = OTTOGI_METADATA_SCHEMA;

const OTTOGI_CAPTION_REPAIR_SCHEMA = {
  type: 'object',
  properties: {
    scene_repairs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          scene_id: { type: 'string' },
          caption_text: { type: 'string' },
          caption_text_ko: { type: 'string' },
          screen_captions_ja: { type: 'array', items: { type: 'string' } },
          screen_captions_ko: { type: 'array', items: { type: 'string' } }
        },
        required: ['scene_id', 'caption_text', 'caption_text_ko', 'screen_captions_ja', 'screen_captions_ko']
      }
    }
  },
  required: ['scene_repairs']
};

// Metadata repair must stay intentionally thin for Vertex responseSchema.
// Do not reuse OTTOGI_METADATA_SCHEMA or OTTOGI_VARIANT_METADATA_SCHEMA here:
// large nested schemas can trigger Vertex INVALID_ARGUMENT "too many states".
const OTTOGI_METADATA_FIELD_REPAIR_SCHEMA = {
  type: 'object',
  properties: {
    repaired_fields: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        properties: {
          field: { type: 'string' },
          value: { type: 'string' }
        },
        required: ['field', 'value']
      }
    }
  },
  required: ['repaired_fields']
};

const FULL_CAPTION_SCRIPT_REPAIR_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    scene_id: { type: 'string' },
    role: { type: 'string' },
    text: { type: 'string' },
    source_basis: { type: 'string' }
  },
  required: ['scene_id', 'role', 'text', 'source_basis']
};

const OTTOGI_FULL_CAPTION_SCRIPT_REPAIR_SCHEMA = {
  type: 'object',
  properties: {
    full_caption_script_ko: {
      type: 'array',
      minItems: 20,
      maxItems: 24,
      items: FULL_CAPTION_SCRIPT_REPAIR_ITEM_SCHEMA
    }
  },
  required: ['full_caption_script_ko']
};

const CAPTION_REPAIR_BATCH_SIZE = 12;

const DEFAULT_REGIONAL_EDITING_STRATEGY = {
  kr: {
    viewer_intent: 'fast understanding, result impact, clear process value',
    hook_style: 'result_first',
    caption_style: 'short spoken Korean with clear information',
    emphasis_keywords: ['자동', '정밀', '한 번에', '고정', '완성'],
    avoid: ['명사 나열', '번역체', '긴 설명문', '낚시처럼 오래 숨기기']
  },
  jp: {
    viewer_intent: 'process curiosity, satisfying observation rhythm, midokoro focus',
    hook_style: 'curiosity_first',
    caption_style: 'natural Japanese Shorts phrasing',
    emphasis_keywords: ['見どころ', '気持ちいい', 'ぴったり', '全部自動'],
    avoid: ['直訳', '技術資料調', '硬い名詞表現', '強すぎる煽り']
  }
};

const DEFAULT_VARIANT_STRATEGY = {
  jp_full: {
    cut_plan_source: 'full_cut_plan_base',
    caption_goal: 'process observation and satisfying flow',
    metadata_goal: 'Japanese process-observation upload copy'
  },
  jp_highlight: {
    cut_plan_source: 'highlight_cut_plan_base',
    caption_goal: 'satisfying visual hook and curiosity',
    metadata_goal: 'Japanese visual-hook upload copy'
  },
  jp_midform: {
    cut_plan_source: 'midform_cut_plan_base',
    caption_goal: 'fuller Japanese process-flow explanation across the selected 120-second window',
    metadata_goal: 'Japanese midform process upload copy'
  },
  ko_review: {
    cut_plan_source: 'none',
    caption_goal: 'Korean review text only for local checking',
    metadata_goal: 'review-only Korean summary that must not be uploaded'
  },
  phase2_note: 'Phase 2 creates JP Full, JP Highlight, and JP Midform drafts only. Korean text is review-only inside each TXT package and must not become upload metadata or a draft variant.'
};

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeRegionalEditingStrategy(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    ...cloneJson(DEFAULT_REGIONAL_EDITING_STRATEGY),
    ...source,
    kr: {
      ...DEFAULT_REGIONAL_EDITING_STRATEGY.kr,
      ...(source.kr || source.korean || {})
    },
    jp: {
      ...DEFAULT_REGIONAL_EDITING_STRATEGY.jp,
      ...(source.jp || source.japanese || {})
    }
  };
}

function normalizeVariantStrategy(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    ...cloneJson(DEFAULT_VARIANT_STRATEGY),
    ...source,
    jp_full: {
      ...DEFAULT_VARIANT_STRATEGY.jp_full,
      ...(source.jp_full || source.full || {})
    },
    jp_highlight: {
      ...DEFAULT_VARIANT_STRATEGY.jp_highlight,
      ...(source.jp_highlight || source.highlight || {})
    },
    jp_midform: {
      ...DEFAULT_VARIANT_STRATEGY.jp_midform,
      ...(source.jp_midform || source.midform || {})
    },
    ko_review: {
      ...DEFAULT_VARIANT_STRATEGY.ko_review,
      ...(source.ko_review || source.korean_review || {})
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkCancellation(throwIfCancelled) {
  if (typeof throwIfCancelled === 'function') {
    throwIfCancelled();
  }
}

async function cancellableSleep(ms, throwIfCancelled) {
  const totalMs = Math.max(0, Number(ms) || 0);
  const deadline = Date.now() + totalMs;
  checkCancellation(throwIfCancelled);
  while (Date.now() < deadline) {
    await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
    checkCancellation(throwIfCancelled);
  }
}

function normalizeFileState(file) {
  return String(file?.state || '').toUpperCase();
}

function resolveVertexLocation(config = {}) {
  return String(
    process.env.PROCESS_METADATA_VERTEX_LOCATION
    || process.env.GEMINI_VERTEX_LOCATION
    || DEFAULT_VERTEX_LOCATION
    || config.location
    || ''
  ).trim() || 'global';
}

function buildVertexEndpoint(config = {}) {
  const override = String(process.env.GEMINI_VERTEX_ENDPOINT_OVERRIDE || '').trim();
  if (override) return override;
  const location = resolveVertexLocation(config);
  const host = location === 'global'
    ? 'https://aiplatform.googleapis.com'
    : `https://${location}-aiplatform.googleapis.com`;
  return `${host}/v1/projects/${config.project}/locations/${location}/publishers/google/models/${config.model}:generateContent`;
}

function buildMultimodalGenerationConfig({ responseSchema, includeVideo = false } = {}) {
  return {
    responseMimeType: 'application/json',
    responseSchema,
    ...(includeVideo ? { mediaResolution: DEFAULT_MULTIMODAL_MEDIA_RESOLUTION } : {})
  };
}

function safeDebugName(value = '') {
  return String(value || 'unknown')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown';
}

function writeGeminiDebugFile({ phase = 'unknown', attempt = 0, kind = 'raw', text = '', filename = '' } = {}) {
  try {
    const debugRoot = path.join(process.cwd(), 'server', 'output', 'gemini_debug');
    fs.mkdirSync(debugRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = `${stamp}_${safeDebugName(filename)}_${safeDebugName(phase)}_${attempt}_${kind}.txt`;
    const filePath = path.join(debugRoot, file);
    fs.writeFileSync(filePath, String(text || ''), 'utf8');
    return filePath;
  } catch {
    return '';
  }
}

function cleanJsonText(text) {
  let cleaned = String(text || '').trim();
  cleaned = cleaned
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) {
    cleaned = cleaned.slice(first, last + 1);
  }

  return cleaned
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
}

function extractJson(text, context = {}) {
  const raw = String(text || '');
  try {
    return JSON.parse(raw);
  } catch {
    const cleaned = cleanJsonText(raw);
    try {
      return JSON.parse(cleaned);
    } catch {
      const rawPath = writeGeminiDebugFile({ ...context, kind: 'raw', text: raw });
      const cleanedPath = writeGeminiDebugFile({ ...context, kind: 'cleaned', text: cleaned });
      throw createHttpError(500, 'OTTOGI_METADATA_JSON_PARSE_ERROR', 'Gemini metadata response was not valid JSON', {
        snippet: raw.slice(0, 500),
        raw_response_path: rawPath,
        cleaned_response_path: cleanedPath,
        phase: context.phase || '',
        attempt: context.attempt || 0
      });
    }
  }
}

function buildPrompt({ sourceUrl, filename, durationSec }) {
  return loadPrompt('ottogi_process_metadata.txt')
    .replace('{sourceUrl}', sourceUrl || 'not provided')
    .replace('{filename}', filename || 'unknown')
    .replace('{durationSec}', String(durationSec || 'unknown'));
}

function buildScenePrompt({ sourceUrl, filename, durationSec, sourceType = 'unknown', sourceWorkflowMode = 'unknown', metadataVariantMode = 'all' }) {
  const longformInstructions = sourceWorkflowMode === 'longform_to_shorts' || sourceType === 'longform'
    ? [
        '',
        'Long-form source handling:',
        '- This source is long-form or likely long-form. Do not compress the whole video blindly.',
        '- First identify short-form candidate windows suitable for vertical short videos.',
        '- Return shortform_candidate_windows with 3 to 8 candidates when possible.',
        '- Each candidate window should include start_sec, end_sec, purpose, hook_score, process_coverage, crop_hint, and reason.',
        '- Produce two different long-form extraction outputs: hook_clip_10s and story_clip_40s.',
        '- hook_clip_10s is NOT a summary. It is the strongest visual teaser only: strange, satisfying, fast-moving, repetitive, cutting, pressing, pouring, transforming, assembling, or a result-reveal moment.',
    '- hook_clip_10s is a legacy field name. For long-form sources, the actual highlight may be 6 to 24 seconds if that is needed for one complete action cycle to end naturally.',
    '- The first second must make viewers wonder "what is this?". Use very few captions.',
        '- story_clip_40s is the JP Full core-process window. Despite the legacy field name, it should usually last 55 to 65 seconds, preferably 60 seconds.',
        '- story_clip_40s must cover ONE coherent core process only. Do not combine unrelated processes from different parts of the long video.',
        '- hook_clip_10s and story_clip_40s must contain real absolute source timestamps in seconds. Do not return empty objects.',
        '- Do not use sampled, normalized, or relative timeline values such as 0.11 to 0.25 unless the source video itself is truly under one second.',
    '- If a visually strong moment is very brief, expand the window before and after it so hook_clip_10s covers one natural action cycle, while story_clip_40s is still about 60 seconds when the source is long enough.',
        '- shortform_candidate_windows are also real source timestamp windows. Each candidate should usually last at least 4 seconds.',
        '- Set recommended_highlight_window to the same start_sec/end_sec as hook_clip_10s for backwards compatibility.',
        '- Set recommended_full_window to the same start_sec/end_sec as story_clip_40s for backwards compatibility.',
        '- scene_transitions must describe ONLY the selected 60-second story_clip_40s core process, not the whole long-form source and not hook_clip_10s.',
        '- Return 8 to 16 scene_transitions for story_clip_40s. Do not return dozens of scenes from the whole long-form video.',
        '- If the long-form video contains many unrelated processes, ignore the weaker ones and use only the strongest coherent process.',
        '- Scene timestamps may be global source timestamps within the selected window. Draft generation will shift selected windows to timeline zero.',
        ''
      ]
    : [];
  return [
    'You are the scene analysis engine for the 3-minute Ottogi process video workflow.',
    'Analyze only the visible video structure and return JSON only. Do not include Markdown.',
    '',
    'Main output language: Japanese. Korean fields are review-only and must never be treated as upload metadata.',
    '',
    'Required task:',
    '- Keep this analysis lightweight and visual. Do not perform four-part narrative analysis, 10-framework strategy classification, or duplication strategy analysis here.',
    '- Return only the scene/cut information needed for editing, highlight selection, focus crop, and later Full Draft script writing.',
    '- Detect scene transitions and meaningful process/action changes.',
    '- If no clear scene transition exists, create scene timestamps using a forced 3-second rule.',
    '- Every scene\'s start_sec/end_sec/transition_at_sec must be REAL absolute source seconds spanning the whole video. Collapsed or placeholder values (e.g. every scene reporting start 1 / end 1.2) are forbidden -- if the video is 58 seconds long, the scene list must cover roughly 0 to 58 seconds.',
    '- Every scene must include start_sec, end_sec, transition_at_sec, visual_summary, caption_text, caption_text_ko, screen_captions_ja, screen_captions_ko, focus_target, focus_zone, recommended_camera_move, motion_intensity, visual_hook_score, visual_hook_type, curiosity_reason, repetition_potential, mechanical_rhythm, human_presence, process_focus_priority.',
    '- Also include A-grade scoring fields: tempo_score, tension_score, transformation_score, framing_score, flow_score, a_grade_score, and scene_role.',
    '- Score scenes using manufacturing-process criteria: tempo, machine/hand tension, instant transformation, close-up/POV framing, and repeated flow.',
    '',
    'Cut-quality fields (measured facts about the footage, not stylistic judgments):',
    '- cycle_time_sec: how many seconds ONE complete action cycle takes at the footage\'s natural playback speed within this scene (from action start, through impact/peak, to reset or result). If no complete cycle is visible, estimate from the visible portion.',
    '- appears_sped_up: true only if the footage itself is visibly time-lapsed or fast-forwarded (unnaturally fast motion, jerky frame pacing). Normal fast work by a skilled worker at real speed is NOT sped up.',
    '- human_visibility: exactly one of "FULL_PERSON" (a person\'s full body or most of it is visible performing the action), "HANDS_ONLY" (only hands/arms visible), "NONE" (no human visible).',
    '- A visible person performing the action is a positive signal for scene value. The earlier rule about not making the person the main subject is about caption/story focus, not about avoiding scenes where a person is visible.',
    '- caption_text and screen_captions_ja must be natural Japanese only. Do not output English captions in Japanese fields.',
    '- Do not use emoji, emoticons, decorative symbols, or reaction icons in any caption field.',
    '- caption_text_ko and screen_captions_ko must be natural Korean review captions for local checking only.',
    '- JP Full screen_captions_ja must be observational: describe what is visibly happening in that exact cut, as if the viewer is watching the action now.',
    '- Korean review captions should explain what the Japanese viewer-facing caption means, but they are not a separate draft variant.',
    '- Japanese screen captions are the only viewer-facing draft captions.',
    '',
    'On-screen caption writing rules for full drafts:',
    '- Do not translate long sentences. Rewrite them as short spoken Shorts captions for the edited cut rhythm.',
    '- Do not output noun-only labels, keyword tags, or factory-report terms.',
    '- Do not split grammar across caption lines. A caption line must not end with an unfinished particle, comma, or verb stem.',
    '- Bad Japanese fragments: "そろばん珠を", "日本の伝統、", "まず木材から珠を作り", "ます", "専用の機械で正確に穴", "を開け".',
    '- Good Japanese captions: "木片に穴を開ける", "珠の形が見える", "銅色の珠を並べる", "最後は手で整える".',
    '- One caption unit should contain one visible action or one short idea only.',
    '- Use short natural spoken sentences. Long explanation is forbidden, but a short sentence that reads naturally is allowed.',
    '- Avoid stiff explanation wording such as "a series of processes", "shows the process", "until it is assembled", or similar textbook phrasing.',
    '- Japanese screen_captions_ja: observation-style captions for each cut. Use visible-action wording such as "型に流れ込む", "表面を整える", "形が見えてくる". Do not explain the whole process.',
    '- Korean screen_captions_ko: explanation-style captions for each cut. Use short helpful wording such as "틀 안으로 퍼지고", "형태가 잡히는 단계", "표면을 다시 다듬기". Do not write a full paragraph.',
    '- Japanese screen_captions_ja should usually be around 8 to 18 Japanese characters when needed, but natural phrase completion is more important than exact character count.',
    '- Korean screen_captions_ko should usually be around 8 to 20 Korean characters when needed.',
    '- Use multiple screen_captions_* items per scene when the scene has multiple actions.',
    '- caption_text can be a compact scene summary, but screen_captions_* are the actual on-screen spoken rhythm captions.',
    '- Good Japanese style examples: "これ何だろう", "タイヤを作る", "形を整えて", "リムに合わせる", "空気で支える".',
    '- Bad Japanese style examples: "タイヤ骨格形成", "ロボット搬送", "空気圧注入", "固定完了", "精密自動化工程".',
    '- Good Korean style examples: "이게 뭔지 아세요?", "타이어를 만들고", "모양을 맞춰", "휠에 끼운 뒤", "공기로 버텨요".',
    '- Bad Korean style examples: "타이어 골격 형성", "로봇 운반", "공기 압력 주입", "고정 완료", "정밀 자동화 공정".',
    '- Focus on material, machine, hands, or process. If a person is visible, do not make the person the main subject.',
    '- Highlight scoring should prefer visual hooks, mechanical repetition, material transformation, close-up curiosity, texture flow, color contrast, and hand-machine interaction.',
    ...longformInstructions,
    '',
    'Source information:',
    `- Source URL: ${sourceUrl || 'not provided'}`,
    `- Original Filename: ${filename || 'unknown'}`,
    `- Duration Sec: ${durationSec || 'unknown'}`,
    `- Source Type: ${sourceType || 'unknown'}`,
    `- Source Workflow Mode: ${sourceWorkflowMode || 'unknown'}`,
    '',
    'Return JSON only.'
  ].join('\n');
}

function buildLongformCandidatePrompt({ sourceUrl, filename, durationSec, sourceType = 'longform', sourceWorkflowMode = 'longform_to_shorts' }) {
  return [
    'You are a long-form video editor analyzing a source for short-form extraction.',
    'Find candidate windows only. Return JSON only. Do not include Markdown.',
    '',
    'Critical rules:',
    '- Do not write captions.',
    '- Do not write titles.',
    '- Do not write metadata.',
    '- Find candidate time windows only.',
    '- First observe visible actions across the long-form source, then choose candidates from those observations. Do not infer a strategy before observing the footage.',
    '- Every timestamp must be absolute original source seconds.',
    '- Relative, sampled, normalized, or frame-local timestamps are forbidden.',
    '- Values like 0.11 to 0.25 are forbidden unless the full source itself is under one second.',
    '- end_sec must be greater than start_sec.',
    '',
    'A-grade manufacturing scene rubric:',
    '- Detection cues: human-machine synchronization, instant transformation within 1-2 seconds, and rhythmic audio or repeated physical cycle.',
    '- Cut points: start 0.5 seconds before the hand/tool/material enters the danger/work zone; peak at press/cut/bend/pour/impact; end when the processed part exits and the worker/machine resets.',
    '- Score every strong candidate with five 1-5 sub-scores: tempo_score, tension_score, transformation_score, framing_score, flow_score.',
    '- hook_score should reflect the total A-grade value. Strong scenes have fast tempo, visible tension near the machine, obvious material transformation, close-up/POV framing, and repeated flow.',
    '- Avoid scoring static overview, packaging, final-product-only, or explanation-only shots as high hook candidates.',
    '- Do not run 10-framework, emotion/info, or duplication strategy analysis here. Candidate selection must stay visual, fast, and timestamp-focused.',
    '',
    'Cut-quality fields (report measured facts for every hook candidate):',
    '- cycle_time_sec: how many seconds ONE complete action cycle takes at natural playback speed within the candidate window (action start -> impact/peak -> reset or result). A short complete cycle (5 seconds or less) is a strong positive signal.',
    '- appears_sped_up: true only if the source footage itself is visibly time-lapsed or fast-forwarded. Sped-up footage is a negative signal that editing cannot fix. Normal fast real-speed work is NOT sped up.',
    '- human_visibility: exactly one of "FULL_PERSON", "HANDS_ONLY", "NONE". A fully visible person performing the action is a positive signal.',
    '',
    'Find:',
    '1. hook_candidates',
    '- 6 to 24 seconds each. Prefer the natural end of one action cycle over forcing exactly 10 seconds.',
    '- Strongest visual hook moments: repetition, pressing, cutting, pouring, transforming, assembling, rapid machine movement, texture flow, or dangerous-looking hand-machine synchronization.',
    '- Each hook candidate must be one continuous source window focused on one specific process/action only.',
    '- Do not create hook candidates by summarizing many different long-form moments.',
    '- Do not choose montage, overview, compilation, or many-scene recap sections for hook candidates.',
    '- Start in-media-res from the strongest Action moment, not from the beginning of the process.',
    '- Logical process order is not important for hook_candidates. Dopamine, rhythm, curiosity, and visual impact are more important.',
    '- Must be visually interesting without explanation.',
    '',
    '2. story_candidates',
    '- 55 to 65 seconds each, preferably about 60 seconds.',
    '- One coherent core process or event flow only.',
    '- Should show material input -> core processing -> inspection/result inside one continuous work zone when possible.',
    '- Must be useful for understanding how or why the thing is made, not merely a chain of intense hook shots.',
    '- May overlap the hook candidate, but must not be identical to it.',
    '- For 16:9 long-form sources, prefer a process where the active tool/material area can be enlarged as a vertical 9:16 crop.',
    '',
    '3. midform_candidates',
    '- 105 to 130 seconds each, preferably around 120 seconds.',
    '- Use only when the source is long enough to support it.',
    '- Should start from Ambient or context when possible: factory atmosphere, machine warm-up, wide shot, preparation, or a strong establishing shot.',
    '- Should cover the broadest useful process flow: input/material, setup, main process, transformation, result, and closing.',
    '- Must start at a different source moment from hook_candidates and story_candidates when possible.',
    '',
    'Return shape:',
    JSON.stringify({
      source_time_basis: 'absolute_original_seconds',
      hook_candidates: [
        {
          start_sec: 0,
          end_sec: 10,
          duration_sec: 10,
          visual_hook: '',
          opening_type: 'action_peak',
          hook_score: 9,
          tempo_score: 5,
          tension_score: 5,
          transformation_score: 5,
          framing_score: 5,
          flow_score: 5,
          cycle_time_sec: 4,
          appears_sped_up: false,
          human_visibility: 'FULL_PERSON',
          reason: '',
          risk: ''
        }
      ],
      story_candidates: [
        {
          start_sec: 0,
          end_sec: 60,
          duration_sec: 60,
          story_flow: '',
          opening_type: 'result_or_raw_material',
          hook_score: 7,
          process_coverage_score: 5,
          reason: '',
          risk: ''
        }
      ],
      midform_candidates: [
        {
          start_sec: 0,
          end_sec: 120,
          duration_sec: 120,
          process_flow: '',
          opening_type: 'ambient_context',
          atmosphere_score: 5,
          process_coverage_score: 5,
          reason: '',
          risk: ''
        }
      ]
    }, null, 2),
    '',
    'Source information:',
    `- Source URL: ${sourceUrl || 'not provided'}`,
    `- Original Filename: ${filename || 'unknown'}`,
    `- Duration Sec: ${durationSec || 'unknown'}`,
    `- Source Type: ${sourceType || 'unknown'}`,
    `- Source Workflow Mode: ${sourceWorkflowMode || 'unknown'}`
  ].join('\n');
}

function clampWindowStart(startSec = 0, durationSec = 0, sourceDurationSec = 0) {
  const duration = Math.max(1, Number(durationSec || 0));
  const sourceDuration = Number(sourceDurationSec || 0);
  const requestedStart = Math.max(0, Number(startSec || 0));
  if (!Number.isFinite(sourceDuration) || sourceDuration <= duration) return Math.max(0, requestedStart);
  return Math.min(requestedStart, Math.max(0, sourceDuration - duration));
}

function buildLocalLongformWindow({ startSec = 0, durationSec = 10, sourceDurationSec = 0, reason = '', extra = {} } = {}) {
  const sourceDuration = Number(sourceDurationSec || 0);
  const requestedDuration = Math.max(1, Number(durationSec || 0));
  const duration = Number.isFinite(sourceDuration) && sourceDuration > 0
    ? Math.min(requestedDuration, sourceDuration)
    : requestedDuration;
  const start = clampWindowStart(startSec, duration, sourceDuration);
  return {
    start_sec: Number(start.toFixed(3)),
    end_sec: Number((start + duration).toFixed(3)),
    duration_sec: Number(duration.toFixed(3)),
    reason,
    ...extra
  };
}

function buildLocalLongformCandidateGuide({ durationSec = 0, sourceType = 'longform', sourceWorkflowMode = 'longform_to_shorts' } = {}) {
  const sourceDuration = Number(durationSec || 0);
  const analysisDuration = sourceDuration > ULTRA_LONGFORM_ANALYSIS_HORIZON_SEC
    ? ULTRA_LONGFORM_ANALYSIS_HORIZON_SEC
    : sourceDuration;
  const segmentStep = Math.max(30, LOCAL_LONGFORM_SEGMENT_SEC - LOCAL_LONGFORM_SEGMENT_OVERLAP_SEC);
  const segmentStarts = [];
  for (let start = 0; start < Math.max(analysisDuration, 1); start += segmentStep) {
    segmentStarts.push(start);
    if (analysisDuration > 0 && start + LOCAL_LONGFORM_SEGMENT_SEC >= analysisDuration) break;
  }
  if (!segmentStarts.length) segmentStarts.push(0);

  const hookCandidates = segmentStarts.slice(0, 6).map((segmentStart, index) => {
    const hookStart = segmentStart + Math.max(6, Math.min(36, index * 4 + 8));
    return buildLocalLongformWindow({
      startSec: hookStart,
      durationSec: LOCAL_LONGFORM_HOOK_DURATION_SEC,
      sourceDurationSec: analysisDuration,
      reason: `local segment ${index + 1}: visually active window inside ${Math.round(segmentStart)}-${Math.round(Math.min(analysisDuration, segmentStart + LOCAL_LONGFORM_SEGMENT_SEC))}s`,
      extra: {
        visual_hook: `local candidate ${index + 1}`,
        opening_type: 'local_segment_probe',
        hook_score: Math.max(5, 9 - index),
        tempo_score: Math.max(3, 5 - Math.floor(index / 2)),
        tension_score: Math.max(3, 5 - Math.floor(index / 2)),
        transformation_score: Math.max(3, 5 - Math.floor(index / 3)),
        framing_score: 3,
        flow_score: 3,
        cycle_time_sec: 4,
        appears_sped_up: false,
        human_visibility: 'UNKNOWN'
      }
    });
  });

  const storyStarts = [0, Math.max(0, analysisDuration * 0.25), Math.max(0, analysisDuration * 0.5), Math.max(0, analysisDuration * 0.7)]
    .map((value) => Number(value || 0));
  const storyCandidates = Array.from(new Set(storyStarts.map((value) => clampWindowStart(value, LOCAL_LONGFORM_STORY_DURATION_SEC, analysisDuration)))).slice(0, 4)
    .map((startSec, index) => buildLocalLongformWindow({
      startSec,
      durationSec: LOCAL_LONGFORM_STORY_DURATION_SEC,
      sourceDurationSec: analysisDuration,
      reason: `local story window ${index + 1}: broad process coverage around ${Math.round(startSec)}s`,
      extra: {
        story_flow: `local story candidate ${index + 1}`,
        opening_type: index === 0 ? 'result_or_raw_material' : 'local_segment_probe',
        hook_score: Math.max(5, 8 - index),
        process_coverage_score: Math.max(3, 5 - Math.floor(index / 2))
      }
    }));

  const midformCandidates = analysisDuration >= 125
    ? [buildLocalLongformWindow({
        startSec: clampWindowStart(analysisDuration * 0.2, LOCAL_LONGFORM_MIDFORM_DURATION_SEC, analysisDuration),
        durationSec: LOCAL_LONGFORM_MIDFORM_DURATION_SEC,
        sourceDurationSec: analysisDuration,
        reason: 'local midform candidate from longform duration segmentation',
        extra: {
          process_flow: 'local midform candidate 1',
          opening_type: 'ambient_context',
          atmosphere_score: 4,
          process_coverage_score: 4
        }
      })]
    : [];

  return {
    source_time_basis: 'absolute_original_seconds',
    source_type: sourceType,
    source_workflow_mode: sourceWorkflowMode,
    hook_candidates: hookCandidates,
    story_candidates: storyCandidates,
    midform_candidates: midformCandidates,
    local_preprocessed: true,
    local_candidate_strategy: {
      type: 'duration_segmented_prepass',
      source_duration_sec: Number(sourceDuration.toFixed(3)),
      analysis_duration_sec: Number(analysisDuration.toFixed(3)),
      capped_to_analysis_horizon: sourceDuration > analysisDuration,
      segment_sec: LOCAL_LONGFORM_SEGMENT_SEC,
      overlap_sec: LOCAL_LONGFORM_SEGMENT_OVERLAP_SEC,
      generated_hook_candidates: hookCandidates.length,
      generated_story_candidates: storyCandidates.length,
      generated_midform_candidates: midformCandidates.length
    }
  };
}

function buildLongformHookPrompt({ candidateGuide }) {
  // Deterministic tier annotation so the "prefer T1 over T2 over T3" prompt
  // instruction below refers to a label we computed, not one Gemini invents.
  const annotatedGuide = candidateGuide && Array.isArray(candidateGuide.hook_candidates)
    ? {
        ...candidateGuide,
        hook_candidates: candidateGuide.hook_candidates.map((candidate) => ({
          ...candidate,
          cut_selection_tier: computeCutSelectionTier(candidate)
        }))
      }
    : candidateGuide;
  return [
    'You are an editing director choosing one natural-action highlight for YouTube Shorts.',
    'Choose exactly one hook_clip_10s from the candidates. Return JSON only.',
    '',
    'Goal:',
    '- This is not a summary.',
    '- Pick the strongest visual moment.',
    '- The first second must stop the viewer.',
    '- It should be rewatchable and visually rhythmic.',
    '- Prefer the candidate with the highest A-grade hook_score and strongest combination of tempo, tension, transformation, close-up framing, and repeated flow.',
    '- The opening should be an Action peak: press/cut/pour/bend/impact, hand-machine synchronization, or instant material transformation.',
    '- Cut-quality priority (based on measured hit-rate data): prefer candidates where cycle_time_sec is 5 seconds or less, appears_sped_up is false, and human_visibility is FULL_PERSON. If candidates carry a cut_selection_tier label, prefer T1 over T2 over T3 unless a lower-tier candidate is overwhelmingly stronger visually.',
    '- Never refuse to choose: if no candidate satisfies the cut-quality priorities, still pick the best available candidate.',
    '',
    'Rules:',
    '- Duration should be 6 to 24 seconds.',
    '- Do not cut in the middle of the action just to stay near 10 seconds.',
    '- End when one visible action cycle naturally finishes: the pressed/cut/poured/assembled/transformed material exits, resets, or the result is clearly visible.',
    '- All timestamps must be absolute original source seconds.',
    '- Relative/sample timestamps are forbidden.',
    '- Include start_sec, end_sec, and duration_sec.',
    '- duration_sec must equal end_sec - start_sec.',
    '- Do not create captions yet.',
    '',
    'Return shape:',
    JSON.stringify({
      hook_clip_10s: {
        start_sec: 0,
        end_sec: 10,
        duration_sec: 10,
        source_time_basis: 'absolute_original_seconds',
        visual_hook: '',
        why_this_clip: '',
        first_second_hook: '',
        edit_note: ''
      }
    }, null, 2),
    '',
    'Candidate windows:',
    JSON.stringify(annotatedGuide || {}, null, 2)
  ].join('\n');
}

function buildLongformStoryPrompt({ candidateGuide, hookGuide }) {
  return [
    'You are an editing director choosing one 60-second core-process Full Draft window from a long-form source.',
    'Choose exactly one story_clip_40s from the candidates. The field name is legacy; the selected window should be about 60 seconds. Return JSON only.',
    '',
    'Goal:',
    '- This is not a 10-second highlight.',
    '- This is one important core process, not the whole long video.',
    '- Viewers should understand what the process is for and how it changes the material by the end.',
    '- Opening may use a strong process moment, raw material, or result, but the rest must stay on the same coherent process.',
    '- Structure should be hook/identity -> material/input -> core action -> transformation -> result/meaning.',
    '- Prefer one strong process with enough continuity over many unrelated satisfying clips.',
    '',
    'Rules:',
    '- Duration must be 55 to 65 seconds, preferably exactly 60 seconds when the source is long enough.',
    '- Under 55 seconds is forbidden for long-form sources.',
    '- All timestamps must be absolute original source seconds.',
    '- Relative/sample timestamps are forbidden.',
    '- Include start_sec, end_sec, and duration_sec.',
    '- duration_sec must equal end_sec - start_sec.',
    '- It may overlap hook_clip_10s if that is the strongest core process, but it must expand into a wider 60-second process flow.',
    '- Do not choose many distant mini-clips. Choose one continuous source window.',
    '- Do not create captions or scene_transitions yet.',
    '',
    'Return shape:',
    JSON.stringify({
      story_clip_40s: {
        start_sec: 0,
        end_sec: 60,
        duration_sec: 60,
        source_time_basis: 'absolute_original_seconds',
        story_structure: {
          hook: '',
          reveal: '',
          process: '',
          climax: '',
          ending: ''
        },
        why_this_window: '',
        relationship_to_hook_clip: ''
      }
    }, null, 2),
    '',
    'hook_clip_10s:',
    JSON.stringify(hookGuide || {}, null, 2),
    '',
    'Candidate windows:',
    JSON.stringify(candidateGuide || {}, null, 2)
  ].join('\n');
}

function buildLongformMidformPrompt({ candidateGuide, hookGuide, storyGuide }) {
  return [
    'You are an editing director choosing one 120-second midform process video from a long-form source.',
    'Choose exactly one midform_clip_120s from the candidates. Return JSON only.',
    '',
    'Goal:',
    '- This is not a 10-second highlight.',
    '- This is not the 60-second Full core-process draft.',
    '- This is a fuller process-flow version for a separate Japanese midform channel.',
    '- It should explain the most complete manufacturing/process arc available in about two minutes.',
    '',
    'Rules:',
    '- Target duration is 120 seconds.',
    '- Acceptable duration is 105 to 130 seconds.',
    '- If the source itself is shorter than 125 seconds, still return the best available window, but mark risk clearly.',
    '- All timestamps must be absolute original source seconds.',
    '- Relative/sample timestamps are forbidden.',
    '- Include start_sec, end_sec, and duration_sec.',
    '- duration_sec must equal end_sec - start_sec.',
    '- The first source cut may overlap other formats if it is the strongest process opening, but the edit format must be broader than Highlight.',
    '- Do not create captions yet.',
    '',
    'Return shape:',
    JSON.stringify({
      midform_clip_120s: {
        start_sec: 0,
        end_sec: 120,
        duration_sec: 120,
        source_time_basis: 'absolute_original_seconds',
        process_structure: {
          opening_hook: '',
          material_or_input: '',
          main_process: '',
          transformation: '',
          result: '',
          ending: ''
        },
        why_this_window: '',
        relationship_to_hook_and_full: ''
      }
    }, null, 2),
    '',
    'hook_clip_10s:',
    JSON.stringify(hookGuide || {}, null, 2),
    '',
    'story_clip_40s:',
    JSON.stringify(storyGuide || {}, null, 2),
    '',
    'Candidate windows:',
    JSON.stringify(candidateGuide || {}, null, 2)
  ].join('\n');
}

function buildLongformFinalPrompt({ sourceUrl, filename, durationSec, candidateGuide, hookGuide, storyGuide, midformGuide }) {
  return [
    'You are a Shorts video editor, caption writer, and upload metadata writer.',
    'Use only the fixed long-form extraction windows below. Return one complete JSON object only.',
    '',
    'Critical rules:',
    '- Do not choose new time windows.',
    '- Do not change hook_clip_10s start_sec/end_sec.',
    '- Do not change story_clip_40s start_sec/end_sec.',
    '- Do not change midform_clip_120s start_sec/end_sec.',
    '- scene_transitions must be created only inside story_clip_40s.',
    '- midform scene/caption strategy must be based on midform_clip_120s.',
    '- highlight captions must be created only inside hook_clip_10s.',
    '- All timestamps must be absolute original source seconds.',
    '- Relative/sample timestamps are forbidden.',
    '- English fallback is forbidden.',
    '- Korean and Japanese subtitles must not be empty.',
    '- Treat hook_clip_10s as a visual-hook edit, not a process summary.',
    '- Treat story_clip_40s as a legacy field name for the selected about-60-second Full core-process window.',
    '- Full should cover one important process in depth, not many unrelated moments from the whole long-form source.',
    '- Treat midform_clip_120s as an immersive process/documentary edit with atmosphere, craft, and flow.',
    '',
    'Caption rules:',
    '- Do not translate long sentences directly.',
    '- Do not write long explanation captions.',
    '- Do not list bare words or noun-only labels.',
    '- Write short spoken captions a viewer can read quickly.',
    '- One caption should contain one visible action or one short idea.',
    '- Technical report wording is forbidden.',
    '- Bad: "骨格形成", "空気圧注入", "固定完了", "타이어 골격", "공기 압력 주입".',
    '- Good: "形を作る", "空気を入れる", "しっかり固定", "모양을 잡고", "공기를 넣어 고정".',
    '',
    'scene_transitions rules:',
    '- Minimum 8, maximum 16 scenes.',
    '- First scene must start at story_clip_40s.start_sec.',
    '- Last scene must end near story_clip_40s.end_sec.',
    '- The scene span must cover at least 85 percent of story_clip_40s.',
    '- Every scene must be inside story_clip_40s.',
    '- Scene transitions should describe only the selected Full core process window, not the whole source.',
    '- Scene times must not be compressed into a 1 to 2 second range.',
    '- Each scene should include scene_role: raw_material, result, ambient, action, inspection, reset, or transition.',
    '- Each scene should preserve A-grade scoring fields when visible: tempo_score, tension_score, transformation_score, framing_score, flow_score, a_grade_score.',
    '- Use action/reset cut points: in before hand/tool/material enters the work zone, peak at impact/transformation, out after the part exits or the worker/machine resets.',
    '',
    'Metadata rules:',
    '- Create distinct JP Full, JP Highlight, and JP Midform metadata.',
    '- Korean text is review-only. Do not create Korean upload-channel variants.',
    '- Full metadata is process-story oriented.',
    '- Highlight metadata is visual-hook oriented.',
    '- Midform metadata is fuller process-flow oriented and suitable for an about 2-minute Japanese upload.',
    '- Each recommended title has exactly five English hashtags: #worker, #process, plus three relevant English hashtags. Do not use Japanese or Korean hashtags.',
    '- No emoji or decorative symbols.',
    '',
    'Return the existing Ottogi metadata schema shape with these required fields:',
    '- short_description_200, short_description_ko, recommended_titles, recommended_titles_ko',
    '- report_description, report_description_ko, explainer_text, explainer_text_ko',
    '- highlight_explainer_text, highlight_explainer_text_ko',
    '- full_metadata, full_metadata_ko, highlight_metadata, highlight_metadata_ko, midform_metadata, midform_metadata_ko',
    '- full_caption_script_ja, full_caption_script_ko, midform_caption_script_ja, midform_caption_script_ko',
    '- highlight_hook_captions_ja, highlight_hook_captions_ko',
    '- hook_clip_10s, story_clip_40s, midform_clip_120s, recommended_full_window, recommended_highlight_window, recommended_midform_window',
    '- scene_transitions',
    '',
    'Fixed windows:',
    JSON.stringify({
      candidateGuide,
      hookGuide,
      storyGuide,
      midformGuide
    }, null, 2),
    '',
    'Source information:',
    `- Source URL: ${sourceUrl || 'not provided'}`,
    `- Original Filename: ${filename || 'unknown'}`,
    `- Duration Sec: ${durationSec || 'unknown'}`
  ].join('\n');
}

function buildMetadataPrompt({ sourceUrl, filename, durationSec, sceneGuide, sourceType = 'unknown', sourceWorkflowMode = 'unknown', assignedHookType = null, metadataVariantMode = 'all' }) {
  const speechBudget = calculateKoreanFullSpeechBudget({ targetDurationSec: durationSec });
  const normalizedMetadataVariantMode = normalizeMetadataVariantMode(metadataVariantMode);
  const wantsFull = ['all', 'full_highlight_only', 'full_only'].includes(normalizedMetadataVariantMode);
  const sceneSummary = (sceneGuide?.scene_transitions || [])
    .slice(0, 30)
    .map((scene) => `${scene.scene_id || ''} ${scene.start_sec}-${scene.end_sec}: ${scene.visual_summary || scene.caption_text || ''}`)
    .join('\n');

  if (!wantsFull) {
    return [
      'You are the metadata writer for the 3-minute Ottogi process video workflow.',
      'Return JSON only. Do not include Markdown.',
      '',
      `Highlight draft production language: ${OUTPUT_CONFIG.highlight.lang.toUpperCase()} (${OUTPUT_CONFIG.highlight.label}).`,
      '',
      'This source is below the Full Draft threshold.',
      '- Do not generate, repair, or regenerate Korean Full script fields for this item.',
      '- Treat Full Draft as skipped, not failed.',
      `- Write ${OUTPUT_CONFIG.highlight.metadataKey} for the natural-action highlight draft: Japanese upload metadata focused on visual hook, rhythm, repetition, curiosity, and satisfying motion.`,
      '- Write highlight_metadata_ko as Korean review text for the Japanese highlight draft. This is not upload metadata.',
      '- Highlight metadata must use variant_type="highlight", caption_mode="long_bottom_explainer", and onscreen_caption_block as one long lower-third explainer paragraph.',
      '- Highlight versions must never use an onscreen_subtitles array.',
      '- Each metadata object must include short_description, summary_caption, variant_type, caption_mode, exactly five recommended_titles, report_description, upload_title, and hashtags.',
      '- Korean metadata and caption fields must not contain Japanese Hiragana or Katakana.',
      '- Do not invent facts not visible in the video/scene analysis.',
      '',
      'Scene analysis summary:',
      sceneSummary || 'No scene summary provided. Use the visible video only.',
      '',
      'Source information:',
      `- Source URL: ${sourceUrl || 'not provided'}`,
      `- Original Filename: ${filename || 'unknown'}`,
      `- Duration Sec: ${durationSec || 'unknown'}`,
      `- Source Type: ${sourceType || 'unknown'}`,
      `- Source Workflow Mode: ${sourceWorkflowMode || 'unknown'}`,
      '',
      'Return JSON only.'
    ].join('\n');
  }

  return [
    'You are the metadata writer for the 3-minute Ottogi process video workflow.',
    'Return JSON only. Do not include Markdown.',
    '',
    `Full draft production language: ${OUTPUT_CONFIG.full_draft.lang.toUpperCase()} (${OUTPUT_CONFIG.full_draft.label}).`,
    `Highlight draft production language: ${OUTPUT_CONFIG.highlight.lang.toUpperCase()} (${OUTPUT_CONFIG.highlight.label}).`,
    '',
    'Use the scene analysis below to write:',
    `- ${OUTPUT_CONFIG.full_draft.metadataKey} for the full process draft: Korean upload metadata for a shortened technical/process explanation video.`,
    `- ${OUTPUT_CONFIG.highlight.metadataKey} for the natural-action highlight draft: Japanese upload metadata focused on visual hook, rhythm, repetition, curiosity, and satisfying mechanical motion.`,
    '- highlight_metadata_ko as Korean review text for the Japanese natural-action highlight draft. This is not upload metadata.',
    '- midform_metadata for the Japanese 120-second midform draft when the source is long enough.',
    '- midform_metadata_ko as Korean review text for the Japanese midform draft. This is not upload metadata.',
    '- Each metadata object must include short_description, summary_caption, variant_type, caption_mode, exactly five recommended_titles, report_description, upload_title, and hashtags.',
    `- Full metadata objects must use variant_type="full", caption_mode="${OUTPUT_CONFIG.full_draft.captionMode}", and onscreen_subtitles as an array copied from the manuscript-based ${OUTPUT_CONFIG.full_draft.scriptKey}, not from raw scene labels.`,
    `- Highlight metadata objects must use variant_type="highlight", caption_mode="${OUTPUT_CONFIG.highlight.captionMode}", and onscreen_caption_block as one long lower-third explainer paragraph.`,
    '- Highlight versions must never use an onscreen_subtitles array. Full versions must never use onscreen_caption_block.',
    '- Highlight caption blocks are part of the visual format, not just text. They should feel like a dense lower-bottom explainer block that makes Highlight visually different from Full.',
    '- Highlight onscreen_caption_block should target about 200 Japanese/Korean characters. Ideal range is 195 to 215 characters; acceptable range is 180 to 240 characters. Keep it natural for Shorts viewers and focused on the strongest visual hook.',
    `- Full onscreen_subtitles must mirror ${OUTPUT_CONFIG.full_draft.scriptKey} text for upload metadata. Do not create Japanese Full subtitles.`,
    '',
    'Priority deliverable: full_caption_script_ko',
    `- ${OUTPUT_CONFIG.full_draft.scriptKey} is a first-class required output, not optional metadata support text. If it is missing, empty, or shorter than 20 items, the whole response is invalid.`,
    `- Before writing metadata prose, fully draft ${OUTPUT_CONFIG.full_draft.scriptKey} as 20 to 24 Korean caption objects with scene_id, role, text, and source_basis.`,
    '- Do not treat Korean Full script as something to infer later from metadata. Write it now in the same response.',
    '- Follow this structure pattern exactly, while changing the actual content to match the source footage:',
    JSON.stringify([
      { scene_id: 'scene_01', role: 'hook', text: '처음엔 뭐 하는지', source_basis: 'hidden_manuscript' },
      { scene_id: 'scene_01', role: 'process_purpose', text: '잘 안 보여도요.', source_basis: 'hidden_manuscript' },
      { scene_id: 'scene_02', role: 'technical_context', text: '이건 소리를 버틸', source_basis: 'hidden_manuscript' },
      { scene_id: 'scene_02', role: 'process_purpose', text: '기초를 맞추는 공정이에요.', source_basis: 'hidden_manuscript' },
      { scene_id: 'scene_03', role: 'quality_reason', text: '여기서 조금만 틀어져도', source_basis: 'hidden_manuscript' },
      { scene_id: 'scene_03', role: 'closing', text: '전체 균형이 달라져요.', source_basis: 'hidden_manuscript' }
    ], null, 2),
    '- Full caption scripts are NOT one sentence per scene. Do not fill the array directly from scene labels.',
    '- Full caption script writing order is mandatory: first create one hidden continuous spoken manuscript, then split that manuscript into short caption items.',
    '- The hidden manuscript must answer these in order: what is this process, what product/material is handled, why this step matters, what visible actions support that explanation, and what emotional/quality meaning remains at the end.',
    '- Do not claim a final result that is not visible in the selected clip. If water, finished product, packaging, or completion is not shown, describe it only as the purpose or goal, not as an achieved result.',
    '- Each caption item is a cut piece of that hidden manuscript. It is not a standalone title card, keyword tag, or scene name.',
    '- Core test: when the Full caption items are read in order, they must sound like one person speaking a connected process narration. If each item feels like an independent scene label, the script is invalid.',
    '- Full Draft script only: use a four-part narrative feel internally. Start with curiosity, explain what is being made, weave in 4 to 6 scene observations around 25/50/75 percent and completion beats, and close emotionally around precision, repetition, craftsmanship, transformation, or completion.',
    '- Full caption script structure must be: curiosity hook -> whole-process purpose/explanation -> technical process explanation -> scene mention around 25 percent -> process/emotional explanation -> scene mention around 50 percent -> process/emotional explanation -> scene mention around 75 percent -> emotional closing.',
    ...koreanFullSpeechBudgetPromptLines(speechBudget),
    ...koreanFullSceneSpeechBudgetPromptLines(sceneGuide?.scene_transitions || []),
    '- Full caption script roles are descriptive, not a quota target. Use scene_observation only when a visible beat is necessary; otherwise explain purpose, method, risk, quality, or emotion.',
    '- Full script is not an action checklist. Do not write the process as "wide place -> material -> machine picks -> trailer loads -> factory". That is still label sequencing.',
    '- Sentence rule v2 is more important than role counts: captions must join into human Korean sentences, not a sequence of noun phrases.',
    ...koreanFullHookPromptLines(assignedHookType, {
      seed: `${sourceUrl || ''}:${filename || ''}`,
      sourceUrl,
      filename,
      sourceType,
      sourceWorkflowMode,
      sourceText: sceneSummary
    }),
    `- The first ${OUTPUT_CONFIG.full_draft.scriptKey} item must follow the assigned Korean hook type. Do not create full_caption_script_ja.`,
    `- For ${OUTPUT_CONFIG.full_draft.scriptKey}, scene data is reference material only. Do not copy visual_summary, caption_text_ko, or screen_captions_ko as the script. Rewrite them into fresh spoken Korean narration.`,
    '- Korean Full narration must not end caption items with report-style noun endings such as ~함 or ~됨.',
    '- Korean Full narration must not contain three consecutive caption items ending in 합니다. Vary the rhythm with natural spoken Korean endings like -요, -죠, -예요, -해요, and -돼요.',
    '- Sentence validity rule v2: never output 3 consecutive caption items without sentence-closing endings. At least every 1 to 2 short pieces must close or complete a Korean sentence with endings like -요, -죠, -예요, -해요, -돼요, -합니다, -됩니다, -입니다, -니다, -까, or punctuation.',
    '- The next 2 to 4 captions must answer what is being made and why this process exists. Split long thoughts into short connected phrases, not isolated labels.',
    '- Use natural Korean connector ideas when needed, such as 사실은, 여기서 중요한 건, 그래서, 이 정밀함이, 사람의 손으로, 기계의 힘으로, 조금씩, 마지막에는.',
    '- Scene labels are only raw material. Use scene_observation only near the 25%, 50%, and 75% positions of the script, not for every scene.',
    `- Write ${OUTPUT_CONFIG.full_draft.scriptKey} as 20 to 24 short connected Korean screen-phrase items. Each item.scene_id must be one of the real scene_transitions IDs such as scene_01, scene_02, scene_03; never invent script_001 IDs. Reuse a scene_id for multiple nearby caption chunks when needed.`,
    '- Each full_caption_script item must have role: hook, process_purpose, technical_context, emotional_expression, scene_observation, method, quality_reason, progress, or closing.',
    '- Use scene_observation sparingly near meaningful beats. Do not describe every visible cut, and never sacrifice sentence flow or timing budget to hit a role count.',
    '- Most Full script items must explain the whole process purpose, method, material change, quality reason, and emotional meaning. Scene labels are supporting material only.',
    '- Each Full caption item must be short enough to fit in the 9:16 caption box. Hard limit: Korean 12 visible characters, Japanese 14 visible characters. Split longer ideas into multiple connected items.',
    '- The final 1 to 2 Full captions must be a natural emotional closing about precision, craftsmanship, repetition, transformation, quality, or completion.',
    '- The emotional closing must stay honest to the footage. Good if water is not visible: "水を探すため", "見えない努力が", "深さを重ねる". Bad if water is not visible: "水脈へ届く", "水が湧き出る", "大地を潤す", "恵みへ繋がる".',
    `- ${OUTPUT_CONFIG.full_draft.label} script: explanation tone. It should help the viewer understand the purpose and technical meaning of the visible process.`,
    '- Korean metadata and caption fields must not contain Japanese Hiragana or Katakana. Translate words like チューブ into natural Korean such as 튜브.',
    '- Do not make Full captions all scene labels. Scene labels should be about 30 percent of the script at most.',
    '- Forbidden pattern: do not write three or more consecutive independent captions shaped like "[noun]が[verb]ます" or "[명사]을 [동사]합니다". Use connected wording so the next caption continues the narration.',
    '- Never end a Japanese Full caption with an unfinished particle such as を, が, の, に, へ, と, や, な. These are broken captions and must be rewritten.',
    '- Bad broken Japanese fragments: ["ワイヤーを部品が", "手作業で隙間に", "コイルを形を", "しっかり中央を完璧な", "たくさんの"].',
    '- Bad Japanese label script: ["巨大な機械が動きます", "鉄筋を加工します", "材料が供給されます"]. This is scene labeling, not narration.',
    '- Bad array-first rhythm: ["これ何だろう", "パーム油の収穫", "熟した実の山", "機械の出番", "満載のトレーラー"]. It names scenes but does not speak as a manuscript.',
    '- Bad action-checklist rhythm: ["これ何だろう", "広大な農園", "パーム油を採る", "落ちた実から", "クレーンが拾う", "トレーラーへ積む", "工場へ運ぶ"]. This follows visible actions but still is not a spoken script.',
    '- Good agriculture Full script flow: ["これ何だろう", "油の原料です", "実を集める作業", "熟した房だけを", "時期を見極め", "傷めず集めます", "ここで大事なのは", "広い農園でも", "流れを止めないこと", "人が実を見極め", "機械が力を補い", "荷台へ運びます", "この連携が", "毎日の油を支えます"].',
    '- Good hidden manuscript idea: "これはモーターの中で電気を動きに変えるコイルを作る工程です。細い銅線を重ねながら、電気が通る形へ少しずつ整えます。ここで大事なのは、速さよりもズレを残さないことです。機械の速さと人の確認が合わさって、小さな精度が最後の力になります。"',
    '- Good Japanese Full script flow split from that manuscript: ["これ何だろう", "モーター内部で", "コイルを作ります", "電気を動きに", "変える部品です", "細い銅線を重ね", "少しずつ整えます", "ここで大事なのは", "ズレを残さないこと", "機械は速く動き", "人の手で確認し", "小さな精度が", "最後の力になります"].',
    '- Bad Japanese noun-label captions: ["パーム油の収穫", "熟した実の山", "広大な農園", "満載のトレーラー"]. Rewrite these as spoken narration, for example ["パーム油を収穫します", "熟した実が集まり", "広い農園で進み", "荷台がいっぱいに"].',
    '- Bad Korean label script: ["거대한 기계가 작동합니다", "철근을 가공합니다", "재료가 공급됩니다"]. This is scene labeling, not narration.',
    '- Good Korean hidden manuscript idea: "이건 건물을 떠받치는 철근을 만드는 공정입니다. 먼저 철근을 일정한 길이로 맞추고, 각도까지 규격대로 휘어냅니다. 몇 밀리 차이가 강도를 바꿀 수 있어서, 기계의 속도보다 사람의 확인이 중요합니다. 이 정밀함이 결국 오래 버티는 구조를 만듭니다."',
    '- Good Korean Full script flow split from that manuscript: ["이게 뭔지 아세요?", "건물을 받치는", "철근을 만듭니다", "먼저 철근을", "길이에 맞추고", "각도까지 맞춰", "규격대로 휘어요", "몇 밀리 차이가", "강도를 바꾸니까", "사람이 확인해요", "이 정밀함이", "오래 버티는", "구조를 만듭니다"].',
    '- Full onscreen_subtitles items must be short spoken captions readable in 1 to 2 seconds, but they should follow the same technical/educational process arc as full_caption_script_*.',
    '- Japanese Full onscreen_subtitles must stay within 14 visible characters per item when used.',
    '- Korean Full onscreen_subtitles must stay within 12 visible characters per item when used.',
    '- Full onscreen_subtitles should usually contain 20 to 24 items and mirror the full_caption_script_ko rhythm.',
    '- Do not put one report-like paragraph in Full onscreen_subtitles.',
    '- Bad Japanese Full onscreen_subtitles: ["職人技が光る無塗装の鉄鍋製造工程。真っ赤に溶けた鉄が型に注がれ、見事な中華鍋が形作られる様子をご覧ください。"].',
    '- Good Korean Full onscreen_subtitles: copy the same manuscript rhythm as full_caption_script_ko, for example ["순서가 중요한 이유는", "건물을 받치는", "철근을 만들고", "먼저 길이를", "기준에 맞춰", "각도까지 휘어요"].',
    '- Good Japanese Highlight onscreen_caption_block: "真っ赤に溶けた鉄が型へ一気に流れ込み、数秒で中華鍋の形へ変わっていく瞬間です。高温の鉄が広がる迫力と、形が一気に決まる気持ちよさが見どころです。".',
    '- Bad Korean review subtitles: ["숙련된 작업자들이 무쇠 웍을 만드는 과정입니다. 붉게 달궈진 쇳물을 틀에 부어 굳히고 섬세한 가공을 거칩니다."].',
    '- Good Korean review subtitles: ["뜨거운 쇳물을 붓고", "틀 안으로 빠르게 퍼져요", "웍의 형태가 잡히고", "단단하게 굳어요"].',
    '- Good Korean highlight review block: "붉게 달궈진 쇳물이 웍 모양의 틀 안으로 한 번에 쏟아지는 순간입니다. 뜨거운 금속이 틀 전체로 빠르게 퍼지면서, 순식간에 무쇠 웍의 형태가 잡히는 장면이 핵심입니다.".',
    '- Every recommended title must include exactly five English hashtags. Include #worker and #process plus three relevant English hashtags such as #manufacturing, #craftsmanship, #factory, #metalwork, #tools, #machinework, #satisfying, or #processvideo.',
    '- Do not use Japanese or Korean hashtags anywhere. Japanese/Korean prose is allowed in titles/descriptions, but hashtags must be ASCII English only.',
    '- Do not use emoji, emoticons, decorative symbols, or reaction icons in any upload metadata or explainer text.',
    `- ${OUTPUT_CONFIG.full_draft.label} titles and ${OUTPUT_CONFIG.highlight.label} titles must be meaningfully different. Do not reuse the same title list.`,
    '- Every report_description is the actual YouTube upload description metadata. Do not shorten it into one paragraph.',
    '- Korean full report_description must be a detailed report with these exact numbered sections in Korean: 1. 작업 개요, 2. 사용 재료 및 장비, 3. 시공 절차, 4. 작업의 중요성, 5. 가이드라인 준수 및 교육적 목적.',
    '- Japanese highlight report_description must be a detailed report with these exact numbered sections in Japanese: 1. 作業概要, 2. 使用材料と設備, 3. 工程手順, 4. 作業の重要性, 5. ガイドライン遵守と教育目的.',
    '- Section 5 is mandatory. If the video includes dangerous-looking, industrial, hot, sharp, heavy, or professional work, clearly state that the video is for educational process understanding and not an instruction to imitate.',
    '- Full draft report_description should explain the complete process flow using all five required sections.',
    '- Highlight report_description should explain why the short hook moment is visually compelling using all five required sections.',
    '- Top-level short_description_ko, recommended_titles_ko, and report_description_ko should mirror full_metadata_ko for Korean Full.',
    '- Full draft explainer text in Korean only.',
    '- Highlight explainer text in Japanese plus Korean review text focused on visual hook, repetition, rhythm, and curiosity.',
    '- Safety note if needed.',
    '- If source_type is longform, base full metadata on story_clip_40s/recommended_full_window and highlight metadata on hook_clip_10s/recommended_highlight_window.',
    '',
    'Important:',
    '- Do not invent facts not visible in the video/scene analysis.',
    '- Keep wording YouTube guideline-safe and educational.',
    '- upload/title metadata is separate from on-screen captions.',
    '',
    'Scene analysis summary:',
    sceneSummary || 'No scene summary provided. Use the visible video only.',
    '',
    'Allowed scene IDs for Korean Full anchors:',
    JSON.stringify(sceneTransitionPromptSummary(sceneGuide?.scene_transitions || []), null, 2),
    '',
    'Source information:',
    `- Source URL: ${sourceUrl || 'not provided'}`,
    `- Original Filename: ${filename || 'unknown'}`,
    `- Duration Sec: ${durationSec || 'unknown'}`,
    `- Source Type: ${sourceType || 'unknown'}`,
    `- Source Workflow Mode: ${sourceWorkflowMode || 'unknown'}`,
    '',
    'Return JSON only.'
  ].join('\n');
}

function buildReviewPrompt({ sourceUrl, filename, durationSec, draftGuide, sourceType = 'unknown', sourceWorkflowMode = 'unknown', assignedHookType = null, metadataVariantMode = 'all' }) {
  const normalizedMetadataVariantMode = normalizeMetadataVariantMode(metadataVariantMode);
  const wantsFull = ['all', 'full_highlight_only', 'full_only'].includes(normalizedMetadataVariantMode);
  if (!wantsFull) {
    return [
      'You are the final JSON quality gate for the 3-minute Ottogi process video workflow.',
      'Do not re-analyze the video. Review and repair the provided draft JSON only.',
      'Return one complete JSON object only. Do not include Markdown.',
      '',
      'This source is below the Full Draft threshold.',
      '- Do not generate, repair, regenerate, or validate Korean Full script fields.',
      '- Treat full_generation_status as skipped rather than failed.',
      '- Ensure highlight_metadata uses caption_mode="long_bottom_explainer" and contains a Japanese onscreen_caption_block string.',
      '- Ensure highlight_metadata_ko is a Korean review-only long explainer block, not upload metadata.',
      '- Ensure scene_transitions is not empty.',
      '- Preserve factual grounding. Do not invent hidden details.',
      '',
      'Source information:',
      `- Source URL: ${sourceUrl || 'not provided'}`,
      `- Original Filename: ${filename || 'unknown'}`,
      `- Duration Sec: ${durationSec || 'unknown'}`,
      `- Source Type: ${sourceType || 'unknown'}`,
      `- Source Workflow Mode: ${sourceWorkflowMode || 'unknown'}`,
      '',
      'Draft JSON to review and repair:',
      JSON.stringify(draftGuide || {}, null, 2),
      '',
      'Return complete repaired JSON only.'
    ].join('\n');
  }
  return [
    'You are the final JSON quality gate for the 3-minute Ottogi process video workflow.',
    'Do not re-analyze the video. Review and repair the provided draft JSON only.',
    'Return one complete JSON object only. Do not include Markdown.',
    '',
    'Required validation and repair tasks:',
    '- Ensure every required top-level field exists.',
    '- Ensure recommended_titles_ko contains exactly 5 usable Korean Full upload titles.',
    '- Ensure full_metadata_ko uses caption_mode="scene_based_short_subtitles" and contains Korean onscreen_subtitles arrays copied from full_caption_script_ko.',
    '- Ensure midform_metadata uses caption_mode="scene_based_short_subtitles" for the Japanese midform draft when present.',
    '- Ensure midform_metadata_ko is review-only Korean text matching the Japanese midform intent when present.',
    '- Ensure full_caption_script_ko exists as an ordered Korean screen-phrase script, not one item per scene.',
    '- Full caption script must be global Korean process narration split into short readable phrases across the whole timeline.',
    '- Core test: when the Full caption items are read in order, they must sound like one connected spoken script. If each item feels like an independent scene label, rewrite it.',
    '- Full caption script must not be fragmented by raw character count. Rewrite into natural Korean screen phrases first.',
    '- Full caption script structure must be: curiosity hook -> whole-process purpose/explanation -> technical process explanation -> scene mention around 25 percent -> process/emotional explanation -> scene mention around 50 percent -> process/emotional explanation -> scene mention around 75 percent -> emotional closing.',
    '- Full caption script quota: use scene_observation only 4 to 6 times in a 20 to 24 item script. All other items must explain what is being made, why the step matters, how it works, or why precision/quality matters.',
    ...koreanFullHookPromptLines(assignedHookType, {
      seed: `${sourceUrl || ''}:${filename || ''}`,
      sourceUrl,
      filename,
      sourceType,
      sourceWorkflowMode,
      sourceText: JSON.stringify(draftGuide?.scene_transitions || [])
    }),
    '- The first Korean full_caption_script_ko item must follow the assigned hook type without using the banned exact phrase. The next 2 to 4 Korean captions must answer the process using connected short phrases, not noun labels. Avoid repeated 입니다/습니다/됩니다/집니다 endings.',
    '- Use scene_id values such as script_001, script_002, script_003. Scene labels are source material only and should appear mainly near 25, 50, and 75 percent of the script.',
    '- Use scene_observation for only 4 to 6 items. If more than about 30 percent of Full script items are scene_observation, rewrite them into technical_context, method, quality_reason, or emotional_expression.',
    '- full_caption_script_ko is the production Full subtitle script. Do not create or require full_caption_script_ja.',
    '- Korean fields must be written in natural Korean only. Do not mix Japanese kana such as Hiragana or Katakana into Korean captions.',
    '- The first 1 to 3 Full script captions must answer what the process is making. A hook question without an early answer is invalid.',
    '- The final 1 to 2 Full script captions must close with precision, craftsmanship, repetition, transformation, quality, or completion.',
    '- Ensure highlight_metadata uses caption_mode="long_bottom_explainer" and contains a Japanese onscreen_caption_block string.',
    '- Ensure highlight_metadata_ko is a Korean review-only long explainer block, not upload metadata.',
    '- Highlight metadata must not contain short onscreen_subtitles arrays. Full metadata must not contain long onscreen_caption_block text.',
    '- Reject or rewrite Full onscreen_subtitles if any item reads like a summary paragraph, has multiple sentences, says ご覧ください, or starts like a long process description.',
    '- Reject or rewrite Highlight onscreen_caption_block if it is missing, too short, too long, keyword-like, or not a natural lower-bottom explainer paragraph.',
    '- Ensure full_metadata_ko is process-summary oriented.',
    '- Ensure highlight_metadata and highlight_metadata_ko are visual-hook oriented.',
    '- Ensure Japanese Highlight upload outputs follow observation-rhythm/midokoro. Korean Full fields are production upload fields.',
    '- Ensure variant_strategy is present and states that Korean Full and Japanese Highlight are the active output variants.',
    '- Ensure every title in every language has exactly five English hashtags: #worker, #process, plus three relevant English hashtags.',
    '- Do not use Japanese or Korean hashtags anywhere. Hashtags must be ASCII English only.',
    '- Ensure every report_description has the five required numbered sections. Japanese: 作業概要, 使用材料と設備, 工程手順, 作業の重要性, ガイドライン遵守と教育目的. Korean: 작업 개요, 사용 재료 및 장비, 시공 절차, 작업의 중요성, 가이드라인 준수 및 교육적 목적.',
    '- Ensure scene_transitions is not empty.',
    '- Ensure every scene has safe start_sec/end_sec values within source duration.',
    '- Ensure caption_text is short enough for one-line full draft captions. Prefer concise Japanese phrases.',
    '- Ensure screen_captions_ja and screen_captions_ko are not direct sentence translations. They may stay short scene captions, but full_caption_script_* is the authoritative Full Draft screen script.',
    '- Ensure full_metadata_ko.onscreen_subtitles has the same manuscript quality as full_caption_script_ko. Do not allow weaker keyword labels or grammatical fragments.',
    '- Do not approve noun-only keyword captions or scene-label-only Full scripts. Rewrite labels into a flowing process explanation script.',
    '- Japanese screen_captions_ja should be natural Japanese and can support observation rhythm.',
    '- Korean screen_captions_ko should be natural Korean and can support process explanation.',
    '- Korean captions must not contain Japanese kana characters. Translate words like チューブ into Korean such as 튜브.',
    '- Rewrite stiff explanatory captions into manuscript-style connected narration. Example bad: "タイヤが製造されホイールに組み付けられるまでの一連の工程です". Example good: ["これ何だろう", "タイヤの形を", "作る工程です", "材料を重ねて", "強度を整えます", "最後の精度が", "走りを支えます"].',
    '- Example bad Japanese labels: ["タイヤ", "骨格", "形成", "搬送", "固定完了"]. Example bad Korean labels: ["타이어 골격", "로봇 운반", "공기 압력", "고정 완료"].',
    '- Rewrite any English caption_text or screen_captions_ja into natural Japanese.',
    '- Ensure caption_text_ko exists as natural Korean review copy for local inspection.',
    '- Ensure highlight_explainer_text is suitable for a natural-action highlight draft and is not a single unbroken line.',
    '- If source_type is longform, preserve hook_clip_10s, story_clip_40s, recommended_full_window, recommended_highlight_window, and shortform_candidate_windows when present.',
    '- Remove emoji, emoticons, decorative symbols, and reaction icons from all user-facing Japanese text.',
    '- Preserve factual grounding. Do not invent hidden details.',
    '- If a field is missing, repair it using visible/factual information already present in the draft.',
    '',
    'Source information:',
    `- Source URL: ${sourceUrl || 'not provided'}`,
    `- Original Filename: ${filename || 'unknown'}`,
    `- Duration Sec: ${durationSec || 'unknown'}`,
    `- Source Type: ${sourceType || 'unknown'}`,
    `- Source Workflow Mode: ${sourceWorkflowMode || 'unknown'}`,
    '',
    'Draft JSON to review and repair:',
    JSON.stringify(draftGuide || {}, null, 2),
    '',
    'Return complete repaired JSON only.'
  ].join('\n');
}

function buildJapaneseCaptionRepairPrompt({ sourceUrl, filename, durationSec, draftGuide, issues }) {
  return [
    'You are a strict Japanese caption repair pass for the 3-minute Ottogi process video workflow.',
    'Return one complete JSON object only. Do not include Markdown.',
    '',
    'Critical rule:',
    '- All user-facing Japanese fields must be natural Japanese.',
    '- Do not leave English in caption_text, screen_captions_ja, explainer_text, highlight_explainer_text, short_description, report_description, upload_title, or recommended title fields.',
    '- Do not use generic placeholder captions.',
    '- Rewrite captions from the original video context, existing visual_summary, focus_target, source filename, and nearby metadata.',
    '- Keep start_sec, end_sec, transition_at_sec, focus_zone, camera move, scores, Japanese metadata, and Korean upload metadata intact unless repair is necessary.',
    '- Each scene caption_text should be short and suitable for one-line full-draft captions.',
    '- screen_captions_ja should contain short observation-style Japanese captions for that exact scene, not noun-only labels.',
    '- screen_captions_ko should contain short explanation-style Korean captions for that exact scene, not noun-only labels.',
    '- Japanese captions observe what is visible now. Korean captions explain what the visible action means in the process.',
    '- Do not split a translated sentence by raw character count. Rewrite into natural spoken action lines first.',
    '- Bad Japanese: "ホイールに組み付けられるまでの一連の". Good Japanese: "リムに合わせる".',
    '- Bad Japanese labels: "骨格", "形成", "搬送", "空気注入", "固定完了".',
    '- Bad Korean: "자동화된 공정을 보여줍니다". Good Korean: "로봇이 정확히 옮깁니다".',
    '- Bad Korean labels: "타이어 골격", "로봇 운반", "공기 압력", "고정 완료".',
    '- highlight_explainer_text must be Japanese and suitable for the long highlight caption block.',
    '',
    'Invalid caption issues detected:',
    JSON.stringify(issues || [], null, 2),
    '',
    'Source information:',
    `- Source URL: ${sourceUrl || 'not provided'}`,
    `- Original Filename: ${filename || 'unknown'}`,
    `- Duration Sec: ${durationSec || 'unknown'}`,
    '',
    'Draft JSON to repair:',
    JSON.stringify(draftGuide || {}, null, 2),
    '',
    'Return complete repaired JSON only.'
  ].join('\n');
}

function buildCaptionRepairBatchPrompt({ sourceUrl, filename, durationSec, scenes, issues }) {
  return [
    'You are a caption repair pass for the 3-minute Ottogi process video workflow.',
    'Return JSON only. Do not include Markdown.',
    '',
    'Task:',
    '- Repair only the provided scenes.',
    '- Return scene_repairs only.',
    '- Do not re-analyze the whole video.',
    '- Keep each scene_id unchanged.',
    '',
    'Caption style:',
    '- Do not output noun-only labels, keyword tags, or factory-report terms.',
    '- Use short natural spoken captions.',
    '- Long explanation is forbidden, but a short sentence that reads naturally is allowed.',
    '- One caption should contain one visible action or one short idea.',
    '- Japanese captions must be natural Japanese.',
    '- Korean captions must be natural Korean, not translationese.',
    '- Do not use emoji or decorative symbols.',
    '- For Full Draft use, captions should support a technical/educational process arc. Do not only label the visible object.',
    '- If the caption starts with curiosity, answer what is being made in the same or next caption context.',
    '',
    'Good Japanese examples:',
    '- これ何だろう',
    '- タイヤを作る',
    '- 形を整えて',
    '- リムに合わせる',
    '- 空気で支える',
    '',
    'Bad Japanese examples:',
    '- タイヤ骨格形成',
    '- ロボット搬送',
    '- 空気圧注入',
    '- 固定完了',
    '',
    'Good Korean examples:',
    '- 이게 뭔지 아세요?',
    '- 타이어 모양을 만듭니다',
    '- 로봇이 옮깁니다',
    '- 휠에 맞춰 넣기',
    '- 공기로 고정',
    '',
    'Bad Korean examples:',
    '- 타이어 골격 형성',
    '- 로봇 운반',
    '- 공기 압력 주입',
    '- 고정 완료',
    '',
    'Source information:',
    `- Source URL: ${sourceUrl || 'not provided'}`,
    `- Original Filename: ${filename || 'unknown'}`,
    `- Duration Sec: ${durationSec || 'unknown'}`,
    '',
    'Invalid issues:',
    JSON.stringify(issues || [], null, 2),
    '',
    'Scenes to repair:',
    JSON.stringify(scenes || [], null, 2),
    '',
    'Return shape:',
    JSON.stringify({
      scene_repairs: [
        {
          scene_id: 'scene_001',
          caption_text: '自然な日本語の短い場面説明',
          caption_text_ko: '자연스러운 한국어 짧은 장면 설명',
          screen_captions_ja: ['自然な短い字幕'],
          screen_captions_ko: ['자연스러운 짧은 자막']
        }
      ]
    }, null, 2)
  ].join('\n');
}

function buildMetadataFieldRepairPrompt({ sourceUrl, filename, durationSec, guide, issues }) {
  const repairFields = (Array.isArray(issues) ? issues : [])
    .map((issue) => normalizeText(issue?.field || ''))
    .filter(Boolean);
  return [
    'You are a Japanese/Korean metadata repair pass for the 3-minute Ottogi process video workflow.',
    'Return JSON only. Do not include Markdown.',
    '',
    'Task:',
    '- Repair only the metadata fields listed in Invalid issues.',
    '- Japanese fields must be natural Japanese.',
    '- Korean fields must be natural Korean.',
    '- Do not re-analyze the whole video.',
    '- Use the provided scene summaries and existing metadata as factual grounding.',
    '- Return a flat repaired_fields array only. Do not return nested metadata objects.',
    '- Each repaired_fields item must have the exact field path and the replacement string value.',
    '- For recommended_titles[*].title issues, return one item per title field path.',
    '',
    'Style:',
    '- Natural Japanese or natural Korean for YouTube Shorts according to each field name.',
    '- Safe, educational, process/manufacturing focused.',
    '- No emoji or decorative symbols.',
    '- No English fallback in Japanese/Korean fields.',
    '',
    'Fields requested for this call:',
    JSON.stringify(repairFields, null, 2),
    '',
    'Return shape example:',
    JSON.stringify({
      repaired_fields: [
        { field: 'full_metadata_ko.recommended_titles[0].title', value: '주먹 망치를 만드는 과정 #worker #process #metalwork #tools #craftsmanship' }
      ]
    }, null, 2),
    '',
    'Invalid issues:',
    JSON.stringify(issues || [], null, 2),
    '',
    'Source information:',
    `- Source URL: ${sourceUrl || 'not provided'}`,
    `- Original Filename: ${filename || 'unknown'}`,
    `- Duration Sec: ${durationSec || 'unknown'}`,
    '',
    'Current metadata context:',
    JSON.stringify({
      detected_subject: guide?.detected_subject || '',
      short_description_200: guide?.short_description_200 || '',
      short_description_ko: guide?.short_description_ko || '',
      explainer_text: guide?.explainer_text || '',
      explainer_text_ko: guide?.explainer_text_ko || '',
      highlight_explainer_text: guide?.highlight_explainer_text || '',
      highlight_explainer_text_ko: guide?.highlight_explainer_text_ko || '',
      full_caption_script_ja: guide?.full_caption_script_ja || [],
      full_caption_script_ko: guide?.full_caption_script_ko || [],
      full_metadata: guide?.full_metadata || null,
      full_metadata_ko: guide?.full_metadata_ko || null,
      highlight_metadata: guide?.highlight_metadata || null,
      highlight_metadata_ko: guide?.highlight_metadata_ko || null,
      scene_summary: (Array.isArray(guide?.scene_transitions) ? guide.scene_transitions : []).slice(0, 12).map((scene) => ({
        scene_id: scene.scene_id,
        start_sec: scene.start_sec,
        end_sec: scene.end_sec,
        visual_summary: scene.visual_summary,
        caption_text: scene.caption_text,
        caption_text_ko: scene.caption_text_ko
      }))
    }, null, 2),
    '',
    'Return only repaired_fields as JSON.'
  ].join('\n');
}

function stableHashText(value = '') {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function selectKoreanFullHookType(context = {}) {
  const seed = normalizeText(context.seed || context.jobId || context.job_id || context.sourceUrl || context.filename || '');
  const sourceText = normalizeText([
    context.sourceText,
    context.sourceUrl,
    context.filename,
    context.detectedSubject,
    context.sourceType,
    context.sourceWorkflowMode
  ].filter(Boolean).join(' ')).toLowerCase();
  if (/(돈|비용|가격|수익|판매|재활용|버려|폐|고철|scrap|recycle|reuse|old|waste|profit|money|cost|value)/iu.test(sourceText)) {
    return KOREAN_FULL_HOOK_TYPES.money;
  }
  if (/(위험|뜨거|고온|불꽃|용접|절단|칼|날카|화상|폭발|무거|압착|프레스|danger|hot|weld|spark|cut|press|sharp|heavy|risk)/iu.test(sourceText)) {
    return KOREAN_FULL_HOOK_TYPES.danger;
  }
  const rotationIndex = stableHashText(seed || sourceText) % KOREAN_FULL_HOOK_ROTATION.length;
  return KOREAN_FULL_HOOK_TYPES[KOREAN_FULL_HOOK_ROTATION[rotationIndex]] || KOREAN_FULL_HOOK_TYPES.transformation;
}

function normalizeAssignedKoreanHookType(value, context = {}) {
  const key = normalizeText(typeof value === 'object' ? value?.type : value).toLowerCase();
  if (KOREAN_FULL_HOOK_TYPES[key]) return KOREAN_FULL_HOOK_TYPES[key];
  return selectKoreanFullHookType(context);
}

function koreanFullHookPromptLines(assignedHookType, context = {}) {
  const hook = normalizeAssignedKoreanHookType(assignedHookType, context);
  return [
    `Assigned Korean Full hook: ${hook.label} (${hook.type}).`,
    `- Use this assigned hook type for the opening: ${hook.instruction}`,
    '- Do not write the literal sentence "이게 뭔지 아세요?" anywhere. That exact phrase is banned.',
    '- Even for the same hook type, vary the actual opening sentence every time.',
    '- If the opening hides the identity, the manuscript must reveal the object/product/material name later. If it asks a question, answer it inside the script.',
    '- Hooks without payoff are forbidden.',
    '- Do not fill lines with decorative adjectives such as 정성껏, 섬세한, 거침없이, 반짝이는. For each process line, prefer one of: why this order matters, what risk happens if skipped/mistaken, or a concrete number such as temperature/count/weight.',
    '- Two consecutive decorative-only caption lines are invalid.',
    `- Opening examples for this type, to vary not copy: ${JSON.stringify(hook.examples)}`
  ];
}

function buildFullCaptionScriptRepairPrompt({ sourceUrl, filename, durationSec, guide, issues, assignedHookType = null }) {
  const speechBudget = koreanFullSpeechBudgetFromGuide(guide, durationSec);
  const sceneSummary = (Array.isArray(guide?.scene_transitions) ? guide.scene_transitions : [])
    .slice(0, 16)
    .map((scene) => ({
      scene_id: scene.scene_id,
      start_sec: scene.start_sec,
      end_sec: scene.end_sec,
      visual_summary: scene.visual_summary,
      caption_text: scene.caption_text,
      caption_text_ko: scene.caption_text_ko
    }));
  return [
    'You are repairing ONLY the Full Draft screen-caption manuscript for the 3-minute Ottogi process workflow.',
    'Return JSON only. Do not include Markdown.',
    '',
    'This is not upload description writing.',
    'You must create ordered screen-caption scripts for Full Draft video subtitles.',
    '',
    'Required output fields:',
    `- ${OUTPUT_CONFIG.full_draft.scriptKey}: 20 to 24 objects. Full Draft production language is ${OUTPUT_CONFIG.full_draft.lang.toUpperCase()} only.`,
    '- Each object must contain scene_id, role, text, source_basis.',
    '- scene_id must be copied from Existing metadata context.scene_summary[].scene_id, for example scene_01. Do not output script_001 IDs.',
    '',
    'Korean Full Draft style:',
    '- Explanation tone, natural Korean, not translationese.',
    ...koreanFullHookPromptLines(assignedHookType, {
      seed: `${sourceUrl || ''}:${filename || ''}`,
      sourceUrl,
      filename,
      detectedSubject: guide?.detected_subject || '',
      sourceText: JSON.stringify(guide?.scene_transitions || [])
    }),
    '- Avoid repeated 입니다/습니다/됩니다/집니다 endings.',
    '- Sentence validity rule v3: every caption item must be its own complete clause. Never end an item with only a bare noun, an object/topic/subject particle (을/를/은/는/이/가), or a half-finished modifier — never split one grammatical unit across two items. Each item must end in a natural Korean ending or connector such as -요, -죠, -예요, -해요, -돼요, -고, -니까, -면서, -합니다, -됩니다, -입니다, -니다, -까, or punctuation.',
    ...koreanFullSpeechBudgetPromptLines(speechBudget),
    ...koreanFullSceneSpeechBudgetPromptLines(sceneSummary),
    `- Each text should fit the caption box: target ${OUTPUT_CONFIG.full_draft.caption.promptTargetMinChars} to ${OUTPUT_CONFIG.full_draft.caption.promptTargetMaxChars} Korean characters, hard max ${OUTPUT_CONFIG.full_draft.caption.safeMaxChars} visible characters.`,
    '- Do not return full_caption_script_ja or any Japanese Full fields.',
    '',
    'Bad output rhythm (items with no predicate of their own; do not do this):',
    JSON.stringify(['여기서 중요한 건', '힘보다', '같은 움직임을', '마지막 형태가'], null, 2),
    '',
    'Good Korean output rhythm (every item has its own predicate):',
    JSON.stringify(['버려질 줄 알았던 게 다시 쓰임을 얻어요', '먼저 기준을 정확히 맞추고', '흔들리면 안 되니까 손으로 위치를 잡죠', '힘보다 방향이 중요해요', '기계가 눌러도 기준이 틀어지면', '품질이 눈에 띄게 달라져요', '같은 움직임을 계속 반복하면서', '정밀함이 조금씩 쌓이고', '마지막 형태가 조용히 완성돼요'], null, 2),
    '',
    'Invalid issues:',
    JSON.stringify(issues || [], null, 2),
    '',
    'Source information:',
    `- Source URL: ${sourceUrl || 'not provided'}`,
    `- Original Filename: ${filename || 'unknown'}`,
    `- Duration Sec: ${durationSec || 'unknown'}`,
    '',
    'Existing metadata context:',
    JSON.stringify({
      detected_subject: guide?.detected_subject || '',
      full_metadata: guide?.full_metadata || null,
      full_metadata_ko: guide?.full_metadata_ko || null,
      scene_summary: sceneSummary,
      allowed_scene_ids: sceneSummary.map((scene) => scene.scene_id).filter(Boolean)
    }, null, 2)
  ].join('\n');
}

function buildInitialFullCaptionScriptSeedPrompt({ sourceUrl, filename, durationSec, guide, assignedHookType = null }) {
  const speechBudget = koreanFullSpeechBudgetFromGuide(guide, durationSec);
  const sceneSummary = (Array.isArray(guide?.scene_transitions) ? guide.scene_transitions : [])
    .slice(0, 16)
    .map((scene) => ({
      scene_id: scene.scene_id,
      start_sec: scene.start_sec,
      end_sec: scene.end_sec,
      visual_summary: scene.visual_summary,
      caption_text_ko: scene.caption_text_ko,
      screen_captions_ko: scene.screen_captions_ko
    }));
  return [
    'You are writing the FIRST full Korean caption manuscript for the 3-minute Ottogi process workflow.',
    'Return JSON only. Do not include Markdown.',
    '',
    'This is an initial generation step, not a repair pass.',
    `The metadata response omitted ${OUTPUT_CONFIG.full_draft.scriptKey}, so you must write it now as a required production field.`,
    '',
    'Required output fields:',
    `- ${OUTPUT_CONFIG.full_draft.scriptKey}: 20 to 24 objects. Korean only.`,
    '- Each object must contain scene_id, role, text, source_basis.',
    '- scene_id must be copied from Existing context.scene_summary[].scene_id. Do not output script_001 IDs.',
    '- source_basis must be "initial_full_caption_script_seed" for every item.',
    '- Do not return upload descriptions, title lists, or any non-script fields.',
    '',
    'Korean narration rules:',
    '- First write one hidden connected Korean narration, then split it into short screen-caption items.',
    ...koreanFullHookPromptLines(assignedHookType, {
      seed: `${sourceUrl || ''}:${filename || ''}`,
      sourceUrl,
      filename,
      detectedSubject: guide?.detected_subject || '',
      sourceText: JSON.stringify(guide?.scene_transitions || [])
    }),
    '- The first 3 to 5 items must quickly answer what is being assembled and why precision matters.',
    '- Never leave the script empty. Empty arrays are invalid.',
    '- Never output bare noun labels or scene tags instead of spoken Korean narration.',
    '- Every item must be its own complete clause that ends in a natural Korean ending or connector (-요, -죠, -예요, -해요, -돼요, -고, -니까, -면서, -합니다, -됩니다, -입니다, -니다, -까, or punctuation). Never end an item with only a bare noun, an object/topic/subject particle (을/를/은/는/이/가), or a half-finished modifier — never split one grammatical unit across two items.',
    '- Pseudo-sentences made only of fragments such as ["위험,", "청결,", "끝."] are forbidden.',
    '- Do not write three consecutive fragment lines without a real spoken predicate.',
    ...koreanFullSpeechBudgetPromptLines(speechBudget),
    ...koreanFullSceneSpeechBudgetPromptLines(sceneSummary),
    `- Target ${OUTPUT_CONFIG.full_draft.caption.promptTargetMinChars} to ${OUTPUT_CONFIG.full_draft.caption.promptTargetMaxChars} Korean characters per item; hard max ${OUTPUT_CONFIG.full_draft.caption.safeMaxChars} visible characters.`,
    '',
    'Example shape (structure only, not content):',
    JSON.stringify({
      full_caption_script_ko: [
        { scene_id: 'scene_01', role: 'hook', text: '처음엔 뭘 만드는지 잘 안 보여도요', source_basis: 'initial_full_caption_script_seed' },
        { scene_id: 'scene_02', role: 'technical_context', text: '이건 소리를 버틸 기초를 맞추는 공정이에요', source_basis: 'initial_full_caption_script_seed' }
      ]
    }, null, 2),
    '',
    'Existing context:',
    JSON.stringify({
      detected_subject: guide?.detected_subject || '',
      full_metadata_ko: guide?.full_metadata_ko || null,
      scene_summary: sceneSummary,
      allowed_scene_ids: sceneSummary.map((scene) => scene.scene_id).filter(Boolean)
    }, null, 2)
  ].join('\n');
}

function buildKoreanFullCaptionScriptRegenerationPrompt({ sourceUrl, filename, durationSec, guide, issues, assignedHookType = null }) {
  const speechBudget = koreanFullSpeechBudgetFromGuide(guide, durationSec);
  const sceneSummary = (Array.isArray(guide?.scene_transitions) ? guide.scene_transitions : [])
    .slice(0, 16)
    .map((scene) => ({
      scene_id: scene.scene_id,
      start_sec: scene.start_sec,
      end_sec: scene.end_sec,
      visual_summary: scene.visual_summary,
      caption_text_ko: scene.caption_text_ko,
      screen_captions_ko: scene.screen_captions_ko,
      focus_target: scene.focus_target,
      scene_role: scene.scene_role
    }));
  return [
    'You are regenerating ONLY the Korean Full Draft screen-caption manuscript for the 3-minute Ottogi process workflow.',
    'Return JSON only. Do not include Markdown.',
    '',
    'Why this regeneration is required:',
    '- The previous Korean Full manuscript used forbidden report-style or repetitive formal endings.',
    '- This must be a fresh Korean narration rewrite, not a local text repair.',
    '',
    'Required output fields:',
    `- ${OUTPUT_CONFIG.full_draft.scriptKey}: 20 to 24 objects. Korean only.`,
    '- Each object must contain scene_id, role, text, source_basis.',
    '- scene_id must be copied from Existing context.scene_summary[].scene_id, for example scene_01. Do not output script_001 IDs.',
    '- Do not return full_caption_script_ja or any Japanese Full fields.',
    '',
    'Korean narration rules:',
    '- Scene data is factual reference only. Do not copy visual_summary, caption_text_ko, or screen_captions_ko as the script.',
    '- First write one hidden connected Korean narration, then split it into short screen-caption items.',
    ...koreanFullHookPromptLines(assignedHookType, {
      seed: `${sourceUrl || ''}:${filename || ''}`,
      sourceUrl,
      filename,
      detectedSubject: guide?.detected_subject || '',
      sourceText: JSON.stringify(guide?.scene_transitions || [])
    }),
    '- Use natural spoken Korean for a friendly process-channel host.',
    '- Sentence validity rule v3: every caption item must be its own complete clause. Never end an item with only a bare noun, an object/topic/subject particle (을/를/은/는/이/가), or a half-finished modifier — never split one grammatical unit across two items. Each item must end in a natural Korean ending or connector such as -요, -죠, -예요, -해요, -돼요, -고, -니까, -면서, -합니다, -됩니다, -입니다, -니다, -까, or punctuation.',
    '- Forbidden: no caption item may end with 함 or 됨.',
    '- Forbidden: do not write three consecutive caption items ending in 합니다.',
    ...koreanFullSpeechBudgetPromptLines(speechBudget),
    ...koreanFullSceneSpeechBudgetPromptLines(sceneSummary),
    `- Target ${OUTPUT_CONFIG.full_draft.caption.promptTargetMinChars} to ${OUTPUT_CONFIG.full_draft.caption.promptTargetMaxChars} Korean characters per item; hard max ${OUTPUT_CONFIG.full_draft.caption.safeMaxChars} visible characters.`,
    '- Scene_observation is optional support, not a quota target. Use it sparingly only when a visible beat helps the spoken manuscript.',
    '- Do not make scene_observation items consecutive. Sentence flow and timing budget are more important than role counts.',
    '- Use connector/explanation clauses such as 여기서 중요한 건 방향이에요, 그래서 힘 조절이 필요해요, 이 기준이 정밀함을 만들어요, 사람의 손이 마지막을 다듬어요 when they help the manuscript read as real Korean — always attach the reason/predicate in the same item, never leave the connector as a bare item by itself.',
    '- If a draft line says only what is visible, rewrite the text to explain why that visible action matters.',
    '',
    'Bad output rhythm (items with no predicate of their own; do not do this):',
    JSON.stringify(['이 부품은 곧', '여기서 중요한 건', '기준이 틀어지면', '같은 움직임을', '마지막 형태가'], null, 2),
    '',
    'Good Korean output rhythm (every item has its own predicate):',
    JSON.stringify(['처음엔 평범해 보여도 이 부품은 곧 새 역할을 얻어요', '먼저 자리를 맞추고', '흔들리면 안 되니까 손으로 잡아줘요', '여기서 중요한 건 힘보다 방향이에요', '기계가 눌러도 기준이 틀어지면', '품질이 눈에 띄게 달라져요', '같은 움직임을 계속 반복하면서', '정밀함이 조금씩 쌓이고', '마지막 형태가 조용히 완성돼요'], null, 2),
    '',
    'Invalid style issues:',
    JSON.stringify(issues || [], null, 2),
    '',
    'Source information:',
    `- Source URL: ${sourceUrl || 'not provided'}`,
    `- Original Filename: ${filename || 'unknown'}`,
    `- Duration Sec: ${durationSec || 'unknown'}`,
    '',
    'Existing context:',
    JSON.stringify({
      detected_subject: guide?.detected_subject || '',
      current_full_caption_script_ko: guide?.full_caption_script_ko || [],
      full_metadata_ko: guide?.full_metadata_ko || null,
      scene_summary: sceneSummary,
      allowed_scene_ids: sceneSummary.map((scene) => scene.scene_id).filter(Boolean)
    }, null, 2)
  ].join('\n');
}

function normalizeText(value) {
  return String(value || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanScriptText(text, korean = false) {
  const cleaned = normalizeText(text).replace(/\s+/g, korean ? ' ' : '').trim();
  if (!cleaned) return '';
  const validLanguage = korean ? isValidKoreanCaption(cleaned) : isValidJapaneseCaption(cleaned);
  if (!validLanguage) return '';
  if (looksLikeParagraphCaption(cleaned, korean)) return '';
  if (visibleTextLength(cleaned) > 80) return '';
  return cleaned;
}

function hasJapaneseText(value = '') {
  return /[\u3040-\u30ff\u3400-\u9fff]/u.test(String(value || ''));
}

function hasKanaText(value = '') {
  return /[\u3040-\u30ff]/u.test(String(value || ''));
}

function hasKoreanText(value = '') {
  return /[\uac00-\ud7af]/u.test(String(value || ''));
}

function isMostlyLatinText(value = '') {
  const text = String(value || '');
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const japanese = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/gu) || []).length;
  return latin >= 12 && latin > japanese * 2;
}

function isMostlyLatinKoreanText(value = '') {
  const text = String(value || '');
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const korean = (text.match(/[\uac00-\ud7af]/gu) || []).length;
  return latin >= 12 && latin > korean * 2;
}

function isValidJapaneseCaption(value = '') {
  const text = normalizeText(value);
  return Boolean(text) && hasJapaneseText(text) && !isMostlyLatinText(text);
}

function isBrokenJapaneseScreenPhrase(value = '') {
  const text = normalizeText(value || '')
    .replace(/[、。！？!?]+$/u, '')
    .replace(/\s+/g, '');
  if (!text) return true;
  if (!hasJapaneseText(text)) return true;
  if (/(?:こと|もの)$/u.test(text)) return false;

  // Unsafe as a standalone CapCut caption: Gemini likely cut the sentence
  // before the object/predicate arrived.
  if (/(?:を|が|の|に|へ|と|や|より|ほど|なら|な)$/u.test(text)) return true;

  // Production failures: "ワイヤーを部品が", "コイルを形を",
  // "しっかり中央を完璧な".
  if (/(?:を.*が$|を.*を|に.*を.*な$)/u.test(text)) return true;

  if (/^(?:たくさん|多く|大量|少し|少しずつ|いくつか)の$/u.test(text)) return true;
  return false;
}

function isValidKoreanCaption(value = '') {
  const text = normalizeText(value);
  return Boolean(text) && hasKoreanText(text) && !hasKanaText(text) && !isMostlyLatinKoreanText(text);
}

function clampNumber(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function clampDescription(value) {
  const text = normalizeText(value);
  if (text.length <= SHORT_DESCRIPTION_SOFT_MAX) return text;

  const sentenceCut = Math.max(
    text.lastIndexOf('.', SHORT_DESCRIPTION_SOFT_MAX),
    text.lastIndexOf('!', SHORT_DESCRIPTION_SOFT_MAX),
    text.lastIndexOf('?', SHORT_DESCRIPTION_SOFT_MAX),
    text.lastIndexOf('다.', SHORT_DESCRIPTION_SOFT_MAX),
    text.lastIndexOf('요.', SHORT_DESCRIPTION_SOFT_MAX)
  );
  if (sentenceCut >= 120) {
    return text.slice(0, sentenceCut + 1).trim();
  }

  const spaceCut = text.lastIndexOf(' ', SHORT_DESCRIPTION_SOFT_MAX);
  if (spaceCut >= 120) {
    return text.slice(0, spaceCut).trim();
  }

  return text.slice(0, SHORT_DESCRIPTION_SOFT_MAX).trim();
}

function defaultHighlightCaptionBlock(korean = false) {
  return korean
    ? '이 장면은 소재가 움직이며 형태를 바꾸는 가장 눈에 띄는 순간을 짧게 잘라낸 하이라이트입니다. 기계와 손작업의 흐름, 질감의 변화, 반복되는 움직임이 한 번에 보이도록 구성했습니다. 짧은 장면 안에서도 공정의 재미와 핵심 변화를 확인할 수 있습니다.'
    : 'ここでは、素材が動きながら形を変えていく一番目を引く瞬間を切り取っています。機械や手作業の流れに合わせて、質感、速度、変化の気持ちよさが伝わる場面です。短い時間でも工程の面白さと、完成へ近づく動きの魅力が分かる見どころです。';
}

function ensureHighlightCaptionBlock(value = '', korean = false) {
  const text = normalizeText(value);
  const validLanguage = korean
    ? isValidKoreanCaption(text)
    : isValidJapaneseCaption(text) && !hasKoreanText(text);
  const fallback = defaultHighlightCaptionBlock(korean);
  let block = validLanguage ? text : '';

  if ([...block].length < 120) {
    block = normalizeText(block ? `${block} ${fallback}` : fallback);
  }
  if ([...block].length < 120) {
    block = normalizeText(`${block} ${fallback}`);
  }

  return clampDescription(block);
}

function defaultJapaneseTitle(index, subject) {
  const safeSubject = normalizeText(subject) || '工場の工程';
  const defaults = [
    `${safeSubject}の流れを短く見る #worker #process #manufacturing #craftsmanship #factory`,
    `${safeSubject}が形になる瞬間 #worker #process #metalwork #tools #processvideo`,
    `${safeSubject}の製造工程を観察 #worker #process #factorywork #machinework #satisfying`,
    `職人と機械で進む${safeSubject} #worker #process #handmade #production #workshop`,
    `素材が変わる${safeSubject}の現場 #worker #process #material #transformation #industrial`
  ];
  return defaults[index % defaults.length];
}

function defaultKoreanTitle(index, subject) {
  const safeSubject = normalizeText(subject) || '공정';
  const defaults = [
    `${safeSubject}이 만들어지는 흐름 #worker #process #manufacturing #craftsmanship #factory`,
    `${safeSubject}이 형태를 갖추는 순간 #worker #process #metalwork #tools #processvideo`,
    `${safeSubject} 제조 공정 관찰 #worker #process #factorywork #machinework #satisfying`,
    `장인과 기계가 함께 만드는 ${safeSubject} #worker #process #handmade #production #workshop`,
    `소재가 바뀌는 ${safeSubject} 현장 #worker #process #material #transformation #industrial`
  ];
  return defaults[index % defaults.length];
}

function extractHashtagsFromText(value = '') {
  const tags = [];
  const regex = /[#＃]([\p{L}\p{N}_-]+)/gu;
  let match;
  while ((match = regex.exec(String(value || '')))) {
    tags.push(`#${match[1]}`);
  }
  return tags;
}

function defaultLocalizedHashtags(korean = false) {
  void korean;
  return ['#worker', '#process', '#manufacturing', '#craftsmanship', '#factory'];
}

function normalizeLocalizedHashtags(value = [], korean = false) {
  void korean;
  const raw = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  const seen = new Set();
  const tags = [];
  const push = (tag) => {
    const cleaned = normalizeText(tag).replace(/^#/, '').replace(/[^A-Za-z0-9_-]+/g, '');
    if (!cleaned) return;
    const valueWithHash = `#${cleaned}`;
    if (!/^#[A-Za-z0-9_-]+$/u.test(valueWithHash)) return;
    const key = valueWithHash.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(valueWithHash);
  };

  push('#worker');
  push('#process');
  raw.forEach(push);

  defaultLocalizedHashtags().forEach(push);

  return tags.slice(0, 5);
}

function titleWithEnglishHashtags(title = '', hashtags = []) {
  const cleanTitle = normalizeText(title)
    .replace(/[#＃][\p{L}\p{N}_-]+/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const normalizedHashtags = normalizeLocalizedHashtags(hashtags);
  return normalizeText(`${cleanTitle} ${normalizedHashtags.join(' ')}`).trim();
}

function normalizeTitleList(value, subject, korean = false) {
  const source = Array.isArray(value) ? value : [];
  const categories = korean
    ? ['간결형', '간결형', '정보형', '후킹형', '후킹형']
    : ['concise', 'concise', 'informational', 'hook', 'hook'];
  const normalized = source
    .map((item, index) => {
      if (typeof item === 'string') {
        const tagsFromTitle = extractHashtagsFromText(item);
        const hashtags = normalizeLocalizedHashtags(tagsFromTitle, korean);
        return {
          category: categories[index] || categories[0],
          title: titleWithEnglishHashtags(item, hashtags),
          hashtags
        };
      }
      if (!item || typeof item !== 'object') return null;
      const hashtags = normalizeLocalizedHashtags([
        ...(Array.isArray(item.hashtags) ? item.hashtags : []),
        ...extractHashtagsFromText(item.title || item.text || item.name || '')
      ], korean);
      return {
        category: normalizeText(item.category || categories[index] || categories[0]),
        title: titleWithEnglishHashtags(item.title || item.text || item.name || '', hashtags),
        hashtags
      };
    })
    .filter((item) => item?.title);

  while (normalized.length < 5) {
    const index = normalized.length;
    const title = korean ? defaultKoreanTitle(index, subject) : defaultJapaneseTitle(index, subject);
    normalized.push({
      category: categories[index] || categories[0],
      title: titleWithEnglishHashtags(title, extractHashtagsFromText(title)),
      hashtags: normalizeLocalizedHashtags(extractHashtagsFromText(title), korean)
    });
  }

  return normalized.slice(0, 5);
}

function normalizeHashtagList(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  const tags = raw
    .map((tag) => normalizeText(tag).replace(/^#/, ''))
    .filter(Boolean)
    .map((tag) => `#${tag}`);
  return [...new Set(tags.length ? tags : defaultLocalizedHashtags(false))].slice(0, 10);
}

function cleanUploadTitle(value = '') {
  let text = normalizeText(value)
    .replace(/\s+#\S.*$/u, '')
    .replace(/\s*\((?:Hook Video|Process Video|Ottogi Production|Ottogi Foods)\)\s*/giu, ' ')
    .replace(/\s*[-|]\s*(?:Full Process Video|Highlight Video|Hook Video|JP channel.*|KR channel.*|English Hashtags?.*)$/iu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const separatorParts = text.split(/\s+(?:[|｜]|-|–|—)\s+/u);
  if (separatorParts.length > 1 && hasJapaneseText(separatorParts[0])) {
    const suffix = separatorParts.slice(1).join(' ');
    if (isMostlyLatinText(suffix) || /(video|channel|hashtag|draft|full|highlight)/iu.test(suffix)) {
      text = separatorParts[0].trim();
    }
  }

  return text.slice(0, 100);
}

function titleHashtagsFromList(titles, korean = false) {
  const first = Array.isArray(titles) ? titles[0] : null;
  return normalizeLocalizedHashtags(first?.hashtags || defaultLocalizedHashtags(korean), korean);
}

function looksLikeParagraphCaption(value = '', korean = false) {
  const text = normalizeText(value);
  if (!text) return true;
  const punctuationCount = (text.match(/[。.!?！？]/gu) || []).length;
  if (punctuationCount >= 2) return true;
  if (/ご覧ください|様子を|工程を紹介|プロセスを紹介/u.test(text)) return true;
  if (visibleTextLength(text) > 30 && /(工程です|プロセスです)/u.test(text)) return true;
  if (korean && /(과정을 소개|모습을 보여|제조 과정을)/u.test(text)) return true;
  if (korean && visibleTextLength(text) > 30 && /(과정입니다|공정입니다)/u.test(text)) return true;
  return false;
}

function normalizeOnscreenSubtitleText(value = '', { korean = false } = {}) {
  const text = normalizeText(value)
    .replace(/^[-•*\d.)\s]+/u, '')
    .trim();
  if (!text) return '';
  const maxLength = korean ? 28 : 22;
  if (visibleTextLength(text) > maxLength) return '';
  if (looksLikeParagraphCaption(text, korean)) return '';
  if (korean) {
    if (!isValidKoreanCaption(text) || isStiffKoreanScreenCaption(text)) return '';
    return text;
  }
  if (!isValidJapaneseCaption(text) || isStiffJapaneseScreenCaption(text)) return '';
  return text;
}

function normalizeOnscreenSubtitles(value = [], fallback = [], options = {}) {
  const raw = [];
  const push = (item) => {
    if (Array.isArray(item)) item.forEach(push);
    else if (item && typeof item === 'object') push(item.text || item.caption || item.subtitle || item.line);
    else if (typeof item === 'string') {
      item.split(/\r?\n+/).forEach((line) => raw.push(line));
    }
  };
  push(value);
  const minItems = options.minItems || 3;
  const normalizeLines = (items) => {
    const seen = new Set();
    return items
      .map((line) => normalizeOnscreenSubtitleText(line, options))
      .filter(Boolean)
      .filter((line) => {
        const key = line.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  };
  let normalized = normalizeLines(raw);
  if (normalized.length < minItems) {
    const originalRaw = raw.splice(0, raw.length);
    push(fallback);
    normalized = normalizeLines([...originalRaw, ...raw]);
  }
  const seen = new Set();
  return normalized
    .filter((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, options.maxItems || 10);
}

function incompleteCaptionFragmentCount(lines = [], korean = false) {
  const items = Array.isArray(lines) ? lines : [];
  return items.filter((line) => {
    const text = normalizeText(line || '');
    if (!text) return false;
    if (korean) {
      return visibleTextLength(text) <= 5
        || /(은|는|이|가|을|를|에|로|의)$/u.test(text);
    }
    return visibleTextLength(text) <= 5
      || /[をにがでへとのは、,]$/u.test(text)
      || /^(ます|です|でした|ました)$/u.test(text);
  }).length;
}

function isBareFullDraftLabel(text = '', korean = false) {
  const normalized = normalizeText(text || '');
  if (!normalized) return false;
  if (korean) {
    return visibleTextLength(normalized) <= 8 && (
      /^(?:다시|더|정확히|깔끔하게|리듬감 있게)$/u.test(normalized)
      || /(?:세팅|절단|고정|유도|조정|완성|완성품|완성형)$/u.test(normalized)
      || /^[가-힣]+(?:을|를)\s*[가-힣]+$/u.test(normalized)
    );
  }
  return visibleTextLength(normalized) <= 10 && (
    /^(?:さらに|また|正確に|リズミカルに|ぴたっと)$/u.test(normalized)
    || /(?:セット|カット|固定|\u8a98\u5c0e|調整|完成|完成品|完成形)$/u.test(normalized)
    || /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+を[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(normalized)
  );
}

function chooseFullOnscreenSubtitles(sourceLines = [], fallbackLines = [], korean = false) {
  const source = normalizeOnscreenSubtitles(sourceLines, [], { korean, maxItems: 24, minItems: 1 });
  const fallback = normalizeOnscreenSubtitles(fallbackLines, [], { korean, maxItems: 24, minItems: 1 });
  if (!source.length) return fallback;
  if (!fallback.length) return source;

  const sourceWeakCount = incompleteCaptionFragmentCount(source, korean);
  const fallbackWeakCount = incompleteCaptionFragmentCount(fallback, korean);
  const sourceTooShortRatio = sourceWeakCount / Math.max(1, source.length);
  const fallbackTooShortRatio = fallbackWeakCount / Math.max(1, fallback.length);
  if (sourceTooShortRatio >= 0.35 && fallbackTooShortRatio < sourceTooShortRatio) {
    return fallback;
  }
  return source;
}

function deriveOnscreenSubtitlesFromScenes(scenes = [], language = 'ja', { highlight = false } = {}) {
  const korean = language === 'ko';
  const ranked = [...(Array.isArray(scenes) ? scenes : [])];
  const sceneScore = (scene) => {
    const explicit = Number(scene.a_grade_score || 0);
    if (explicit > 0) return explicit;
    const subScores = [
      Number(scene.tempo_score || 0),
      Number(scene.tension_score || 0),
      Number(scene.transformation_score || 0),
      Number(scene.framing_score || 0),
      Number(scene.flow_score || 0)
    ].filter((score) => Number.isFinite(score) && score > 0);
    if (subScores.length) return subScores.reduce((sum, score) => sum + score, 0);
    return Number(scene.visual_hook_score || 0) + Number(scene.repetition_potential || 0);
  };
  if (highlight) {
    ranked.sort((a, b) => {
      return sceneScore(b) - sceneScore(a);
    });
  }
  const source = highlight ? ranked.slice(0, 6) : ranked;
  const lines = [];
  source.forEach((scene) => {
    const captions = korean ? scene.screen_captions_ko : scene.screen_captions_ja;
    if (Array.isArray(captions)) lines.push(...captions);
    else if (typeof captions === 'string') lines.push(captions);
    lines.push(korean ? scene.caption_text_ko : scene.caption_text);
  });
  return normalizeOnscreenSubtitles(lines, [], { korean, maxItems: highlight ? 6 : 10 });
}

function normalizeVariantMetadata(value = {}, fallback = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const firstText = (...values) => {
    for (const value of values) {
      const text = normalizeText(value || '');
      if (text) return text;
    }
    return '';
  };
  const firstLongText = (...values) => {
    const candidates = values
      .map((value) => normalizeText(value || ''))
      .filter(Boolean);
    return candidates.find((text) => [...text].length >= 120) || candidates[0] || '';
  };
  const rawVariantType = String(
    source.variant_type ||
      fallback.variant_type ||
      (fallback.highlight ? 'highlight' : 'full')
  ).trim();
  const variantType = ['highlight', 'midform', 'full'].includes(rawVariantType)
    ? rawVariantType
    : 'full';
  const captionMode = variantType === 'highlight'
    ? 'long_bottom_explainer'
    : 'scene_based_short_subtitles';
  const titles = normalizeTitleList(
    source.recommended_titles || fallback.recommended_titles || [],
    fallback.subject || '',
    Boolean(fallback.korean)
  );
  const shortDescription = clampDescription(firstText(
    source.short_description,
    source.short_description_200,
    source.description,
    fallback.short_description,
    fallback.explainer_text,
    source.summary_caption,
    source.report_description
  ));
  const summaryCaption = clampDescription(firstText(
    source.summary_caption,
    fallback.summary_caption,
    source.short_description,
    source.short_description_200,
    fallback.short_description,
    shortDescription,
    source.report_description
  ));
  const onscreenSubtitles = variantType !== 'highlight'
    ? chooseFullOnscreenSubtitles(
        source.onscreen_subtitles || source.screen_captions || source.screen_caption_lines || [],
        fallback.onscreen_subtitles || [],
        Boolean(fallback.korean)
      )
    : [];
  const onscreenCaptionBlock = variantType === 'highlight'
    ? clampDescription(firstLongText(
        source.onscreen_caption_block,
        source.screen_caption_block,
        source.caption_block,
        source.long_bottom_explainer,
        source.lower_bottom_explainer,
        source.highlight_caption,
        source.highlight_explainer_text,
        fallback.onscreen_caption_block,
        fallback.summary_caption,
        fallback.short_description,
        fallback.explainer_text,
        source.summary_caption,
        source.short_description,
        source.short_description_200,
        source.report_description,
        shortDescription
      ))
    : '';
  const reportDescription = String(
    source.report_description ||
      fallback.report_description ||
      buildFallbackReport(fallback.subject || '', shortDescription, Boolean(fallback.korean))
  ).trim();
  const uploadTitle = cleanUploadTitle(source.upload_title || titles[0]?.title || fallback.upload_title || '');
  const hashtags = normalizeLocalizedHashtags(
    source.hashtags || fallback.hashtags || titleHashtagsFromList(titles, Boolean(fallback.korean)),
    Boolean(fallback.korean)
  );

  return {
    short_description: shortDescription,
    summary_caption: summaryCaption,
    variant_type: variantType,
    caption_mode: captionMode,
    onscreen_subtitles: onscreenSubtitles,
    onscreen_caption_block: onscreenCaptionBlock,
    recommended_titles: titles,
    report_description: ensureStructuredReportDescription(
      reportDescription,
      fallback.subject || '',
      shortDescription,
      Boolean(fallback.korean)
    ),
    upload_title: uploadTitle,
    hashtags
  };
}

const FULL_CAPTION_SCRIPT_ROLES = new Set([
  'hook',
  'identity',
  'process_purpose',
  'technical_context',
  'emotional_expression',
  'scene_observation',
  'method',
  'quality_reason',
  'progress',
  'closing'
]);

const FULL_CAPTION_SAFE_MAX_CHARS = {
  ja: captionSafeMaxChars('ja'),
  ko: captionSafeMaxChars('ko')
};

const LONGFORM_MIDFORM_SCHEMA = {
  type: 'object',
  properties: {
    midform_clip_120s: {
      type: 'object',
      properties: {
        start_sec: { type: 'number' },
        end_sec: { type: 'number' },
        duration_sec: { type: 'number' },
        source_time_basis: { type: 'string' },
        process_structure: {
          type: 'object',
          properties: {
            opening_hook: { type: 'string' },
            material_or_input: { type: 'string' },
            main_process: { type: 'string' },
            transformation: { type: 'string' },
            result: { type: 'string' },
            ending: { type: 'string' }
          }
        },
        why_this_window: { type: 'string' },
        relationship_to_hook_and_full: { type: 'string' }
      },
      required: ['start_sec', 'end_sec', 'duration_sec', 'source_time_basis', 'why_this_window']
    }
  },
  required: ['midform_clip_120s']
};

function inferFullScriptRole(index = 0, total = 1) {
  const safeTotal = Math.max(1, Number(total) || 1);
  const ratio = safeTotal <= 1 ? 0 : index / Math.max(1, safeTotal - 1);
  if (index === 0) return 'hook';
  if (index <= 3) return index === 1 ? 'process_purpose' : 'technical_context';
  if (ratio >= 0.92) return 'closing';
  if (
    Math.abs(ratio - 0.25) <= 0.06 ||
    Math.abs(ratio - 0.5) <= 0.06 ||
    Math.abs(ratio - 0.75) <= 0.06
  ) {
    return 'scene_observation';
  }
  if (ratio < 0.45) return 'method';
  if (ratio < 0.8) return 'quality_reason';
  return 'emotional_expression';
}

function splitFullScriptScreenPhrases(text = '', korean = false) {
  const cleaned = normalizeText(text).replace(/\s+/g, korean ? ' ' : '').trim();
  if (!cleaned) return [];
  const maxChars = korean ? FULL_CAPTION_SAFE_MAX_CHARS.ko : FULL_CAPTION_SAFE_MAX_CHARS.ja;
  const minChars = korean ? 4 : 6;
  if (visibleTextLength(cleaned) <= maxChars) return [cleaned];

  if (korean) {
    const parts = cleaned
      .split(/(?<=[.!?。！？]|입니다|합니다|됩니다|되죠|하죠|가죠|죠|요|다)\s*/u)
      .map((part) => part.replace(/[.!?。！？]+$/g, '').trim())
      .filter(Boolean);
    const units = [];
    const pushUnit = (unit) => {
      const value = normalizeText(unit).replace(/^[,，、\s]+|[,，、\s]+$/g, '').trim();
      if (!value) return;
      units.push(value);
    };
    for (const part of (parts.length ? parts : [cleaned])) {
      const words = part.split(/\s+/).filter(Boolean);
      let current = '';
      for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        if (visibleTextLength(next) > maxChars && visibleTextLength(current) >= minChars) {
          pushUnit(current);
          current = word;
        } else {
          current = next;
        }
      }
      pushUnit(current);
    }
    return units.filter(Boolean);
  }

  const chunks = cleaned
    .split(/(?<=[、,。！？!?])/u)
    .map((part) => part.replace(/[。！？!?]+$/g, '').trim())
    .filter(Boolean);
  if (visibleTextLength(cleaned) <= maxChars) {
    return [cleaned.replace(/[。！？!?]+$/g, '').trim()].filter(Boolean);
  }
  const units = [];
  for (const chunk of (chunks.length ? chunks : [cleaned])) {
    if (visibleTextLength(chunk) <= maxChars) {
      units.push(chunk);
      continue;
    }
    let current = '';
    for (const char of [...chunk]) {
      const next = `${current}${char}`;
      if (visibleTextLength(next) > maxChars && visibleTextLength(current) >= minChars) {
        units.push(current);
        current = char;
      } else {
        current = next;
      }
    }
    if (current) units.push(current);
  }
  return units.filter(Boolean);
}


function enforceFullCaptionSafeLengths(items = [], korean = false) {
  const output = [];
  const safeItems = Array.isArray(items) ? items : [];
  safeItems.forEach((item, index) => {
    const text = normalizeText(item?.text || '');
    if (!text) return;
    const maxChars = korean ? FULL_CAPTION_SAFE_MAX_CHARS.ko : FULL_CAPTION_SAFE_MAX_CHARS.ja;
    const phrases = visibleTextLength(text) > maxChars
      ? splitFullScriptScreenPhrases(text, korean)
      : [text];
    (phrases.length ? phrases : [text]).forEach((phrase, phraseIndex) => {
      const cleaned = normalizeText(phrase || '');
      if (!cleaned) return;
      if (visibleTextLength(cleaned) > maxChars) return;
      const baseSceneId = normalizeText(item?.scene_id || `script_${String(index + 1).padStart(3, '0')}`);
      output.push({
        ...item,
        scene_id: phraseIndex === 0 ? baseSceneId : `${baseSceneId}_${String(phraseIndex + 1).padStart(2, '0')}`,
        text: cleaned
      });
    });
  });
  return output;
}

function limitFullScriptSceneRoles(items = []) {
  const output = items.map((item) => ({ ...item }));
  const sceneIndexes = output
    .map((item, index) => ({ index, role: item.role }))
    .filter((item) => item.role === 'scene_observation')
    .map((item) => item.index);
  if (sceneIndexes.length <= 6) return output;

  const total = Math.max(1, output.length - 1);
  const keep = new Set();
  for (const target of [0.2, 0.35, 0.5, 0.65, 0.75, 0.9]) {
    const nearest = sceneIndexes
      .filter((index) => !keep.has(index))
      .sort((a, b) => Math.abs((a / total) - target) - Math.abs((b / total) - target))[0];
    if (nearest !== undefined) keep.add(nearest);
  }
  output.forEach((item, index) => {
    if (item.role === 'scene_observation' && !keep.has(index)) {
      item.role = inferFullScriptRole(index, output.length);
      if (item.role === 'scene_observation') item.role = index % 2 ? 'method' : 'technical_context';
    }
  });
  return output;
}

function expandRepairedKoreanFullScriptItems(items = [], minimum = 20) {
  const output = (Array.isArray(items) ? items : [])
    .map((item) => ({ ...item, text: normalizeText(item?.text || '') }))
    .filter((item) => item.text);
  if (output.length >= minimum || output.length < 12) return output;

  const inserts = buildFullScriptItemsFromLines([
    '여기서 중요한 건',
    '흐름이 흔들리지',
    '않게 맞추는 것',
    '손으로 상태를 보고',
    '기계로 힘을 더해',
    '작은 틈도 확인해요',
    '표면을 다시 보고',
    '완성도를 높여요'
  ], true, 'server_full_script_repair_expansion');
  const sceneObservationTargets = new Set([2, 5, 6]);
  inserts.forEach((item, index) => {
    item.role = sceneObservationTargets.has(index) ? 'scene_observation' : item.role;
  });

  let insertIndex = Math.max(1, output.length - 1);
  for (const insert of inserts) {
    if (output.length >= minimum) break;
    output.splice(insertIndex, 0, {
      ...insert,
      scene_id: `script_repair_expand_${String(output.length + 1).padStart(3, '0')}`
    });
    insertIndex = Math.min(output.length - 1, insertIndex + 2);
  }
  return limitFullScriptSceneRoles(output);
}

function repairKoreanBrokenFullScriptItems(items = []) {
  const output = items.map((item) => ({ ...item, text: normalizeText(item.text || '') }));
  const consumeNextPrefix = (index, pattern, replacement = '') => {
    const next = output[index + 1];
    if (!next?.text || !pattern.test(next.text)) return false;
    next.text = next.text.replace(pattern, replacement).trim();
    return true;
  };

  for (let index = 0; index < output.length - 1; index += 1) {
    const item = output[index];
    if (!item?.text) continue;
    if (item.text === '다' && /^음은\s*/u.test(output[index + 1]?.text || '')) {
      item.text = '다음은';
      output[index + 1].text = output[index + 1].text.replace(/^음은\s*/u, '').trim();
    }
    if (/다$/u.test(item.text) && consumeNextPrefix(index, /^음\b\s*/u)) {
      item.text = item.text.replace(/다$/u, '다음').trim();
    }
    if (/다$/u.test(item.text) && consumeNextPrefix(index, /^시\b\s*/u)) {
      item.text = item.text.replace(/다$/u, '다시').trim();
    }
    if (/기다$/u.test(item.text) && consumeNextPrefix(index, /^립니다\b\s*/u)) {
      item.text = item.text.replace(/기다$/u, '기다립니다').trim();
    }
    if (/중요$/u.test(item.text) && consumeNextPrefix(index, /^한\b\s*/u, '한 ')) {
      item.text = item.text.replace(/중요$/u, '중요한').trim();
    }
    const next = output[index + 1];
    if (!next?.text) continue;
    if (
      /[이가은는을를에로와과도]$/u.test(item.text)
      || visibleTextLength(item.text) <= 5
      || visibleTextLength(next.text) <= 4
      || /\($/.test(item.text)
      || /^[)\]}]/.test(next.text)
      || /^장면\)?$/u.test(next.text)
    ) {
      item.text = normalizeText(`${item.text} ${next.text}`.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')')).trim();
      next.text = '';
    }
  }

  return output
    .map((item) => ({ ...item, text: normalizeText(item.text || '') }))
    .filter((item) => item.text);
}

function shouldJoinJapaneseCaptionFragments(previous = '', current = '') {
  const prev = normalizeText(previous);
  const next = normalizeText(current);
  if (!prev || !next) return false;
  if (/[。！？!?]$/u.test(prev)) return false;
  if (visibleTextLength(next) <= 3) return true;
  if (/^[をにがでへとやのもは、,]/u.test(next)) return true;
  if (/^(ます|ました|です|でした|れます|ります|します|込み|刻|生|て|った|セット)$/u.test(next)) return true;
  if (/[、,]$/u.test(prev)) return true;
  if (/(作り|開け|流|彫|行わ|はめ|組み合|詰ま)$/u.test(prev)) return true;
  return false;
}

function repairJapaneseBrokenFullScriptItems(items = []) {
  const output = [];
  for (const item of items.map((entry) => ({ ...entry, text: normalizeJapaneseFullScriptEnding(entry.text || '') }))) {
    if (!item.text) continue;
    const previous = output[output.length - 1];
    if (previous && shouldJoinJapaneseCaptionFragments(previous.text, item.text)) {
      previous.text = normalizeText(`${previous.text}${item.text}`).replace(/、{2,}/g, '、');
      previous.source_basis = previous.source_basis || item.source_basis || '';
      continue;
    }
    output.push(item);
  }
  return output.filter((item) => item.text);
}

function normalizeJapaneseFullScriptEnding(text = '') {
  const normalized = normalizeText(text || '');
  if (/^(?:進み){2,}$/u.test(normalized)) return '';
  return normalized
    .replace(/固まる前に$/u, '固まるのを待つ')
    .replace(/均一に$/u, '均一に整え')
    .replace(/丁寧に$/u, '丁寧に進め')
    .replace(/前に$/u, '前の準備')
    .replace(/へ$/u, 'へ進み')
    .replace(/を$/u, 'を扱い');
}

function comparableCaptionText(text = '') {
  return normalizeText(text)
    .replace(/[\s"'“”‘’.,!?！？。、，・:：;；\-—–~〜…]+/gu, '')
    .trim()
    .toLowerCase();
}

function dedupeAdjacentFullCaptionScriptItems(items = []) {
  const output = [];
  for (const item of (Array.isArray(items) ? items : [])) {
    const text = normalizeText(item?.text || '');
    if (!text) continue;
    const previous = output[output.length - 1];
    if (previous && comparableCaptionText(previous.text) === comparableCaptionText(text)) {
      continue;
    }
    output.push({ ...item, text });
  }
  return output;
}

function buildFullScriptItemsFromLines(lines = [], korean = false, sourceBasis = 'server_full_script_domain_fallback') {
  return (Array.isArray(lines) ? lines : [])
    .map((text, index) => {
      const cleaned = normalizeText(text || '');
      if (!cleaned) return null;
      return {
        scene_id: `script_fallback_${String(index + 1).padStart(3, '0')}`,
        role: inferFullScriptRole(index, lines.length),
        text: cleaned,
        source_basis: sourceBasis
      };
    })
    .filter(Boolean);
}

function maybeBuildDomainFullScriptFallback(source = [], korean = false) {
  void source;
  void korean;
  // Do not inject domain-specific local scripts. A wrong fallback is worse than
  // a failed validation because it can silently produce an unrelated draft.
  // Invalid Full manuscripts must be preserved for validation/repair instead.
  return [];
  /*
  const texts = (Array.isArray(source) ? source : [])
    .map((item) => normalizeText((item && typeof item === 'object') ? (item.text || item.caption || item.subtitle || '') : item))
    .filter(Boolean);
  const joined = texts.join(' ');
  const palmOilLike = korean
    ? /(팜유|기름|열매|농원|농장|트럭|트레일러|수확|크레인)/u.test(joined)
    : /(パーム油|油|原料|果実|実|農園|収穫|トレーラー|荷台|クレーン|アブラヤシ)/u.test(joined);
  if (!palmOilLike) return [];

  if (korean) {
    return buildFullScriptItemsFromLines([
      '이게 뭔지 아세요?',
      '기름의 원료가 되는',
      '팜유 열매를',
      '수확하는 장면이에요',
      '넓은 농장에서',
      '잘 익은 송이를',
      '사람이 먼저 보고',
      '상태를 가려냅니다',
      '긴 장대로 떨어뜨린 뒤',
      '땅에 모인 열매를',
      '기계가 받아 올리고',
      '여기서 중요한 건',
      '많이 모으는 것보다',
      '상하지 않게',
      '흐름을 이어가는 것',
      '사람의 판단과',
      '기계의 힘이 만나',
      '무거운 열매도',
      '빠르게 실립니다',
      '이 반복이 쌓여',
      '공장으로 이어지고',
      '결국 매일 쓰는',
      '기름을 만들어냅니다'
    ], true, 'server_full_script_palm_oil_fallback');
  }

  return buildFullScriptItemsFromLines([
    'これ何だろう',
    '油の原料になる',
    'パームの実を',
    '収穫する場面',
    'パーム油を作るために',
    'まず実を集める',
    '広い農園の中で',
    '熟した房だけを見て',
    '人がタイミングを',
    '細かく見極める',
    '長い竿で落とした実は',
    '地面に集まっていき',
    'そこへ機械が入る',
    'ここで大事なのは',
    '速く集めるだけでなく',
    '実を傷めないこと',
    '人の判断に',
    '機械の力が加わり',
    '重い実も少しずつ',
    '荷台へ運ばれる',
    '同じ動きを重ねて',
    '収穫の流れを止めず',
    'この積み重ねが',
    '毎日の油を支える'
  ], false, 'server_full_script_palm_oil_fallback');
  */
}

function rewriteBareFullDraftScriptText(text = '', korean = false, index = 0) {
  const value = normalizeText(text).replace(/\s+/g, korean ? ' ' : '').trim();
  if (!value) return '';
  if (korean) {
    if (index === 0 && /^이게\s*뭔지\s*아세요\??$/u.test(value)) return '처음엔 낯설어 보여도';
    const rewritten = value
      .replace(/material transformation/giu, '소재 변화')
      .replace(/[()]/g, '')
      .replace(/세척$/u, '을 씻고')
      .replace(/만드는$/u, '만드는 과정')
      .replace(/압착$/u, '으로 짜내고')
      .replace(/분리$/u, '을 걸러내고')
      .replace(/붓고$/u, '부어 넣고')
      .replace(/완성$/u, '완성돼요')
      .replace(/^모터의 심장부$/u, '모터의 심장부예요')
      .replace(/^가는 구리선이$/u, '가는 구리선이 감겨 올라가고')
      .replace(/^빠르게 감겨간다$/u, '빠르게 감겨 올라가요')
      .replace(/^정밀 기계가$/u, '정밀 기계가 움직이고')
      .replace(/^지정된 위치로$/u, '지정된 위치로 들어가고')
      .replace(/^정확히 유도한다$/u, '정확한 자리로 유도해요')
      .replace(/^숙련된 작업자가$/u, '숙련된 작업자가 곁에서')
      .replace(/^작업을 지켜본다$/u, '작업 흐름을 끝까지 지켜봐요')
      .replace(/^작은 오차도$/u, '작은 오차도 그냥 넘기지 않고')
      .replace(/^용납되지 않는다$/u, '바로 다시 맞춰요')
      .replace(/^이 코일이$/u, '이 코일이 결국')
      .replace(/^전기를 만들어내는$/u, '전기를 만들어내는 핵심이 되고')
      .replace(/^중요한 부품이다$/u, '중요한 부품이 돼요')
      .replace(/^여러 번 겹쳐$/u, '여러 번 겹쳐 감기면서')
      .replace(/^이상적인 형태로$/u, '이상적인 형태에 가까워지고')
      .replace(/^고도의 기술이$/u, '고도의 기술이 끝까지')
      .replace(/^고품질을 지탱한다$/u, '고품질을 지탱해요')
      .trim();
    if (/^[가-힣0-9\s]{2,}$/u.test(rewritten) && isFullScriptNominalLabel(rewritten, true)) {
      return `${rewritten.replace(/[.,!?！？。]+$/u, '').trim()}예요`;
    }
    return rewritten;
  }
  if (index === 0 && /(何|なん|これ)/u.test(value)) return 'これ何だろう';
  if (/^(じゃ|でもそれだけ)$/u.test(value)) return '';
  return value
    .replace(/^パーム油の収穫$/u, 'パーム油を収穫します')
    .replace(/^パーム油の元$/u, '油の原料です')
    .replace(/^パーム油の元を$/u, '油の原料です')
    .replace(/^パーム油のもと$/u, '油の原料です')
    .replace(/^油の原料ですね$/u, '油の原料です')
    .replace(/^アブラヤシの実$/u, '油の原料です')
    .replace(/^パーム油の果実$/u, '油の原料になる実')
    .replace(/^熟した実の山$/u, '熟した実が集まり')
    .replace(/^広大な農園$/u, '広い農園で進み')
    .replace(/^広大な農園で$/u, '広い農園で進み')
    .replace(/^広い農園の一角$/u, '広い農園でも')
    .replace(/^広い農園で$/u, '広い農園で')
    .replace(/^機械が効率よく$/u, '機械が力を補い')
    .replace(/^地面の実を拾い$/u, '実を傷めず集め')
    .replace(/^満載のトレーラー$/u, '荷台いっぱいに')
    .replace(/^荷台がいっぱいに$/u, '荷台いっぱいに')
    .replace(/^トレーラーへ積む$/u, '荷台へ運び')
    .replace(/^トレーラーへ運ぶ$/u, '荷台へ運び')
    .replace(/^トレーラーへ積むでもそれだけ$/u, '運ぶだけでなく')
    .replace(/^タイミング見極め$/u, '時期を見極め')
    .replace(/^大量の油に$/u, '油の原料になります')
    .replace(/^収穫現場$/u, '収穫が進みます')
    .replace(/^機械の出番$/u, '機械が加わります')
    .replace(/^職人の技$/u, '職人が見極めます')
    .replace(/^完成品$/u, '完成へ近づきます')
    .replace(/^素材の山$/u, '素材が集まります')
    .replace(/洗い$/u, 'を洗う')
    .replace(/作り$/u, 'を作る工程')
    .replace(/から$/u, 'から始まり')
    .replace(/を$/u, 'を扱い')
    .replace(/へ$/u, 'へ進み')
    .replace(/投入$/u, 'を入れて')
    .replace(/圧搾$/u, 'を絞り')
    .replace(/分離$/u, 'を分けて')
    .replace(/煮込み$/u, 'を煮詰め')
    .replace(/流し込み$/u, 'へ流し込み')
    .replace(/仕上げ$/u, 'を仕上げる')
    .replace(/均一に$/u, '均一に整え')
    .replace(/丁寧に$/u, '丁寧に流す')
    .replace(/にを洗う$/u, 'に洗う')
    .replace(/へへ/u, 'へ')
      .replace(/固まるを待つ/u, '固まるのを待つ');
}

function isProtectedKoreanFullScriptSourceBasis(value = '') {
  const basis = normalizeText(value || '');
  return basis === 'full_caption_script_repair'
    || basis === 'full_caption_script_regeneration';
}

function normalizeRewrittenFullScriptItems(source = [], korean = false) {
  const items = (Array.isArray(source) ? source : [])
    .map((item, index) => {
      const itemObject = item && typeof item === 'object' ? item : { text: item };
      const rewritten = rewriteBareFullDraftScriptText(itemObject.text || itemObject.caption || itemObject.subtitle || item, korean, index);
      if (!rewritten) return null;
      return {
        scene_id: normalizeText(itemObject.scene_id || `script_${String(index + 1).padStart(3, '0')}`),
        role: FULL_CAPTION_SCRIPT_ROLES.has(normalizeText(itemObject.role || ''))
          ? normalizeText(itemObject.role || '')
          : inferFullScriptRole(index, source.length),
        text: rewritten,
        source_basis: normalizeText(itemObject.source_basis || itemObject.basis || 'label_rewritten_to_full_script')
      };
    })
    .filter((item) => item?.text);
  if (!items.length) return [];
  const firstText = normalizeText(items[0]?.text || '');
  if (korean && !firstText) {
    items.unshift({
      scene_id: 'script_hook_001',
      role: 'hook',
      text: '처음엔 낯설어 보여도',
      source_basis: 'server_full_script_label_rewrite'
    });
  } else if (!korean && !/(何|なん|これ)/u.test(firstText)) {
    items.unshift({
      scene_id: 'script_hook_001',
      role: 'hook',
      text: 'これ何だろう',
      source_basis: 'server_full_script_label_rewrite'
    });
  }
  const repaired = korean ? repairKoreanBrokenFullScriptItems(items) : repairJapaneseBrokenFullScriptItems(items);
  const limited = limitFullScriptSceneRoles(enforceFullCaptionSafeLengths(dedupeAdjacentFullCaptionScriptItems(repaired), korean));
  const limitedTexts = limited.map((item) => normalizeText(item?.text || '')).filter(Boolean);
  const formalEndingCount = limitedTexts.filter((text) => (
    korean
      ? /(입니다|습니다|됩니다|집니다|합니다)$/u.test(text)
      : /(です|ます|ました|されます|なります|します)$/u.test(text)
  )).length;
  const repairSourced = items.some((item) => isProtectedKoreanFullScriptSourceBasis(item?.source_basis || ''));
  const narrationConnectorCount = limitedTexts.filter((text) => isFullScriptNarrationConnector(text, korean)).length;
  const brokenFragmentCount = limitedTexts.filter((text) => (
    korean
      ? false
      : (isBrokenJapaneseScreenPhrase(text) || /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+が$/u.test(text))
  )).length;
  const stillReadsLikeLabels = limited.length < 8
    || limitedTexts.filter((text) => isFullScriptNominalLabel(text, korean)).length >= 3
    || limitedTexts.filter((text) => isFullScriptActionChecklistLine(text, korean)).length >= 5
    || narrationConnectorCount < 5
    || brokenFragmentCount > 0
    || formalEndingCount > Math.max(2, Math.floor(limitedTexts.length * 0.25));
  if (stillReadsLikeLabels && !repairSourced) {
    const fallback = maybeBuildDomainFullScriptFallback(source, korean);
    if (fallback.length) {
      return limitFullScriptSceneRoles(enforceFullCaptionSafeLengths(dedupeAdjacentFullCaptionScriptItems(fallback), korean));
    }
  }
  return limited;
}

function normalizeFullCaptionScript(value = [], scenes = [], language = 'ja', fallbackLines = [], options = {}) {
  const korean = language === 'ko';
  const source = Array.isArray(value) ? value : [];
  const fallback = Array.isArray(fallbackLines) ? fallbackLines : [];
  const allowSceneFallback = options.allowSceneFallback !== false;
  const sourceHasRepairResult = source.some((item) => isProtectedKoreanFullScriptSourceBasis((item && typeof item === 'object' ? item.source_basis : '') || ''));
  const normalizedScenes = Array.isArray(scenes) ? scenes : [];
  const sceneIds = normalizedScenes.map((scene, index) => normalizeText(scene?.scene_id || `scene_${String(index + 1).padStart(3, '0')}`));
  const textForScene = (scene, index) => {
    const explicit = fallback[index];
    if (explicit) return explicit;
    const captions = korean ? scene?.screen_captions_ko : scene?.screen_captions_ja;
    if (Array.isArray(captions) && captions.length) return captions[0];
    return korean ? scene?.caption_text_ko : scene?.caption_text;
  };
  const cleanScriptText = (text) => {
    const cleaned = normalizeText(text).replace(/\s+/g, korean ? ' ' : '').trim();
    if (!cleaned) return '';
    const validLanguage = korean ? isValidKoreanCaption(cleaned) : isValidJapaneseCaption(cleaned);
    if (!validLanguage) return '';
    if (looksLikeParagraphCaption(cleaned, korean)) return '';
    if (!sourceHasRepairResult && isBareFullDraftLabel(cleaned, korean)) return '';
    const maxLength = korean ? 80 : 80;
    if (visibleTextLength(cleaned) > maxLength) return '';
    return cleaned;
  };

  const sourceResult = source
    .flatMap((item, index) => {
      const itemObject = item && typeof item === 'object' ? item : { text: item };
      const text = cleanScriptText(itemObject.text || itemObject.caption || itemObject.subtitle || item);
      if (!text) return [];
      const role = normalizeText(itemObject.role || '');
      const baseSceneId = normalizeText(itemObject.scene_id || `script_${String(index + 1).padStart(3, '0')}`);
      const phrases = splitFullScriptScreenPhrases(text, korean);
      return (phrases.length ? phrases : [text]).map((phrase, phraseIndex) => ({
        scene_id: phraseIndex === 0 ? baseSceneId : `${baseSceneId}_${String(phraseIndex + 1).padStart(2, '0')}`,
        role: FULL_CAPTION_SCRIPT_ROLES.has(role) ? role : inferFullScriptRole(index, source.length),
        text: phrase,
        source_basis: normalizeText(itemObject.source_basis || itemObject.basis || '')
      }));
    })
    .filter(Boolean);

  if (sourceResult.length) {
    const firstText = normalizeText(sourceResult[0]?.text || '');
    if (korean && !firstText) {
      sourceResult.unshift({
        scene_id: 'script_hook_001',
        role: 'hook',
        text: '처음엔 낯설어 보여도',
        source_basis: 'required Korean full draft opening hook'
      });
    } else if (!korean && !/(何|なん|これ)/u.test(firstText)) {
      sourceResult.unshift({
        scene_id: 'script_hook_001',
        role: 'hook',
        text: 'これ何だろう',
        source_basis: 'required Japanese full draft opening hook'
      });
    }
    const repaired = sourceHasRepairResult && korean
      ? sourceResult
      : (korean ? repairKoreanBrokenFullScriptItems(sourceResult) : repairJapaneseBrokenFullScriptItems(sourceResult));
    const deduped = dedupeAdjacentFullCaptionScriptItems(repaired);
    const limited = limitFullScriptSceneRoles(enforceFullCaptionSafeLengths(deduped, korean));
    const limitedTexts = limited.map((item) => item.text);
    const weakCount = incompleteCaptionFragmentCount(limitedTexts, korean)
      + limitedTexts.filter((text) => isBareFullDraftLabel(text, korean)).length;
    const weakRatio = weakCount / Math.max(1, limited.length);
    if (sourceHasRepairResult && korean && limited.length >= 12) {
      return expandRepairedKoreanFullScriptItems(limited);
    }
    if (limited.length >= 20 && weakRatio < 0.35) {
      return limited;
    }
    if (limited.length >= 20) {
      // Keep Gemini's paid result intact. Later validation/repair can reject or
      // rewrite weak manuscript rhythm, but normalization must not erase a
      // complete script and turn it into a misleading "missing subtitles" error.
      return limited;
    }
  }

  const rewrittenSourceResult = normalizeRewrittenFullScriptItems(source, korean);
  if (rewrittenSourceResult.length >= 20) {
    return rewrittenSourceResult;
  }

  if (!allowSceneFallback) {
    return [];
  }

  const result = normalizedScenes.flatMap((scene, index) => {
    const sceneId = sceneIds[index];
    const fallbackText = cleanScriptText(textForScene(scene, index));
    if (!fallbackText) return [];
    const phrases = splitFullScriptScreenPhrases(fallbackText, korean);
    return (phrases.length ? phrases : [fallbackText]).map((phrase, phraseIndex) => ({
      scene_id: phraseIndex === 0 ? sceneId : `${sceneId}_${String(phraseIndex + 1).padStart(2, '0')}`,
      role: inferFullScriptRole(index, normalizedScenes.length),
      text: phrase,
      source_basis: normalizeText(scene?.visual_summary || '')
    }));
  }).filter(Boolean);

  if (result.length) {
    const repaired = korean ? repairKoreanBrokenFullScriptItems(result) : repairJapaneseBrokenFullScriptItems(result);
    const deduped = dedupeAdjacentFullCaptionScriptItems(repaired);
    return limitFullScriptSceneRoles(enforceFullCaptionSafeLengths(deduped, korean));
  }
  return [];
}

function fullCaptionScriptTexts(script = []) {
  return (Array.isArray(script) ? script : [])
    .map((item) => normalizeText(item?.text || item || ''))
    .filter(Boolean);
}

function expandMidformCaptionScript(script = [], fallbackLines = [], korean = false, durationSec = 120) {
  const minimum = midformCaptionMinimumForDuration(durationSec);
  const sourceItems = Array.isArray(script) ? script : [];
  const items = sourceItems
    .map((item, index) => {
      const text = cleanScriptText(item?.text || item || '', korean);
      if (!text) return null;
      return {
        scene_id: normalizeText(item?.scene_id || `midform_${String(index + 1).padStart(3, '0')}`),
        role: normalizeText(item?.role || inferFullScriptRole(index, Math.max(sourceItems.length, minimum))),
        text,
        source_basis: normalizeText(item?.source_basis || 'midform_caption_source')
      };
    })
    .filter(Boolean);

  const fallbackTexts = (Array.isArray(fallbackLines) ? fallbackLines : [])
    .map((line) => cleanScriptText(line?.text || line || '', korean))
    .filter(Boolean);
  const defaultTexts = korean
    ? [
        '이 장면을 보세요',
        '공정의 흐름 시작',
        '재료가 이동하고',
        '형태가 조금씩 잡혀요',
        '기계는 일정한 리듬',
        '작업 속도가 올라가요',
        '다음 단계로 전환',
        '표면을 다시 정리',
        '정확한 위치 맞춤',
        '반복 작업의 리듬',
        '작은 차이가 품질',
        '작업자가 흐름 확인',
        '재료의 방향 전환',
        '힘을 일정하게 유지',
        '모양이 더 선명해져요',
        '불필요한 부분 정리',
        '완성에 가까워져요',
        '공정의 리듬이 보여요',
        '정밀함이 쌓이는 중',
        '마지막 형태 맞추기',
        '결과물이 드러나는 순간',
        '반복 속의 기술',
        '완성도를 만드는 과정',
        '작업 흐름의 마무리'
      ]
    : [
        'これ何だろう',
        '素材が入って',
        '形の土台に',
        '機械の力で',
        '少しずつ整う',
        'ここで精度が',
        '品質を決める',
        '同じ動きを',
        '何度も重ねて',
        '職人の確認が',
        '流れを守る',
        '向きが変わり',
        '形が見えて',
        '余分を整え',
        '完成へ近づく',
        'この反復が',
        '仕上がりを',
        '静かに支える'
      ];
  const pool = [...fallbackTexts, ...defaultTexts].filter(Boolean);
  let poolIndex = 0;
  while (items.length < minimum) {
    const text = pool[poolIndex % pool.length] || (korean ? '공정이 이어져요' : '工程が続く');
    const safeText = cleanScriptText(text, korean);
    if (safeText && items[items.length - 1]?.text !== safeText) {
      items.push({
        scene_id: `midform_auto_${String(items.length + 1).padStart(3, '0')}`,
        role: inferFullScriptRole(items.length, minimum),
        text: safeText,
        source_basis: 'server_midform_caption_completion'
      });
    }
    poolIndex += 1;
    if (poolIndex > minimum + pool.length + 5) break;
  }
  return enforceFullCaptionSafeLengths(items, korean).slice(0, MIDFORM_CAPTION_MAX_ITEMS_120S);
}

function midformCaptionMinimumForDuration(durationSec = 120) {
  const duration = Number(durationSec);
  if (!Number.isFinite(duration) || duration <= 0) return MIDFORM_CAPTION_MIN_ITEMS_120S;
  return Math.max(24, Math.min(MIDFORM_CAPTION_MIN_ITEMS_120S, Math.floor(duration / 4)));
}

function buildFallbackReport(subject, shortDescription, korean = false) {
  const safeSubject = normalizeText(subject) || (korean ? '공정' : '工程');
  if (korean) {
    return [
      '1. 작업 개요',
      `${safeSubject}이 어떤 순서로 변화하는지 보여주는 공정 영상입니다.`,
      '2. 사용 재료 및 장비',
      '영상에서 확인되는 재료, 작업 도구, 기계 장치를 중심으로 설명합니다.',
      '3. 시공 절차',
      shortDescription || '소재가 투입되고, 가공되며, 형태를 갖추는 과정을 순서대로 정리합니다.',
      '4. 작업의 중요성',
      '각 단계의 손작업과 기계 동작은 결과물의 형태와 품질을 결정합니다.',
      '5. 가이드라인 준수 및 교육적 목적',
      '본 영상은 제조 공정을 이해하기 위한 교육적 목적의 설명입니다.'
    ].join('\n');
  }
  return [
    '1. 作業概要',
    `${safeSubject}がどのような順序で変化するかを紹介する工程映像です。`,
    '2. 使用材料と設備',
    '映像で確認できる素材、道具、機械の動きを中心に説明します。',
    '3. 工程手順',
    shortDescription || '素材が投入され、加工され、形を整えていく流れを順番にまとめます。',
    '4. 作業の重要性',
    '各工程の手作業と機械動作が、仕上がりの形や品質に影響します。',
    '5. ガイドライン遵守と教育目的',
    '本映像は製造工程を理解するための教育的な説明です。'
  ].join('\n');
}

function metadataTextHasLatin(value = '') {
  return hasLongLatinWord(value);
}

function stripMetadataHashtags(value = '') {
  return normalizeText(value || '')
    .replace(/[#＃][\p{L}\p{N}_-]+/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function safeMetadataSeed(candidates = [], korean = false) {
  for (const candidate of candidates) {
    const text = stripMetadataHashtags(candidate);
    if (!text || metadataTextHasLatin(text)) continue;
    if (korean ? isValidKoreanCaption(text) : isValidJapaneseCaption(text)) return text;
  }
  return korean ? '제조 공정' : '製造工程';
}

function metadataSectionTextCandidates(metadata = {}) {
  return [
    metadata.upload_title,
    metadata.short_description,
    metadata.summary_caption,
    metadata.onscreen_caption_block,
    metadata.report_description,
    ...(Array.isArray(metadata.recommended_titles) ? metadata.recommended_titles.map((item) => item?.title) : [])
  ];
}

function deterministicDescription(seed = '', korean = false) {
  const safeSeed = safeMetadataSeed([seed], korean);
  return korean
    ? `${safeSeed}의 핵심 장면을 자연스럽게 보여주는 공정 영상입니다.`
    : `${safeSeed}の見どころを自然に伝える工程映像です。`;
}

function deterministicCaptionBlock(seed = '', korean = false) {
  const safeSeed = safeMetadataSeed([seed], korean);
  return korean
    ? `${safeSeed}이 어떤 순서로 움직이고 완성되는지 한눈에 볼 수 있는 장면입니다. 짧은 순간 안에 재료의 변화와 작업 흐름이 선명하게 드러납니다.`
    : `${safeSeed}がどのような流れで形を変えていくのかを一目で見せる場面です。短い時間の中に、素材の変化と作業のリズムが分かりやすく詰まっています。`;
}

function deterministicTitlePatterns(seed = '', korean = false) {
  const safeSeed = safeMetadataSeed([seed], korean);
  return korean
    ? [
        `${safeSeed}이 만들어지는 과정`,
        `${safeSeed}이 완성되는 순간`,
        `${safeSeed} 공정의 핵심 장면`,
        `작업 흐름으로 보는 ${safeSeed}`,
        `${safeSeed} 제작 과정 관찰`
      ]
    : [
        `${safeSeed}ができるまで`,
        `${safeSeed}が形になる瞬間`,
        `${safeSeed}工程の見どころ`,
        `作業の流れで見る${safeSeed}`,
        `${safeSeed}づくりを観察`
      ];
}

function rebuildMetadataTitles(metadata = {}, seed = '', korean = false) {
  const categories = korean
    ? ['간결형', '간결형', '정보형', '후킹형', '후킹형']
    : ['concise', 'concise', 'informational', 'hook', 'hook'];
  const hashtags = normalizeLocalizedHashtags([
    ...(Array.isArray(metadata.hashtags) ? metadata.hashtags : []),
    ...(Array.isArray(metadata.recommended_titles)
      ? metadata.recommended_titles.flatMap((item) => Array.isArray(item?.hashtags) ? item.hashtags : [])
      : [])
  ], korean);
  return deterministicTitlePatterns(seed, korean).map((title, index) => ({
    category: categories[index] || categories[0],
    title: titleWithEnglishHashtags(title, hashtags),
    hashtags
  }));
}

function publicTitleNeedsRebuild(metadata = {}) {
  const titles = Array.isArray(metadata.recommended_titles) ? metadata.recommended_titles : [];
  return titles.length < 5 || titles.some((item) => metadataTextHasLatin(stripMetadataHashtags(item?.title || '')));
}

function enforceMetadataSectionLanguage(metadata = {}, seedCandidates = [], korean = false) {
  const source = metadata && typeof metadata === 'object' ? metadata : {};
  const seed = safeMetadataSeed([...seedCandidates, ...metadataSectionTextCandidates(source)], korean);
  const next = { ...source };
  ['upload_title', 'short_description', 'summary_caption'].forEach((field) => {
    const value = normalizeText(next[field] || '');
    if (!value || metadataTextHasLatin(stripMetadataHashtags(value)) || !(korean ? isValidKoreanCaption(stripMetadataHashtags(value)) : isValidJapaneseCaption(stripMetadataHashtags(value)))) {
      next[field] = field === 'upload_title'
        ? titleWithEnglishHashtags(deterministicTitlePatterns(seed, korean)[0], next.hashtags || [])
        : deterministicDescription(seed, korean);
    }
  });
  if (Object.prototype.hasOwnProperty.call(next, 'onscreen_caption_block')) {
    const value = normalizeText(next.onscreen_caption_block || '');
    if (!value || metadataTextHasLatin(value) || !(korean ? isValidKoreanCaption(value) : isValidJapaneseCaption(value))) {
      next.onscreen_caption_block = deterministicCaptionBlock(seed, korean);
    }
  }
  const reportValue = normalizeText(next.report_description || '');
  if (!reportValue || metadataTextHasLatin(reportValue) || !(korean ? isValidKoreanCaption(reportValue) : isValidJapaneseCaption(reportValue))) {
    next.report_description = formatStructuredReportDescription(buildFallbackReport(
      seed,
      deterministicDescription(seed, korean),
      korean
    ), korean);
  }
  if (publicTitleNeedsRebuild(next)) {
    next.recommended_titles = rebuildMetadataTitles(next, seed, korean);
  }
  return next;
}

function enforcePublicMetadataLanguage(guide = {}) {
  const next = { ...guide };
  const koSeedCandidates = [
    next.detected_subject_ko,
    next.short_description_ko,
    next.explainer_text_ko,
    next.report_description_ko,
    ...(Array.isArray(next.full_caption_script_ko) ? next.full_caption_script_ko.map((item) => item?.text) : [])
  ];
  const jaSeedCandidates = [
    next.highlight_explainer_text,
    ...(Array.isArray(next.highlight_hook_captions_ja) ? next.highlight_hook_captions_ja : []),
    next.detected_subject_ja
  ];
  next.full_metadata_ko = enforceMetadataSectionLanguage(next.full_metadata_ko, koSeedCandidates, true);
  next.highlight_metadata = enforceMetadataSectionLanguage(next.highlight_metadata, jaSeedCandidates, false);
  next.highlight_metadata_ko = enforceMetadataSectionLanguage(next.highlight_metadata_ko, koSeedCandidates, true);
  next.short_description_ko = metadataTextHasLatin(next.short_description_ko) || !isValidKoreanCaption(next.short_description_ko)
    ? deterministicDescription(safeMetadataSeed(koSeedCandidates, true), true)
    : next.short_description_ko;
  next.explainer_text_ko = metadataTextHasLatin(next.explainer_text_ko) || !isValidKoreanCaption(next.explainer_text_ko)
    ? deterministicDescription(safeMetadataSeed(koSeedCandidates, true), true)
    : next.explainer_text_ko;
  next.report_description_ko = metadataTextHasLatin(next.report_description_ko) || !isValidKoreanCaption(next.report_description_ko)
    ? next.full_metadata_ko.report_description
    : next.report_description_ko;
  next.recommended_titles_ko = rebuildMetadataTitles(next.full_metadata_ko, safeMetadataSeed(koSeedCandidates, true), true);
  return next;
}

function buildLongformVariantFinalPrompt({ variant, sourceUrl, filename, durationSec, candidateGuide, hookGuide, storyGuide, midformGuide, assignedHookType = null }) {
  const storyDurationSec = durationFromWindow(storyGuide?.story_clip_40s)
    || durationFromWindow(candidateGuide?.story_clip_40s)
    || durationFromWindow(candidateGuide?.recommended_full_window)
    || durationSec;
  const fullSpeechBudgetLines = koreanFullSpeechBudgetPromptLines(calculateKoreanFullSpeechBudget({
    targetDurationSec: storyDurationSec
  }));
  const variantConfig = {
    full: {
      phaseName: 'KR Full',
      windowName: 'story_clip_40s',
      requiredFields: [
        'full_metadata_ko',
        'full_caption_script_ko',
        'short_description_ko',
        'recommended_titles_ko',
        'report_description_ko',
        'explainer_text_ko'
      ],
      rules: [
        '- Create only the KR Full process-summary draft metadata and scripts.',
        '- Full uses story_clip_40s only. The field name is legacy; treat it as one about-60-second core-process source window.',
        '- Full must explain one important process in depth, not summarize unrelated moments from the whole long-form video.',
        '- Full must not claim an unseen result. If the selected source window does not visibly show water, final products, packaging, or completion, describe those as purpose/goal only.',
        '- Full caption mode is scene_based_short_subtitles for compatibility, but the content must be manuscript-based caption chunks, not scene labels.',
        '- Full production language is Korean. full_caption_script_ko and full_metadata_ko are the real production output for this variant.',
        '- Korean Full must sound like natural spoken Korean for curious viewers, not like translated Japanese or noun-only labels.',
        '- Avoid bare label chunks such as "모터의 심장부", "정밀 기계가", "작은 오차도" unless they continue naturally into the next phrase.',
        '- Prefer connected Korean phrasing such as "모터의 심장부예요", "정밀 기계가 움직이고", "작은 오차도 그냥 넘기지 않고".',
        '- Do not leave English fallback phrases like "material transformation" inside Korean Full fields. Rewrite them into natural Korean.',
        '- full_caption_script_ko should be 20 to 24 short Korean connected narration phrases for the selected core-process window.',
        '- Each full_caption_script_ko item.scene_id must be copied from the selected scene_transitions real IDs such as scene_01, scene_02, scene_03. Reuse a scene ID for multiple nearby caption chunks when needed; never output script_001 IDs.',
        ...fullSpeechBudgetLines,
        ...koreanFullSceneSpeechBudgetPromptLines(storyGuide?.scene_transitions || candidateGuide?.scene_transitions || []),
        '- full_metadata_ko.onscreen_subtitles must copy the same manuscript chunks from full_caption_script_ko. Do not fill it from raw scene captions.',
        '- full_metadata_ko.summary_caption is a short public Korean summary, not the screen caption block.',
        ...koreanFullHookPromptLines(assignedHookType, {
          seed: `${sourceUrl || ''}:${filename || ''}:longform:${variant}`,
          sourceUrl,
          filename,
          sourceType: 'longform',
          sourceWorkflowMode: 'longform_to_shorts',
          sourceText: JSON.stringify({ candidateGuide, hookGuide, storyGuide, midformGuide })
        }),
        '- The first KR Full caption must follow the assigned hook type without using the banned exact phrase.',
        '- Do not create Japanese Full metadata, Japanese Full subtitles, or full_caption_script_ja. Full drafts are Korean only.',
        '- Do not create Highlight or Midform metadata in this response.'
      ]
    },
    highlight: {
      phaseName: 'JP Highlight',
      windowName: 'hook_clip_10s',
      requiredFields: [
        'highlight_metadata',
        'highlight_metadata_ko',
        'highlight_explainer_text',
        'highlight_explainer_text_ko',
        'highlight_hook_captions_ja',
        'highlight_hook_captions_ko'
      ],
      rules: [
        '- Create only the JP Highlight visual-hook metadata.',
        '- Highlight uses hook_clip_10s only.',
        '- Highlight must describe one selected process/action only, not the whole long-form source.',
        '- Do not mention multiple unrelated scenes, many workers, or a compilation of different jobs in Highlight metadata.',
        '- Highlight caption mode is long_bottom_explainer.',
        '- highlight_metadata.onscreen_caption_block is mandatory and should be about 180 to 240 Japanese characters.',
        '- highlight_metadata.onscreen_caption_block is one long lower-bottom explainer block. It is not an array of short captions.',
        '- The long lower-bottom caption is part of the visual format, so write it as a dense but natural Japanese explainer paragraph.',
        '- highlight_explainer_text should match the same idea and may be used as fallback for the caption block.',
        '- highlight_metadata.onscreen_subtitles must be omitted or empty.',
        '- Do not use onscreen_subtitles for Highlight.',
        '- Do not create Full or Midform metadata in this response.'
      ]
    },
    midform: {
      phaseName: 'JP Midform',
      windowName: 'midform_clip_120s',
      requiredFields: [
        'midform_metadata',
        'midform_metadata_ko',
        'midform_caption_script_ja',
        'midform_caption_script_ko'
      ],
      rules: [
        '- Create only the JP Midform metadata and scripts.',
        '- Midform uses midform_clip_120s only.',
        '- Midform caption mode is scene_based_short_subtitles.',
        `- midform_caption_script_ja must contain ${MIDFORM_CAPTION_MIN_ITEMS_120S} to ${MIDFORM_CAPTION_MAX_ITEMS_120S} short Japanese process-flow captions for the longer selected window.`,
        `- midform_caption_script_ko must contain ${MIDFORM_CAPTION_MIN_ITEMS_120S} to ${MIDFORM_CAPTION_MAX_ITEMS_120S} Korean review captions matching the Japanese midform flow.`,
        '- Think of this as one caption about every 3 to 4 seconds. Do not summarize the 120-second Midform into only 8 to 12 labels.',
        '- Each Midform caption must be short enough for the CapCut text box and must avoid forced line breaks.',
        '- Midform script flow: opening hook -> process identity -> continuous technical/process explanation -> scene observations spread across the window -> emotional closing.',
        '- Midform is a separate channel format from Full. Use a broader whole-process perspective and do not copy Full metadata.',
        `- midform_metadata.onscreen_subtitles must mirror the same short Japanese process captions and should also contain ${MIDFORM_CAPTION_MIN_ITEMS_120S} to ${MIDFORM_CAPTION_MAX_ITEMS_120S} items.`,
        '- midform_metadata.summary_caption is a short public summary, not a screen caption block.',
        '- midform_caption_script_ko is Korean review-only and must be natural Korean.',
        '- Do not create Full or Highlight metadata in this response.'
      ]
    }
  }[variant];

  return [
    'You are a Shorts/Midform video metadata and caption writer for the 3-minute Ottogi workflow.',
    'Return JSON only. Do not include Markdown.',
    `Focused output variant: ${variantConfig.phaseName}`,
    `Use only this fixed window: ${variantConfig.windowName}. Do not choose new time windows.`,
    '',
    'Critical shared rules:',
    '- Japanese is the upload language.',
    '- Korean is review-only. Korean must never be upload metadata.',
    '- English fallback is forbidden.',
    '- No emoji or decorative symbols.',
    '- Titles must include exactly five English hashtags: #worker, #process, plus three relevant English hashtags.',
    '- Korean review titles must also use English hashtags only.',
    '',
    ...variantConfig.rules,
    '',
    'Return these fields when relevant:',
    variantConfig.requiredFields.map((field) => `- ${field}`).join('\n'),
    '',
    'Fixed windows and candidate context:',
    JSON.stringify({
      candidateGuide,
      hookGuide,
      storyGuide,
      midformGuide
    }, null, 2),
    '',
    'Source information:',
    `- Source URL: ${sourceUrl || 'not provided'}`,
    `- Original Filename: ${filename || 'unknown'}`,
    `- Duration Sec: ${durationSec || 'unknown'}`
  ].join('\n');
}

function buildLongformVariantFinalSchema(variant) {
  const shared = OTTOGI_METADATA_SCHEMA.properties;
  const schemas = {
    full: {
      type: 'object',
      properties: {
        detected_subject: { type: 'string' },
        short_description_ko: shared.short_description_ko,
        recommended_titles_ko: shared.recommended_titles_ko,
        report_description_ko: shared.report_description_ko,
        explainer_text_ko: shared.explainer_text_ko,
        full_metadata_ko: OTTOGI_VARIANT_METADATA_SCHEMA,
        full_caption_script_ko: shared.full_caption_script_ko,
        regional_editing_strategy: shared.regional_editing_strategy,
        variant_strategy: shared.variant_strategy
      },
      required: [
        'full_metadata_ko',
        'full_caption_script_ko',
        'short_description_ko',
        'recommended_titles_ko',
        'report_description_ko',
        'explainer_text_ko'
      ]
    },
    highlight: {
      type: 'object',
      properties: {
        detected_subject: { type: 'string' },
        highlight_metadata: buildVariantMetadataSchema('highlight'),
        highlight_metadata_ko: buildVariantMetadataSchema('highlight'),
        highlight_explainer_text: shared.highlight_explainer_text,
        highlight_explainer_text_ko: shared.highlight_explainer_text_ko,
        highlight_hook_captions_ja: shared.highlight_hook_captions_ja,
        highlight_hook_captions_ko: shared.highlight_hook_captions_ko,
        regional_editing_strategy: shared.regional_editing_strategy,
        variant_strategy: shared.variant_strategy
      },
      required: [
        'highlight_metadata',
        'highlight_metadata_ko',
        'highlight_explainer_text',
        'highlight_explainer_text_ko',
        'highlight_hook_captions_ja',
        'highlight_hook_captions_ko'
      ]
    },
    midform: {
      type: 'object',
      properties: {
        detected_subject: { type: 'string' },
        midform_metadata: OTTOGI_VARIANT_METADATA_SCHEMA,
        midform_metadata_ko: OTTOGI_VARIANT_METADATA_SCHEMA,
        midform_caption_script_ja: shared.midform_caption_script_ja,
        midform_caption_script_ko: shared.midform_caption_script_ko,
        regional_editing_strategy: shared.regional_editing_strategy,
        variant_strategy: shared.variant_strategy
      },
      required: [
        'midform_metadata',
        'midform_metadata_ko',
        'midform_caption_script_ja',
        'midform_caption_script_ko'
      ]
    }
  };
  return schemas[variant] || OTTOGI_METADATA_FIELD_REPAIR_SCHEMA;
}

function buildLongformMidformMetadataPrompt({ sourceUrl, filename, durationSec, candidateGuide, hookGuide, storyGuide, midformGuide }) {
  return [
    'You are a Japanese Midform upload metadata writer for the 3-minute Ottogi workflow.',
    'Return JSON only. Do not include Markdown.',
    'Focused output variant: JP Midform metadata only.',
    'Use only midform_clip_120s. Do not choose new time windows.',
    '',
    'Critical rules:',
    '- Japanese is the upload language.',
    '- Korean is review-only. Korean must never be upload metadata.',
    '- English fallback is forbidden.',
    '- No emoji or decorative symbols.',
    '- Do not write Midform captions in this response. Captions are requested in separate smaller calls.',
    '- Titles must include exactly five English hashtags: #worker, #process, plus three relevant English hashtags.',
    '- midform_metadata.caption_mode must be scene_based_short_subtitles.',
    '- midform_metadata.onscreen_subtitles may be empty here because captions are generated separately.',
    '- midform_metadata_ko is Korean review-only metadata for checking.',
    '',
    'Return required fields:',
    '- detected_subject',
    '- midform_metadata',
    '- midform_metadata_ko',
    '- regional_editing_strategy',
    '- variant_strategy',
    '',
    'Fixed windows and candidate context:',
    JSON.stringify({
      candidateGuide,
      hookGuide,
      storyGuide,
      midformGuide
    }, null, 2),
    '',
    'Source information:',
    `- Source URL: ${sourceUrl || 'not provided'}`,
    `- Original Filename: ${filename || 'unknown'}`,
    `- Duration Sec: ${durationSec || 'unknown'}`
  ].join('\n');
}

function buildLongformMidformMetadataSchema() {
  const shared = OTTOGI_METADATA_SCHEMA.properties;
  return {
    type: 'object',
    properties: {
      detected_subject: { type: 'string' },
      midform_metadata: OTTOGI_VARIANT_METADATA_SCHEMA,
      midform_metadata_ko: OTTOGI_VARIANT_METADATA_SCHEMA,
      regional_editing_strategy: shared.regional_editing_strategy,
      variant_strategy: shared.variant_strategy
    },
    required: [
      'midform_metadata',
      'midform_metadata_ko'
    ]
  };
}

function buildLongformMidformCaptionPartPrompt({ partIndex, totalParts, sourceUrl, filename, durationSec, candidateGuide, hookGuide, storyGuide, midformGuide, midformMetadata }) {
  const totalMin = MIDFORM_CAPTION_MIN_ITEMS_120S;
  const totalMax = MIDFORM_CAPTION_MAX_ITEMS_120S;
  const partMin = Math.ceil(totalMin / totalParts);
  const partMax = Math.ceil(totalMax / totalParts);
  return [
    'You are a Japanese Midform screen-caption writer for the 3-minute Ottogi workflow.',
    'Return JSON only. Do not include Markdown.',
    `Focused output: JP Midform caption part ${partIndex + 1} of ${totalParts}.`,
    'Use only midform_clip_120s. Do not choose new time windows.',
    '',
    'Critical caption rules:',
    '- Japanese captions are for the CapCut screen.',
    '- Korean captions are review-only and must match the Japanese flow.',
    '- English fallback is forbidden.',
    '- No emoji or decorative symbols.',
    `- Return ${partMin} to ${partMax} captions for this part only.`,
    '- Each caption must be short enough for the CapCut text box.',
    '- Avoid forced line breaks.',
    '- Keep one idea per caption.',
    '- Use natural Japanese observation/process phrasing.',
    '- Korean review captions must be natural Korean, not translationese.',
    '- Do not return metadata in this response.',
    '',
    'Part allocation:',
    `- part_index: ${partIndex}`,
    `- total_parts: ${totalParts}`,
    partIndex === 0
      ? '- This part covers the opening and first half of the Midform process.'
      : '- This part covers the second half and closing of the Midform process.',
    '',
    'Return required fields:',
    '- midform_caption_script_ja',
    '- midform_caption_script_ko',
    '',
    'Context:',
    JSON.stringify({
      candidateGuide,
      hookGuide,
      storyGuide,
      midformGuide,
      midformMetadata
    }, null, 2),
    '',
    'Source information:',
    `- Source URL: ${sourceUrl || 'not provided'}`,
    `- Original Filename: ${filename || 'unknown'}`,
    `- Duration Sec: ${durationSec || 'unknown'}`
  ].join('\n');
}

function buildLongformMidformCaptionPartSchema() {
  const shared = OTTOGI_METADATA_SCHEMA.properties;
  return {
    type: 'object',
    properties: {
      midform_caption_script_ja: shared.midform_caption_script_ja,
      midform_caption_script_ko: shared.midform_caption_script_ko
    },
    required: [
      'midform_caption_script_ja',
      'midform_caption_script_ko'
    ]
  };
}

function mergeMidformSplitOutputs(metadataGuide = {}, captionParts = []) {
  const midformCaptionScriptJa = captionParts.flatMap((part) => (
    Array.isArray(part?.midform_caption_script_ja) ? part.midform_caption_script_ja : []
  ));
  const midformCaptionScriptKo = captionParts.flatMap((part) => (
    Array.isArray(part?.midform_caption_script_ko) ? part.midform_caption_script_ko : []
  ));
  return {
    ...metadataGuide,
    midform_caption_script_ja: midformCaptionScriptJa,
    midform_caption_script_ko: midformCaptionScriptKo,
    midform_generation_details: {
      ...(metadataGuide.midform_generation_details || {}),
      split_final_generation: true,
      caption_parts: captionParts.length,
      midform_caption_script_ja_count: midformCaptionScriptJa.length,
      midform_caption_script_ko_count: midformCaptionScriptKo.length
    }
  };
}

function validateLongformVariantFinalGuide(variant, guide = {}, options = {}) {
  if (variant === 'full') {
    const jaCount = Array.isArray(guide.full_caption_script_ja) ? guide.full_caption_script_ja.length : 0;
    const koCount = Array.isArray(guide.full_caption_script_ko) ? guide.full_caption_script_ko.length : 0;
    const metadataSubtitleCount = Array.isArray(guide.full_metadata?.onscreen_subtitles)
      ? guide.full_metadata.onscreen_subtitles.length
      : 0;
    const missing = [];
    if (!guide.full_metadata || typeof guide.full_metadata !== 'object') missing.push('missing_full_metadata');
    if (!guide.full_metadata_ko || typeof guide.full_metadata_ko !== 'object') missing.push('missing_full_review_metadata');
    if (jaCount < 20) missing.push('full_caption_script_ja_too_short');
    if (koCount < 20) missing.push('full_caption_script_ko_too_short');
    if (metadataSubtitleCount < 8 && jaCount < 20) missing.push('full_metadata_onscreen_subtitles_too_short');
    if (missing.length) {
      throw createHttpError(500, 'OTTOGI_FULL_FINAL_VALIDATION_FAILED', 'Gemini Full output is missing required full-draft caption script fields', {
        missing,
        full_caption_script_ja_count: jaCount,
        full_caption_script_ko_count: koCount,
        full_metadata_onscreen_subtitles_count: metadataSubtitleCount,
        expected_caption_script_items: '20-24'
      });
    }
    return guide;
  }
  if (variant !== 'midform') return guide;
  const window = normalizeWindow(options.midformWindow || guide.midform_clip_120s || guide.recommended_midform_window);
  const duration = windowDuration(window) || Number(options.durationSec || 120);
  const jaCount = Array.isArray(guide.midform_caption_script_ja) ? guide.midform_caption_script_ja.length : 0;
  const koCount = Array.isArray(guide.midform_caption_script_ko) ? guide.midform_caption_script_ko.length : 0;
  const metadataSubtitleCount = Array.isArray(guide.midform_metadata?.onscreen_subtitles)
    ? guide.midform_metadata.onscreen_subtitles.length
    : 0;
  const missing = [];
  if (!guide.midform_metadata || typeof guide.midform_metadata !== 'object') missing.push('missing_midform_metadata');
  if (!guide.midform_metadata_ko || typeof guide.midform_metadata_ko !== 'object') missing.push('missing_midform_review_metadata');
  if (missing.length) {
    throw createHttpError(500, 'OTTOGI_MIDFORM_FINAL_VALIDATION_FAILED', 'Gemini Midform output is missing required metadata fields', {
      missing,
      midform_duration_sec: duration,
      midform_caption_script_ja_count: jaCount,
      midform_caption_script_ko_count: koCount,
      midform_metadata_onscreen_subtitles_count: metadataSubtitleCount
    });
  }
  return guide;
}

function buildLongformVariantWindowPrompt({ variant, sourceUrl, filename, durationSec, sourceType, sourceWorkflowMode }) {
  const configs = {
    highlight: {
      name: 'JP Highlight',
      shape: {
        hook_clip_10s: {
          start_sec: 0,
          end_sec: 16,
          duration_sec: 16,
          source_time_basis: 'absolute_original_seconds',
          visual_hook: '',
          why_this_clip: '',
          first_second_hook: '',
          edit_note: ''
        }
      },
      rules: [
        '- Choose exactly one 6 to 24 second visual-hook window for JP Highlight.',
        '- Prefer the natural end of one action cycle over forcing exactly 10 seconds.',
        '- End when the pressed/cut/poured/assembled/transformed material exits, resets, or the result is clearly visible.',
        '- This is not a summary. Pick the strongest visual moment in the whole source.',
        '- The window must be one continuous source segment focused on one specific process/action.',
        '- Do not stitch, imply, or represent multiple separate moments from the long-form source.',
        '- Do not choose a broad compilation section. Choose one core work-zone moment only.',
        '- Prioritize repetition, machinery, pouring, cutting, pressing, transformation, close-up motion, and curiosity.',
        '- The first second must be visually strong.',
        '- For 16:9 long-form sources, assume the editor will crop into the core work area for 9:16. Pick a moment where one tool/material interaction can be enlarged clearly.',
        '- Return hook_clip_10s only.'
      ]
    },
    full: {
      name: 'JP Full',
      shape: {
        story_clip_40s: {
          start_sec: 0,
          end_sec: 60,
          duration_sec: 60,
          source_time_basis: 'absolute_original_seconds',
          story_structure: {
            hook: '',
            reveal: '',
            process: '',
            climax: '',
            ending: ''
          },
          why_this_window: '',
          relationship_to_hook_clip: ''
        }
      },
      rules: [
        '- Choose exactly one 55 to 65 second core-process window for JP Full, preferably 60 seconds.',
        '- This must explain one coherent process flow, not only the strongest hook and not the entire long-form video.',
        '- Prefer a window where viewers can understand what is being made and why the steps matter.',
        '- For 16:9 long-form sources, prefer a window where the active tool/material area can be cropped tightly into a vertical 9:16 frame.',
        '- Return story_clip_40s only.'
      ]
    },
    midform: {
      name: 'JP Midform',
      shape: {
        midform_clip_120s: {
          start_sec: 0,
          end_sec: 120,
          duration_sec: 120,
          source_time_basis: 'absolute_original_seconds',
          process_structure: {
            opening_hook: '',
            material_or_input: '',
            main_process: '',
            transformation: '',
            result: '',
            ending: ''
          },
          why_this_window: '',
          relationship_to_hook_and_full: ''
        }
      },
      rules: [
        '- Choose exactly one 105 to 130 second process-flow window for JP Midform.',
        '- Target duration is 120 seconds.',
        '- This should cover the broadest useful manufacturing/process arc available in the source.',
        '- It can share a strong opening moment with other formats if that is the best editorial choice.',
        '- Return midform_clip_120s only.'
      ]
    }
  };
  const config = configs[variant] || configs.full;
  return [
    'You are a video editing director using Gemini Vision.',
    'Analyze the provided source video directly and choose a fixed source-time window for one format only.',
    'Return JSON only. Do not include Markdown.',
    '',
    `Focused format: ${config.name}`,
    '',
    'Rules:',
    '- All timestamps must be absolute original source seconds.',
    '- Relative/sample timestamps are forbidden.',
    '- Include start_sec, end_sec, and duration_sec.',
    '- duration_sec must equal end_sec - start_sec.',
    '- Do not create captions or metadata in this step.',
    ...config.rules,
    '',
    'Return shape:',
    JSON.stringify(config.shape, null, 2),
    '',
    'Source information:',
    `- Source URL: ${sourceUrl || 'not provided'}`,
    `- Original Filename: ${filename || 'unknown'}`,
    `- Duration Sec: ${durationSec || 'unknown'}`,
    `- Source Type: ${sourceType || 'unknown'}`,
    `- Workflow Mode: ${sourceWorkflowMode || 'unknown'}`
  ].join('\n');
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function buildSelectedLongformCandidateGuide({ hookGuide = {}, storyGuide = {}, midformGuide = {} }) {
  const safeHookGuide = asPlainObject(hookGuide);
  const safeStoryGuide = asPlainObject(storyGuide);
  const safeMidformGuide = asPlainObject(midformGuide);
  const hook = normalizeWindow(safeHookGuide.hook_clip_10s);
  const story = normalizeWindow(safeStoryGuide.story_clip_40s);
  const midform = normalizeWindow(safeMidformGuide.midform_clip_120s);
  return {
    source_time_basis: 'absolute_original_seconds',
    hook_candidates: hook ? [{
      ...hook,
      visual_hook: safeHookGuide.hook_clip_10s?.visual_hook || safeHookGuide.hook_clip_10s?.why_this_clip || 'selected highlight window',
      reason: safeHookGuide.hook_clip_10s?.why_this_clip || safeHookGuide.hook_clip_10s?.edit_note || 'Selected by independent Highlight Vision analysis',
      hook_score: 8
    }] : [],
    story_candidates: story ? [{
      ...story,
      story_flow: safeStoryGuide.story_clip_40s?.why_this_window || safeStoryGuide.story_clip_40s?.story_structure?.process || 'selected full process window',
      reason: safeStoryGuide.story_clip_40s?.why_this_window || 'Selected by independent Full Vision analysis',
      hook_score: 6,
      process_coverage_score: 8
    }] : [],
    midform_candidates: midform ? [{
      ...midform,
      process_flow: safeMidformGuide.midform_clip_120s?.why_this_window || safeMidformGuide.midform_clip_120s?.process_structure?.main_process || 'selected midform process window',
      reason: safeMidformGuide.midform_clip_120s?.why_this_window || 'Selected by independent Midform Vision analysis',
      process_coverage_score: 8
    }] : []
  };
}

function buildFullStoryGuideFromExistingCandidates(existingGuide = {}, durationSec = 0) {
  const safeExistingGuide = asPlainObject(existingGuide);
  const existingWindow = normalizeWindow(safeExistingGuide.story_clip_40s || safeExistingGuide.recommended_full_window);
  if (existingWindow) {
    return {
      story_clip_40s: {
        ...existingWindow,
        source_time_basis: 'absolute_original_seconds',
        why_this_window: safeExistingGuide.story_clip_40s?.why_this_window
          || safeExistingGuide.recommended_full_window?.why_this_window
          || 'Reused existing Full source window to avoid another Vision window-selection call',
        story_structure: safeExistingGuide.story_clip_40s?.story_structure || {
          opening: 'existing full window',
          main_process: 'core process window',
          transformation: 'process change',
          result: 'process result',
          ending: 'process closing'
        }
      }
    };
  }

  const sourceDuration = Number(durationSec || 0);
  const candidates = (Array.isArray(safeExistingGuide.shortform_candidate_windows)
    ? safeExistingGuide.shortform_candidate_windows
    : [])
    .map((candidate) => normalizeWindow(candidate) ? {
      ...candidate,
      ...normalizeWindow(candidate)
    } : null)
    .filter(Boolean)
    .sort((a, b) => {
      const scoreA = Number(a.hook_score || a.visual_hook_score || a.score || 0);
      const scoreB = Number(b.hook_score || b.visual_hook_score || b.score || 0);
      const purposeA = String(a.purpose || a.selection_strategy || a.reason || '').toLowerCase();
      const purposeB = String(b.purpose || b.selection_strategy || b.reason || '').toLowerCase();
      const fullA = /story|full|process|coverage|재료|工程|candidate/.test(purposeA) ? 1 : 0;
      const fullB = /story|full|process|coverage|재료|工程|candidate/.test(purposeB) ? 1 : 0;
      return fullB - fullA || scoreB - scoreA || Number(a.start_sec || 0) - Number(b.start_sec || 0);
    });

  if (!candidates.length) return null;

  const primary = candidates[0];
  const requestedDuration = Math.min(65, Math.max(55, Number(primary.duration_sec || 0), 60));
  const maxStart = sourceDuration > 0 ? Math.max(0, sourceDuration - requestedDuration) : Number(primary.start_sec || 0);
  const start = Math.max(0, Math.min(Number(primary.start_sec || 0), maxStart));
  const end = sourceDuration > 0
    ? Math.min(sourceDuration, start + requestedDuration)
    : start + requestedDuration;
  const duration = Math.max(1, end - start);

  return {
    story_clip_40s: {
      start_sec: Number(start.toFixed(3)),
      end_sec: Number(end.toFixed(3)),
      duration_sec: Number(duration.toFixed(3)),
      source_time_basis: 'absolute_original_seconds',
      why_this_window: 'Built from existing longform highlight candidates so Full can proceed without an extra Vision window-selection call',
      story_structure: {
        opening: 'candidate-based full opening',
        main_process: String(primary.process_coverage || primary.story_flow || primary.visual_hook || primary.reason || 'core process candidate'),
        transformation: 'selected candidate process change',
        result: 'candidate process result',
        ending: 'full draft closing'
      },
      source_candidate_window_id: primary.window_id || primary.id || '',
      source_candidate_reason: primary.reason || primary.selection_strategy || ''
    }
  };
}

function hasRequiredReportSections(value = '', korean = false) {
  const text = String(value || '');
  if (korean) {
    return [
      /1\.\s*작업\s*개요/u,
      /2\.\s*사용\s*재료\s*및\s*장비/u,
      /3\.\s*시공\s*절차/u,
      /4\.\s*작업의\s*중요성/u,
      /5\.\s*가이드라인\s*준수\s*및\s*교육적\s*목적/u
    ].every((pattern) => pattern.test(text));
  }
  return [
    /1\.\s*(?:作業概要|作業\s*概要)/u,
    /2\.\s*(?:使用材料と設備|使用\s*材料|材料|設備)/u,
    /3\.\s*(?:工程手順|工程\s*手順|作業手順)/u,
    /4\.\s*(?:作業の重要性|作業\s*の\s*重要性)/u,
    /5\.\s*(?:ガイドライン遵守と教育目的|ガイドライン|教育目的)/u
  ].every((pattern) => pattern.test(text));
}

function formatStructuredReportDescription(value = '', korean = false) {
  let text = normalizeText(value);
  if (!text) return '';
  const headings = korean
    ? [
        ['1', '작업\\s*개요'],
        ['2', '사용\\s*재료\\s*및\\s*장비'],
        ['3', '시공\\s*절차'],
        ['4', '작업의\\s*중요성'],
        ['5', '가이드라인\\s*준수\\s*및\\s*교육적\\s*목적']
      ]
    : [
        ['1', '作業\\s*概要'],
        ['2', '使用\\s*材料\\s*と\\s*設備'],
        ['3', '(?:工程\\s*手順|作業\\s*手順)'],
        ['4', '作業\\s*の\\s*重要性'],
        ['5', 'ガイドライン\\s*遵守\\s*と\\s*教育\\s*目的']
      ];

  headings.forEach(([number, label], index) => {
    const pattern = new RegExp(`\\s*(?:#{1,6}\\s*)?(${number}\\.\\s*${label})\\s*`, 'u');
    const replacement = `${index === 0 ? '' : '\n\n'}## $1\n`;
    text = text.replace(pattern, replacement);
  });

  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function ensureStructuredReportDescription(value, subject, shortDescription, korean = false) {
  const text = normalizeText(value);
  if (hasRequiredReportSections(text, korean)) return formatStructuredReportDescription(text, korean);
  const fallback = buildFallbackReport(subject, shortDescription || text, korean);
  if (!text) return formatStructuredReportDescription(fallback, korean);
  if (korean) {
    return formatStructuredReportDescription([
      '1. 작업 개요',
      `${normalizeText(subject) || '공정'}의 핵심 흐름과 변화 과정을 설명하는 영상입니다.`,
      '2. 사용 재료 및 장비',
      '영상에서 확인되는 재료, 작업 도구, 기계 장비를 중심으로 정리합니다.',
      '3. 시공 절차',
      text,
      '4. 작업의 중요성',
      '각 단계의 정확한 반복과 손작업은 최종 결과물의 형태, 품질, 안정성을 좌우합니다.',
      '5. 가이드라인 준수 및 교육적 목적',
      '본 영상은 제조 및 작업 공정을 이해하기 위한 교육적 목적의 설명입니다. 위험하거나 전문적인 장면은 따라 하기 위한 안내가 아니라 공정 이해를 위한 참고 자료로 다룹니다.'
    ].join('\n'), korean);
  }
  return formatStructuredReportDescription([
    '1. 作業概要',
    `${normalizeText(subject) || '工程'}の流れと変化を分かりやすく説明する映像です。`,
    '2. 使用材料と設備',
    '映像で確認できる素材、道具、機械設備を中心に整理します。',
    '3. 工程手順',
    text,
    '4. 作業の重要性',
    '各段階の正確な繰り返しと手作業が、最終的な形、品質、安定性を支えています。',
    '5. ガイドライン遵守と教育目的',
    '本映像は製造および作業工程を理解するための教育的な説明です。危険または専門的に見える場面は、実践を促すものではなく、工程理解のための参考情報として扱います。'
  ].join('\n'), korean);
}

function fallbackSceneTransitions(guide, durationSec = 0) {
  const duration = clampNumber(durationSec, 3, 600, 30);
  const count = Math.max(1, Math.ceil(duration / 3));
  const scenes = [];
  for (let index = 0; index < count; index += 1) {
    const start = Number((index * 3).toFixed(3));
    const end = Number(Math.min(duration, start + 3).toFixed(3));
    scenes.push({
      scene_id: `scene_${String(index + 1).padStart(3, '0')}`,
      start_sec: start,
      end_sec: end,
      transition_at_sec: end,
      visual_summary: '工程の変化を確認する区間です。',
      caption_text: '',
      caption_text_ko: '공정의 움직임에 주목',
      screen_captions_ja: [],
      screen_captions_ko: ['공정의 움직임에 주목'],
      change_type: 'forced_3_second_rule',
      confidence: 'low',
      focus_target: normalizeText(guide?.detected_subject || 'material process'),
      focus_zone: 'center',
      recommended_camera_move: 'slow_zoom_in',
      motion_intensity: 'medium',
      visual_hook_score: 5,
      visual_hook_type: 'static_overview',
      curiosity_reason: '工程の次の変化が気になるため。',
      repetition_potential: 5,
      mechanical_rhythm: 'none',
      tempo_score: 2,
      tension_score: 1,
      transformation_score: 2,
      framing_score: 2,
      flow_score: 2,
      a_grade_score: 9,
      scene_role: 'transition',
      human_presence: false,
      process_focus_priority: 'process'
    });
    if (end >= duration) break;
  }
  return scenes;
}

function normalizeScene(scene, index, durationSec = 0) {
  const duration = clampNumber(durationSec, 1, 600, Math.max(3, Number(scene?.end_sec || 3)));
  const start = clampNumber(scene?.start_sec, 0, duration, Math.min(index * 3, duration));
  const end = clampNumber(scene?.end_sec, start + 0.2, duration, Math.min(start + 3, duration));
  const rawCaptionText = normalizeText(scene?.caption_text || '');
  const captionText = isValidJapaneseCaption(rawCaptionText) && !hasLongLatinWord(rawCaptionText)
    ? rawCaptionText
    : '工程の動き';
  const rawCaptionKo = normalizeText(scene?.caption_text_ko || '');
  const captionKo = isValidKoreanCaption(rawCaptionKo) && !hasLongLatinWord(rawCaptionKo)
    ? rawCaptionKo
    : '공정의 움직임에 주목';
  const screenCaptionsJa = Array.isArray(scene?.screen_captions_ja)
    ? scene.screen_captions_ja
      .map(normalizeText)
      .filter((caption) => caption && isValidJapaneseCaption(caption) && !hasLongLatinWord(caption))
    : [];
  const screenCaptionsKo = Array.isArray(scene?.screen_captions_ko)
    ? scene.screen_captions_ko
      .map(normalizeText)
      .filter((caption) => caption && isValidKoreanCaption(caption) && !hasLongLatinWord(caption))
    : [];
  return {
    ...scene,
    scene_id: normalizeText(scene?.scene_id || `scene_${String(index + 1).padStart(3, '0')}`),
    start_sec: start,
    end_sec: end,
    transition_at_sec: clampNumber(scene?.transition_at_sec, start, end, end),
    visual_summary: normalizeText(scene?.visual_summary || captionText || '工程の変化を確認する区間です。'),
    caption_text: captionText,
    caption_text_ko: captionKo,
    focus_target: normalizeText(scene?.focus_target || 'material process'),
    focus_zone: normalizeText(scene?.focus_zone || 'center'),
    recommended_camera_move: normalizeText(scene?.recommended_camera_move || 'slow_zoom_in'),
    motion_intensity: normalizeText(scene?.motion_intensity || 'medium'),
    visual_hook_score: Math.round(clampNumber(scene?.visual_hook_score, 1, 10, 5)),
    visual_hook_type: normalizeText(scene?.visual_hook_type || 'static_overview'),
    curiosity_reason: normalizeText(scene?.curiosity_reason || '工程の次の変化が気になるため。'),
    repetition_potential: Math.round(clampNumber(scene?.repetition_potential, 1, 10, 5)),
    mechanical_rhythm: normalizeText(scene?.mechanical_rhythm || 'none'),
    tempo_score: Math.round(clampNumber(scene?.tempo_score, 1, 5, 3)),
    tension_score: Math.round(clampNumber(scene?.tension_score, 1, 5, 2)),
    transformation_score: Math.round(clampNumber(scene?.transformation_score, 1, 5, 3)),
    framing_score: Math.round(clampNumber(scene?.framing_score, 1, 5, 3)),
    flow_score: Math.round(clampNumber(scene?.flow_score, 1, 5, 3)),
    a_grade_score: Math.round(clampNumber(scene?.a_grade_score, 1, 25, (
      Number(scene?.tempo_score || 0)
      + Number(scene?.tension_score || 0)
      + Number(scene?.transformation_score || 0)
      + Number(scene?.framing_score || 0)
      + Number(scene?.flow_score || 0)
    ) || 14)),
    scene_role: normalizeText(scene?.scene_role || scene?.role || 'action'),
    human_presence: scene?.human_presence === true,
    process_focus_priority: normalizeText(scene?.process_focus_priority || 'process'),
    screen_captions_ja: screenCaptionsJa.length ? screenCaptionsJa : [captionText].filter(Boolean),
    screen_captions_ko: screenCaptionsKo.length ? screenCaptionsKo : [captionKo].filter(Boolean)
  };
}

function isLongformGuide(guide = {}) {
  return normalizeText(guide.source_workflow_mode || '') === 'longform_to_shorts'
    || normalizeText(guide.source_type || '') === 'longform';
}

function normalizeWindow(value = {}) {
  if (!value || typeof value !== 'object') return null;
  const start = parseTimeToSeconds(value.start_sec ?? value.start_time ?? value.start);
  const end = parseTimeToSeconds(value.end_sec ?? value.end_time ?? value.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start_sec: start, end_sec: end };
}

function windowDuration(value = {}) {
  const window = normalizeWindow(value);
  return window ? window.end_sec - window.start_sec : 0;
}

function normalizeVariantCompareText(value = '') {
  return normalizeText(value)
    .toLowerCase()
    .replace(/#[^\s#]+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function metadataCompareFields(metadata = {}) {
  if (!metadata || typeof metadata !== 'object') return {};
  const titles = Array.isArray(metadata.recommended_titles)
    ? metadata.recommended_titles.map((item) => normalizeText(item?.title || '')).join(' ')
    : '';
  const hashtags = Array.isArray(metadata.hashtags)
    ? metadata.hashtags.join(' ')
    : '';
  return {
    upload_title: normalizeVariantCompareText(metadata.upload_title || titles),
    short_description: normalizeVariantCompareText(metadata.short_description || metadata.summary_caption || ''),
    report_description: normalizeVariantCompareText(metadata.report_description || ''),
    hashtags: normalizeVariantCompareText(hashtags)
  };
}

function collectDuplicateVariantMetadataIssues(guide = {}, activeVariants = ['full', 'highlight', 'midform']) {
  const active = new Set(Array.isArray(activeVariants) && activeVariants.length
    ? activeVariants
    : ['full', 'highlight', 'midform']);
  const pairs = [
    ['full', guide.full_metadata, 'highlight', guide.highlight_metadata],
    ['full', guide.full_metadata, 'midform', guide.midform_metadata],
    ['highlight', guide.highlight_metadata, 'midform', guide.midform_metadata]
  ].filter(([leftName, , rightName]) => active.has(leftName) && active.has(rightName));
  const issues = [];
  pairs.forEach(([leftName, leftMetadata, rightName, rightMetadata]) => {
    const left = metadataCompareFields(leftMetadata);
    const right = metadataCompareFields(rightMetadata);
    ['upload_title', 'short_description', 'report_description'].forEach((field) => {
      if (!left[field] || !right[field]) return;
      if (left[field].length < 12 || right[field].length < 12) return;
      if (left[field] === right[field]) {
        issues.push(`duplicate_${leftName}_${rightName}_${field}`);
      }
    });
  });
  return issues;
}

function collectLongformWindowSeparationIssues(guide = {}) {
  const rawHook = normalizeWindow(guide.hook_clip_10s) || normalizeWindow(guide.recommended_highlight_window);
  const hook = clampLongformHighlightWindow(rawHook, guide.source_duration_sec || guide.duration_sec || 0, 15) || rawHook;
  const story = normalizeWindow(guide.story_clip_40s) || normalizeWindow(guide.recommended_full_window);
  const issues = [];
  const minStartGapSec = 5;
  const check = (leftName, left, rightName, right) => {
    if (!left || !right) return;
    const startGap = Math.abs(Number(left.start_sec) - Number(right.start_sec));
    if (Number.isFinite(startGap) && startGap < minStartGapSec) {
      issues.push(`${leftName}_${rightName}_first_source_cut_too_close:${startGap.toFixed(3)}s`);
    }
  };
  check('highlight', hook, 'full', story);
  // Midform can intentionally open with the same strong hook and then expand into
  // a longer process flow. Keep the hard first-cut separation only between
  // Highlight and Full, where the two outputs are both short-form drafts.
  return issues;
}

function startGapTooClose(left, right, minGapSec = 5) {
  const a = normalizeWindow(left);
  const b = normalizeWindow(right);
  if (!a || !b) return false;
  const startGap = Math.abs(Number(a.start_sec) - Number(b.start_sec));
  return Number.isFinite(startGap) && startGap < minGapSec;
}

function separateWindowStart({ window, avoidWindows = [], sourceDurationSec = 0, durationSec = 120, minGapSec = 5 }) {
  const normalized = normalizeWindow(window);
  if (!normalized) return null;
  const sourceDuration = Number(sourceDurationSec || 0);
  const targetDuration = Math.max(1, Number(durationSec || windowDuration(normalized) || 120));
  if (!Number.isFinite(sourceDuration) || sourceDuration <= targetDuration + minGapSec) {
    return {
      ...normalized,
      duration_sec: Number((normalized.end_sec - normalized.start_sec).toFixed(3))
    };
  }

  const anchors = avoidWindows
    .map(normalizeWindow)
    .filter(Boolean)
    .map((item) => item.start_sec)
    .sort((a, b) => a - b);
  const candidates = [
    normalized.start_sec,
    0,
    Math.max(0, sourceDuration * 0.25),
    Math.max(0, sourceDuration * 0.5),
    Math.max(0, sourceDuration * 0.72),
    Math.max(0, sourceDuration - targetDuration)
  ];

  anchors.forEach((start) => {
    candidates.push(start + minGapSec);
    candidates.push(start + 15);
    candidates.push(start + 45);
    candidates.push(start + 90);
  });

  const maxStart = Math.max(0, sourceDuration - targetDuration);
  const validStart = candidates
    .map((start) => Math.max(0, Math.min(maxStart, Number(start || 0))))
    .filter((start, index, list) => Number.isFinite(start) && list.indexOf(start) === index)
    .sort((a, b) => {
      const aOk = anchors.every((anchor) => Math.abs(anchor - a) >= minGapSec);
      const bOk = anchors.every((anchor) => Math.abs(anchor - b) >= minGapSec);
      if (aOk !== bOk) return aOk ? -1 : 1;
      return Math.abs(a - normalized.start_sec) - Math.abs(b - normalized.start_sec);
    })[0];

  const start = Number((Number.isFinite(validStart) ? validStart : normalized.start_sec).toFixed(3));
  const end = Number(Math.min(sourceDuration, start + targetDuration).toFixed(3));
  return {
    start_sec: start,
    end_sec: end,
    duration_sec: Number((end - start).toFixed(3))
  };
}

function sceneSpanWindow(scenes = []) {
  const starts = [];
  const ends = [];
  scenes.forEach((scene) => {
    const start = parseTimeToSeconds(scene?.start_sec ?? scene?.start);
    const end = parseTimeToSeconds(scene?.end_sec ?? scene?.end);
    if (Number.isFinite(start)) starts.push(start);
    if (Number.isFinite(end)) ends.push(end);
  });
  if (!starts.length || !ends.length) return null;
  const start = Math.min(...starts);
  const end = Math.max(...ends);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start_sec: start, end_sec: end };
}

function expandWindowAround(window, targetDurationSec, durationSec = 0) {
  const normalized = normalizeWindow(window);
  if (!normalized) return null;
  const target = Math.max(targetDurationSec, normalized.end_sec - normalized.start_sec);
  const sourceDuration = Number(durationSec);
  const center = (normalized.start_sec + normalized.end_sec) / 2;
  let start = center - (target / 2);
  let end = center + (target / 2);
  if (Number.isFinite(sourceDuration) && sourceDuration > 0) {
    if (target >= sourceDuration) {
      return { start_sec: 0, end_sec: sourceDuration };
    }
    if (start < 0) {
      end += -start;
      start = 0;
    }
    if (end > sourceDuration) {
      start = Math.max(0, start - (end - sourceDuration));
      end = sourceDuration;
    }
  } else if (start < 0) {
    end += -start;
    start = 0;
  }
  return {
    start_sec: Number(start.toFixed(3)),
    end_sec: Number(end.toFixed(3))
  };
}

function bestCandidateWindow(candidates = [], purposeMatcher = null) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const ranked = candidates
    .map((candidate, index) => {
      const window = normalizeWindow(candidate);
      if (!window) return null;
      const purpose = normalizeText(candidate?.purpose || candidate?.process_coverage || '');
      const purposeBonus = purposeMatcher && purposeMatcher(purpose) ? 20 : 0;
      const score = Number(candidate?.hook_score || candidate?.visual_hook_score || 0) + purposeBonus;
      return { index, score, window };
    })
    .filter(Boolean)
    .sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return ranked[0]?.window || null;
}

function normalizeClipObject(value, fallbackWindow = null) {
  const window = normalizeWindow(value) || normalizeWindow(fallbackWindow);
  if (!window) return null;
  return {
    ...(value && typeof value === 'object' ? value : {}),
    start_sec: window.start_sec,
    end_sec: window.end_sec,
    duration_sec: Number((window.end_sec - window.start_sec).toFixed(3))
  };
}

function deriveLongformWindows(guide = {}, durationSec = 0, rawScenes = []) {
  if (!isLongformGuide(guide)) {
    const hookWindow = normalizeWindow(guide.recommended_highlight_window) || windowFromClip(guide.hook_clip_10s);
    const fullWindow = normalizeWindow(guide.recommended_full_window) || windowFromClip(guide.story_clip_40s);
    const midformWindow = normalizeWindow(guide.recommended_midform_window) || windowFromClip(guide.midform_clip_120s);
    return {
      hookWindow,
      storyWindow: fullWindow,
      midformWindow,
      hookClip: normalizeClipObject(guide.hook_clip_10s, hookWindow),
      storyClip: normalizeClipObject(guide.story_clip_40s, fullWindow),
      midformClip: normalizeClipObject(guide.midform_clip_120s, midformWindow)
    };
  }

  const candidates = Array.isArray(guide.shortform_candidate_windows) ? guide.shortform_candidate_windows : [];
  const sourceDuration = Number(durationSec);
  const minStoryDuration = Number.isFinite(sourceDuration) && sourceDuration > 0 && sourceDuration < 65 ? 20 : 55;
  const hookBase = windowFromClip(guide.hook_clip_10s)
    || normalizeWindow(guide.recommended_highlight_window)
    || bestCandidateWindow(candidates, (purpose) => /hook|reveal|cut|press|pour|transform|repeat|pattern|rhythm|切断|押|注|変化|反復|模様/.test(purpose))
    || sceneSpanWindow(rawScenes);
  const storyBase = windowFromClip(guide.story_clip_40s)
    || normalizeWindow(guide.recommended_full_window)
    || sceneSpanWindow(rawScenes)
    || bestCandidateWindow(candidates);
  const midformBase = windowFromClip(guide.midform_clip_120s)
    || normalizeWindow(guide.recommended_midform_window)
    || bestCandidateWindow(candidates, (purpose) => /midform|120|complete|full process|overall|entire|全体|全工程|全体工程/.test(purpose))
    || sceneSpanWindow(rawScenes)
    || storyBase;

  const hookWindow = windowDuration(hookBase) >= 4
    ? normalizeWindow(hookBase)
    : expandWindowAround(hookBase, 10, durationSec);
  const storyWindow = windowDuration(storyBase) >= minStoryDuration
    ? normalizeWindow(storyBase)
    : expandWindowAround(storyBase, Math.min(60, Math.max(minStoryDuration, 60)), durationSec);
  const midformTarget = sourceDuration > 0 && sourceDuration < 125 ? sourceDuration : 120;
  const midformWindow = windowDuration(midformBase) >= Math.min(90, midformTarget * 0.75)
    ? normalizeWindow(midformBase)
    : expandWindowAround(midformBase, midformTarget, durationSec);

  return {
    hookWindow,
    storyWindow,
    midformWindow,
    hookClip: normalizeClipObject(guide.hook_clip_10s, hookWindow),
    storyClip: normalizeClipObject(guide.story_clip_40s, storyWindow),
    midformClip: normalizeClipObject(guide.midform_clip_120s, midformWindow)
  };
}

function retimeCollapsedLongformScenes(scenes = [], guide = {}, durationSec = 0) {
  if (!isLongformGuide(guide) || !Array.isArray(scenes) || scenes.length < 2) return scenes;
  const storyWindow = normalizeWindow(guide.recommended_full_window) || windowFromClip(guide.story_clip_40s);
  if (!storyWindow || windowDuration(storyWindow) < 8) return scenes;
  const span = sceneSpanWindow(scenes);
  const storyDuration = windowDuration(storyWindow);
  const minAcceptableSpan = storyDuration >= 35 ? storyDuration * 0.85 : storyDuration * 0.65;
  if (span && windowDuration(span) >= minAcceptableSpan) return scenes;

  const total = storyDuration;
  const unit = total / scenes.length;
  return scenes.map((scene, index) => {
    const start = storyWindow.start_sec + (unit * index);
    const end = index === scenes.length - 1 ? storyWindow.end_sec : storyWindow.start_sec + (unit * (index + 1));
    return {
      ...scene,
      start_sec: Number(start.toFixed(3)),
      end_sec: Number(end.toFixed(3)),
      transition_at_sec: Number(end.toFixed(3))
    };
  });
}

function ensureMinimumLongformScenes(scenes = [], guide = {}, durationSec = 0, minimum = 5) {
  if (!isLongformGuide(guide) || !Array.isArray(scenes)) return scenes;
  if (scenes.length >= minimum) return scenes;
  const storyWindow = normalizeWindow(guide.recommended_full_window) || windowFromClip(guide.story_clip_40s);
  if (!storyWindow || windowDuration(storyWindow) < 8) return scenes;

  const count = Math.max(minimum, 6);
  const unit = windowDuration(storyWindow) / count;
  const baseScenes = scenes.length ? scenes : fallbackSceneTransitions(guide, durationSec);
  return Array.from({ length: count }, (_, index) => {
    const start = storyWindow.start_sec + (unit * index);
    const end = index === count - 1 ? storyWindow.end_sec : storyWindow.start_sec + (unit * (index + 1));
    const source = baseScenes[Math.min(index, baseScenes.length - 1)] || {};
    const sourceCaptionJa = Array.isArray(source.screen_captions_ja) && source.screen_captions_ja.length
      ? source.screen_captions_ja
      : [source.caption_text || '工程の動き'];
    const sourceCaptionKo = Array.isArray(source.screen_captions_ko) && source.screen_captions_ko.length
      ? source.screen_captions_ko
      : [source.caption_text_ko || '공정의 움직임을 보여줍니다'];
    return {
      ...source,
      scene_id: `scene_${String(index + 1).padStart(3, '0')}`,
      start_sec: Number(start.toFixed(3)),
      end_sec: Number(end.toFixed(3)),
      transition_at_sec: Number(end.toFixed(3)),
      visual_summary: normalizeText(source.visual_summary || source.caption_text || '工程の流れを補強した区間です。'),
      caption_text: normalizeText(source.caption_text || sourceCaptionJa[0] || '工程の動き'),
      caption_text_ko: normalizeText(source.caption_text_ko || sourceCaptionKo[0] || '공정의 움직임을 보여줍니다'),
      screen_captions_ja: sourceCaptionJa.map(normalizeText).filter(Boolean),
      screen_captions_ko: sourceCaptionKo.map(normalizeText).filter(Boolean),
      change_type: source.change_type || 'server_balanced_story_split',
      confidence: source.confidence || 'medium',
      scene_role: source.scene_role || source.role || 'process'
    };
  });
}

function hasNonEmptySubtitles(guide = {}, language = 'ja') {
  const hasValidScript = (items, validator) => {
    return Array.isArray(items)
      && items.some((item) => validator(normalizeText(item?.text || item || '')));
  };
  const hasValidMetadataSubtitles = (metadata, validator) => {
    return metadata
      && Array.isArray(metadata.onscreen_subtitles)
      && metadata.onscreen_subtitles.some((line) => validator(normalizeText(line || '')));
  };
  const hasValidHighlightBlock = (metadata, validator) => {
    return metadata && validator(normalizeText(metadata.onscreen_caption_block || ''));
  };

  if (language === 'ko') {
    return hasValidScript(guide.full_caption_script_ko, isValidKoreanCaption)
      || hasValidScript(guide.midform_caption_script_ko, isValidKoreanCaption)
      || hasValidMetadataSubtitles(guide.full_metadata_ko, isValidKoreanCaption)
      || hasValidMetadataSubtitles(guide.midform_metadata_ko, isValidKoreanCaption)
      || hasValidHighlightBlock(guide.highlight_metadata_ko, isValidKoreanCaption);
  }

  if (
    hasValidScript(guide.full_caption_script_ja, isValidJapaneseCaption)
    || hasValidScript(guide.midform_caption_script_ja, isValidJapaneseCaption)
    || hasValidMetadataSubtitles(guide.full_metadata, isValidJapaneseCaption)
    || hasValidMetadataSubtitles(guide.midform_metadata, isValidJapaneseCaption)
    || hasValidHighlightBlock(guide.highlight_metadata, isValidJapaneseCaption)
  ) {
    return true;
  }

  const scenes = Array.isArray(guide.scene_transitions) ? guide.scene_transitions : [];
  const sceneHas = scenes.some((scene) => {
    return isValidJapaneseCaption(scene.caption_text)
      || (Array.isArray(scene.screen_captions_ja) && scene.screen_captions_ja.some(isValidJapaneseCaption));
  });
  const highlightHas = (Array.isArray(guide.highlight_hook_captions_ja) && guide.highlight_hook_captions_ja.some(isValidJapaneseCaption))
    || isValidJapaneseCaption(guide.highlight_explainer_text)
    || isValidJapaneseCaption(guide.highlight_onscreen_caption_block_ja);
  return sceneHas || highlightHas;
}

function hasEnglishFallback(guide = {}, options = {}) {
  const values = [];
  const push = (value) => {
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) value.forEach(push);
    else if (value && typeof value === 'object') {
      Object.values(value).forEach(push);
    }
  };

  const pushMetadata = (metadata) => {
    if (!metadata || typeof metadata !== 'object') return;
    push(metadata.title);
    push(metadata.titles);
    push(metadata.title_candidates);
    push(metadata.short_description);
    push(metadata.description);
    push(metadata.report_description);
    push(metadata.upload_title);
    push(metadata.upload_description);
  };

  const includeFull = options.includeFull !== false;
  const includeHighlight = options.includeHighlight !== false;
  const includeMidform = options.includeMidform !== false;

  if (includeFull) {
    push({
      short_description_200: guide.short_description_200,
      short_description_ko: guide.short_description_ko,
      explainer_text: guide.explainer_text,
      explainer_text_ko: guide.explainer_text_ko,
      full_screen_captions_ja: guide.full_screen_captions_ja,
      full_screen_captions_ko: guide.full_screen_captions_ko,
      full_caption_script_ja: guide.full_caption_script_ja,
      full_caption_script_ko: guide.full_caption_script_ko
    });
    pushMetadata(guide.full_metadata);
    pushMetadata(guide.full_metadata_ja);
    pushMetadata(guide.full_metadata_ko);
  }
  if (includeHighlight) {
    push({
      highlight_explainer_text: guide.highlight_explainer_text,
      highlight_explainer_text_ko: guide.highlight_explainer_text_ko,
      highlight_hook_captions_ja: guide.highlight_hook_captions_ja,
      highlight_hook_captions_ko: guide.highlight_hook_captions_ko,
      highlight_onscreen_caption_block_ja: guide.highlight_onscreen_caption_block_ja,
      highlight_onscreen_caption_block_ko: guide.highlight_onscreen_caption_block_ko
    });
    pushMetadata(guide.highlight_metadata);
    pushMetadata(guide.highlight_metadata_ja);
    pushMetadata(guide.highlight_metadata_ko);
  }
  if (includeMidform) {
    push({
      midform_caption_script_ja: guide.midform_caption_script_ja,
      midform_caption_script_ko: guide.midform_caption_script_ko
    });
    pushMetadata(guide.midform_metadata);
    pushMetadata(guide.midform_metadata_ko);
  }

  return values.some((value) => {
    const text = normalizeText(value);
    if (!text) return false;
    const hasCjk = hasJapaneseText(text) || hasKoreanText(text);
    return !hasCjk && /[A-Za-z]{12,}/.test(text);
  });
}


function classifyLongformValidationIssues(guide = {}, error = {}) {
  const missing = Array.isArray(error.details?.missing) ? error.details.missing : [];
  const invalidCaptions = Array.isArray(error.details?.invalid_japanese_captions) ? error.details.invalid_japanese_captions : [];
  const fullProductionIsKorean = OUTPUT_CONFIG.full_draft.lang === 'ko';
  const allIssues = [
    ...missing.map((issue) => String(issue || '')),
    ...invalidCaptions.map((issue) => String(issue?.field || issue?.reason || ''))
  ].filter(Boolean);
  const variantIssue = {
    full: allIssues.filter((issue) => {
      const text = String(issue || '');
      if (!/(^|_|\.)full|story|scene_transitions|japanese_subtitles|short_description|recommended_titles|explainer_text/i.test(text)) {
        return false;
      }
      if (!fullProductionIsKorean) return true;
      if (/full_caption_script_ja|full_metadata(?:_ja)?\.onscreen_subtitles/i.test(text)) return false;
      if (/screen_captions_ja|caption_text(?:[^_]|$)/i.test(text) && !/caption_text_ko|screen_captions_ko/i.test(text)) return false;
      return true;
    }),
    highlight: allIssues.filter((issue) => /highlight|hook/i.test(issue)),
    midform: allIssues.filter((issue) => /midform/i.test(issue))
  };
  const failedVariants = Object.entries(variantIssue)
    .filter(([, issues]) => issues.length > 0)
    .map(([variant]) => variant);
  return { missing, invalidCaptions, allIssues, variantIssue, failedVariants };
}

// Korean Full CONTENT fields (manuscript, on-screen subtitles, upload description)
// are all things a human can fix during script review, so a full-variant failure
// made up entirely of these is recoverable — the item is held for review rather
// than hard-failed. Structural/schema/scene/API problems are NOT held-eligible.
function isHeldEligibleFullContentIssue(issue = '') {
  return /full_caption_script_ko|full_metadata_ko\./i.test(String(issue || ''));
}

function markValidationFailedVariants(guide = {}, error = {}, allowedVariants = []) {
  const info = classifyLongformValidationIssues(guide, error);
  const allowed = new Set(allowedVariants.length ? allowedVariants : ['full', 'highlight', 'midform']);
  const failedVariants = info.failedVariants.filter((variant) => allowed.has(variant));
  if (!failedVariants.length) return { guide, failedVariants, handled: false, info };
  const next = { ...guide };
  failedVariants.forEach((variant) => {
    const issues = info.variantIssue[variant];
    const status = variant === 'full' && issues.length && issues.every(isHeldEligibleFullContentIssue)
      ? 'held'
      : 'failed';
    next[`${variant}_generation_status`] = status;
    next[`${variant}_generation_error`] = `${error.message || 'Gemini result validation failed'}: ${issues.join(', ')}`;
    next[`${variant}_generation_details`] = {
      missing: info.missing,
      invalid_japanese_captions: info.invalidCaptions
    };
  });
  return { guide: next, failedVariants, handled: true, info };
}

function isHighlightCaptionBlockOnlyFailure(info = {}) {
  const highlightIssues = info.variantIssue?.highlight || [];
  if (!highlightIssues.length) return false;
  return highlightIssues.every((issue) => /highlight_metadata(?:_ko)?\.onscreen_caption_block|highlight metadata must use one natural long_bottom_explainer/i.test(String(issue || '')));
}

function reviveHighlightCaptionBlockFailure(guide = {}, info = {}, sourceUrl = '', durationSec = 0) {
  void info;
  void sourceUrl;
  void durationSec;
  return { guide, revived: false };
}

function normalizeLongformRecoverableFields(guide = {}, sourceUrl = '', durationSec = 0) {
  if (!isLongformGuide(guide)) return guide;
  const next = { ...guide };
  const sceneTransitions = Array.isArray(next.scene_transitions) ? next.scene_transitions : [];
  next.full_caption_script_ja = normalizeFullCaptionScript(
    next.full_caption_script_ja,
    sceneTransitions,
    'ja',
    [],
    { allowSceneFallback: false }
  );
  next.full_caption_script_ko = normalizeFullCaptionScript(
    next.full_caption_script_ko,
    sceneTransitions,
    'ko',
    [],
    { allowSceneFallback: false }
  );
  const hook = clampLongformHighlightWindow(
    next.hook_clip_10s || next.recommended_highlight_window,
    durationSec,
    15
  );
  if (hook) {
    next.hook_clip_10s = {
      ...(next.hook_clip_10s || {}),
      ...hook,
      source_time_basis: 'absolute_original_seconds'
    };
    next.recommended_highlight_window = {
      ...(next.recommended_highlight_window || {}),
      ...hook
    };
  }

  const fullSubtitlesJa = fullCaptionScriptTexts(next.full_caption_script_ja);
  if (fullSubtitlesJa.length >= 20) {
    next.full_metadata = {
      ...(next.full_metadata || {}),
      variant_type: 'full',
      caption_mode: 'scene_based_short_subtitles',
      onscreen_subtitles: fullSubtitlesJa
    };
  }
  const fullSubtitlesKo = fullCaptionScriptTexts(next.full_caption_script_ko);
  if (fullSubtitlesKo.length >= 20) {
    next.full_metadata_ko = {
      ...(next.full_metadata_ko || {}),
      variant_type: 'full',
      caption_mode: 'scene_based_short_subtitles',
      onscreen_subtitles: fullSubtitlesKo
    };
  }

  const highlightBlock = ensureHighlightCaptionBlock(
    next.highlight_metadata?.onscreen_caption_block ||
      next.highlight_onscreen_caption_block_ja ||
      next.highlight_explainer_text ||
      next.full_metadata?.summary_caption ||
      next.short_description_200 ||
      next.explainer_text,
    false
  );
  if (highlightBlock) {
    next.highlight_metadata = {
      ...(next.highlight_metadata || {}),
      variant_type: 'highlight',
      caption_mode: 'long_bottom_explainer',
      onscreen_subtitles: [],
      onscreen_caption_block: highlightBlock
    };
    next.highlight_onscreen_caption_block_ja = highlightBlock;
    next.highlight_explainer_text = highlightBlock;
  }
  const highlightBlockKo = ensureHighlightCaptionBlock(
    next.highlight_metadata_ko?.onscreen_caption_block ||
      next.highlight_onscreen_caption_block_ko ||
      next.highlight_explainer_text_ko ||
      next.full_metadata_ko?.summary_caption ||
      next.short_description_ko ||
      next.explainer_text_ko,
    true
  );
  if (highlightBlockKo) {
    next.highlight_metadata_ko = {
      ...(next.highlight_metadata_ko || {}),
      variant_type: 'highlight',
      caption_mode: 'long_bottom_explainer',
      onscreen_subtitles: [],
      onscreen_caption_block: highlightBlockKo
    };
    next.highlight_onscreen_caption_block_ko = highlightBlockKo;
    next.highlight_explainer_text_ko = highlightBlockKo;
  }

  const recoveredFullSubtitleCount = Array.isArray(next.full_metadata?.onscreen_subtitles)
    ? next.full_metadata.onscreen_subtitles.length
    : 0;
  const recoveredFullJaCount = Array.isArray(next.full_caption_script_ja) ? next.full_caption_script_ja.length : 0;
  const recoveredFullKoCount = Array.isArray(next.full_caption_script_ko) ? next.full_caption_script_ko.length : 0;
  if (
    next.full_generation_status === 'failed'
    && recoveredFullJaCount >= 20
    && recoveredFullKoCount >= 20
    && recoveredFullSubtitleCount >= 8
  ) {
    next.full_generation_status = 'ready';
    next.full_generation_error = '';
    next.full_generation_details = {
      ...(next.full_generation_details || {}),
      recovered_from_validation_failure: true
    };
  }

  const recoveredHighlightWindow = normalizeWindow(next.hook_clip_10s) || normalizeWindow(next.recommended_highlight_window);
  const recoveredHighlightBlock = normalizeText(next.highlight_metadata?.onscreen_caption_block || next.highlight_explainer_text || '');
  if (
    next.highlight_generation_status === 'failed'
    && windowDuration(recoveredHighlightWindow) >= 4
    && windowDuration(recoveredHighlightWindow) <= 24.5
    && visibleTextLength(recoveredHighlightBlock) >= 80
  ) {
    next.highlight_generation_status = 'ready';
    next.highlight_generation_error = '';
    next.highlight_generation_details = {
      ...(next.highlight_generation_details || {}),
      recovered_from_validation_failure: true
    };
  }
  return normalizeGuide(next, sourceUrl, durationSec);
}

function isInternalTextsReferenceError(error = {}) {
  return error?.name === 'ReferenceError'
    && /texts is not defined/i.test(String(error.message || ''));
}

function validateLongformShortsResult(guide = {}, options = {}) {
  if (!isLongformGuide(guide)) return true;

  const missing = [];
  const skipFullValidation = options.skipFullValidation === true
    || guide.full_generation_status === 'failed';
  const skipHighlightValidation = options.skipHighlightValidation === true
    || guide.highlight_generation_status === 'failed';
  const skipMidformValidation = options.skipMidformValidation === true
    || guide.midform_generation_status === 'failed';
  const activeDuplicateVariants = [
    !skipFullValidation ? 'full' : '',
    !skipHighlightValidation ? 'highlight' : '',
    !skipMidformValidation ? 'midform' : ''
  ].filter(Boolean);
  const hook = normalizeWindow(guide.hook_clip_10s) || normalizeWindow(guide.recommended_highlight_window);
  const story = normalizeWindow(guide.story_clip_40s) || normalizeWindow(guide.recommended_full_window);
  const midform = normalizeWindow(guide.midform_clip_120s) || normalizeWindow(guide.recommended_midform_window);

  if (!hook && !skipHighlightValidation) missing.push('missing_hook_clip_10s');
  if (!story && !skipFullValidation) missing.push('missing_story_clip_40s');
  if (skipFullValidation && skipHighlightValidation && skipMidformValidation) {
    missing.push('all_variant_generation_failed');
  }
  if (midform && !skipMidformValidation) {
    const midformDuration = windowDuration(midform);
    const midformCaptionMinimum = midformCaptionMinimumForDuration(midformDuration);
    if (midformDuration < 90 || midformDuration > 135.5) missing.push(`invalid_midform_duration:${midformDuration}`);
    if (guide.midform_metadata_source !== 'gemini') missing.push('missing_gemini_midform_metadata');
    if (guide.midform_metadata_ko_source !== 'gemini') missing.push('missing_gemini_midform_review_metadata');
    if (guide.midform_caption_script_source !== 'gemini') missing.push('missing_gemini_midform_caption_script');
    const midformCaptionCount = Array.isArray(guide.midform_caption_script_ja) ? guide.midform_caption_script_ja.length : 0;
    const midformReviewCaptionCount = Array.isArray(guide.midform_caption_script_ko) ? guide.midform_caption_script_ko.length : 0;
    if (midformCaptionCount < midformCaptionMinimum) {
      missing.push(`midform_caption_script_too_sparse:${midformCaptionCount}/${midformCaptionMinimum}`);
    }
    if (midformReviewCaptionCount < midformCaptionMinimum) {
      missing.push(`midform_review_caption_script_too_sparse:${midformReviewCaptionCount}/${midformCaptionMinimum}`);
    }
  }

  if (hook && !skipHighlightValidation) {
    const hookDuration = windowDuration(hook);
    if (hookDuration < 4 || hookDuration > 24.5) missing.push(`invalid_hook_duration:${hookDuration}`);
  }

  if (story && !skipFullValidation) {
    const storyDuration = windowDuration(story);
    if (storyDuration < 55 || storyDuration > 65.5) missing.push(`invalid_story_duration:${storyDuration}`);
  }

  // Long-form outputs may intentionally reuse a strong opening source moment
  // and rely on caption/template/editing differences for format separation.
  // Treat window proximity and duplicate metadata as review concerns, not
  // generation blockers; otherwise one recoverable mismatch prevents all
  // successfully analyzed variants from becoming drafts.

  const scenes = Array.isArray(guide.scene_transitions) ? guide.scene_transitions : [];
  const storyScenes = story
    ? scenes
        .filter((scene) => {
          const start = Number(scene.start_sec);
          const end = Number(scene.end_sec);
          return Number.isFinite(start) && Number.isFinite(end)
            && end > story.start_sec
            && start < story.end_sec;
        })
        .map((scene) => ({
          ...scene,
          start_sec: Number(Math.max(Number(scene.start_sec), story.start_sec).toFixed(3)),
          end_sec: Number(Math.min(Number(scene.end_sec), story.end_sec).toFixed(3))
        }))
        .filter((scene) => Number(scene.end_sec) > Number(scene.start_sec))
    : scenes;
  const fullScenesForValidation = storyScenes.length ? storyScenes : scenes;
  if (!skipFullValidation && fullScenesForValidation.length < 5) {
    missing.push('not_enough_scene_transitions');
  }

  if (!skipFullValidation && story && fullScenesForValidation.length) {
    const orderedScenes = [...fullScenesForValidation].sort((a, b) => Number(a.start_sec) - Number(b.start_sec));
    const first = orderedScenes[0];
    const last = orderedScenes[orderedScenes.length - 1];
    const firstStart = Number(first.start_sec);
    const lastEnd = Number(last.end_sec);
    if (!Number.isFinite(firstStart) || !Number.isFinite(lastEnd)) {
      missing.push('invalid_scene_timestamps');
    } else {
      if (firstStart < story.start_sec - 0.25 || lastEnd > story.end_sec + 0.25) {
        missing.push('scene_transitions_out_of_story_window');
      }
      const sceneSpan = lastEnd - firstStart;
      const storyDuration = windowDuration(story);
      if (sceneSpan < storyDuration * 0.85) {
        missing.push(`scene_span_too_short:${sceneSpan}/${storyDuration}`);
      }
      const tooCompressed = orderedScenes.every((scene) => {
        const start = Number(scene.start_sec);
        const end = Number(scene.end_sec);
        return Number.isFinite(start) && Number.isFinite(end)
          && start >= firstStart
          && end <= firstStart + 2;
      });
      if (tooCompressed) missing.push('scene_transitions_compressed_into_tiny_window');
    }
  }

  const fullProductionIsKorean = OUTPUT_CONFIG.full_draft.lang === 'ko';
  if (!skipFullValidation && fullProductionIsKorean && !hasNonEmptySubtitles(guide, 'ko')) {
    missing.push('missing_korean_subtitles');
  }
  if ((!fullProductionIsKorean || !skipHighlightValidation || !skipMidformValidation) && !hasNonEmptySubtitles(guide, 'ja')) {
    missing.push('missing_japanese_subtitles');
  }
  if (!options.skipEnglishFallback && hasEnglishFallback(guide, {
    includeFull: !skipFullValidation,
    includeHighlight: !skipHighlightValidation,
    includeMidform: !skipMidformValidation
  })) missing.push('english_fallback_detected');

  if (missing.length) {
    throw createHttpError(500, 'OTTOGI_LONGFORM_VALIDATION_FAILED', 'Long-form Gemini result failed validation', {
      missing,
      hook_clip_10s: guide.hook_clip_10s || null,
      story_clip_40s: guide.story_clip_40s || null,
      midform_clip_120s: guide.midform_clip_120s || guide.recommended_midform_window || null,
      recommended_highlight_window: guide.recommended_highlight_window || null,
      recommended_full_window: guide.recommended_full_window || null,
      recommended_midform_window: guide.recommended_midform_window || null,
      scene_count: scenes.length,
      japanese_subtitle_sources: {
        full_caption_script_ja: Array.isArray(guide.full_caption_script_ja) ? guide.full_caption_script_ja.length : 0,
        midform_caption_script_ja: Array.isArray(guide.midform_caption_script_ja) ? guide.midform_caption_script_ja.length : 0,
        full_metadata_onscreen_subtitles: Array.isArray(guide.full_metadata?.onscreen_subtitles) ? guide.full_metadata.onscreen_subtitles.length : 0,
        midform_metadata_onscreen_subtitles: Array.isArray(guide.midform_metadata?.onscreen_subtitles) ? guide.midform_metadata.onscreen_subtitles.length : 0,
        highlight_caption_block_chars: [...normalizeText(guide.highlight_metadata?.onscreen_caption_block || guide.highlight_onscreen_caption_block_ja || '')].length
      }
    });
  }
  return true;
}

function parseTimeToSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const parts = trimmed.split(':').map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length ? Number(parts.pop()) : 0;
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return (hours * 3600) + (minutes * 60) + seconds;
}

function windowFromClip(value = {}) {
  if (!value || typeof value !== 'object') return null;
  const start = parseTimeToSeconds(value.start_sec ?? value.start_time ?? value.start);
  const end = parseTimeToSeconds(value.end_sec ?? value.end_time ?? value.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start_sec: start, end_sec: end };
}

function selectLongformProcessScenes(scenes = [], guide = {}) {
  if (!isLongformGuide(guide)) return scenes;
  const maxScenes = 12;
  const recommendedWindow = normalizeWindow(guide.recommended_full_window)
    || windowFromClip(guide.story_clip_40s)
    || normalizeWindow((Array.isArray(guide.shortform_candidate_windows) ? guide.shortform_candidate_windows : [])[0]);

  let selected = scenes;
  if (recommendedWindow) {
    selected = scenes.filter((scene) => {
      const start = Number(scene.start_sec);
      const end = Number(scene.end_sec);
      return Number.isFinite(start) && Number.isFinite(end)
        && end > recommendedWindow.start_sec
        && start < recommendedWindow.end_sec;
    }).map((scene) => {
      const start = Math.max(Number(scene.start_sec), recommendedWindow.start_sec);
      const end = Math.min(Number(scene.end_sec), recommendedWindow.end_sec);
      return {
        ...scene,
        start_sec: Number(start.toFixed(3)),
        end_sec: Number(end.toFixed(3)),
        transition_at_sec: Number(end.toFixed(3))
      };
    }).filter((scene) => Number(scene.end_sec) > Number(scene.start_sec));
  }

  if (!selected.length) selected = scenes;
  if (selected.length <= maxScenes) return selected;

  const scoreScene = (scene) => {
    const explicit = Number(scene.a_grade_score || 0);
    if (explicit > 0) return explicit;
    const subScores = [
      Number(scene.tempo_score || 0),
      Number(scene.tension_score || 0),
      Number(scene.transformation_score || 0),
      Number(scene.framing_score || 0),
      Number(scene.flow_score || 0)
    ].filter((score) => Number.isFinite(score) && score > 0);
    if (subScores.length) return subScores.reduce((sum, score) => sum + score, 0);
    return Number(scene.visual_hook_score || 0) + Number(scene.repetition_potential || 0);
  };

  const ranked = [...selected].sort((a, b) => {
    return scoreScene(b) - scoreScene(a);
  }).slice(0, maxScenes);
  const keep = new Set(ranked.map((scene) => scene.scene_id));
  return selected.filter((scene) => keep.has(scene.scene_id)).slice(0, maxScenes);
}

function normalizeGuide(guide = {}, sourceUrl = '', durationSec = 0) {
  const subject = normalizeText(guide.detected_subject || guide.subject || guide.title || '');
  const shortDescription = clampDescription(
    guide.short_description_200 ||
      guide.explainer_text ||
      guide.highlight_explainer_text ||
      guide.scene_transitions?.[0]?.visual_summary ||
      '素材が加工され、形を変えながら製品に近づいていく工程を紹介します。'
  );
  const shortDescriptionKo = normalizeText(
    guide.short_description_ko ||
      guide.explainer_text_ko ||
      guide.highlight_explainer_text_ko ||
      '소재가 가공되고 형태를 바꾸며 제품에 가까워지는 공정을 소개합니다.'
  );
  const titles = Array.isArray(guide.recommended_titles) ? guide.recommended_titles : [];
  const titlesKo = Array.isArray(guide.recommended_titles_ko) ? guide.recommended_titles_ko : [];
  const normalizedTitles = normalizeTitleList(titles, subject, false);
  const normalizedTitlesKo = normalizeTitleList(titlesKo, subject, true);
  const highlightHookCaptionsJa = Array.isArray(guide.highlight_hook_captions_ja)
    ? guide.highlight_hook_captions_ja.map(normalizeText).filter(Boolean)
    : [];
  const highlightHookCaptionsKo = Array.isArray(guide.highlight_hook_captions_ko)
    ? guide.highlight_hook_captions_ko.map(normalizeText).filter(Boolean)
    : [];
  const rawScenes = Array.isArray(guide.scene_transitions) && guide.scene_transitions.length
    ? guide.scene_transitions
    : fallbackSceneTransitions(guide, durationSec);
  const derivedWindows = deriveLongformWindows(guide, durationSec, rawScenes);
  const hookClip10s = derivedWindows.hookClip;
  const storyClip40s = derivedWindows.storyClip;
  const midformClip120s = derivedWindows.midformClip;
  const recommendedFullWindow = derivedWindows.storyWindow;
  const recommendedHighlightWindow = derivedWindows.hookWindow;
  const recommendedMidformWindow = derivedWindows.midformWindow;
  const guideWithMappedWindows = {
    ...guide,
    hook_clip_10s: hookClip10s,
    story_clip_40s: storyClip40s,
    midform_clip_120s: midformClip120s,
    recommended_full_window: recommendedFullWindow,
    recommended_highlight_window: recommendedHighlightWindow,
    recommended_midform_window: recommendedMidformWindow
  };
  const sceneTransitions = ensureMinimumLongformScenes(retimeCollapsedLongformScenes(selectLongformProcessScenes(
    rawScenes.map((scene, index) => normalizeScene(scene, index, durationSec)),
    guideWithMappedWindows
  ), guideWithMappedWindows, durationSec), guideWithMappedWindows, durationSec).map((scene, index) => ({
    ...scene,
    scene_id: normalizeText(scene.scene_id || `scene_${String(index + 1).padStart(3, '0')}`)
  }));
  const fallbackFullOnscreenSubtitlesJa = deriveOnscreenSubtitlesFromScenes(sceneTransitions, 'ja');
  const fallbackFullOnscreenSubtitlesKo = deriveOnscreenSubtitlesFromScenes(sceneTransitions, 'ko');
  const fullCaptionScriptJa = normalizeFullCaptionScript(
    guide.full_caption_script_ja,
    sceneTransitions,
    'ja',
    [],
    { allowSceneFallback: false }
  );
  const fullCaptionScriptKo = normalizeFullCaptionScript(
    guide.full_caption_script_ko,
    sceneTransitions,
    'ko',
    [],
    { allowSceneFallback: false }
  );
  let midformCaptionScriptJa = normalizeFullCaptionScript(
    guide.midform_caption_script_ja,
    sceneTransitions,
    'ja',
    guide.midform_metadata?.onscreen_subtitles || fullCaptionScriptTexts(fullCaptionScriptJa) || fallbackFullOnscreenSubtitlesJa
  );
  let midformCaptionScriptKo = normalizeFullCaptionScript(
    guide.midform_caption_script_ko,
    sceneTransitions,
    'ko',
    guide.midform_metadata_ko?.onscreen_subtitles || fullCaptionScriptTexts(fullCaptionScriptKo) || fallbackFullOnscreenSubtitlesKo
  );
  const midformCaptionDuration = windowDuration(midformClip120s || recommendedMidformWindow) || 120;
  midformCaptionScriptJa = expandMidformCaptionScript(
    midformCaptionScriptJa,
    guide.midform_metadata?.onscreen_subtitles || fullCaptionScriptTexts(fullCaptionScriptJa) || fallbackFullOnscreenSubtitlesJa,
    false,
    midformCaptionDuration
  );
  midformCaptionScriptKo = expandMidformCaptionScript(
    midformCaptionScriptKo,
    guide.midform_metadata_ko?.onscreen_subtitles || fullCaptionScriptTexts(fullCaptionScriptKo) || fallbackFullOnscreenSubtitlesKo,
    true,
    midformCaptionDuration
  );
  const fullOnscreenSubtitlesJa = fullCaptionScriptTexts(fullCaptionScriptJa).length
    ? fullCaptionScriptTexts(fullCaptionScriptJa)
    : [];
  const fullOnscreenSubtitlesKo = fullCaptionScriptTexts(fullCaptionScriptKo).length
    ? fullCaptionScriptTexts(fullCaptionScriptKo)
    : [];
  const reportDescription = String(guide.report_description || buildFallbackReport(subject, shortDescription, false)).trim();
  const reportDescriptionKo = String(guide.report_description_ko || buildFallbackReport(subject, shortDescriptionKo, true)).trim();
  const highlightDescription = ensureHighlightCaptionBlock(
    guide.highlight_explainer_text ||
      guide.highlight_onscreen_caption_block_ja ||
      guide.highlight_metadata?.onscreen_caption_block ||
      guide.highlight_metadata?.summary_caption ||
      shortDescription,
    false
  );
  const highlightDescriptionKo = ensureHighlightCaptionBlock(
    guide.highlight_explainer_text_ko ||
      guide.highlight_onscreen_caption_block_ko ||
      guide.highlight_metadata_ko?.onscreen_caption_block ||
      guide.highlight_metadata_ko?.summary_caption ||
      shortDescriptionKo,
    true
  );
  const fullMetadata = normalizeVariantMetadata(guide.full_metadata, {
    subject,
    variant_type: 'full',
    caption_mode: 'scene_based_short_subtitles',
    short_description: shortDescription,
    recommended_titles: normalizedTitles,
    report_description: reportDescription,
    summary_caption: shortDescription,
    onscreen_subtitles: fullOnscreenSubtitlesJa,
    hashtags: titleHashtagsFromList(normalizedTitles, false),
    upload_title: normalizedTitles[0]?.title || ''
  });
  fullMetadata.onscreen_subtitles = fullOnscreenSubtitlesJa;
  const fullMetadataKo = normalizeVariantMetadata(guide.full_metadata_ko, {
    subject,
    korean: true,
    variant_type: 'full',
    caption_mode: 'scene_based_short_subtitles',
    short_description: shortDescriptionKo,
    recommended_titles: normalizedTitlesKo,
    report_description: reportDescriptionKo,
    summary_caption: shortDescriptionKo,
    onscreen_subtitles: fullOnscreenSubtitlesKo,
    hashtags: titleHashtagsFromList(normalizedTitlesKo, true),
    upload_title: normalizedTitlesKo[0]?.title || ''
  });
  const highlightMetadata = normalizeVariantMetadata(guide.highlight_metadata, {
    subject,
    variant_type: 'highlight',
    caption_mode: 'long_bottom_explainer',
    short_description: highlightDescription,
    recommended_titles: guide.highlight_recommended_titles || normalizedTitles,
    report_description: guide.highlight_report_description || reportDescription,
    summary_caption: highlightDescription,
    onscreen_caption_block: guide.highlight_onscreen_caption_block_ja || highlightDescription,
    highlight: true,
    hashtags: guide.highlight_hashtags || titleHashtagsFromList(normalizedTitles, false),
    upload_title: guide.highlight_upload_title || normalizedTitles[0]?.title || ''
  });
  const highlightMetadataKo = normalizeVariantMetadata(guide.highlight_metadata_ko, {
    subject,
    korean: true,
    variant_type: 'highlight',
    caption_mode: 'long_bottom_explainer',
    short_description: highlightDescriptionKo,
    recommended_titles: guide.highlight_recommended_titles_ko || normalizedTitlesKo,
    report_description: guide.highlight_report_description_ko || reportDescriptionKo,
    summary_caption: highlightDescriptionKo,
    onscreen_caption_block: guide.highlight_onscreen_caption_block_ko || highlightDescriptionKo,
    highlight: true,
    hashtags: titleHashtagsFromList(normalizedTitlesKo, true),
    upload_title: guide.highlight_upload_title_ko || normalizedTitlesKo[0]?.title || ''
  });
  fullMetadataKo.onscreen_subtitles = fullOnscreenSubtitlesKo;
  highlightMetadata.onscreen_caption_block = ensureHighlightCaptionBlock(
    highlightMetadata.onscreen_caption_block || highlightDescription,
    false
  );
  highlightMetadata.onscreen_subtitles = [];
  highlightMetadataKo.onscreen_caption_block = ensureHighlightCaptionBlock(
    highlightMetadataKo.onscreen_caption_block || highlightDescriptionKo,
    true
  );
  highlightMetadataKo.onscreen_subtitles = [];
  const midformMetadataSource = guide.midform_metadata && typeof guide.midform_metadata === 'object'
    ? guide.midform_metadata
    : {};
  const midformMetadataKoSource = guide.midform_metadata_ko && typeof guide.midform_metadata_ko === 'object'
    ? guide.midform_metadata_ko
    : {};
  const midformMetadata = normalizeVariantMetadata(midformMetadataSource, {
    subject,
    variant_type: 'midform',
    caption_mode: 'scene_based_short_subtitles',
    short_description: guide.midform_short_description || shortDescription,
    recommended_titles: guide.midform_recommended_titles || normalizedTitles,
    report_description: guide.midform_report_description || reportDescription,
    summary_caption: guide.midform_summary_caption || shortDescription,
    onscreen_subtitles: fullCaptionScriptTexts(midformCaptionScriptJa).length
      ? fullCaptionScriptTexts(midformCaptionScriptJa)
      : fullOnscreenSubtitlesJa,
    hashtags: guide.midform_hashtags || titleHashtagsFromList(normalizedTitles, false),
    upload_title: guide.midform_upload_title || normalizedTitles[0]?.title || ''
  });
  const midformMetadataKo = normalizeVariantMetadata(midformMetadataKoSource, {
    subject,
    korean: true,
    variant_type: 'midform',
    caption_mode: 'scene_based_short_subtitles',
    short_description: guide.midform_short_description_ko || shortDescriptionKo,
    recommended_titles: guide.midform_recommended_titles_ko || normalizedTitlesKo,
    report_description: guide.midform_report_description_ko || reportDescriptionKo,
    summary_caption: guide.midform_summary_caption_ko || shortDescriptionKo,
    onscreen_subtitles: fullCaptionScriptTexts(midformCaptionScriptKo).length
      ? fullCaptionScriptTexts(midformCaptionScriptKo)
      : fullOnscreenSubtitlesKo,
    hashtags: guide.midform_hashtags_ko || titleHashtagsFromList(normalizedTitlesKo, true),
    upload_title: guide.midform_upload_title_ko || normalizedTitlesKo[0]?.title || ''
  });
  const regionalEditingStrategy = normalizeRegionalEditingStrategy(guide.regional_editing_strategy);
  const variantStrategy = normalizeVariantStrategy(guide.variant_strategy);
  return {
    ...guide,
    regional_editing_strategy: regionalEditingStrategy,
    variant_strategy: variantStrategy,
    four_part_scene_observation: guide.four_part_scene_observation || {},
    shorts_strategy_analysis: guide.shorts_strategy_analysis || {},
    source_type: guide.source_type || 'unknown',
    source_workflow_mode: guide.source_workflow_mode || 'unknown',
    shortform_candidate_windows: Array.isArray(guide.shortform_candidate_windows) ? guide.shortform_candidate_windows : [],
    hook_clip_10s: hookClip10s,
    story_clip_40s: storyClip40s,
    midform_clip_120s: midformClip120s,
    recommended_full_window: recommendedFullWindow || null,
    recommended_highlight_window: recommendedHighlightWindow || null,
    recommended_midform_window: recommendedMidformWindow || null,
    short_description_200: shortDescription,
    short_description_ko: shortDescriptionKo,
    recommended_titles: normalizedTitles,
    recommended_titles_ko: normalizedTitlesKo,
    report_description: reportDescription,
    report_description_ko: reportDescriptionKo,
    explainer_text: shortDescription,
    explainer_text_ko: shortDescriptionKo,
    highlight_explainer_text: highlightMetadata.onscreen_caption_block,
    highlight_explainer_text_ko: highlightMetadataKo.onscreen_caption_block,
    full_metadata: fullMetadata,
    full_metadata_ko: fullMetadataKo,
    full_caption_script_ja: fullCaptionScriptJa,
    full_caption_script_ko: fullCaptionScriptKo,
    highlight_metadata: highlightMetadata,
    highlight_metadata_ko: highlightMetadataKo,
    midform_metadata: midformMetadata,
    midform_metadata_ko: midformMetadataKo,
    midform_caption_script_ja: midformCaptionScriptJa.length ? midformCaptionScriptJa : fullCaptionScriptJa,
    midform_caption_script_ko: midformCaptionScriptKo.length ? midformCaptionScriptKo : fullCaptionScriptKo,
    full_onscreen_subtitles_ja: fullMetadata.onscreen_subtitles,
    full_onscreen_subtitles_ko: fullMetadataKo.onscreen_subtitles,
    highlight_onscreen_caption_block_ja: highlightMetadata.onscreen_caption_block,
    highlight_onscreen_caption_block_ko: highlightMetadataKo.onscreen_caption_block,
    highlight_onscreen_subtitles_ja: [],
    highlight_onscreen_subtitles_ko: [],
    highlight_hook_captions_ja: highlightHookCaptionsJa,
    highlight_hook_captions_ko: highlightHookCaptionsKo,
    midform_metadata_source: Object.keys(midformMetadataSource).length ? 'gemini' : 'generated_missing_input',
    midform_metadata_ko_source: Object.keys(midformMetadataKoSource).length ? 'gemini' : 'generated_missing_input',
    midform_caption_script_source: Array.isArray(guide.midform_caption_script_ja) && guide.midform_caption_script_ja.length
      ? 'gemini'
      : 'generated_missing_input',
    source_url: sourceUrl || guide.source_url || '',
    scene_transitions: sceneTransitions
  };
}

function mergeSplitGuides(sceneGuide = {}, metadataGuide = {}, sourceUrl = '', durationSec = 0) {
  const merged = {
    ...metadataGuide,
    detected_subject: metadataGuide.detected_subject || sceneGuide.detected_subject || '',
    source_url: sourceUrl || metadataGuide.source_url || sceneGuide.source_url || '',
    source_type: metadataGuide.source_type || sceneGuide.source_type || '',
    source_workflow_mode: metadataGuide.source_workflow_mode || sceneGuide.source_workflow_mode || '',
    four_part_scene_observation: metadataGuide.four_part_scene_observation || sceneGuide.four_part_scene_observation || {},
    shorts_strategy_analysis: metadataGuide.shorts_strategy_analysis || sceneGuide.shorts_strategy_analysis || {},
    shortform_candidate_windows: Array.isArray(sceneGuide.shortform_candidate_windows) && sceneGuide.shortform_candidate_windows.length
      ? sceneGuide.shortform_candidate_windows
      : metadataGuide.shortform_candidate_windows,
    hook_clip_10s: sceneGuide.hook_clip_10s || metadataGuide.hook_clip_10s || null,
    story_clip_40s: sceneGuide.story_clip_40s || metadataGuide.story_clip_40s || null,
    recommended_full_window: sceneGuide.recommended_full_window || metadataGuide.recommended_full_window || null,
    recommended_highlight_window: sceneGuide.recommended_highlight_window || metadataGuide.recommended_highlight_window || null,
    scene_transitions: Array.isArray(sceneGuide.scene_transitions) && sceneGuide.scene_transitions.length
      ? sceneGuide.scene_transitions
      : metadataGuide.scene_transitions,
    highlight_hook_captions_ja: Array.isArray(metadataGuide.highlight_hook_captions_ja) && metadataGuide.highlight_hook_captions_ja.length
      ? metadataGuide.highlight_hook_captions_ja
      : sceneGuide.highlight_hook_captions_ja,
    highlight_hook_captions_ko: Array.isArray(metadataGuide.highlight_hook_captions_ko) && metadataGuide.highlight_hook_captions_ko.length
      ? metadataGuide.highlight_hook_captions_ko
      : sceneGuide.highlight_hook_captions_ko,
    full_caption_script_ja: Array.isArray(metadataGuide.full_caption_script_ja) && metadataGuide.full_caption_script_ja.length
      ? metadataGuide.full_caption_script_ja
      : sceneGuide.full_caption_script_ja,
    full_caption_script_ko: Array.isArray(metadataGuide.full_caption_script_ko) && metadataGuide.full_caption_script_ko.length
      ? metadataGuide.full_caption_script_ko
      : sceneGuide.full_caption_script_ko
  };
  return normalizeGuide(merged, sourceUrl, durationSec);
}

function mergeLongformVariantGuides({ baseGuide = {}, fullGuide = {}, highlightGuide = {}, midformGuide = {}, sourceUrl = '', durationSec = 0 }) {
  return normalizeGuide({
    ...baseGuide,
    detected_subject: fullGuide.detected_subject
      || highlightGuide.detected_subject
      || midformGuide.detected_subject
      || baseGuide.detected_subject
      || '',
    short_description_200: fullGuide.short_description_200 || baseGuide.short_description_200 || '',
    short_description_ko: fullGuide.short_description_ko || baseGuide.short_description_ko || '',
    recommended_titles: fullGuide.recommended_titles || baseGuide.recommended_titles || [],
    recommended_titles_ko: fullGuide.recommended_titles_ko || baseGuide.recommended_titles_ko || [],
    report_description: fullGuide.report_description || baseGuide.report_description || '',
    report_description_ko: fullGuide.report_description_ko || baseGuide.report_description_ko || '',
    explainer_text: fullGuide.explainer_text || baseGuide.explainer_text || '',
    explainer_text_ko: fullGuide.explainer_text_ko || baseGuide.explainer_text_ko || '',
    highlight_explainer_text: highlightGuide.highlight_explainer_text || baseGuide.highlight_explainer_text || '',
    highlight_explainer_text_ko: highlightGuide.highlight_explainer_text_ko || baseGuide.highlight_explainer_text_ko || '',
    highlight_hook_captions_ja: highlightGuide.highlight_hook_captions_ja || baseGuide.highlight_hook_captions_ja || [],
    highlight_hook_captions_ko: highlightGuide.highlight_hook_captions_ko || baseGuide.highlight_hook_captions_ko || [],
    full_metadata: fullGuide.full_metadata || baseGuide.full_metadata || {},
    full_metadata_ko: fullGuide.full_metadata_ko || baseGuide.full_metadata_ko || {},
    highlight_metadata: highlightGuide.highlight_metadata || baseGuide.highlight_metadata || {},
    highlight_metadata_ko: highlightGuide.highlight_metadata_ko || baseGuide.highlight_metadata_ko || {},
    midform_metadata: midformGuide.midform_metadata || baseGuide.midform_metadata || {},
    midform_metadata_ko: midformGuide.midform_metadata_ko || baseGuide.midform_metadata_ko || {},
    full_caption_script_ja: fullGuide.full_caption_script_ja || baseGuide.full_caption_script_ja || [],
    full_caption_script_ko: fullGuide.full_caption_script_ko || baseGuide.full_caption_script_ko || [],
    full_generation_status: fullGuide.full_generation_status || baseGuide.full_generation_status || '',
    full_generation_error: fullGuide.full_generation_error || baseGuide.full_generation_error || '',
    full_generation_details: fullGuide.full_generation_details || baseGuide.full_generation_details || null,
    highlight_generation_status: highlightGuide.highlight_generation_status || baseGuide.highlight_generation_status || '',
    highlight_generation_error: highlightGuide.highlight_generation_error || baseGuide.highlight_generation_error || '',
    highlight_generation_details: highlightGuide.highlight_generation_details || baseGuide.highlight_generation_details || null,
    midform_caption_script_ja: midformGuide.midform_caption_script_ja || baseGuide.midform_caption_script_ja || [],
    midform_caption_script_ko: midformGuide.midform_caption_script_ko || baseGuide.midform_caption_script_ko || [],
    midform_generation_status: midformGuide.midform_generation_status || baseGuide.midform_generation_status || '',
    midform_generation_error: midformGuide.midform_generation_error || baseGuide.midform_generation_error || '',
    midform_generation_details: midformGuide.midform_generation_details || baseGuide.midform_generation_details || null,
    regional_editing_strategy: {
      ...(baseGuide.regional_editing_strategy || {}),
      ...(fullGuide.regional_editing_strategy || {}),
      ...(highlightGuide.regional_editing_strategy || {}),
      ...(midformGuide.regional_editing_strategy || {})
    },
    variant_strategy: {
      ...(baseGuide.variant_strategy || {}),
      ...(fullGuide.variant_strategy || {}),
      ...(highlightGuide.variant_strategy || {}),
      ...(midformGuide.variant_strategy || {})
    },
    four_part_scene_observation: fullGuide.four_part_scene_observation
      || highlightGuide.four_part_scene_observation
      || midformGuide.four_part_scene_observation
      || baseGuide.four_part_scene_observation
      || {},
    shorts_strategy_analysis: fullGuide.shorts_strategy_analysis
      || highlightGuide.shorts_strategy_analysis
      || midformGuide.shorts_strategy_analysis
      || baseGuide.shorts_strategy_analysis
      || {},
    source_url: sourceUrl || baseGuide.source_url || '',
    source_type: baseGuide.source_type || 'longform',
    source_workflow_mode: baseGuide.source_workflow_mode || 'longform_to_shorts'
  }, sourceUrl, durationSec);
}

function mergeReviewedGuide(draftGuide = {}, reviewGuide = {}, sourceUrl = '', durationSec = 0) {
  const reviewedScenes = Array.isArray(reviewGuide.scene_transitions) && reviewGuide.scene_transitions.length
    ? reviewGuide.scene_transitions
    : draftGuide.scene_transitions;
  return normalizeGuide({
    ...draftGuide,
    ...reviewGuide,
    scene_transitions: reviewedScenes,
    detected_subject: reviewGuide.detected_subject || draftGuide.detected_subject || '',
    source_url: sourceUrl || reviewGuide.source_url || draftGuide.source_url || '',
    source_type: reviewGuide.source_type || draftGuide.source_type || '',
    source_workflow_mode: reviewGuide.source_workflow_mode || draftGuide.source_workflow_mode || '',
    four_part_scene_observation: reviewGuide.four_part_scene_observation || draftGuide.four_part_scene_observation || {},
    shorts_strategy_analysis: reviewGuide.shorts_strategy_analysis || draftGuide.shorts_strategy_analysis || {},
    shortform_candidate_windows: Array.isArray(reviewGuide.shortform_candidate_windows) && reviewGuide.shortform_candidate_windows.length
      ? reviewGuide.shortform_candidate_windows
      : draftGuide.shortform_candidate_windows,
    hook_clip_10s: reviewGuide.hook_clip_10s || draftGuide.hook_clip_10s || null,
    story_clip_40s: reviewGuide.story_clip_40s || draftGuide.story_clip_40s || null,
    recommended_full_window: reviewGuide.recommended_full_window || draftGuide.recommended_full_window || null,
    recommended_highlight_window: reviewGuide.recommended_highlight_window || draftGuide.recommended_highlight_window || null
  }, sourceUrl, durationSec);
}

function emitProgress(onProgress, message, data = {}) {
  if (typeof onProgress === 'function') {
    onProgress(message, data);
  }
}

function isRetryableGeminiStatus(status) {
  return [429, 500, 502, 503, 504].includes(Number(status));
}

function isRetryableGeminiError(error) {
  return error?.code === 'OTTOGI_METADATA_JSON_PARSE_ERROR'
    || error?.message === 'fetch failed'
    || error?.name === 'TypeError'
    || isRetryableGeminiStatus(getGeminiErrorStatus(error));
}

function getGeminiErrorStatus(error) {
  return Number(error?.status || error?.statusCode || error?.code || error?.response?.status || 0);
}

function isLongformFinalPhase(phase = '') {
  return /^longform_final_/i.test(String(phase || ''));
}

function geminiMaxAttemptsForPhase(phase = '', options = {}) {
  const requested = Number(options.maxAttempts || 0);
  if (Number.isFinite(requested) && requested > 0) return Math.max(1, Math.floor(requested));
  return isLongformFinalPhase(phase) ? GEMINI_LONGFORM_FINAL_MAX_ATTEMPTS : GEMINI_GENERATE_MAX_ATTEMPTS;
}

function retryDelayMs(attempt, phase = '', status = 0, options = {}) {
  const requestedBase = Number(options.retryBaseMs || 0);
  const base = Number.isFinite(requestedBase) && requestedBase > 0
    ? requestedBase
    : isLongformFinalPhase(phase)
      ? GEMINI_LONGFORM_FINAL_RETRY_BASE_MS
      : GEMINI_GENERATE_RETRY_BASE_MS;
  const multiplier = Number(status) === 429 && isLongformFinalPhase(phase)
    ? Math.max(1, attempt)
    : attempt;
  return Math.min(base * multiplier, 5 * 60 * 1000);
}

function assertLongformBasis(value = {}, label = 'longform') {
  const basis = normalizeText(value.source_time_basis || '');
  if (!basis) return;
  if (basis !== 'absolute_original_seconds') {
    throw createHttpError(500, 'OTTOGI_LONGFORM_TIME_BASIS_INVALID', `${label} must use absolute original seconds`, {
      source_time_basis: basis
    });
  }
}

function assertWindowDuration(window, { label, min, max, sourceDurationSec = 0 }) {
  const normalized = normalizeWindow(window);
  if (!normalized) {
    throw createHttpError(500, 'OTTOGI_LONGFORM_WINDOW_INVALID', `${label} window is missing or invalid`, { window });
  }
  const duration = windowDuration(normalized);
  if (duration < min || duration > max) {
    throw createHttpError(500, 'OTTOGI_LONGFORM_WINDOW_INVALID', `${label} duration is invalid`, {
      window: normalized,
      duration,
      min,
      max
    });
  }
  const sourceDuration = Number(sourceDurationSec || 0);
  if (Number.isFinite(sourceDuration) && sourceDuration > 0) {
    if (normalized.start_sec < 0 || normalized.end_sec > sourceDuration || normalized.start_sec >= sourceDuration) {
      throw createHttpError(500, 'OTTOGI_LONGFORM_WINDOW_OUT_OF_RANGE', `${label} window is outside source duration`, {
        window: normalized,
        source_duration_sec: sourceDuration
      });
    }
  }
  return {
    ...window,
    start_sec: normalized.start_sec,
    end_sec: normalized.end_sec,
    duration_sec: Number(duration.toFixed(3))
  };
}

function fallbackWindow({ start = 0, duration = 10, sourceDurationSec = 0 }) {
  const sourceDuration = Number(sourceDurationSec || 0);
  const targetDuration = Math.max(1, Number(duration || 10));
  let safeStart = Math.max(0, Number(start || 0));
  if (Number.isFinite(sourceDuration) && sourceDuration > 0) {
    if (targetDuration >= sourceDuration) {
      return { start_sec: 0, end_sec: Number(sourceDuration.toFixed(3)), duration_sec: Number(sourceDuration.toFixed(3)) };
    }
    safeStart = Math.min(safeStart, Math.max(0, sourceDuration - targetDuration));
  }
  const safeEnd = safeStart + targetDuration;
  return {
    start_sec: Number(safeStart.toFixed(3)),
    end_sec: Number(safeEnd.toFixed(3)),
    duration_sec: Number(targetDuration.toFixed(3))
  };
}

function buildLongformCandidateGuideFromExisting(existingGuide = {}, durationSec = 0) {
  const safeExistingGuide = asPlainObject(existingGuide);
  const directGuide = {
    source_time_basis: 'absolute_original_seconds',
    hook_candidates: Array.isArray(safeExistingGuide.hook_candidates) ? safeExistingGuide.hook_candidates : [],
    story_candidates: Array.isArray(safeExistingGuide.story_candidates) ? safeExistingGuide.story_candidates : [],
    midform_candidates: Array.isArray(safeExistingGuide.midform_candidates) ? safeExistingGuide.midform_candidates : []
  };
  const hasDirectCandidates = directGuide.hook_candidates.length
    || directGuide.story_candidates.length
    || directGuide.midform_candidates.length;
  if (hasDirectCandidates) {
    return validateLongformCandidateGuide(directGuide, durationSec);
  }

  const shortformWindows = Array.isArray(safeExistingGuide.shortform_candidate_windows)
    ? safeExistingGuide.shortform_candidate_windows
    : [];
  if (!shortformWindows.length) return null;

  const guide = {
    source_time_basis: 'absolute_original_seconds',
    hook_candidates: [],
    story_candidates: [],
    midform_candidates: []
  };

  shortformWindows.forEach((candidate) => {
    const window = normalizeWindow(candidate);
    if (!window) return;
    const normalizedCandidate = {
      ...candidate,
      ...window,
      duration_sec: windowDuration(window)
    };
    const purpose = normalizeText(candidate.purpose || candidate.selection_strategy || candidate.reason || '').toLowerCase();
    if (/midform|120|documentary/.test(purpose)) {
      guide.midform_candidates.push(normalizedCandidate);
      return;
    }
    if (/story|full|process|coverage|재료|工程/.test(purpose)) {
      guide.story_candidates.push(normalizedCandidate);
      return;
    }
    guide.hook_candidates.push(normalizedCandidate);
  });

  const hasDerivedCandidates = guide.hook_candidates.length
    || guide.story_candidates.length
    || guide.midform_candidates.length;
  return hasDerivedCandidates ? validateLongformCandidateGuide(guide, durationSec) : null;
}

function clampLongformHighlightWindow(window = {}, sourceDurationSec = 0, targetDurationSec = 15) {
  const normalized = normalizeWindow(window);
  if (!normalized) return null;
  const duration = windowDuration(normalized);
  if (duration >= 4 && duration <= 24.5) {
    return {
      ...window,
      start_sec: normalized.start_sec,
      end_sec: normalized.end_sec,
      duration_sec: Number(duration.toFixed(3))
    };
  }
  const targetDuration = duration < 4
    ? 6
    : Math.min(24, Math.max(10, Number(targetDurationSec || 15)));
  const clamped = fallbackWindow({
    start: normalized.start_sec,
    duration: targetDuration,
    sourceDurationSec
  });
  return {
    ...window,
    ...clamped,
    adjusted_from: {
      start_sec: normalized.start_sec,
      end_sec: normalized.end_sec,
      duration_sec: Number(duration.toFixed(3))
    },
    adjustment_reason: duration > 24.5
      ? `longform highlight duration auto-clamped from ${Number(duration.toFixed(3))}s`
      : `longform highlight duration auto-expanded from ${Number(duration.toFixed(3))}s`
  };
}

function buildFallbackCandidate({ type, sourceDurationSec = 0, anchorWindow = null, avoidWindow = null }) {
  const sourceDuration = Number(sourceDurationSec || 0);
  const anchor = normalizeWindow(anchorWindow);
  const avoid = normalizeWindow(avoidWindow);
  const durationByType = { hook: 10, story: 40, midform: 120 };
  const duration = durationByType[type] || 10;
  let start = anchor ? anchor.start_sec : 0;
  if (type === 'story') {
    start = anchor ? Math.max(0, anchor.end_sec + 5) : 0;
    if (sourceDuration > duration + 20 && start + duration > sourceDuration) {
      start = Math.max(0, sourceDuration - duration - 5);
    }
  } else if (type === 'midform') {
    start = 0;
    if (avoid && sourceDuration > duration + 20 && Math.abs(avoid.start_sec - start) < 8) start = 20;
  }
  const window = fallbackWindow({ start, duration, sourceDurationSec: sourceDuration });
  const base = {
    ...window,
    generated_fallback: true,
    reason: 'Gemini candidate output did not provide enough valid windows; generated from source duration.'
  };
  if (type === 'hook') {
    return {
      ...base,
      visual_hook: 'Fallback visual hook window',
      opening_type: 'action_peak',
      hook_score: 6,
      tempo_score: 3,
      tension_score: 3,
      transformation_score: 3,
      framing_score: 3,
      flow_score: 3
    };
  }
  if (type === 'midform') {
    return {
      ...base,
      process_flow: 'Fallback midform process window',
      opening_type: 'ambient_context',
      atmosphere_score: 3,
      process_coverage_score: 3
    };
  }
  return {
    ...base,
    story_flow: 'Fallback coherent process window',
    opening_type: 'result_or_raw_material',
    hook_score: 5,
    process_coverage_score: 3
  };
}

function separatedFallbackWindow({ anchorWindow, sourceDurationSec = 0, duration = 40, minGapSec = 5 }) {
  const anchor = normalizeWindow(anchorWindow);
  const sourceDuration = Number(sourceDurationSec || 0);
  let start = anchor ? anchor.end_sec + minGapSec : minGapSec;
  if (sourceDuration > duration + minGapSec) {
    start = Math.min(start, Math.max(0, sourceDuration - duration));
  }
  return fallbackWindow({ start, duration, sourceDurationSec: sourceDuration });
}

function validateLongformCandidateGuide(candidateGuide = {}, durationSec = 0) {
  assertLongformBasis(candidateGuide, 'candidateGuide');
  const sourceDuration = Number(durationSec || 0);
  const hookCandidates = Array.isArray(candidateGuide.hook_candidates) ? candidateGuide.hook_candidates : [];
  const storyCandidates = Array.isArray(candidateGuide.story_candidates) ? candidateGuide.story_candidates : [];
  const midformCandidates = Array.isArray(candidateGuide.midform_candidates) ? candidateGuide.midform_candidates : [];
  const validHooks = hookCandidates
    .map((candidate) => {
      try {
        return assertWindowDuration(candidate, { label: 'hook_candidate', min: 4, max: 24.5, sourceDurationSec: sourceDuration });
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const validStories = storyCandidates
    .map((candidate) => {
      try {
        return assertWindowDuration(candidate, { label: 'story_candidate', min: 55, max: 65.5, sourceDurationSec: sourceDuration });
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const validMidforms = midformCandidates
    .map((candidate) => {
      try {
        return assertWindowDuration(candidate, { label: 'midform_candidate', min: 90, max: 135, sourceDurationSec: sourceDuration });
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const fallbacks = [];
  if (!validHooks.length) {
    const fallback = buildFallbackCandidate({ type: 'hook', sourceDurationSec: sourceDuration, anchorWindow: normalizeWindow(hookCandidates[0]) });
    validHooks.push(fallback);
    fallbacks.push('hook');
  }
  if (!validStories.length) {
    const fallback = buildFallbackCandidate({ type: 'story', sourceDurationSec: sourceDuration, anchorWindow: validHooks[0], avoidWindow: validHooks[0] });
    validStories.push(fallback);
    fallbacks.push('story');
  }
  if (!validMidforms.length && sourceDuration >= 125) {
    const fallback = buildFallbackCandidate({ type: 'midform', sourceDurationSec: sourceDuration, anchorWindow: validStories[0], avoidWindow: validStories[0] });
    validMidforms.push(fallback);
    fallbacks.push('midform');
  }

  return {
    ...candidateGuide,
    source_time_basis: 'absolute_original_seconds',
    hook_candidates: validHooks,
    story_candidates: validStories,
    midform_candidates: validMidforms,
    fallback_windows_applied: fallbacks,
    candidate_validation_summary: {
      hook_candidates_count: hookCandidates.length,
      valid_hook_candidates_count: validHooks.length,
      story_candidates_count: storyCandidates.length,
      valid_story_candidates_count: validStories.length,
      midform_candidates_count: midformCandidates.length,
      valid_midform_candidates_count: validMidforms.length,
      fallback_windows_applied: fallbacks
    }
  };
}

function validateLongformHookGuide(hookGuide = {}, durationSec = 0) {
  const safeHookGuide = asPlainObject(hookGuide);
  const hook = safeHookGuide.hook_clip_10s || {};
  assertLongformBasis(hook, 'hook_clip_10s');
  const safeHook = clampLongformHighlightWindow(hook, durationSec, 15) || hook;
  return {
    ...safeHookGuide,
    hook_clip_10s: {
      ...assertWindowDuration(safeHook, { label: 'hook_clip_10s', min: 4, max: 24.5, sourceDurationSec: durationSec }),
      source_time_basis: 'absolute_original_seconds'
    }
  };
}

function validateLongformStoryGuide(storyGuide = {}, hookGuide = {}, durationSec = 0) {
  const safeStoryGuide = asPlainObject(storyGuide);
  const story = safeStoryGuide.story_clip_40s || {};
  assertLongformBasis(story, 'story_clip_40s');
  const normalizedStory = assertWindowDuration(story, { label: 'story_clip_40s', min: 55, max: 65.5, sourceDurationSec: durationSec });
  return {
    ...safeStoryGuide,
    story_clip_40s: {
      ...normalizedStory,
      source_time_basis: 'absolute_original_seconds'
    }
  };
}

function validateLongformMidformGuide(midformGuide = {}, storyGuide = {}, durationSec = 0) {
  const safeMidformGuide = asPlainObject(midformGuide);
  const safeStoryGuide = asPlainObject(storyGuide);
  const midform = safeMidformGuide.midform_clip_120s || {};
  assertLongformBasis(midform, 'midform_clip_120s');
  const normalizedMidform = assertWindowDuration(midform, { label: 'midform_clip_120s', min: 90, max: 135, sourceDurationSec: durationSec });
  // Do not shift Midform because it starts near Highlight. Midform may open with
  // the same strong hook and then expand into a longer process-flow format.
  // Only keep a soft automatic shift away from Full to avoid two long-ish drafts
  // starting at the exact same story point.
  const separatedMidform = startGapTooClose(normalizedMidform, safeStoryGuide.story_clip_40s)
    ? separateWindowStart({
        window: normalizedMidform,
        avoidWindows: [safeStoryGuide.story_clip_40s],
        sourceDurationSec: durationSec,
        durationSec: Math.min(120, Math.max(90, windowDuration(normalizedMidform) || 120)),
        minGapSec: 5
      })
    : normalizedMidform;
  return {
    ...safeMidformGuide,
    midform_clip_120s: {
      ...assertWindowDuration(separatedMidform, { label: 'midform_clip_120s', min: 90, max: 135, sourceDurationSec: durationSec }),
      source_time_basis: 'absolute_original_seconds',
      ...(separatedMidform.start_sec !== normalizedMidform.start_sec
        ? {
            adjusted_from: normalizedMidform,
            adjustment_reason: 'midform_clip_120s started too close to Full; shifted to keep Midform process flow distinct'
          }
        : {})
    }
  };
}

function candidateWindowsToShortformWindows(candidateGuide = {}) {
  const hooks = (candidateGuide.hook_candidates || []).map((candidate, index) => ({
    ...candidate,
    window_id: candidate.window_id || `hook_candidate_${String(index + 1).padStart(2, '0')}`,
    purpose: candidate.purpose || 'visual_hook',
    hook_score: candidate.hook_score || 9,
    process_coverage: candidate.visual_hook || '',
    crop_hint: candidate.crop_hint || '9:16 portrait',
    reason: candidate.reason || ''
  }));
  const stories = (candidateGuide.story_candidates || []).map((candidate, index) => ({
    ...candidate,
    window_id: candidate.window_id || `story_candidate_${String(index + 1).padStart(2, '0')}`,
    purpose: candidate.purpose || 'story_process',
    hook_score: candidate.hook_score || 7,
    process_coverage: candidate.story_flow || '',
    crop_hint: candidate.crop_hint || '9:16 portrait',
    reason: candidate.reason || ''
  }));
  const midforms = (candidateGuide.midform_candidates || []).map((candidate, index) => ({
    ...candidate,
    window_id: candidate.window_id || `midform_candidate_${String(index + 1).padStart(2, '0')}`,
    purpose: candidate.purpose || 'midform_process',
    hook_score: candidate.hook_score || 6,
    process_coverage: candidate.process_flow || '',
    crop_hint: candidate.crop_hint || '9:16 portrait',
    reason: candidate.reason || ''
  }));
  return [...hooks, ...stories, ...midforms];
}

function visibleTextLength(value = '') {
  return [...String(value || '').replace(/\s+/g, '')].length;
}

function isKeywordLikeJapaneseCaption(value = '') {
  const text = normalizeText(value || '').replace(/[、。！？!?\s]/g, '');
  if (!text) return true;
  const length = visibleTextLength(text);
  if (length <= 4) return true;
  if (/(骨格|形成|成形|搬送|装着|自動化|工程|空気注入|固定完了|精密|注入|最終)$/u.test(text)) return true;
  const hasSpokenCue = /(する|なる|いく|走る|動く|入る|流れる|広がる|そろう|揃う|整う|育つ|見える|支える|重なる|変わる|つながる|近づく|作る|運ぶ|押す|固定|確認|加工|回転|注ぐ|切る|曲がる|伸びる|入れて|合わせて|して|れて|って|運び|作り|押し|分かり|でき)/u.test(text);
  const hasParticleFlow = /[をにがでへと]/u.test(text) && length >= 5;
  return !hasSpokenCue && !hasParticleFlow;
}

function isKeywordLikeKoreanCaption(value = '') {
  const text = normalizeText(value || '').replace(/[,.!?！？。\s]/g, '');
  if (!text) return true;
  const length = visibleTextLength(text);
  if (length <= 5) return true;
  if (/(골격|형성|성형|운반|이동|압력|주입|고정완료|정밀자동|자동화공정|공정)$/u.test(text)) return true;
  const hasSpokenCue = /(요|죠|까요|세요|해요|돼요|져요|만드는 중|하는 중|넣고|옮기고|맞춰|고정|정리|확인|흐름|품질|정밀|리듬|움직|쌓|드러나|바뀌|잡혀)/u.test(text);
  const hasParticleFlow = (/[이가은는을를에로]/u.test(text) || /(까지|부터|처럼|하게|부터|마다|쪽으로|안으로|밖으로)/u.test(text)) && length >= 6;
  return !hasSpokenCue && !hasParticleFlow;
}

function isFullScriptNominalLabel(value = '', korean = false) {
  const text = normalizeText(value || '').replace(/[、。！？!?.,\s]/g, '');
  if (!text) return false;
  const length = visibleTextLength(text);
  if (length < 5 || length > (korean ? FULL_CAPTION_SAFE_MAX_CHARS.ko : FULL_CAPTION_SAFE_MAX_CHARS.ja)) {
    return false;
  }
  if (korean) {
    if (/(세요|까요|나요|해요|돼요|져요|합니다|됩니다|입니다|집니다|하고|하며|해서|되며|모으|만들|옮기|넣|잡|고정|확인|지탱|받치|살아|완성)/u.test(text)) {
      return false;
    }
    return /(수확현장|익은열매|열매더미|넓은농장|농장풍경|가득찬트럭|트럭가득|기계차례|장인기술|작업현장|완성품|재료더미|제품더미|공정)$/u.test(text);
  }
  if (/(だろう|です|ます|ました|する|なる|作る|集まり|進み|動き|落ちる|落とし|入り|運び|つかん|掴み|支え|整え|待ち|流し|煮て|重ね|入れ|込|確認|近づき|残し|生まれ|変わり|加わり)/u.test(text)) {
    return false;
  }
  return /(収穫|現場|実の山|農園|風景|トレーラー|工程|素材|材料|機械の出番|職人の技|作業|部品|製品|完成品|場面|景色)$/u.test(text);
}

function isFullScriptNarrationConnector(value = '', korean = false) {
  const text = normalizeText(value || '').replace(/[、。！？!?.,\s]/g, '');
  if (!text) return false;
  if (korean) {
    return /(이건|사실|먼저|여기서|중요한|왜|때문|그래서|흐름|정밀|정확|품질|흔들림|섬세|꼼꼼|정교|사람|기계|힘을|돕고|맞물|연결|결국|이렇게|이과정|소중한|지탱|만듭니다|만들어요|수확해요|작업입니다)/u.test(text);
  }
  return /(実は|これは|ここで|大事|なぜ|だから|ため|ことで|流れ|精度|品質|原料|時期|見極め|傷めず|傷つけ|人が|人の|機械が|機械の|力を|補い|合わさ|連携|支え|残し|作ります|作る作業|集める作業|収穫します|工程です|最後|この)/u.test(text);
}

function isFullScriptActionChecklistLine(value = '', korean = false) {
  const text = normalizeText(value || '').replace(/[、。！？!?.,\s]/g, '');
  if (!text) return false;
  if (isFullScriptNarrationConnector(text, korean)) return false;
  if (korean) {
    return /(떨어진|주워|싣고|실어요|옮겨요|잘라|떨어져|가요|집어|넣고|담고|채워|정리)$/u.test(text);
  }
  return /(拾う|積む|運ぶ|切り|落ちる|落とし|回収|出して|整理|載せる|入れる|掴む|つかむ|掘る|使う|目指す|押し込む|捉える|回していく|削る|引き上げる|捨てる|延長する|探す)$/u.test(text);
}

function hasKoreanSentenceClosure(text = '') {
  return /(?:[.!?！？。]|요|죠|예요|이에요|해요|돼요|합니다|됩니다|입니다|집니다|니다|까|네요|군요|어요|아요|다)$/u.test(normalizeText(text));
}

function hasKoreanSentencePredicateSignal(text = '') {
  return /(?:요|죠|예요|이에요|해요|돼요|합니다|됩니다|입니다|집니다|니다|까|네요|군요|어요|아요|다|하고|되어|되고|맞추|세우|얹|쌓|만들|열|확인|결정|영향|중요|시작|완성|이어|잡|고정|지탱|버티|달라지|흔들리|맞물리)/u.test(normalizeText(text));
}

function koreanFullDraftStyleViolations(texts = []) {
  const normalizedTexts = (Array.isArray(texts) ? texts : [])
    .map((text) => normalizeText(text || ''));
  const exactBannedOpening = /^이게\s*뭔지\s*아세요\??$/u.test(normalizedTexts[0] || '')
    ? normalizedTexts[0]
    : '';
  const reportStyleEndings = normalizedTexts
    .map((text, index) => ({ text, index }))
    .filter(({ text }) => /(?:함|됨)[.!?！？。]*$/u.test(text));

  const consecutiveHamNidaRuns = [];
  let runStart = -1;
  let runItems = [];
  normalizedTexts.forEach((text, index) => {
    if (/합니다[.!?！？。]*$/u.test(text)) {
      if (runStart < 0) runStart = index;
      runItems.push({ text, index });
      return;
    }
    if (runItems.length >= 3) {
      consecutiveHamNidaRuns.push({ start: runStart, items: runItems });
    }
    runStart = -1;
    runItems = [];
  });
  if (runItems.length >= 3) {
    consecutiveHamNidaRuns.push({ start: runStart, items: runItems });
  }

  const decorativeOnlyRuns = [];
  const isDecorativeOnly = (text = '') => {
    const value = normalizeText(text);
    if (!/(정성껏|섬세한|섬세하게|거침없이|반짝이는|반짝이게|완벽한|놀라운|신기한|아름다운|최고의)/u.test(value)) return false;
    const hasWhyRiskOrNumber = /(?:왜|이유|때문|중요|실수|건너뛰|틀어지|흔들리|깨지|위험|리스크|오차|\d|[0-9０-９]+|한 번|두 번|세 번|몇 밀리|몇 초|도|kg|g|mm|cm|℃)/iu.test(value);
    return !hasWhyRiskOrNumber;
  };
  let decorativeStart = -1;
  let decorativeItems = [];
  normalizedTexts.forEach((text, index) => {
    if (isDecorativeOnly(text)) {
      if (decorativeStart < 0) decorativeStart = index;
      decorativeItems.push({ text, index });
      return;
    }
    if (decorativeItems.length >= 2) {
      decorativeOnlyRuns.push({ start: decorativeStart, items: decorativeItems });
    }
    decorativeStart = -1;
    decorativeItems = [];
  });
  if (decorativeItems.length >= 2) {
    decorativeOnlyRuns.push({ start: decorativeStart, items: decorativeItems });
  }

  const sentenceEndinglessRuns = [];
  let endinglessStart = -1;
  let endinglessItems = [];
  normalizedTexts.forEach((text, index) => {
    if (text && !hasKoreanSentenceClosure(text)) {
      if (endinglessStart < 0) endinglessStart = index;
      endinglessItems.push({ text, index });
      return;
    }
    if (endinglessItems.length >= 3) {
      sentenceEndinglessRuns.push({ start: endinglessStart, items: endinglessItems });
    }
    endinglessStart = -1;
    endinglessItems = [];
  });
  if (endinglessItems.length >= 3) {
    sentenceEndinglessRuns.push({ start: endinglessStart, items: endinglessItems });
  }

  const weakSentenceGroups = [];
  let currentGroupStart = -1;
  let currentGroupItems = [];
  normalizedTexts.forEach((text, index) => {
    if (!text) return;
    if (currentGroupStart < 0) currentGroupStart = index;
    currentGroupItems.push({ text, index });
    if (!hasKoreanSentenceClosure(text)) return;
    const groupHasPredicate = currentGroupItems.some((item) => hasKoreanSentencePredicateSignal(item.text));
    if (currentGroupItems.length >= 2 && !groupHasPredicate) {
      weakSentenceGroups.push({ start: currentGroupStart, items: currentGroupItems });
    }
    currentGroupStart = -1;
    currentGroupItems = [];
  });
  if (currentGroupItems.length >= 2) {
    const groupHasPredicate = currentGroupItems.some((item) => hasKoreanSentencePredicateSignal(item.text));
    if (!groupHasPredicate) {
      weakSentenceGroups.push({ start: currentGroupStart, items: currentGroupItems });
    }
  }

  return {
    exactBannedOpening,
    reportStyleEndings,
    consecutiveHamNidaRuns,
    decorativeOnlyRuns,
    sentenceEndinglessRuns,
    weakSentenceGroups
  };
}

function collectKoreanFullRepairGateIssues(scriptItems = []) {
  const lines = Array.isArray(scriptItems) ? scriptItems : [];
  const texts = lines.map((item) => normalizeText(item?.text || item || '')).filter(Boolean);
  if (lines.length < 20) {
    return [{ reason: 'repair output must contain at least 20 Korean Full caption items', value: { count: lines.length, preview: texts.slice(0, 8) } }];
  }
  const style = koreanFullDraftStyleViolations(texts);
  const issues = [];
  if (style.reportStyleEndings.length) {
    issues.push({ reason: 'repair output contains forbidden report-style endings (~함/~됨)', value: style.reportStyleEndings.map((item) => item.text) });
  }
  if (style.consecutiveHamNidaRuns.length) {
    issues.push({ reason: 'repair output contains three consecutive 합니다 endings', value: style.consecutiveHamNidaRuns.map((run) => run.items.map((item) => item.text)) });
  }
  if (style.decorativeOnlyRuns.length) {
    issues.push({ reason: 'repair output contains decorative-only runs', value: style.decorativeOnlyRuns.map((run) => run.items.map((item) => item.text)) });
  }
  if (style.sentenceEndinglessRuns.length) {
    issues.push({ reason: 'repair output contains three or more consecutive non-sentence fragments', value: style.sentenceEndinglessRuns.map((run) => run.items.map((item) => item.text)) });
  }
  if (style.weakSentenceGroups.length) {
    issues.push({ reason: 'repair output contains pseudo-sentence groups made only of fragments or noun labels', value: style.weakSentenceGroups.map((run) => run.items.map((item) => item.text)) });
  }
  return issues;
}

function isKoreanFullScriptStyleRegenerationIssue(issue = {}) {
  const field = normalizeText(issue?.field || '');
  return issue?.style_regeneration_required === true
    && (field === 'full_caption_script_ko' || field.startsWith('full_caption_script_ko['));
}

function koreanSubjectTokens(value = '') {
  return normalizeText(value || '')
    .replace(/[#＃][A-Za-z0-9_-]+/gu, ' ')
    .split(/[^가-힣A-Za-z0-9]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !/^(과정|공정|작업|제작|제조|영상|핵심|장면|비밀|정밀|완벽|사용|도구|부품)$/u.test(token))
    .slice(0, 8);
}

function hasHookPayoff({ texts = [], detectedSubject = '', metadata = {} } = {}) {
  const normalizedTexts = (Array.isArray(texts) ? texts : []).map((text) => normalizeText(text || ''));
  const opening = normalizedTexts[0] || '';
  if (!/[?？]|뭔지|무엇|뭘까|정체|처음엔|처음에는|보이/u.test(opening)) return true;
  const subjectTokens = koreanSubjectTokens([
    detectedSubject,
    metadata?.upload_title,
    metadata?.short_description,
    metadata?.summary_caption
  ].filter(Boolean).join(' '));
  if (!subjectTokens.length) return /(만들|제작|공정|제품|부품|재료|도구|형태|완성|쓰임|역할)/u.test(normalizedTexts.slice(1).join(' '));
  const payoffText = normalizedTexts.slice(1).join(' ');
  return subjectTokens.some((token) => payoffText.includes(token));
}

function isUnseenResultClaimCaption(value = '', korean = false) {
  const text = normalizeText(value || '').replace(/[、。！？!?.,\s]/g, '');
  if (!text) return false;
  if (korean) {
    return /(물이솟|물이흘|수맥에도달|수맥으로이어|대지를적시|은혜로이어|완전히완성|완성품이나오)/u.test(text);
  }
  return /(水が出る|水が湧|水脈へ届|水脈につなが|水脈へ進|大地を潤|恵みへ繋|恵みにつなが|完全に完成|完成品になる)/u.test(text);
}

function isStiffJapaneseScreenCaption(value = '') {
  const text = normalizeText(value || '');
  if (!text) return true;
  if (visibleTextLength(text) > 20) return true;
  if (isKeywordLikeJapaneseCaption(text)) return true;
  return /(一連の|されるまでの|プロセスを示|工程を示|自動化されたプロセス|様子が映し出|実行されます|組み付けられるまで)/u.test(text);
}

function isStiffKoreanScreenCaption(value = '') {
  const text = normalizeText(value || '');
  if (!text) return true;
  if (visibleTextLength(text) > 20) return true;
  if (isKeywordLikeKoreanCaption(text)) return true;
  return /(일련의|공정을 보여줍니다|과정을 보여줍니다|자동화된 공정|수행됩니다|고정되는 모습|제조되어|조립되는)/u.test(text);
}

function hasLongLatinWord(value = '') {
  const textWithoutHashtags = normalizeText(value || '')
    .replace(/#[A-Za-z0-9_]+/gu, '')
    .replace(/\b(?:4K|3D)\b/giu, '');
  return /[A-Za-z]{2,}/u.test(textWithoutHashtags);
}

function stripHashtagsForLanguageValidation(value = '') {
  return normalizeText(value || '')
    .replace(/[#＃][\p{L}\p{N}_-]+/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function collectJapaneseCaptionIssues(guide = {}, options = {}) {
  const issues = [];
  const includeFull = options.includeFull !== false;
  const includeHighlight = options.includeHighlight !== false;
  const includeMidform = options.includeMidform !== false;
  const includeScenes = options.includeScenes !== false;
  const includeJapanese = options.includeJapanese !== false;
  const includeJapaneseFull = includeJapanese && options.includeJapaneseFull === true;
  const includeKorean = options.includeKorean === true;
  const strictHighlightMetadata = options.strictHighlightMetadata !== false;
  const requireJapaneseField = (field, value) => {
    const validationValue = /(?:recommended_titles\[\d+\]\.title|upload_title)$/u.test(field)
      ? stripHashtagsForLanguageValidation(value)
      : normalizeText(value || '');
    if (!isValidJapaneseCaption(validationValue) || hasLongLatinWord(validationValue)) {
      issues.push({
        scene_id: 'metadata',
        field,
        value: normalizeText(value || ''),
        reason: `${field} must be natural Japanese, not English or empty`
      });
    }
  };
  const requireKoreanField = (field, value) => {
    const validationValue = /(?:recommended_titles\[\d+\]\.title|upload_title)$/u.test(field)
      ? stripHashtagsForLanguageValidation(value)
      : normalizeText(value || '');
    if (!isValidKoreanCaption(validationValue) || hasLongLatinWord(validationValue)) {
      issues.push({
        scene_id: 'metadata',
        field,
        value: normalizeText(value || ''),
        reason: `${field} must be natural Korean, not English or empty`
      });
    }
  };

  if (includeJapaneseFull && includeFull) {
    [
      'short_description_200',
      'explainer_text'
    ].forEach((field) => requireJapaneseField(field, guide?.[field]));
  }
  if (includeJapanese && includeHighlight) {
    requireJapaneseField('highlight_explainer_text', guide?.highlight_explainer_text);
  }
  if (includeKorean && includeFull) {
    [
      'short_description_ko',
      'explainer_text_ko'
    ].forEach((field) => requireKoreanField(field, guide?.[field]));
  }
  if (includeKorean && includeHighlight) {
    requireKoreanField('highlight_explainer_text_ko', guide?.highlight_explainer_text_ko);
  }

  const validateMetadataSubtitles = (section, metadata, korean = false) => {
    const lines = Array.isArray(metadata.onscreen_subtitles) ? metadata.onscreen_subtitles : [];
    const hasBlock = typeof metadata.onscreen_caption_block === 'string' && metadata.onscreen_caption_block.trim();
    if (metadata.caption_mode !== 'scene_based_short_subtitles' || hasBlock || lines.length < 3) {
      issues.push({
        scene_id: 'metadata',
        field: `${section}.onscreen_subtitles`,
        value: lines,
        reason: 'full metadata must use scene_based_short_subtitles and an array of short screen captions, not one long caption block'
      });
      return;
    }
    if (/^full_metadata/u.test(section)) {
      return;
    }
    lines.forEach((line, index) => {
      const normalized = normalizeText(line || '');
      const tooLong = visibleTextLength(normalized) > (korean ? FULL_CAPTION_SAFE_MAX_CHARS.ko : FULL_CAPTION_SAFE_MAX_CHARS.ja);
      const invalid = korean
        ? (!isValidKoreanCaption(normalized) || isStiffKoreanScreenCaption(normalized) || looksLikeParagraphCaption(normalized, true))
        : (!isValidJapaneseCaption(normalized) || isStiffJapaneseScreenCaption(normalized) || isBrokenJapaneseScreenPhrase(normalized) || looksLikeParagraphCaption(normalized, false));
      if (invalid || tooLong) {
        issues.push({
          scene_id: 'metadata',
          field: `${section}.onscreen_subtitles[${index}]`,
          value: normalized,
          reason: `metadata onscreen_subtitles must be short spoken screen captions within ${korean ? FULL_CAPTION_SAFE_MAX_CHARS.ko : FULL_CAPTION_SAFE_MAX_CHARS.ja} visible characters; summary paragraphs belong in summary_caption or report_description`
        });
      }
    });
  };

  const validateHighlightCaptionBlock = (section, metadata, korean = false, minLength = 120) => {
    const block = normalizeText(metadata.onscreen_caption_block || '');
    const len = [...block].length;
    const invalidLanguage = korean ? !isValidKoreanCaption(block) : !isValidJapaneseCaption(block);
    if (
      metadata.caption_mode !== 'long_bottom_explainer' ||
      !block ||
      len < minLength ||
      len > 340 ||
      invalidLanguage
    ) {
      issues.push({
        scene_id: 'metadata',
        field: `${section}.onscreen_caption_block`,
        value: block,
        reason: 'highlight metadata must use one natural long_bottom_explainer caption block and must not use scene subtitle arrays'
      });
    }
  };

  const validateFullCaptionScript = (field, script, korean = false, options = {}) => {
    const lines = Array.isArray(script) ? script : [];
    const isMidform = options.variant === 'midform';
    const minimum = Number(options.minimum) > 0 ? Number(options.minimum) : (isMidform ? 8 : 20);
    if (lines.length < minimum) {
      issues.push({
        scene_id: 'metadata',
        field,
        value: lines,
        reason: isMidform
          ? `Midform must include at least ${minimum} ordered captions for the longer process flow; 120-second drafts cannot be summarized into a few labels`
          : 'Full Draft must include an ordered process narration script of short screen phrases, not only scene labels'
      });
      return;
    }
    if (korean && !isMidform && field === 'full_caption_script_ko') {
      const validSceneIds = sceneTransitionIdSet(guide);
      const invalidExplicitSceneIds = lines
        .map((item, index) => ({ index, scene_id: normalizeText(item?.scene_id || '') }))
        .filter((item) => item.scene_id && !isLegacyScriptSceneId(item.scene_id) && validSceneIds.size && !validSceneIds.has(item.scene_id));
      const missingSceneIds = lines
        .map((item, index) => ({ index, scene_id: normalizeText(item?.scene_id || '') }))
        .filter((item) => !item.scene_id);
      if (invalidExplicitSceneIds.length || missingSceneIds.length) {
        issues.push({
          scene_id: 'metadata',
          field,
          value: {
            invalid_scene_ids: invalidExplicitSceneIds.map((item) => ({ index: item.index + 1, scene_id: item.scene_id })),
            missing_scene_ids: missingSceneIds.map((item) => ({ index: item.index + 1 })),
            allowed_scene_ids: [...validSceneIds]
          },
          reason: 'Korean Full caption script scene_id must be an existing scene_transitions ID such as scene_01. Legacy script_### IDs are allowed only as non-anchored fallback data.',
          style_regeneration_required: true,
          issue_type: 'ko_full_invalid_anchor_scene_id'
        });
      }
    }
    const texts = lines.map((item) => normalizeText(item?.text || item || '')).filter(Boolean);
    const roles = lines.map((item) => normalizeText(item?.role || '')).filter(Boolean);
    const joinedEarly = texts.slice(0, 5).join(' ');
    const joinedAll = texts.join(' ');
    const hookOk = korean
      ? Boolean(texts[0]) && !/^이게\s*뭔지\s*아세요\??$/u.test(texts[0] || '')
      : /(何|なん|これ)/u.test(texts[0] || '');
    const identityOk = korean
      ? /(공정|작업|만들|제조|완성|형태|제품|재료)/u.test(joinedEarly)
      : /(工程|作|作り|作って|製造|完成|形|素材|材料)/u.test(joinedEarly);
    const technicalOk = korean
      ? /(단계|기준|품질|정밀|압력|속도|기계|작업자|형태|고정|다듬|건조|가공)/u.test(joinedAll)
      : /(段階|基準|品質|精度|力|機械|職人|形|固定|整え|乾燥|加工|材料|素材)/u.test(joinedAll);
    const closingOk = korean
      ? /(완성|품질|정밀|손기술|반복|쌓|결국|마무리|완성도)/u.test(texts.slice(-2).join(' '))
      : /(完成|品質|精度|職人|積み重ね|仕上がり|つながる|近づく|支える|残る|宿る|光る|目前|完成へ|反復|技)/u.test(texts.slice(-2).join(' '));
    const hasPurposeRole = roles.some((role) => ['hook', 'process_purpose', 'identity', 'technical_context'].includes(role));
    const hasEmotionRole = roles.some((role) => ['emotional_expression', 'quality_reason', 'closing'].includes(role));
    const sceneRoleCount = roles.filter((role) => role === 'scene_observation').length;
    const sceneRoleRatio = roles.length ? sceneRoleCount / roles.length : 0;
    const looksLikeIndependentLabelCaption = (text = '') => {
      const normalized = normalizeText(text);
      if (!normalized) return false;
      return korean
        ? /[가-힣]+(?:을|를|이|가|은|는)\s*[가-힣]+(?:합니다|됩니다|집니다|시킵니다)$/u.test(normalized)
        : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+(?:が|を|は|に)\s*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+(?:ます|です|されます|なります|します)$/u.test(normalized);
    };
    let maxIndependentLabelRun = 0;
    let currentIndependentLabelRun = 0;
    texts.forEach((text) => {
      if (looksLikeIndependentLabelCaption(text)) {
        currentIndependentLabelRun += 1;
        maxIndependentLabelRun = Math.max(maxIndependentLabelRun, currentIndependentLabelRun);
      } else {
        currentIndependentLabelRun = 0;
      }
    });
    const nominalLabelTexts = texts.filter((text) => isFullScriptNominalLabel(text, korean));
    const nominalLabelRatio = texts.length ? nominalLabelTexts.length / texts.length : 0;
    const narrationConnectorCount = texts.filter((text) => isFullScriptNarrationConnector(text, korean)).length;
    const actionChecklistTexts = texts.filter((text) => isFullScriptActionChecklistLine(text, korean));
    const unseenResultClaimTexts = texts.filter((text) => isUnseenResultClaimCaption(text, korean));
    const koreanStyleViolations = korean && !isMidform
      ? koreanFullDraftStyleViolations(texts)
      : { exactBannedOpening: '', reportStyleEndings: [], consecutiveHamNidaRuns: [], decorativeOnlyRuns: [], sentenceEndinglessRuns: [] };
    const hookPayoffOk = !korean || isMidform || hasHookPayoff({
      texts,
      detectedSubject: guide?.detected_subject || '',
      metadata: guide?.full_metadata_ko || {}
    });
    const koreanSpeechBudget = korean && !isMidform
      ? koreanFullSpeechBudgetFromGuide(guide, options.durationSec || guide?.duration_sec || guide?.target_duration_sec || 0)
      : null;
    const koreanVisibleCharCount = korean && !isMidform ? countKoreanVisibleCharsNoSpaces(texts.join('')) : 0;
    const sceneRoleRatioOk = isMidform
      ? sceneRoleCount >= 5 && sceneRoleRatio <= 0.7
      : korean
        ? sceneRoleRatio <= 0.5
        : sceneRoleCount >= 3 && sceneRoleCount <= 6;
    const missingArcCount = [hookOk, identityOk, technicalOk, closingOk, hasPurposeRole, hasEmotionRole, sceneRoleRatioOk].filter((ok) => !ok).length;
    if (!sceneRoleRatioOk) {
      issues.push({
        scene_id: 'metadata',
        field,
        value: lines.map((item, index) => ({ index: index + 1, role: normalizeText(item?.role || ''), text: normalizeText(item?.text || item || '') })),
        reason: isMidform
          ? 'Midform scene_observation captions must be spread through the process flow without turning every caption into a bare scene label'
          : korean
            ? 'Korean Full Draft uses too many scene_observation roles. Role counts are not a target; rewrite visible beats as sentence-based narration when needed.'
            : 'Full Draft scene_observation must be limited to about 4-6 scene mentions in a 20-24 caption script; do not turn the whole script into scene-by-scene captions'
      });
    }
    if (missingArcCount >= 3) {
      issues.push({
        scene_id: 'metadata',
        field,
        value: texts,
        reason: 'Full Draft script must follow hook -> process purpose -> technical explanation -> scene mentions around 25/50/75 percent -> emotional closing'
      });
    }
    if (!isMidform && maxIndependentLabelRun >= 3) {
      issues.push({
        scene_id: 'metadata',
        field,
        value: texts,
        reason: 'Full Draft script reads like consecutive independent scene labels. Rewrite as one connected spoken process script split into short captions.'
      });
    }
    if (!isMidform && (nominalLabelTexts.length >= 3 || nominalLabelRatio > 0.25)) {
      issues.push({
        scene_id: 'metadata',
        field,
        value: nominalLabelTexts,
        reason: korean
          ? 'Full Draft script still contains too many noun-label captions. Rewrite labels as connected spoken process narration.'
          : 'Full Draft script still contains too many noun-label captions such as process tags or visual labels. Rewrite them as connected spoken narration.'
      });
    }
    if (!isMidform && narrationConnectorCount < 3) {
      issues.push({
        scene_id: 'metadata',
        field,
        value: texts,
        reason: 'Full Draft script does not contain enough narrator/explanation connector lines. First write a spoken manuscript, then split it into captions.'
      });
    }
    if (!isMidform && actionChecklistTexts.length >= 5) {
      issues.push({
        scene_id: 'metadata',
        field,
        value: actionChecklistTexts,
        reason: 'Full Draft script reads like a visible-action checklist. Add purpose, method, quality reason, and emotional meaning between scene actions.'
      });
    }
    if (!isMidform && unseenResultClaimTexts.length) {
      issues.push({
        scene_id: 'metadata',
        field,
        value: unseenResultClaimTexts,
        reason: 'Full Draft script claims a final result that may not be visible in the selected clip. Describe unseen results only as purpose or goal.'
      });
    }
    if (koreanStyleViolations.exactBannedOpening) {
      issues.push({
        scene_id: 'metadata',
        field,
        value: koreanStyleViolations.exactBannedOpening,
        reason: 'Korean Full Draft opening uses the banned exact phrase "이게 뭔지 아세요?". Use the assigned hook type with a fresh sentence.',
        style_regeneration_required: true,
        issue_type: 'ko_full_banned_exact_opening'
      });
    }
    if (!hookPayoffOk) {
      issues.push({
        scene_id: 'metadata',
        field,
        value: texts.slice(0, 8),
        reason: 'Korean Full Draft opens a curiosity loop but does not reveal the object/product/material name later. A question hook must be answered inside the script.',
        style_regeneration_required: true,
        issue_type: 'ko_full_hook_without_payoff'
      });
    }
    if (koreanSpeechBudget && koreanVisibleCharCount > koreanSpeechBudget.max_chars) {
      issues.push({
        scene_id: 'metadata',
        field,
        value: {
          char_count: koreanVisibleCharCount,
          max_chars: koreanSpeechBudget.max_chars,
          target_chars: koreanSpeechBudget.target_chars,
          estimated_speech_sec: roundSeconds(koreanVisibleCharCount / KOREAN_FULL_SPEECH_CHARS_PER_SEC),
          budget: koreanSpeechBudget,
          texts
        },
        reason: `Korean Full Draft script exceeds the speech budget (${koreanVisibleCharCount}/${koreanSpeechBudget.max_chars} Korean visible chars). Regenerate the narration shorter so TTS can fit the video timeline.`,
        style_regeneration_required: true,
        issue_type: 'ko_full_speech_budget_over'
      });
    }
    if (koreanSpeechBudget && koreanVisibleCharCount < koreanSpeechBudget.min_chars) {
      issues.push({
        scene_id: 'metadata',
        field,
        value: {
          char_count: koreanVisibleCharCount,
          min_chars: koreanSpeechBudget.min_chars,
          target_chars: koreanSpeechBudget.target_chars,
          estimated_speech_sec: roundSeconds(koreanVisibleCharCount / KOREAN_FULL_SPEECH_CHARS_PER_SEC),
          budget: koreanSpeechBudget,
          texts
        },
        reason: `Korean Full Draft script is below 75% of the speech budget (${koreanVisibleCharCount}/${koreanSpeechBudget.min_chars} Korean visible chars). Regenerate with enough narration for the video length.`,
        style_regeneration_required: true,
        issue_type: 'ko_full_speech_budget_under'
      });
    }
    if (koreanStyleViolations.reportStyleEndings.length) {
      issues.push({
        scene_id: 'metadata',
        field,
        value: koreanStyleViolations.reportStyleEndings.map((item) => ({ index: item.index + 1, text: item.text })),
        reason: 'Korean Full Draft script contains forbidden report-style endings (~함/~됨). Regenerate the Korean narration once from scene references instead of repairing individual words.',
        style_regeneration_required: true,
        issue_type: 'ko_full_report_style_ending'
      });
    }
    if (koreanStyleViolations.consecutiveHamNidaRuns.length) {
      issues.push({
        scene_id: 'metadata',
        field,
        value: koreanStyleViolations.consecutiveHamNidaRuns.map((run) => ({
          start_index: run.start + 1,
          texts: run.items.map((item) => item.text)
        })),
        reason: 'Korean Full Draft script has three consecutive captions ending in 합니다. Regenerate the Korean narration once with a more natural spoken rhythm.',
        style_regeneration_required: true,
        issue_type: 'ko_full_consecutive_hamnida'
      });
    }
    if (koreanStyleViolations.decorativeOnlyRuns.length) {
      issues.push({
        scene_id: 'metadata',
        field,
        value: koreanStyleViolations.decorativeOnlyRuns.map((run) => ({
          start_index: run.start + 1,
          texts: run.items.map((item) => item.text)
        })),
        reason: 'Korean Full Draft has two or more consecutive decorative-only lines. Replace ornament with a reason, risk, or concrete number.',
        style_regeneration_required: true,
        issue_type: 'ko_full_consecutive_decorative_lines'
      });
    }
    if (koreanStyleViolations.sentenceEndinglessRuns.length) {
      issues.push({
        scene_id: 'metadata',
        field,
        value: koreanStyleViolations.sentenceEndinglessRuns.map((run) => ({
          start_index: run.start + 1,
          texts: run.items.map((item) => item.text)
        })),
        reason: 'Korean Full Draft has three or more consecutive fragments without sentence-closing endings. Rewrite as human Korean sentences, not noun-phrase listing.',
        style_regeneration_required: true,
        issue_type: 'ko_full_consecutive_non_sentence_fragments'
      });
    }
    if (koreanStyleViolations.weakSentenceGroups.length) {
      issues.push({
        scene_id: 'metadata',
        field,
        value: koreanStyleViolations.weakSentenceGroups.map((run) => ({
          start_index: run.start + 1,
          texts: run.items.map((item) => item.text)
        })),
        reason: 'Korean Full Draft contains pseudo-sentence groups made only of fragments or noun labels. Each grouped sentence must contain a real predicate or spoken conclusion.',
        style_regeneration_required: true,
        issue_type: 'ko_full_weak_sentence_group'
      });
    }
    const formalEndingCount = texts.filter((text) => (
      korean
        ? /(입니다|습니다|됩니다|집니다|합니다)$/u.test(text)
        : /(です|ます|ました|されます|なります|します)$/u.test(text)
    )).length;
    if (formalEndingCount > Math.max(2, Math.floor(texts.length * 0.25))) {
      issues.push({
        scene_id: 'metadata',
        field,
        value: texts,
        reason: korean
          ? 'Full Draft script repeats stiff formal endings too often. Avoid 입니다/습니다/됩니다/집니다 rhythm and use short screen phrases.'
          : 'Full Draft script repeats stiff polite endings too often. Avoid です/ます/されます/なります rhythm and use short screen phrases.'
      });
    }
    texts.forEach((text, index) => {
      const allowConnectedJapaneseFragment = !korean
        && index < texts.length - 1
        && visibleTextLength(text) >= 3
        && /(?:を|が|で|に|へ|と|へと)$/u.test(text);
      const invalid = korean
        ? !isValidKoreanCaption(text)
        : ((!isValidJapaneseCaption(text) && !allowConnectedJapaneseFragment) || (isBrokenJapaneseScreenPhrase(text) && !allowConnectedJapaneseFragment));
      const tooLong = visibleTextLength(text) > (korean ? FULL_CAPTION_SAFE_MAX_CHARS.ko : FULL_CAPTION_SAFE_MAX_CHARS.ja);
      if (invalid || tooLong) {
        issues.push({
          scene_id: 'metadata',
          field: `${field}[${index}].text`,
          value: text,
          reason: `Full Draft script text must fit the safe caption box limit (${korean ? FULL_CAPTION_SAFE_MAX_CHARS.ko : FULL_CAPTION_SAFE_MAX_CHARS.ja} visible characters), not a bare scene label, broken Japanese fragment, long sentence, or English fallback`
        });
      }
    });
  };

  if (includeJapaneseFull && includeFull) {
    validateFullCaptionScript('full_caption_script_ja', guide.full_caption_script_ja, false);
  }
  if (includeJapanese && includeMidform) {
    if (isLongformGuide(guide) && normalizeWindow(guide.midform_clip_120s)) {
      const midformDuration = windowDuration(normalizeWindow(guide.midform_clip_120s) || normalizeWindow(guide.recommended_midform_window));
      validateFullCaptionScript('midform_caption_script_ja', guide.midform_caption_script_ja, false, {
        variant: 'midform',
        minimum: midformCaptionMinimumForDuration(midformDuration)
      });
    }
  }
  if (includeKorean && includeFull) {
    validateFullCaptionScript('full_caption_script_ko', guide.full_caption_script_ko, true);
  }
  if (includeKorean && includeMidform) {
    if (isLongformGuide(guide) && normalizeWindow(guide.midform_clip_120s)) {
      const midformDuration = windowDuration(normalizeWindow(guide.midform_clip_120s) || normalizeWindow(guide.recommended_midform_window));
      validateFullCaptionScript('midform_caption_script_ko', guide.midform_caption_script_ko, true, {
        variant: 'midform',
        minimum: midformCaptionMinimumForDuration(midformDuration)
      });
    }
  }

  if (includeJapaneseFull && includeFull) ['full_metadata'].forEach((section) => {
    const metadata = guide?.[section] || {};
    requireJapaneseField(`${section}.short_description`, metadata.short_description);
    requireJapaneseField(`${section}.summary_caption`, metadata.summary_caption);
    requireJapaneseField(`${section}.report_description`, metadata.report_description);
    requireJapaneseField(`${section}.upload_title`, metadata.upload_title);
    validateMetadataSubtitles(section, metadata, false);
    const titles = Array.isArray(metadata.recommended_titles) ? metadata.recommended_titles : [];
    titles.forEach((item, index) => requireJapaneseField(`${section}.recommended_titles[${index}].title`, item?.title));
  });
  if (includeJapanese && includeMidform && isLongformGuide(guide) && normalizeWindow(guide.midform_clip_120s)) ['midform_metadata'].forEach((section) => {
    const metadata = guide[section] || {};
    if (!metadata.upload_title || !hasJapaneseText(metadata.upload_title)) {
      issues.push({ scene_id: 'metadata', field: `${section}.upload_title`, reason: 'missing_japanese_upload_title' });
    }
    if (!metadata.report_description || !hasJapaneseText(metadata.report_description)) {
      issues.push({ scene_id: 'metadata', field: `${section}.report_description`, reason: 'missing_japanese_report_description' });
    }
    if (Array.isArray(metadata.onscreen_subtitles)) {
      metadata.onscreen_subtitles.forEach((line, index) => {
        const text = normalizeText(line || '');
        if (!isValidJapaneseCaption(text)) issues.push({ scene_id: 'metadata', field: `${section}.onscreen_subtitles[${index}]`, reason: 'invalid_japanese_midform_subtitle', text });
      });
    }
  });

  if (includeJapanese && includeHighlight) ['highlight_metadata'].forEach((section) => {
    const metadata = guide?.[section] || {};
    if (strictHighlightMetadata) {
      requireJapaneseField(`${section}.short_description`, metadata.short_description);
      requireJapaneseField(`${section}.summary_caption`, metadata.summary_caption);
      requireJapaneseField(`${section}.report_description`, metadata.report_description);
      requireJapaneseField(`${section}.upload_title`, metadata.upload_title);
      validateHighlightCaptionBlock(section, metadata, false);
      const titles = Array.isArray(metadata.recommended_titles) ? metadata.recommended_titles : [];
      titles.forEach((item, index) => requireJapaneseField(`${section}.recommended_titles[${index}].title`, item?.title));
    } else {
      const fallbackBlock = metadata.onscreen_caption_block
        || guide.highlight_explainer_text
        || (Array.isArray(guide.highlight_hook_captions_ja) ? guide.highlight_hook_captions_ja.join(' ') : '')
        || guide.short_description_200
        || guide.explainer_text
        || '';
      validateHighlightCaptionBlock(section, {
        caption_mode: 'long_bottom_explainer',
        onscreen_caption_block: fallbackBlock,
        onscreen_subtitles: []
      }, false, 40);
    }
  });
  if (includeKorean && includeFull) ['full_metadata_ko'].forEach((section) => {
    const metadata = guide?.[section] || {};
    requireKoreanField(`${section}.short_description`, metadata.short_description);
    requireKoreanField(`${section}.summary_caption`, metadata.summary_caption);
    requireKoreanField(`${section}.report_description`, metadata.report_description);
    requireKoreanField(`${section}.upload_title`, metadata.upload_title);
    validateMetadataSubtitles(section, metadata, true);
    const titles = Array.isArray(metadata.recommended_titles) ? metadata.recommended_titles : [];
    titles.forEach((item, index) => requireKoreanField(`${section}.recommended_titles[${index}].title`, item?.title));
  });
  if (includeKorean && includeMidform && isLongformGuide(guide) && normalizeWindow(guide.midform_clip_120s)) ['midform_metadata_ko'].forEach((section) => {
    const metadata = guide[section] || {};
    if (!metadata.upload_title || !hasKoreanText(metadata.upload_title)) {
      issues.push({ scene_id: 'metadata', field: `${section}.upload_title`, reason: 'missing_korean_review_upload_title' });
    }
    if (!metadata.report_description || !hasKoreanText(metadata.report_description)) {
      issues.push({ scene_id: 'metadata', field: `${section}.report_description`, reason: 'missing_korean_review_report_description' });
    }
  });

  if (includeKorean && includeHighlight) ['highlight_metadata_ko'].forEach((section) => {
    const metadata = guide?.[section] || {};
    if (strictHighlightMetadata) {
      requireKoreanField(`${section}.short_description`, metadata.short_description);
      requireKoreanField(`${section}.summary_caption`, metadata.summary_caption);
      requireKoreanField(`${section}.report_description`, metadata.report_description);
      requireKoreanField(`${section}.upload_title`, metadata.upload_title);
      validateHighlightCaptionBlock(section, metadata, true);
      const titles = Array.isArray(metadata.recommended_titles) ? metadata.recommended_titles : [];
      titles.forEach((item, index) => requireKoreanField(`${section}.recommended_titles[${index}].title`, item?.title));
    } else {
      const fallbackBlock = metadata.onscreen_caption_block
        || guide.highlight_explainer_text_ko
        || (Array.isArray(guide.highlight_hook_captions_ko) ? guide.highlight_hook_captions_ko.join(' ') : '')
        || guide.short_description_ko
        || guide.explainer_text_ko
        || '';
      validateHighlightCaptionBlock(section, {
        caption_mode: 'long_bottom_explainer',
        onscreen_caption_block: fallbackBlock,
        onscreen_subtitles: []
      }, true, 40);
    }
  });

  const scenes = includeScenes ? (Array.isArray(guide.scene_transitions) ? guide.scene_transitions : []) : [];
  scenes.forEach((scene, index) => {
    const sceneId = scene?.scene_id || `scene_${String(index + 1).padStart(3, '0')}`;
    if (!isValidJapaneseCaption(scene?.caption_text)) {
      issues.push({
        scene_id: sceneId,
        field: 'caption_text',
        value: normalizeText(scene?.caption_text || ''),
        reason: 'caption_text must be natural Japanese, not English or empty'
      });
    }
    const captions = Array.isArray(scene?.screen_captions_ja) ? scene.screen_captions_ja : [];
    if (!captions.length) {
      issues.push({
        scene_id: sceneId,
        field: 'screen_captions_ja',
        value: [],
        reason: 'screen_captions_ja must contain at least one natural Japanese caption'
      });
      return;
    }
    captions.forEach((caption, captionIndex) => {
      if (!isValidJapaneseCaption(caption)) {
        issues.push({
          scene_id: sceneId,
          field: `screen_captions_ja[${captionIndex}]`,
          value: normalizeText(caption || ''),
          reason: 'screen_captions_ja must be natural Japanese, not English or empty'
        });
      }
    });
    if (includeKorean) {
      if (!isValidKoreanCaption(scene?.caption_text_ko)) {
        issues.push({
          scene_id: sceneId,
          field: 'caption_text_ko',
          value: normalizeText(scene?.caption_text_ko || ''),
          reason: 'caption_text_ko must be natural Korean, not English or empty'
        });
      }
      const koreanCaptions = Array.isArray(scene?.screen_captions_ko) ? scene.screen_captions_ko : [];
      if (!koreanCaptions.length) {
        issues.push({
          scene_id: sceneId,
          field: 'screen_captions_ko',
          value: [],
          reason: 'screen_captions_ko must contain at least one natural Korean caption'
        });
        return;
      }
      koreanCaptions.forEach((caption, captionIndex) => {
        if (!isValidKoreanCaption(caption)) {
          issues.push({
            scene_id: sceneId,
            field: `screen_captions_ko[${captionIndex}]`,
            value: normalizeText(caption || ''),
            reason: 'screen_captions_ko must be natural Korean, not English or empty'
          });
        }
      });
    }
  });
  return issues;
}

function chunkArray(items = [], size = 10) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function uniqueIssueSceneIds(issues = []) {
  return [...new Set((issues || []).map((issue) => normalizeText(issue?.scene_id || '')).filter(Boolean))];
}

function sceneRepairContext(guide = {}, sceneIds = []) {
  const wanted = new Set(sceneIds);
  return (Array.isArray(guide.scene_transitions) ? guide.scene_transitions : [])
    .filter((scene, index) => wanted.has(normalizeText(scene?.scene_id || `scene_${String(index + 1).padStart(3, '0')}`)))
    .map((scene, index) => ({
      scene_id: normalizeText(scene.scene_id || `scene_${String(index + 1).padStart(3, '0')}`),
      start_sec: scene.start_sec,
      end_sec: scene.end_sec,
      visual_summary: normalizeText(scene.visual_summary || ''),
      focus_target: normalizeText(scene.focus_target || ''),
      current_caption_text: normalizeText(scene.caption_text || ''),
      current_caption_text_ko: normalizeText(scene.caption_text_ko || ''),
      current_screen_captions_ja: Array.isArray(scene.screen_captions_ja) ? scene.screen_captions_ja : [],
      current_screen_captions_ko: Array.isArray(scene.screen_captions_ko) ? scene.screen_captions_ko : []
    }));
}

function applyCaptionRepairBatch(guide = {}, repairResult = {}) {
  const repairs = Array.isArray(repairResult?.scene_repairs) ? repairResult.scene_repairs : [];
  if (!repairs.length) return guide;

  const repairBySceneId = new Map();
  repairs.forEach((repair) => {
    const sceneId = normalizeText(repair?.scene_id || '');
    if (!sceneId) return;
    repairBySceneId.set(sceneId, repair);
  });

  return {
    ...guide,
    scene_transitions: (Array.isArray(guide.scene_transitions) ? guide.scene_transitions : []).map((scene) => {
      const sceneId = normalizeText(scene?.scene_id || '');
      const repair = repairBySceneId.get(sceneId);
      if (!repair) return scene;
      return {
        ...scene,
        caption_text: normalizeText(repair.caption_text || scene.caption_text || ''),
        caption_text_ko: normalizeText(repair.caption_text_ko || scene.caption_text_ko || ''),
        screen_captions_ja: Array.isArray(repair.screen_captions_ja)
          ? repair.screen_captions_ja.map(normalizeText).filter(Boolean)
          : scene.screen_captions_ja,
        screen_captions_ko: Array.isArray(repair.screen_captions_ko)
          ? repair.screen_captions_ko.map(normalizeText).filter(Boolean)
          : scene.screen_captions_ko
      };
    })
  };
}

function applyMetadataFieldRepair(guide = {}, repairResult = {}, options = {}) {
  const next = { ...guide };
  const fullKoreanScriptSourceBasis = normalizeText(options.fullKoreanScriptSourceBasis || 'full_caption_script_repair');
  const repairedFields = Array.isArray(repairResult?.repaired_fields) ? repairResult.repaired_fields : [];
  if (repairedFields.length) {
    repairedFields.forEach((entry) => {
      const field = normalizeText(entry?.field || '');
      const value = normalizeText(entry?.value || '');
      if (!field || !value) return;
      const topLevelTextFields = new Set([
        'short_description_200',
        'short_description_ko',
        'explainer_text',
        'explainer_text_ko',
        'highlight_explainer_text',
        'highlight_explainer_text_ko'
      ]);
      if (topLevelTextFields.has(field)) {
        next[field] = value;
        return;
      }
      const metadataTextMatch = field.match(/^(full_metadata_ko|highlight_metadata|highlight_metadata_ko|midform_metadata|midform_metadata_ko)\.(short_description|summary_caption|report_description|upload_title|onscreen_caption_block)$/u);
      if (metadataTextMatch) {
        const [, section, key] = metadataTextMatch;
        next[section] = {
          ...(next[section] || {}),
          [key]: key === 'upload_title' ? cleanUploadTitle(value) : value
        };
        if (section === 'highlight_metadata' && key === 'onscreen_caption_block') next.highlight_explainer_text = value;
        if (section === 'highlight_metadata_ko' && key === 'onscreen_caption_block') next.highlight_explainer_text_ko = value;
        return;
      }
      const titleMatch = field.match(/^(full_metadata_ko|highlight_metadata|highlight_metadata_ko|midform_metadata|midform_metadata_ko)\.recommended_titles\[(\d+)\]\.title$/u);
      if (titleMatch) {
        const [, section, indexText] = titleMatch;
        const titleIndex = Number(indexText);
        const metadata = next[section] && typeof next[section] === 'object' ? next[section] : {};
        const titles = Array.isArray(metadata.recommended_titles) ? [...metadata.recommended_titles] : [];
        while (titles.length <= titleIndex) {
          titles.push({ category: '', title: '', hashtags: metadata.hashtags || ['#worker', '#process'] });
        }
        const previous = titles[titleIndex] && typeof titles[titleIndex] === 'object' ? titles[titleIndex] : {};
        titles[titleIndex] = {
          ...previous,
          title: cleanUploadTitle(value),
          hashtags: Array.isArray(previous.hashtags) && previous.hashtags.length
            ? previous.hashtags
            : (metadata.hashtags || ['#worker', '#process'])
        };
        next[section] = {
          ...metadata,
          recommended_titles: titles
        };
      }
    });
    return next;
  }
  [
    'short_description_200',
    'short_description_ko',
    'explainer_text',
    'explainer_text_ko',
    'highlight_explainer_text',
    'highlight_explainer_text_ko'
  ].forEach((field) => {
    const value = normalizeText(repairResult?.[field] || '');
    if (value) next[field] = value;
  });
  ['full_metadata_ko', 'highlight_metadata', 'highlight_metadata_ko', 'midform_metadata', 'midform_metadata_ko'].forEach((field) => {
    if (repairResult?.[field] && typeof repairResult[field] === 'object') {
      next[field] = {
        ...(next[field] || {}),
        ...repairResult[field]
      };
    }
  });
  ['full_caption_script_ko', 'midform_caption_script_ja', 'midform_caption_script_ko'].forEach((field) => {
    const scriptItems = extractRepairScriptArray(repairResult, field);
    if (!Array.isArray(scriptItems)) return;
    const isFullKoreanRepair = field === 'full_caption_script_ko';
    const mappedItems = scriptItems
      .map((item, index) => {
        if (typeof item === 'string') {
          return {
            scene_id: `script_${String(index + 1).padStart(3, '0')}`,
            role: index === 0 ? 'hook' : 'technical_context',
            text: normalizeText(item),
            source_basis: isFullKoreanRepair ? fullKoreanScriptSourceBasis : 'metadata_caption_repair'
          };
        }
        if (!item || typeof item !== 'object') return null;
        return {
          scene_id: normalizeText(item.scene_id || `script_${String(index + 1).padStart(3, '0')}`),
          role: normalizeText(item.role || 'scene_observation'),
          text: normalizeText(item.text || ''),
          source_basis: isFullKoreanRepair
            ? fullKoreanScriptSourceBasis
            : normalizeText(item.source_basis || 'metadata_caption_repair')
        };
      })
      .filter((item) => item?.scene_id && item?.text);
    if (field === 'full_caption_script_ko') {
      next[field] = limitFullScriptSceneRoles(enforceFullCaptionSafeLengths(dedupeAdjacentFullCaptionScriptItems(mappedItems), true));
      const repairedSubtitles = fullCaptionScriptTexts(next[field]);
      if (repairedSubtitles.length) {
        next.full_metadata_ko = {
          ...(next.full_metadata_ko || {}),
          variant_type: 'full',
          caption_mode: 'scene_based_short_subtitles',
          onscreen_subtitles: repairedSubtitles
        };
      }
      return;
    }
    next[field] = mappedItems;
  });
  return next;
}

function extractRepairScriptArray(repairResult = {}, field = '') {
  if (Array.isArray(repairResult?.[field])) return repairResult[field];
  const language = field.endsWith('_ko') ? 'ko' : 'ja';
  const variant = field.startsWith('midform_') ? 'midform' : 'full';
  const candidates = [
    repairResult?.[variant]?.[`caption_script_${language}`],
    repairResult?.[variant]?.[`caption_script_${language === 'ja' ? 'jp' : language}`],
    repairResult?.[variant]?.[`screen_script_${language}`],
    repairResult?.[`${variant}_caption_script`]?.[language],
    repairResult?.[`${variant}_caption_script`]?.[language === 'ja' ? 'jp' : language],
    repairResult?.caption_scripts?.[variant]?.[language],
    repairResult?.caption_scripts?.[variant]?.[language === 'ja' ? 'jp' : language],
    repairResult?.caption_script?.[language],
    repairResult?.caption_script?.[language === 'ja' ? 'jp' : language],
    repairResult?.scripts?.[field],
    repairResult?.scripts?.[variant]?.[language],
    repairResult?.scripts?.[variant]?.[language === 'ja' ? 'jp' : language]
  ];
  return candidates.find(Array.isArray) || null;
}

function applyLocalMetadataFallbacks(guide = {}, issues = []) {
  const metadataIssues = (issues || []).filter((issue) => normalizeText(issue?.scene_id || '') === 'metadata');
  if (!metadataIssues.length) return guide;
  const next = {
    ...guide,
    full_metadata: { ...(guide.full_metadata || {}) },
    full_metadata_ko: { ...(guide.full_metadata_ko || {}) },
    highlight_metadata: { ...(guide.highlight_metadata || {}) },
    highlight_metadata_ko: { ...(guide.highlight_metadata_ko || {}) }
  };
  const safeJapaneseTitleFor = (metadata = {}, fallbackTitle = '') => {
    const candidates = [
      metadata.upload_title,
      ...(Array.isArray(metadata.recommended_titles) ? metadata.recommended_titles.map((item) => item?.title) : []),
      fallbackTitle,
      guide.short_description_200,
      guide.explainer_text,
      '職人技が光る製造工程'
    ];
    return cleanUploadTitle(candidates.find((value) => isValidJapaneseCaption(value) && !hasLongLatinWord(value)) || '職人技が光る製造工程');
  };
  const repairRecommendedTitle = (section, titleIndex) => {
    const metadata = next[section] && typeof next[section] === 'object' ? next[section] : {};
    const titles = Array.isArray(metadata.recommended_titles) ? [...metadata.recommended_titles] : [];
    const korean = /_ko$/u.test(section);
    const fallbackTitle = korean
      ? titleWithEnglishHashtags(
          normalizeText(guide.detected_subject || '제조 공정') || '제조 공정',
          metadata.hashtags || ['#worker', '#process', '#metalwork', '#tools', '#craftsmanship']
        )
      : safeJapaneseTitleFor(metadata, guide.detected_subject || '');
    while (titles.length <= titleIndex) {
      titles.push({ title: fallbackTitle, hashtags: metadata.hashtags || ['#worker', '#process'] });
    }
    const previous = titles[titleIndex] && typeof titles[titleIndex] === 'object' ? titles[titleIndex] : {};
    titles[titleIndex] = {
      ...previous,
      title: fallbackTitle,
      hashtags: Array.isArray(previous.hashtags) && previous.hashtags.length
        ? previous.hashtags
        : (metadata.hashtags || ['#worker', '#process'])
    };
    next[section] = {
      ...metadata,
      recommended_titles: titles
    };
  };
  const sanitizeMetadataLanguageText = (section, field, korean = false) => {
    const metadata = next[section] && typeof next[section] === 'object' ? next[section] : {};
    const currentValue = normalizeText(metadata[field] || '');
    const validLanguage = korean ? isValidKoreanCaption(currentValue) : isValidJapaneseCaption(currentValue);
    if (!currentValue || (validLanguage && !hasLongLatinWord(currentValue))) return;
    const subject = normalizeText(guide.detected_subject || metadata.upload_title || guide.short_description_ko || guide.short_description_200 || '제조 공정');
    if (field === 'report_description') {
      next[section] = {
        ...metadata,
        [field]: formatStructuredReportDescription(buildFallbackReport(
          subject,
          metadata.short_description || metadata.summary_caption || subject,
          korean
        ), korean)
      };
      return;
    }
    const replacement = korean
      ? '제조 공정'
      : safeJapaneseTitleFor(metadata, '製造工程');
    next[section] = {
      ...metadata,
      [field]: currentValue
        .replace(/[A-Za-z][A-Za-z\s-]{2,}/gu, replacement)
        .replace(/\s+/g, ' ')
        .trim()
    };
  };
  const sanitizeInlineLanguageText = (value = '', korean = false) => {
    const currentValue = normalizeText(value || '');
    if (!currentValue) return '';
    return currentValue
      .replace(/satisfying/giu, korean ? '만족스러운' : '心地よい')
      .replace(/\bsat\b/giu, korean ? '만족스러운' : '心地よい')
      .replace(/[A-Za-z][A-Za-z\s-]{2,}/gu, korean ? '작업' : '工程')
      .replace(/\s+/g, ' ')
      .trim();
  };
  const repairTopLevelLanguageText = (field, fallback = '', korean = false) => {
    const currentValue = normalizeText(next[field] || '');
    const repaired = currentValue && hasLongLatinWord(currentValue)
      ? sanitizeInlineLanguageText(currentValue, korean)
      : currentValue;
    next[field] = clampDescription(repaired || fallback);
  };
  metadataIssues.forEach((issue) => {
    const field = normalizeText(issue?.field || '');
    if (field === 'full_metadata.upload_title') {
      next.full_metadata.upload_title = cleanUploadTitle(
        next.full_metadata.upload_title ||
        next.full_metadata.recommended_titles?.[0]?.title ||
        guide.recommended_titles?.[0]?.title ||
        guide.detected_subject ||
        '製造工程'
      );
    } else if (field === 'highlight_metadata.upload_title') {
      next.highlight_metadata.upload_title = cleanUploadTitle(
        next.highlight_metadata.upload_title ||
        next.highlight_metadata.recommended_titles?.[0]?.title ||
        guide.recommended_titles?.[0]?.title ||
        guide.detected_subject ||
        '製造ハイライト'
      );
    } else if (field === 'short_description_200') {
      repairTopLevelLanguageText(
        'short_description_200',
        next.full_metadata.short_description ||
          next.full_metadata.summary_caption ||
          next.report_description ||
          next.detected_subject ||
          '製造工程を短く紹介します。'
      );
    } else if (field === 'explainer_text') {
      repairTopLevelLanguageText(
        'explainer_text',
        next.full_metadata.summary_caption ||
          next.full_metadata.short_description ||
          next.short_description_200 ||
          '製造工程を短く紹介します。'
      );
    } else if (field === 'highlight_explainer_text') {
      repairTopLevelLanguageText(
        'highlight_explainer_text',
        next.highlight_metadata.onscreen_caption_block ||
          next.highlight_metadata.short_description ||
          next.short_description_200 ||
          '一番目を引く工程を短く紹介します。'
      );
      if (next.highlight_metadata && typeof next.highlight_metadata === 'object') {
        next.highlight_metadata.onscreen_caption_block = next.highlight_explainer_text;
      }
    } else if (field === 'highlight_explainer_text_ko') {
      repairTopLevelLanguageText(
        'highlight_explainer_text_ko',
        next.highlight_metadata_ko?.onscreen_caption_block ||
          next.highlight_metadata_ko?.short_description ||
          next.short_description_ko ||
          '가장 눈에 띄는 공정을 짧게 소개합니다.',
        true
      );
      if (next.highlight_metadata_ko && typeof next.highlight_metadata_ko === 'object') {
        next.highlight_metadata_ko.onscreen_caption_block = next.highlight_explainer_text_ko;
      }
    } else if (field === 'highlight_metadata.onscreen_caption_block') {
      const metadata = next.highlight_metadata && typeof next.highlight_metadata === 'object' ? next.highlight_metadata : {};
      next.highlight_metadata = {
        ...metadata,
        onscreen_caption_block: clampDescription(sanitizeInlineLanguageText(metadata.onscreen_caption_block || next.highlight_explainer_text || '一番目を引く工程を短く紹介します。'))
      };
      next.highlight_explainer_text = next.highlight_metadata.onscreen_caption_block;
    } else if (field === 'highlight_metadata_ko.onscreen_caption_block') {
      const metadata = next.highlight_metadata_ko && typeof next.highlight_metadata_ko === 'object' ? next.highlight_metadata_ko : {};
      next.highlight_metadata_ko = {
        ...metadata,
        onscreen_caption_block: clampDescription(sanitizeInlineLanguageText(metadata.onscreen_caption_block || next.highlight_explainer_text_ko || '가장 눈에 띄는 공정을 짧게 소개합니다.', true))
      };
      next.highlight_explainer_text_ko = next.highlight_metadata_ko.onscreen_caption_block;
    } else if (field === 'full_metadata.report_description') {
      sanitizeMetadataLanguageText('full_metadata', 'report_description', false);
    } else if (field === 'full_metadata.short_description') {
      sanitizeMetadataLanguageText('full_metadata', 'short_description', false);
    } else if (field === 'full_metadata.summary_caption') {
      sanitizeMetadataLanguageText('full_metadata', 'summary_caption', false);
    } else if (field === 'full_metadata_ko.report_description') {
      sanitizeMetadataLanguageText('full_metadata_ko', 'report_description', true);
    } else if (field === 'full_metadata_ko.short_description') {
      sanitizeMetadataLanguageText('full_metadata_ko', 'short_description', true);
    } else if (field === 'full_metadata_ko.summary_caption') {
      sanitizeMetadataLanguageText('full_metadata_ko', 'summary_caption', true);
    } else if (field === 'highlight_metadata.report_description') {
      sanitizeMetadataLanguageText('highlight_metadata', 'report_description', false);
    } else if (field === 'highlight_metadata.short_description') {
      sanitizeMetadataLanguageText('highlight_metadata', 'short_description', false);
    } else if (field === 'highlight_metadata.summary_caption') {
      sanitizeMetadataLanguageText('highlight_metadata', 'summary_caption', false);
    } else if (field === 'highlight_metadata_ko.report_description') {
      sanitizeMetadataLanguageText('highlight_metadata_ko', 'report_description', true);
    } else if (field === 'highlight_metadata_ko.short_description') {
      sanitizeMetadataLanguageText('highlight_metadata_ko', 'short_description', true);
    } else if (field === 'highlight_metadata_ko.summary_caption') {
      sanitizeMetadataLanguageText('highlight_metadata_ko', 'summary_caption', true);
    } else {
      const titleMatch = field.match(/^(full_metadata|full_metadata_ko|highlight_metadata|highlight_metadata_ko|midform_metadata|midform_metadata_ko)\.recommended_titles\[(\d+)\]\.title$/u);
      if (titleMatch) {
        repairRecommendedTitle(titleMatch[1], Number(titleMatch[2]));
      }
    }
  });
  return next;
}

function fallbackJapaneseScreenCaption(scene = {}) {
  const caption = normalizeText(scene.caption_text || '');
  if (caption && isValidJapaneseCaption(caption) && !isStiffJapaneseScreenCaption(caption)) {
    return caption;
  }
  return '工程の動き';
}

function fallbackKoreanScreenCaption(scene = {}) {
  const caption = normalizeText(scene.caption_text_ko || '');
  if (caption && !isStiffKoreanScreenCaption(caption) && visibleTextLength(caption) <= 20) {
    return caption;
  }
  return '움직임을 보여줍니다';
}

function applyLocalCaptionFallbacks(guide = {}, issues = []) {
  const captionIssues = (issues || []).filter((issue) => normalizeText(issue?.scene_id || '') !== 'metadata');
  if (!captionIssues.length) return guide;

  const issueMap = new Map();
  captionIssues.forEach((issue) => {
    const sceneId = normalizeText(issue?.scene_id || '');
    if (!sceneId) return;
    const list = issueMap.get(sceneId) || [];
    list.push(issue);
    issueMap.set(sceneId, list);
  });

  return {
    ...guide,
    scene_transitions: (Array.isArray(guide.scene_transitions) ? guide.scene_transitions : []).map((scene) => {
      const sceneId = normalizeText(scene?.scene_id || '');
      const issuesForScene = issueMap.get(sceneId);
      if (!issuesForScene?.length) return scene;
      const next = { ...scene };
      issuesForScene.forEach((issue) => {
        const field = normalizeText(issue?.field || '');
        if (field === 'caption_text') {
          next.caption_text = fallbackJapaneseScreenCaption(next);
        } else if (field === 'caption_text_ko') {
          next.caption_text_ko = fallbackKoreanScreenCaption(next);
        } else if (field.startsWith('screen_captions_ja')) {
          next.screen_captions_ja = [fallbackJapaneseScreenCaption(next)];
        } else if (field.startsWith('screen_captions_ko')) {
          next.screen_captions_ko = [fallbackKoreanScreenCaption(next)];
        }
      });
      return next;
    })
  };
}

function validateGuide(guide, options = {}) {
  const missing = [];
  const skipFullValidation = options.skipFullValidation === true || guide?.full_generation_status === 'failed';
  const skipHighlightValidation = options.skipHighlightValidation === true || guide?.highlight_generation_status === 'failed';
  const skipMidformValidation = options.skipMidformValidation === true || guide?.midform_generation_status === 'failed';
  // A variant that is 'held' (pending human script review) is intentionally skipped,
  // not failed — a held full draft must not be reported as "all variants failed",
  // otherwise the item hard-fails before it can be routed to script_review.
  const anyVariantHeld = guide?.full_generation_status === 'held'
    || guide?.highlight_generation_status === 'held'
    || guide?.midform_generation_status === 'held';
  if (skipFullValidation && skipHighlightValidation && skipMidformValidation && !anyVariantHeld) {
    missing.push('all_variant_generation_failed');
  }
  const baseRequiredKeys = skipFullValidation ? [] : [
    'short_description_ko',
    'recommended_titles_ko',
    'report_description_ko',
    'explainer_text_ko'
  ];
  for (const key of baseRequiredKeys) {
    if (!guide?.[key]) missing.push(key);
  }
  if (!Array.isArray(guide?.scene_transitions)) {
    missing.push('scene_transitions_array');
  }
  if (!skipFullValidation && (!Array.isArray(guide?.recommended_titles_ko) || guide.recommended_titles_ko.length < 5)) {
    missing.push('recommended_titles_ko_min_5');
  }
  if (isLongformGuide(guide)) {
    if (windowDuration(guide?.hook_clip_10s) < 4 && windowDuration(guide?.recommended_highlight_window) < 4) {
      missing.push('longform_hook_clip_min_duration');
    }
    if (windowDuration(guide?.story_clip_40s) < 55 && windowDuration(guide?.recommended_full_window) < 55) {
      missing.push('longform_story_clip_min_duration');
    }
    const span = sceneSpanWindow(guide?.scene_transitions || []);
    if (!span || windowDuration(span) < 8) {
      missing.push('longform_scene_transitions_too_collapsed');
    }
  }
  const invalidJapaneseCaptions = collectJapaneseCaptionIssues(guide, {
    includeFull: !skipFullValidation,
    includeHighlight: !skipHighlightValidation,
    includeMidform: !skipMidformValidation,
    includeKorean: true,
    includeJapaneseFull: false,
    durationSec: guide?.duration_sec || guide?.target_duration_sec || 0
  });
  if (invalidJapaneseCaptions.length) {
    missing.push('invalid_japanese_scene_captions');
  }
  if (missing.length) {
    throw createHttpError(500, 'OTTOGI_METADATA_SCHEMA_VALIDATION_FAILED', 'Gemini metadata output is missing required fields', {
      missing,
      invalid_japanese_captions: invalidJapaneseCaptions
    });
  }
  validateLongformShortsResult(guide, {
    skipFullValidation,
    skipHighlightValidation,
    skipMidformValidation
  });
}

function assertOttogiGuideLanguage(guide, options = {}) {
  const invalidCaptions = collectJapaneseCaptionIssues(guide || {}, options);
  if (invalidCaptions.length) {
    throw createHttpError(500, 'OTTOGI_METADATA_LANGUAGE_VALIDATION_FAILED', 'Stored Gemini metadata contains invalid Japanese/Korean captions. Force Gemini reanalysis before draft generation.', {
      invalid_caption_count: invalidCaptions.length,
      invalid_japanese_captions: invalidCaptions
    });
  }
  return true;
}

function summarizeCaptionIssuesForLog(issues = [], limit = 6) {
  return issues
    .slice(0, limit)
    .map((issue) => {
      const field = normalizeText(issue?.field || 'caption');
      const reason = normalizeText(issue?.reason || 'invalid');
      const rawValue = issue?.value;
      let value = '';
      if (Array.isArray(rawValue)) {
        value = rawValue
          .slice(0, 8)
          .map((entry) => {
            if (entry && typeof entry === 'object') return normalizeText(entry.text || entry.value || JSON.stringify(entry));
            return normalizeText(entry);
          })
          .filter(Boolean)
          .join(' / ');
      } else if (rawValue && typeof rawValue === 'object') {
        value = normalizeText(rawValue.text || rawValue.value || JSON.stringify(rawValue));
      } else {
        value = normalizeText(rawValue || '');
      }
      const preview = value ? `: ${value.slice(0, 160)}` : '';
      return `${field}${preview} (${reason.slice(0, 120)})`;
    });
}

function summarizeFullScriptForLog(guide = {}, field, limit = 22) {
  const items = Array.isArray(guide?.[field]) ? guide[field] : [];
  return items
    .slice(0, limit)
    .map((item, index) => {
      const text = normalizeText(item?.text || item || '');
      return text ? `${index + 1}. ${text}` : '';
    })
    .filter(Boolean)
    .join(' / ');
}

function assertRepairNormalizationDidNotCollapse({ field, beforeCount, afterCount }) {
  const before = Number(beforeCount || 0);
  const after = Number(afterCount || 0);
  if (before <= 0) return;
  if (after >= Math.ceil(before * 0.5)) return;
  throw createHttpError(
    500,
    'REPAIR_NORMALIZE_LOSS',
    `REPAIR_NORMALIZE_LOSS: repair ${before}개 중 ${after}개만 생존 — 형식 불일치 의심, 적용 취소`,
    {
      field,
      repair_count: before,
      normalized_count: after,
      loss_ratio: Number(((before - after) / before).toFixed(3))
    }
  );
}

function repairNormalizationPreview(script = [], limit = 8) {
  return (Array.isArray(script) ? script : [])
    .slice(0, limit)
    .map((item) => normalizeText(item?.text || item || ''))
    .filter(Boolean);
}

function summarizeRepairScriptShapeForLog(repairResult = {}) {
  const rootKeys = Object.keys(repairResult || {}).slice(0, 12).join(', ') || '-';
  const countFor = (field) => {
    const value = extractRepairScriptArray(repairResult, field);
    return Array.isArray(value) ? value.length : 0;
  };
  const previewFor = (field) => {
    const value = extractRepairScriptArray(repairResult, field);
    if (!Array.isArray(value)) return '';
    return value
      .slice(0, 6)
      .map((item) => normalizeText(typeof item === 'string' ? item : item?.text || item?.caption || ''))
      .filter(Boolean)
      .join(' / ');
  };
  return {
    rootKeys,
    jaCount: countFor('full_caption_script_ja'),
    koCount: countFor('full_caption_script_ko'),
    jaPreview: previewFor('full_caption_script_ja'),
    koPreview: previewFor('full_caption_script_ko')
  };
}

function fullDraftStageValidationIssues(guide = {}, durationSec = 0) {
  return collectJapaneseCaptionIssues(guide || {}, {
    includeFull: true,
    includeHighlight: false,
    includeMidform: false,
    includeKorean: true,
    includeJapanese: false,
    durationSec
  }).filter((issue) => {
    const field = normalizeText(issue?.field || '');
    return field === 'full_caption_script_ko'
      || field.startsWith('full_caption_script_ko[')
      || field === 'full_metadata_ko.onscreen_subtitles'
      || field.startsWith('full_metadata_ko.onscreen_subtitles[')
      || field === 'full_metadata_ko';
  });
}

function persistFullDraftStageArtifact({
  fullDraftStagesDir = '',
  stageNumber = 0,
  stageName = '',
  guide = {},
  durationSec = 0,
  rawResponse = null,
  notes = {}
} = {}) {
  const dir = String(fullDraftStagesDir || '').trim();
  if (!dir || !stageName) return { summaryPath: '', rawPath: '', validationIssues: [] };
  fs.mkdirSync(dir, { recursive: true });
  const prefix = `${String(stageNumber || 0).padStart(2, '0')}_${safeStageFileName(stageName)}`;
  const summaryPath = path.join(dir, `${prefix}.json`);
  const rawPath = rawResponse ? path.join(dir, `${prefix}.raw.json`) : '';
  const validationIssues = fullDraftStageValidationIssues(guide, durationSec);
  const budget = koreanFullSpeechBudgetFromGuide(guide) || calculateKoreanFullSpeechBudget({ targetDurationSec: durationSec });
  const charCount = countKoreanFullScriptVisibleChars(guide?.full_caption_script_ko || []);
  const payload = {
    stage: stageName,
    stage_number: stageNumber,
    generated_at: new Date().toISOString(),
    char_count: charCount,
    budget: budget ? {
      target_chars: Number(budget.target_chars || 0),
      min_chars: Number(budget.min_chars || 0),
      max_chars: Number(budget.max_chars || 0),
      ratio_vs_target: Number(budget.target_chars ? (charCount / budget.target_chars).toFixed(3) : 0),
      ratio_vs_min: Number(budget.min_chars ? (charCount / budget.min_chars).toFixed(3) : 0)
    } : null,
    validation: {
      passed: validationIssues.length === 0,
      issue_count: validationIssues.length,
      issues: validationIssues
    },
    notes,
    full_caption_script_ko: guide?.full_caption_script_ko || []
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  if (rawPath) {
    fs.writeFileSync(rawPath, `${JSON.stringify(rawResponse, null, 2)}\n`, 'utf8');
  }
  return { summaryPath, rawPath, validationIssues };
}

function safeStageFileName(value = '') {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'stage';
}

async function validateOrRepairJapaneseCaptions({ guide, generateRepairJson, sourceUrl, filename, durationSec, validationOptions = {}, assignedHookType = null, onProgress, fullDraftStagesDir = '', initialStageRawResponse = null }) {
  let current = guide;
  let koreanFullStyleRegenerationUsed = false;
  // The last gate-rejected Korean full-caption attempt is kept so that, when the item
  // is ultimately held for script review, the human has the flawed fragment manuscript
  // to fix in script_review.txt instead of an empty file.
  let lastRejectedFullCaptionScriptKo = null;
  let latestRawResponsePath = '';
  let latestCleanedResponsePath = '';
  const initialStageArtifact = persistFullDraftStageArtifact({
    fullDraftStagesDir,
    stageNumber: 1,
    stageName: 'initial_generation',
    guide: current,
    durationSec,
    rawResponse: initialStageRawResponse,
    notes: { source: 'guide_before_validation' }
  });
  latestRawResponsePath = initialStageArtifact.rawPath || latestRawResponsePath;
  latestCleanedResponsePath = initialStageArtifact.summaryPath || latestCleanedResponsePath;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const normalizedCurrent = normalizeGuide(current, sourceUrl, durationSec);
      validateGuide(normalizedCurrent, validationOptions);
      return normalizedCurrent;
    } catch (error) {
      const issues = error?.details?.invalid_japanese_captions || [];
      if (!issues.length) throw error;
      if (attempt >= 3) {
        summarizeCaptionIssuesForLog(issues, 10).forEach((line) => {
          emitProgress(onProgress, `Gemini 최종 검증 실패 상세: ${line}`, {
            phase: 'metadata_validation_failed',
            attempt
          });
        });
        const finalError = createHttpError(500, 'OTTOGI_METADATA_LANGUAGE_VALIDATION_FAILED', 'Gemini metadata output still contains invalid Japanese/Korean captions after repair attempts', {
          invalid_caption_count: issues.length,
          invalid_japanese_captions: issues,
          raw_response_path: latestRawResponsePath,
          cleaned_response_path: latestCleanedResponsePath
        });
        // If the caption gate rejected every attempt and left no usable manuscript,
        // hand the last rejected fragment draft to the caller so a held item still
        // has editable content in script_review.txt rather than an empty file.
        const currentFullKoCount = Array.isArray(current?.full_caption_script_ko) ? current.full_caption_script_ko.length : 0;
        if (currentFullKoCount === 0 && Array.isArray(lastRejectedFullCaptionScriptKo) && lastRejectedFullCaptionScriptKo.length) {
          finalError.guide = {
            ...current,
            full_caption_script_ko: lastRejectedFullCaptionScriptKo,
            full_caption_script_needs_review: true
          };
        }
        throw finalError;
      }
      const metadataIssues = issues.filter((issue) => normalizeText(issue?.scene_id || '') === 'metadata');
      const captionIssues = issues.filter((issue) => normalizeText(issue?.scene_id || '') !== 'metadata');
        if (metadataIssues.length) {
          const koreanFullStyleRegenerationIssues = metadataIssues.filter(isKoreanFullScriptStyleRegenerationIssue);
          if (koreanFullStyleRegenerationIssues.length && !koreanFullStyleRegenerationUsed) {
            emitProgress(onProgress, `Gemini KO Full 원고 문체 재생성: 금지 문체 ${koreanFullStyleRegenerationIssues.length}개 감지`, {
              phase: 'full_caption_script_regeneration',
              invalid_metadata_count: koreanFullStyleRegenerationIssues.length,
            attempt
          });
          const regeneratedFullScript = await generateRepairJson(
            buildKoreanFullCaptionScriptRegenerationPrompt({
              sourceUrl,
              filename,
              durationSec,
              guide: current,
              issues: koreanFullStyleRegenerationIssues,
              assignedHookType
            }),
            OTTOGI_FULL_CAPTION_SCRIPT_REPAIR_SCHEMA,
            'full_caption_script_regeneration'
          );
          const regenerationShape = summarizeRepairScriptShapeForLog(regeneratedFullScript);
          emitProgress(onProgress, `Gemini KO Full 원고 재생성 응답: keys=${regenerationShape.rootKeys} / KO ${regenerationShape.koCount}개`, {
            phase: 'full_caption_script_regeneration',
            attempt,
            repair_shape: regenerationShape
          });
            if (regenerationShape.koPreview) {
              emitProgress(onProgress, `Gemini KO Full 원고 재생성 미리보기: ${regenerationShape.koPreview}`, {
                phase: 'full_caption_script_regeneration',
                attempt
              });
            }
            const regeneratedFullScriptKo = extractRepairScriptArray(regeneratedFullScript, 'full_caption_script_ko');
            const regenerationGateIssues = collectKoreanFullRepairGateIssues(regeneratedFullScriptKo);
            if (regenerationGateIssues.length) {
              if (Array.isArray(regeneratedFullScriptKo) && regeneratedFullScriptKo.length) {
                lastRejectedFullCaptionScriptKo = regeneratedFullScriptKo;
              }
              emitProgress(onProgress, `Gemini KO Full 원고 재생성 게이트 차단: ${regenerationGateIssues[0].reason}`, {
                phase: 'full_caption_script_regeneration_gate',
                attempt,
                gate_issues: regenerationGateIssues
              });
              continue;
            }
            const appliedGuide = applyMetadataFieldRepair(current, regeneratedFullScript, {
              fullKoreanScriptSourceBasis: 'full_caption_script_regeneration'
            });
          const appliedKoCount = Array.isArray(appliedGuide.full_caption_script_ko) ? appliedGuide.full_caption_script_ko.length : 0;
          const normalizedGuide = normalizeGuide(appliedGuide, sourceUrl, durationSec);
          const normalizedKoCount = Array.isArray(normalizedGuide.full_caption_script_ko) ? normalizedGuide.full_caption_script_ko.length : 0;
          assertRepairNormalizationDidNotCollapse({
            field: 'full_caption_script_ko',
            beforeCount: appliedKoCount,
            afterCount: normalizedKoCount
          });
          current = normalizedGuide;
          const stageArtifact = persistFullDraftStageArtifact({
            fullDraftStagesDir,
            stageNumber: 2,
            stageName: 'regeneration',
            guide: normalizedGuide,
            durationSec,
            rawResponse: regeneratedFullScript,
            notes: { attempt, source_basis: 'full_caption_script_regeneration' }
          });
          latestRawResponsePath = stageArtifact.rawPath || latestRawResponsePath;
          latestCleanedResponsePath = stageArtifact.summaryPath || latestCleanedResponsePath;
            emitProgress(onProgress, `Gemini KO Full 원고 재생성 적용: KO ${appliedKoCount}→${normalizedKoCount}개`, {
              phase: 'full_caption_script_regeneration',
              attempt,
              applied_ko_count: appliedKoCount,
              normalized_ko_count: normalizedKoCount
            });
            koreanFullStyleRegenerationUsed = true;
            continue;
          }
        const fullScriptRepairIssues = metadataIssues.filter((issue) => {
          const field = normalizeText(issue?.field || '');
          return field === 'full_caption_script_ko'
            || field.startsWith('full_caption_script_ko[')
            || field === 'full_metadata_ko.onscreen_subtitles'
            || field.startsWith('full_metadata_ko.onscreen_subtitles[');
        });
        if (fullScriptRepairIssues.length) {
          emitProgress(onProgress, `Gemini Full 원고 배열 누락: 전용 원고 재요청 ${fullScriptRepairIssues.length}개`, {
            phase: 'full_caption_script_repair',
            invalid_metadata_count: fullScriptRepairIssues.length,
            attempt
          });
          const fullScriptRepair = await generateRepairJson(
            buildFullCaptionScriptRepairPrompt({
              sourceUrl,
              filename,
              durationSec,
              guide: current,
              issues: fullScriptRepairIssues,
              assignedHookType
            }),
            OTTOGI_FULL_CAPTION_SCRIPT_REPAIR_SCHEMA,
            'full_caption_script_repair'
          );
          const repairShape = summarizeRepairScriptShapeForLog(fullScriptRepair);
          emitProgress(onProgress, `Gemini Full 원고 repair 응답: keys=${repairShape.rootKeys} / KO ${repairShape.koCount}개`, {
            phase: 'full_caption_script_repair',
            attempt,
            repair_shape: repairShape
          });
          if (repairShape.koPreview) {
            emitProgress(onProgress, `Gemini Full 원고 repair KO 미리보기: ${repairShape.koPreview}`, {
              phase: 'full_caption_script_repair',
              attempt
            });
          }
          const repairFullScriptKo = extractRepairScriptArray(fullScriptRepair, 'full_caption_script_ko');
          const repairGateIssues = collectKoreanFullRepairGateIssues(repairFullScriptKo);
          if (repairGateIssues.length) {
            if (Array.isArray(repairFullScriptKo) && repairFullScriptKo.length) {
              lastRejectedFullCaptionScriptKo = repairFullScriptKo;
            }
            emitProgress(onProgress, `Gemini Full 원고 repair 게이트 차단: ${repairGateIssues[0].reason}`, {
              phase: 'full_caption_script_repair_gate',
              attempt,
              gate_issues: repairGateIssues
            });
            continue;
          }
          const appliedGuide = applyMetadataFieldRepair(current, fullScriptRepair);
          const appliedKoCount = Array.isArray(appliedGuide.full_caption_script_ko) ? appliedGuide.full_caption_script_ko.length : 0;
          const normalizedGuide = normalizeGuide(appliedGuide, sourceUrl, durationSec);
          const normalizedKoCount = Array.isArray(normalizedGuide.full_caption_script_ko) ? normalizedGuide.full_caption_script_ko.length : 0;
          try {
            assertRepairNormalizationDidNotCollapse({
              field: 'full_caption_script_ko',
              beforeCount: appliedKoCount,
              afterCount: normalizedKoCount
            });
          } catch (error) {
            error.details = {
              ...(error.details || {}),
              applied_preview: repairNormalizationPreview(appliedGuide.full_caption_script_ko),
              normalized_preview: repairNormalizationPreview(normalizedGuide.full_caption_script_ko),
              applied_source_basis: (Array.isArray(appliedGuide.full_caption_script_ko) ? appliedGuide.full_caption_script_ko : [])
                .slice(0, 8)
                .map((item) => normalizeText(item?.source_basis || ''))
                .filter(Boolean),
              raw_response_path: latestRawResponsePath,
              cleaned_response_path: latestCleanedResponsePath
            };
            throw error;
          }
          current = normalizedGuide;
          const stageArtifact = persistFullDraftStageArtifact({
            fullDraftStagesDir,
            stageNumber: 3,
            stageName: 'repair',
            guide: normalizedGuide,
            durationSec,
            rawResponse: fullScriptRepair,
            notes: { attempt, source_basis: 'full_caption_script_repair' }
          });
          latestRawResponsePath = stageArtifact.rawPath || latestRawResponsePath;
          latestCleanedResponsePath = stageArtifact.summaryPath || latestCleanedResponsePath;
          emitProgress(onProgress, `Gemini Full 원고 repair 적용: KO ${appliedKoCount}→${normalizedKoCount}개`, {
            phase: 'full_caption_script_repair',
            attempt,
            applied_ko_count: appliedKoCount,
            normalized_ko_count: normalizedKoCount
          });
          const remainingMetadataIssues = metadataIssues.filter((issue) => !fullScriptRepairIssues.includes(issue));
          if (!remainingMetadataIssues.length) continue;
          metadataIssues.splice(0, metadataIssues.length, ...remainingMetadataIssues);
        }
        const fullScriptKo = summarizeFullScriptForLog(current, 'full_caption_script_ko');
        if (fullScriptKo) {
          emitProgress(onProgress, `Gemini Full 원고 KO: ${fullScriptKo}`, {
            phase: 'metadata_validation',
            attempt
          });
        }
        const issuePreview = summarizeCaptionIssuesForLog(metadataIssues);
        issuePreview.forEach((line) => {
          emitProgress(onProgress, `Gemini 메타데이터 검증 상세: ${line}`, {
            phase: 'metadata_validation',
            attempt
          });
        });
        const locallyRepairedGuide = normalizeGuide(enforcePublicMetadataLanguage(
          applyLocalMetadataFallbacks(current, metadataIssues)
        ), sourceUrl, durationSec);
        const issueOptions = {
          includeFull: validationOptions.skipFullValidation !== true,
          includeHighlight: validationOptions.skipHighlightValidation !== true,
          includeMidform: validationOptions.skipMidformValidation !== true,
          includeKorean: true,
          includeJapaneseFull: false
        };
        const remainingAfterLocalRepair = collectJapaneseCaptionIssues(locallyRepairedGuide, issueOptions)
          .filter((issue) => normalizeText(issue?.scene_id || '') === 'metadata');
        if (remainingAfterLocalRepair.length < metadataIssues.length) {
          current = locallyRepairedGuide;
          emitProgress(onProgress, `Gemini 메타데이터 로컬 복구: ${metadataIssues.length}개 중 ${metadataIssues.length - remainingAfterLocalRepair.length}개 해결`, {
            phase: 'metadata_local_repair',
            attempt,
            before_count: metadataIssues.length,
            after_count: remainingAfterLocalRepair.length
          });
          continue;
        }
        current = locallyRepairedGuide;
        emitProgress(onProgress, `Gemini 메타데이터 일본어 검증 실패: ${metadataIssues.length}개 필드 재보정 중`, {
          phase: 'metadata_repair',
          invalid_metadata_count: metadataIssues.length,
          attempt
        });
        const metadataRepair = await generateRepairJson(
          buildMetadataFieldRepairPrompt({
            sourceUrl,
            filename,
            durationSec,
            guide: current,
            issues: metadataIssues
          }),
          OTTOGI_METADATA_FIELD_REPAIR_SCHEMA,
          'metadata_repair'
        );
        current = normalizeGuide(enforcePublicMetadataLanguage(applyLocalMetadataFallbacks(
          applyMetadataFieldRepair(current, metadataRepair),
          metadataIssues
        )), sourceUrl, durationSec);
      }

      const sceneIds = uniqueIssueSceneIds(captionIssues);
      if (!sceneIds.length) continue;
      const captionIssuePreview = summarizeCaptionIssuesForLog(captionIssues);
      captionIssuePreview.forEach((line) => {
        emitProgress(onProgress, `Gemini 자막 검증 상세: ${line}`, {
          phase: 'caption_validation',
          attempt
        });
      });
      emitProgress(onProgress, `Gemini 자막 검증 실패: ${captionIssues.length}개 문제 / ${sceneIds.length}개 장면 재보정 중`, {
        phase: 'caption_repair',
        invalid_caption_count: captionIssues.length,
        invalid_scene_count: sceneIds.length,
        attempt
      });
      for (const [batchIndex, sceneIdBatch] of chunkArray(sceneIds, CAPTION_REPAIR_BATCH_SIZE).entries()) {
        const batchIssues = captionIssues.filter((issue) => sceneIdBatch.includes(normalizeText(issue?.scene_id || '')));
        const scenes = sceneRepairContext(current, sceneIdBatch);
        emitProgress(onProgress, `Gemini 자막 재보정 ${batchIndex + 1}/${Math.ceil(sceneIds.length / CAPTION_REPAIR_BATCH_SIZE)}: ${scenes.length}개 장면`, {
          phase: 'caption_repair',
          batch_index: batchIndex + 1,
          batch_count: Math.ceil(sceneIds.length / CAPTION_REPAIR_BATCH_SIZE),
          scene_count: scenes.length
        });
        const repairResult = await generateRepairJson(
          buildCaptionRepairBatchPrompt({
            sourceUrl,
            filename,
            durationSec,
            scenes,
            issues: batchIssues
          }),
          OTTOGI_CAPTION_REPAIR_SCHEMA,
          'caption_repair'
        );
        current = normalizeGuide(applyLocalCaptionFallbacks(
          applyCaptionRepairBatch(current, repairResult),
          batchIssues
        ), sourceUrl, durationSec);
      }
    }
  }
  const normalizedCurrent = enforcePublicMetadataLanguage(normalizeGuide(
    enforcePublicMetadataLanguage(current),
    sourceUrl,
    durationSec
  ));
  try {
    validateGuide(normalizedCurrent, validationOptions);
  } catch (error) {
    error.guide = normalizedCurrent;
    throw error;
  }
  return normalizedCurrent;
}

function isYouTubeUrl(value = '') {
  return YOUTUBE_URL_RE.test(String(value || '').trim());
}

function normalizeMetadataVariantMode(value = 'all') {
  const mode = String(value || 'all').trim();
  return ['all', 'full_highlight_only', 'full_only', 'highlight_only', 'midform_only'].includes(mode) ? mode : 'all';
}

function validationOptionsForMetadataVariantMode(mode = 'all') {
  const normalizedMode = normalizeMetadataVariantMode(mode);
  return {
    skipFullValidation: normalizedMode === 'highlight_only' || normalizedMode === 'midform_only',
    skipHighlightValidation: normalizedMode === 'full_only' || normalizedMode === 'midform_only',
    skipMidformValidation: normalizedMode !== 'midform_only'
  };
}

function getGeminiAuthMode() {
  return String(process.env.GEMINI_AUTH_MODE || 'api_key').trim().toLowerCase();
}

function isVertexAdcMode() {
  return ['vertex_adc', 'vertex', 'adc'].includes(getGeminiAuthMode());
}

function getVertexConfig() {
  return {
    project: String(process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '').trim(),
    location: String(process.env.GOOGLE_CLOUD_LOCATION || DEFAULT_VERTEX_LOCATION).trim(),
    model: String(process.env.VERTEX_GEMINI_MODEL || GEMINI_MODEL).trim()
  };
}

function getMimeType(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.m4v') return 'video/x-m4v';
  if (ext === '.avi') return 'video/x-msvideo';
  return 'video/mp4';
}

function hasLocalSourceFile(filePath = '') {
  const resolved = String(filePath || '').trim();
  return Boolean(resolved) && fs.existsSync(resolved);
}

function buildYoutubeFilePart(sourceUrl) {
  return {
    fileData: {
      mimeType: 'video/mp4',
      fileUri: String(sourceUrl || '').trim()
    }
  };
}

async function buildApiKeyVideoPart({ filePath, sourceUrl, apiKey, throwIfCancelled = null }) {
  if (hasLocalSourceFile(filePath)) {
    const fileManager = new GoogleAIFileManager(apiKey);
    const uploadResult = await fileManager.uploadFile(filePath, {
      mimeType: getMimeType(filePath),
      displayName: `ottogi_metadata_${Date.now()}_${path.basename(filePath)}`
    });

    let uploadedFile = uploadResult.file;
    let tries = 0;
    while (normalizeFileState(uploadedFile) === 'PROCESSING') {
      checkCancellation(throwIfCancelled);
      if (tries >= FILE_POLL_MAX_RETRIES) {
        throw createHttpError(504, 'GEMINI_FILE_PROCESSING_TIMEOUT', 'Gemini file processing timed out');
      }
      await cancellableSleep(FILE_POLL_INTERVAL_MS, throwIfCancelled);
      uploadedFile = await fileManager.getFile(uploadedFile.name);
      tries += 1;
    }

    if (normalizeFileState(uploadedFile) === 'FAILED') {
      throw createHttpError(500, 'GEMINI_FILE_PROCESSING_FAILED', 'Gemini file processing failed', { file: uploadedFile });
    }

    return {
      fileData: {
        mimeType: uploadedFile.mimeType,
        fileUri: uploadedFile.uri
      }
    };
  }

  if (isYouTubeUrl(sourceUrl)) {
    return buildYoutubeFilePart(sourceUrl);
  }

  throw createHttpError(400, 'SOURCE_VIDEO_REQUIRED', 'source video file is required');
}

function buildVertexVideoPart({ filePath, sourceUrl }) {
  if (hasLocalSourceFile(filePath)) {
    return {
      inlineData: {
        mimeType: getMimeType(filePath),
        data: fs.readFileSync(filePath).toString('base64')
      }
    };
  }

  if (isYouTubeUrl(sourceUrl)) {
    return buildYoutubeFilePart(sourceUrl);
  }

  throw createHttpError(400, 'SOURCE_VIDEO_REQUIRED', 'source video file is required');
}

async function getVertexAccessToken() {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  const client = await auth.getClient();
  const tokenResult = await client.getAccessToken();
  const token = typeof tokenResult === 'string' ? tokenResult : tokenResult?.token;
  if (!token) {
    throw createHttpError(500, 'VERTEX_ADC_TOKEN_MISSING', 'Vertex ADC token could not be acquired');
  }
  return token;
}

function extractVertexResponseText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((part) => part?.text || '').join('').trim();
  if (!text) {
    throw createHttpError(500, 'VERTEX_GEMINI_EMPTY_RESPONSE', 'Vertex Gemini returned an empty response', {
      response: data
    });
  }
  return text;
}

function buildPhaseRawResponseEnvelope({ backend = '', phase = '', response = null, rawText = '' } = {}) {
  return {
    backend,
    phase,
    response,
    raw_text: String(rawText || '')
  };
}

async function testVertexAdcConnection() {
  const config = getVertexConfig();
  if (!config.project) {
    throw createHttpError(400, 'GOOGLE_CLOUD_PROJECT_REQUIRED', 'GOOGLE_CLOUD_PROJECT is required for Vertex ADC mode');
  }
  await getVertexAccessToken();
  return {
    status: 'ok',
    info: `Vertex ADC ready (${config.project}, ${config.location}, ${config.model})`
  };
}

async function generateValidatedLongformStep({ generateJson, prompt, schema, phase, validate, onProgress, includeVideo = false, generateOptions = {}, throwIfCancelled = null }) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    checkCancellation(throwIfCancelled);
    try {
      const result = await generateJson(prompt, schema, phase, { includeVideo, ...generateOptions });
      checkCancellation(throwIfCancelled);
      return validate(result);
    } catch (error) {
      checkCancellation(throwIfCancelled);
      lastError = error;
      if (attempt < 2) {
        const detailParts = [];
        if (error.details && typeof error.details === 'object') {
          if (Object.prototype.hasOwnProperty.call(error.details, 'valid_hook_candidates_count')) {
            detailParts.push(`hook ${error.details.valid_hook_candidates_count}/${error.details.hook_candidates_count}`);
          }
          if (Object.prototype.hasOwnProperty.call(error.details, 'valid_story_candidates_count')) {
            detailParts.push(`story ${error.details.valid_story_candidates_count}/${error.details.story_candidates_count}`);
          }
          if (Object.prototype.hasOwnProperty.call(error.details, 'valid_midform_candidates_count')) {
            detailParts.push(`midform ${error.details.valid_midform_candidates_count}/${error.details.midform_candidates_count}`);
          }
          if (Array.isArray(error.details.missing) && error.details.missing.length) {
            detailParts.push(`missing ${error.details.missing.join('|')}`);
          }
          if (Object.prototype.hasOwnProperty.call(error.details, 'full_caption_script_ja_count')) {
            detailParts.push(`JP captions ${error.details.full_caption_script_ja_count}`);
          }
          if (Object.prototype.hasOwnProperty.call(error.details, 'full_caption_script_ko_count')) {
            detailParts.push(`KR review captions ${error.details.full_caption_script_ko_count}`);
          }
          if (Object.prototype.hasOwnProperty.call(error.details, 'expected_caption_script_items')) {
            detailParts.push(`expected ${error.details.expected_caption_script_items}`);
          }
          if (error.details.window && typeof error.details.window === 'object') {
            const window = error.details.window;
            detailParts.push(`window ${window.start_sec ?? '?'}-${window.end_sec ?? '?'}s`);
          }
          if (Object.prototype.hasOwnProperty.call(error.details, 'duration')) {
            detailParts.push(`duration ${Number(error.details.duration).toFixed(3)}s`);
          }
          if (Object.prototype.hasOwnProperty.call(error.details, 'min') || Object.prototype.hasOwnProperty.call(error.details, 'max')) {
            detailParts.push(`required ${error.details.min ?? '?'}-${error.details.max ?? '?'}s`);
          }
          if (Object.prototype.hasOwnProperty.call(error.details, 'source_time_basis')) {
            detailParts.push(`basis ${error.details.source_time_basis || 'missing'}`);
          }
          if (Object.prototype.hasOwnProperty.call(error.details, 'source_duration_sec')) {
            detailParts.push(`source ${error.details.source_duration_sec}s`);
          }
        }
        const detailText = detailParts.length ? ` (${detailParts.join(', ')})` : '';
        emitProgress(onProgress, `Gemini ${phase} 검증 실패${detailText}: 같은 단계 재시도 (${attempt + 1}/2)`, {
          phase,
          code: error.code || error.name || '',
          message: error.message || '',
          details: error.details || null
        });
        await cancellableSleep(GEMINI_GENERATE_RETRY_BASE_MS, throwIfCancelled);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function withGeminiHeartbeat({
  onProgress,
  phase,
  label,
  task,
  intervalMs = GEMINI_REQUEST_HEARTBEAT_MS,
  timeoutMs = 0,
  throwIfCancelled = null
}) {
  const startedAt = Date.now();
  let tick = 0;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const heartbeat = setInterval(() => {
    tick += 1;
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    emitProgress(onProgress, `Gemini 응답 대기 중: ${label}, 경과 ${elapsedSec}초`, {
      phase,
      heartbeat: true,
      heartbeat_count: tick,
      elapsed_sec: elapsedSec
    });
  }, intervalMs);
  const timeout = timeoutMs > 0
    ? setTimeout(() => {
        if (controller) controller.abort();
      }, timeoutMs)
    : null;

  try {
    checkCancellation(throwIfCancelled);
    const result = await task({ signal: controller?.signal || undefined });
    checkCancellation(throwIfCancelled);
    return result;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createHttpError(504, 'GEMINI_REQUEST_TIMEOUT', `Gemini request timed out after ${Math.round(timeoutMs / 1000)}s`, {
        phase,
        label,
        timeoutMs
      });
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    clearInterval(heartbeat);
  }
}

function summarizeGeminiFailure(error = {}) {
  const parts = [];
  if (error.code || error.name) parts.push(String(error.code || error.name));
  if (error.message) parts.push(String(error.message));
  const details = error.details && typeof error.details === 'object' ? error.details : {};
  if (Array.isArray(details.missing) && details.missing.length) {
    parts.push(`missing=${details.missing.slice(0, 8).join('|')}`);
  }
  if (Array.isArray(details.invalid_japanese_captions) && details.invalid_japanese_captions.length) {
    parts.push(`invalid_japanese=${details.invalid_japanese_captions.length}`);
  }
  if (Array.isArray(details.invalidCaptions) && details.invalidCaptions.length) {
    parts.push(`invalid_captions=${details.invalidCaptions.length}`);
  }
  if (details.raw_response_path) parts.push(`raw=${details.raw_response_path}`);
  if (details.cleaned_response_path) parts.push(`cleaned=${details.cleaned_response_path}`);
  return parts.filter(Boolean).join(' / ') || 'unknown Gemini failure';
}

function requestedLongformVariants({ wantsFullFinal, wantsHighlightFinal, wantsMidformFinal }) {
  return [
    wantsFullFinal ? 'full' : '',
    wantsHighlightFinal ? 'highlight' : '',
    wantsMidformFinal ? 'midform' : ''
  ].filter(Boolean);
}

function normalizeMetadataVariantMode(value = 'all') {
  const mode = String(value || 'all').trim();
  return ['all', 'full_highlight_only', 'full_only', 'highlight_only', 'midform_only'].includes(mode) ? mode : 'all';
}

function coerceStandardMetadataVariantModeForSource({ metadataVariantMode = 'all', durationSec = 0, sourceType = 'unknown', sourceWorkflowMode = 'unknown' } = {}) {
  const normalizedMode = normalizeMetadataVariantMode(metadataVariantMode);
  const isLongformSource = sourceWorkflowMode === 'longform_to_shorts' || sourceType === 'longform';
  const numericDurationSec = Number(durationSec || 0);
  const skipFullDraft = !isLongformSource && numericDurationSec > 0 && numericDurationSec < 24;
  if (!skipFullDraft) return normalizedMode;
  if (normalizedMode === 'midform_only') return normalizedMode;
  return 'highlight_only';
}

function validationOptionsForMetadataVariantMode(value = 'all') {
  const mode = normalizeMetadataVariantMode(value);
  return {
    skipFullValidation: !['all', 'full_highlight_only', 'full_only'].includes(mode),
    skipHighlightValidation: !['all', 'full_highlight_only', 'highlight_only'].includes(mode),
    skipMidformValidation: !['midform_only'].includes(mode)
  };
}

function requestedStandardVariants(value = 'all') {
  const mode = normalizeMetadataVariantMode(value);
  if (mode === 'full_only') return ['full'];
  if (mode === 'highlight_only') return ['highlight'];
  if (mode === 'midform_only') return ['midform'];
  return ['full', 'highlight'];
}

function allRequestedLongformVariantsFailed(guide = {}, variants = []) {
  return variants.length > 0
    && variants.every((variant) => guide?.[`${variant}_generation_status`] === 'failed');
}

async function runLongformGeminiPipeline({ generateJson, sourceUrl, filename, durationSec, sourceType, sourceWorkflowMode, metadataVariantMode = 'all', existingGuide = null, assignedHookType = null, onProgress, throwIfCancelled = null, fullDraftStagesDir = '', phaseRawResponses = null }) {
  const normalizedMetadataVariantMode = normalizeMetadataVariantMode(metadataVariantMode);
  const wantsFullFinal = ['all', 'full_highlight_only', 'full_only'].includes(normalizedMetadataVariantMode);
  const wantsHighlightFinal = ['all', 'full_highlight_only', 'highlight_only'].includes(normalizedMetadataVariantMode);
  const wantsMidformFinal = ['all', 'midform_only'].includes(normalizedMetadataVariantMode);
  const resolvedHookType = normalizeAssignedKoreanHookType(assignedHookType, {
    seed: `${sourceUrl || ''}:${filename || ''}:longform`,
    sourceUrl,
    filename,
    sourceType,
    sourceWorkflowMode,
    detectedSubject: existingGuide?.detected_subject || '',
    sourceText: JSON.stringify(existingGuide || {})
  });
  const sourceDuration = Number(durationSec || 0);
  const analysisDurationSec = sourceDuration > ULTRA_LONGFORM_ANALYSIS_HORIZON_SEC
    ? ULTRA_LONGFORM_ANALYSIS_HORIZON_SEC
    : sourceDuration;

  let hookGuide = existingGuide?.hook_clip_10s ? { hook_clip_10s: existingGuide.hook_clip_10s } : {};
  let storyGuide = existingGuide?.story_clip_40s ? { story_clip_40s: existingGuide.story_clip_40s } : {};
  let midformGuide = existingGuide?.midform_clip_120s ? { midform_clip_120s: existingGuide.midform_clip_120s } : { midform_clip_120s: null };

  let fullGuideRaw = {};
  let highlightGuideRaw = {};
  let midformGuideRaw = {};
  let candidateGuideRaw = buildLongformCandidateGuideFromExisting(existingGuide, durationSec);
  let candidateGuideWasScanned = false;

  if (!candidateGuideRaw && sourceDuration >= LOCAL_LONGFORM_CANDIDATE_MIN_DURATION_SEC && (wantsFullFinal || wantsHighlightFinal || wantsMidformFinal)) {
    candidateGuideRaw = validateLongformCandidateGuide(
      buildLocalLongformCandidateGuide({ durationSec: analysisDurationSec, sourceType, sourceWorkflowMode }),
      analysisDurationSec
    );
    emitProgress(onProgress, `Gemini Longform 1/5 대체: 로컬 후보 전처리 ${candidateGuideRaw.hook_candidates?.length || 0}개 / story ${candidateGuideRaw.story_candidates?.length || 0}개${candidateGuideRaw.midform_candidates?.length ? ` / midform ${candidateGuideRaw.midform_candidates.length}개` : ''}${sourceDuration > analysisDurationSec ? ` / 분석 범위 ${analysisDurationSec}s로 제한` : ''}`, {
      phase: 'longform_candidates',
      local_preprocessed: true,
      local_candidate_strategy: candidateGuideRaw.local_candidate_strategy || null
    });
  }

  if (!candidateGuideRaw && (wantsFullFinal || wantsHighlightFinal || wantsMidformFinal)) {
    try {
      checkCancellation(throwIfCancelled);
      emitProgress(onProgress, 'Gemini Longform 1/5: 후보 구간 탐색', { phase: 'longform_candidates' });
      candidateGuideRaw = await generateValidatedLongformStep({
        generateJson,
        prompt: buildLongformCandidatePrompt({ sourceUrl, filename, durationSec, sourceType, sourceWorkflowMode }),
        schema: LONGFORM_CANDIDATE_SCHEMA,
        phase: 'longform_candidates',
        validate: (result) => validateLongformCandidateGuide(result, durationSec),
        onProgress,
        includeVideo: true,
        throwIfCancelled
      });
      candidateGuideWasScanned = true;
      emitProgress(onProgress, `Gemini Longform 1/5 완료: hook 후보 ${candidateGuideRaw.hook_candidates?.length || 0}개 / story 후보 ${candidateGuideRaw.story_candidates?.length || 0}개 / midform 후보 ${candidateGuideRaw.midform_candidates?.length || 0}개`, {
        phase: 'longform_candidates',
        candidate_validation_summary: candidateGuideRaw.candidate_validation_summary || null,
        fallback_windows_applied: candidateGuideRaw.fallback_windows_applied || []
      });
    } catch (error) {
      const failureSummary = summarizeGeminiFailure(error);
      emitProgress(onProgress, `Gemini Longform 후보 스캔 실패: ${failureSummary} / 포맷별 Vision 선택으로 계속 진행합니다.`, {
        phase: 'longform_candidates',
        code: error.code || error.name || '',
        details: error.details || null,
        fallback_to_variant_window_calls: true
      });
      candidateGuideRaw = null;
    }
  } else if (candidateGuideRaw) {
    emitProgress(onProgress, `Gemini Longform 1/5 생략: 기존 후보 ${candidateWindowsToShortformWindows(candidateGuideRaw).length}개 재사용`, {
      phase: 'longform_candidates',
      reused_candidate_windows: true
    });
  }

  const selectWindow = async ({ variant, phase, schema, validate, label }) => {
    checkCancellation(throwIfCancelled);
    const candidatePrompt = candidateGuideRaw && variant === 'highlight'
      ? buildLongformHookPrompt({ candidateGuide: candidateGuideRaw })
      : candidateGuideRaw && variant === 'full'
        ? buildLongformStoryPrompt({ candidateGuide: candidateGuideRaw, hookGuide })
        : candidateGuideRaw && variant === 'midform'
          ? buildLongformMidformPrompt({ candidateGuide: candidateGuideRaw, hookGuide, storyGuide })
          : null;
    emitProgress(onProgress, candidatePrompt
      ? `Gemini ${label} 2/5: 후보 중 ${label} 구간을 선택합니다.`
      : `Gemini ${label} 2/5: Vision으로 소스 구간을 선택합니다.`, {
      phase,
      uses_candidate_scan: Boolean(candidatePrompt)
    });
    const selected = await generateValidatedLongformStep({
      generateJson,
      prompt: candidatePrompt || buildLongformVariantWindowPrompt({ variant, sourceUrl, filename, durationSec, sourceType, sourceWorkflowMode }),
      schema,
      phase,
      validate,
      onProgress,
      includeVideo: !candidatePrompt,
      throwIfCancelled
    });
    const window = normalizeWindow(selected.hook_clip_10s || selected.story_clip_40s || selected.midform_clip_120s);
    emitProgress(onProgress, `Gemini ${label} 2/5 완료: ${window?.start_sec ?? '?'}-${window?.end_sec ?? '?'}s`, {
      phase,
      selected_window: window
    });
    return selected;
  };

  const selectedCandidateGuide = () => {
    const selected = buildSelectedLongformCandidateGuide({ hookGuide, storyGuide, midformGuide });
    const base = asPlainObject(candidateGuideRaw);
    if (!candidateGuideRaw) return selected;
    return {
      ...base,
      selected_hook_candidates: selected.hook_candidates,
      selected_story_candidates: selected.story_candidates,
      selected_midform_candidates: selected.midform_candidates,
      hook_candidates: selected.hook_candidates.length ? selected.hook_candidates : base.hook_candidates || [],
      story_candidates: selected.story_candidates.length ? selected.story_candidates : base.story_candidates || [],
      midform_candidates: selected.midform_candidates.length ? selected.midform_candidates : base.midform_candidates || []
    };
  };

  if (wantsHighlightFinal) {
    try {
      hookGuide = await selectWindow({
        variant: 'highlight',
        phase: 'longform_highlight_window',
        schema: LONGFORM_HOOK_SCHEMA,
        validate: (result) => validateLongformHookGuide(result, durationSec),
        label: 'Highlight'
      });
      checkCancellation(throwIfCancelled);
      emitProgress(onProgress, 'Gemini Highlight 3/5: create JP Highlight caption and metadata', { phase: 'longform_final_highlight' });
      highlightGuideRaw = await generateJson(
        buildLongformVariantFinalPrompt({ variant: 'highlight', sourceUrl, filename, durationSec, candidateGuide: selectedCandidateGuide(), hookGuide, storyGuide, midformGuide }),
        buildLongformVariantFinalSchema('highlight'),
        'longform_final_highlight',
        {
          includeVideo: false,
          maxAttempts: GEMINI_LONGFORM_FINAL_MAX_ATTEMPTS,
          retryBaseMs: GEMINI_LONGFORM_FINAL_RETRY_BASE_MS,
          timeoutMs: GEMINI_REQUEST_TIMEOUT_MS
        }
      );
    } catch (error) {
      const failureSummary = summarizeGeminiFailure(error);
      const previousHighlightMetadata = existingGuide?.highlight_metadata && typeof existingGuide.highlight_metadata === 'object'
        ? existingGuide.highlight_metadata
        : {};
      const previousHighlightMetadataKo = existingGuide?.highlight_metadata_ko && typeof existingGuide.highlight_metadata_ko === 'object'
        ? existingGuide.highlight_metadata_ko
        : {};
      const recoveredHighlightBlock = ensureHighlightCaptionBlock(
        previousHighlightMetadata.onscreen_caption_block
          || existingGuide?.highlight_explainer_text
          || existingGuide?.highlight_onscreen_caption_block_ja,
        false
      );
      const recoveredHighlightBlockKo = ensureHighlightCaptionBlock(
        previousHighlightMetadataKo.onscreen_caption_block
          || existingGuide?.highlight_explainer_text_ko
          || existingGuide?.highlight_onscreen_caption_block_ko,
        true
      );
      highlightGuideRaw = {
        highlight_generation_status: 'ready',
        highlight_generation_error: '',
        highlight_generation_details: {
          recovered_from_error: failureSummary || error.message || 'Highlight generation failed',
          original_details: error.details || null
        },
        highlight_explainer_text: recoveredHighlightBlock,
        highlight_explainer_text_ko: recoveredHighlightBlockKo,
        highlight_onscreen_caption_block_ja: recoveredHighlightBlock,
        highlight_onscreen_caption_block_ko: recoveredHighlightBlockKo,
        highlight_onscreen_subtitles_ja: [],
        highlight_onscreen_subtitles_ko: [],
        highlight_metadata: {
          ...previousHighlightMetadata,
          variant_type: 'highlight',
          caption_mode: 'long_bottom_explainer',
          onscreen_subtitles: [],
          onscreen_caption_block: recoveredHighlightBlock,
          upload_title: cleanUploadTitle(
            previousHighlightMetadata.upload_title
              || previousHighlightMetadata.recommended_titles?.[0]?.title
              || existingGuide?.full_metadata?.upload_title
              || existingGuide?.detected_subject
              || '製造ハイライト'
          ),
          hashtags: Array.isArray(previousHighlightMetadata.hashtags) && previousHighlightMetadata.hashtags.length
            ? previousHighlightMetadata.hashtags
            : ['#worker', '#process', '#manufacturing']
        },
        highlight_metadata_ko: {
          ...previousHighlightMetadataKo,
          variant_type: 'highlight',
          caption_mode: 'long_bottom_explainer',
          onscreen_subtitles: [],
          onscreen_caption_block: recoveredHighlightBlockKo,
          upload_title: previousHighlightMetadataKo.upload_title || '하이라이트 검수',
          hashtags: Array.isArray(previousHighlightMetadataKo.hashtags) && previousHighlightMetadataKo.hashtags.length
            ? previousHighlightMetadataKo.hashtags
            : ['#worker', '#process']
        }
      };
      emitProgress(onProgress, `Gemini Highlight final call failed: ${failureSummary}; recovered with existing/fallback long-bottom caption.`, {
        phase: 'longform_final_highlight',
        code: error.code || error.name || '',
        details: error.details || null,
        recovered_highlight: true
      });
    }
  }

  if (wantsFullFinal) {
    try {
      const candidateStoryGuide = !candidateGuideWasScanned
        ? buildFullStoryGuideFromExistingCandidates(existingGuide, durationSec)
        : null;
      if (candidateStoryGuide?.story_clip_40s) {
        storyGuide = candidateStoryGuide;
        const selectedStoryWindow = normalizeWindow(asPlainObject(storyGuide).story_clip_40s);
        emitProgress(onProgress, `Gemini Full 4/5 생략: 기존 후보 기반 Full 구간 사용 (${selectedStoryWindow?.start_sec ?? '?'}-${selectedStoryWindow?.end_sec ?? '?'}s)`, {
          phase: 'longform_full_window',
          selected_window: selectedStoryWindow,
          skipped_vision_window_call: true
        });
      } else {
        storyGuide = await selectWindow({
          variant: 'full',
          phase: 'longform_full_window',
          schema: LONGFORM_STORY_SCHEMA,
          validate: (result) => validateLongformStoryGuide(result, hookGuide, durationSec),
          label: 'Full'
        });
      }
      if (!normalizeWindow(asPlainObject(storyGuide).story_clip_40s)) {
        throw createHttpError(500, 'OTTOGI_FULL_WINDOW_MISSING', 'Gemini Full window selection did not return story_clip_40s', {
          variant: 'full',
          required_field: 'story_clip_40s'
        });
      }
      checkCancellation(throwIfCancelled);
      emitProgress(onProgress, 'Gemini Full 5/5: create JP Full script and metadata', { phase: 'longform_final_full' });
      fullGuideRaw = await generateValidatedLongformStep({
        generateJson,
        prompt: buildLongformVariantFinalPrompt({ variant: 'full', sourceUrl, filename, durationSec, candidateGuide: selectedCandidateGuide(), hookGuide, storyGuide, midformGuide, assignedHookType: resolvedHookType }),
        schema: buildLongformVariantFinalSchema('full'),
        phase: 'longform_final_full',
        validate: (result) => validateLongformVariantFinalGuide('full', result, { durationSec }),
        onProgress,
        includeVideo: false,
        generateOptions: {
          maxAttempts: GEMINI_LONGFORM_FINAL_MAX_ATTEMPTS,
          retryBaseMs: GEMINI_LONGFORM_FINAL_RETRY_BASE_MS,
          timeoutMs: GEMINI_REQUEST_TIMEOUT_MS
        },
        throwIfCancelled
      });
    } catch (error) {
      const failureSummary = summarizeGeminiFailure(error);
      fullGuideRaw = {
        full_generation_status: 'failed',
        full_generation_error: failureSummary || error.message || 'Full generation failed',
        full_generation_details: error.details || null
      };
      emitProgress(onProgress, `Gemini Full failed: ${failureSummary} / other formats will continue.`, {
        phase: 'longform_final_full',
        code: error.code || error.name || '',
        details: error.details || null
      });
    }
  }

  if (wantsMidformFinal) {
    if (sourceDuration < 125) {
      midformGuideRaw = {
        midform_generation_status: 'failed',
        midform_generation_error: `Midform skipped: source duration ${sourceDuration || 0}s is under 125s`,
        midform_generation_details: { durationSec: sourceDuration }
      };
      emitProgress(onProgress, `Gemini Midform skipped: source duration ${sourceDuration || 0}s is under 125s.`, {
        phase: 'longform_midform_skipped',
        durationSec: sourceDuration
      });
    } else {
      try {
        midformGuide = await selectWindow({
          variant: 'midform',
          phase: 'longform_midform_window',
          schema: LONGFORM_MIDFORM_SCHEMA,
          validate: (result) => validateLongformMidformGuide(result, storyGuide, durationSec),
          label: 'Midform'
        });
        checkCancellation(throwIfCancelled);
        emitProgress(onProgress, 'Gemini Midform 2/2a: create JP Midform metadata', { phase: 'longform_final_midform_metadata' });
        const midformMetadataGuide = await generateJson(
          buildLongformMidformMetadataPrompt({ sourceUrl, filename, durationSec, candidateGuide: selectedCandidateGuide(), hookGuide, storyGuide, midformGuide }),
          buildLongformMidformMetadataSchema(),
          'longform_final_midform_metadata',
          { includeVideo: true }
        );
        const midformCaptionParts = [];
        for (let partIndex = 0; partIndex < MIDFORM_CAPTION_SPLIT_COUNT; partIndex += 1) {
          checkCancellation(throwIfCancelled);
          emitProgress(onProgress, `Gemini Midform 2/2b: create caption part ${partIndex + 1}/${MIDFORM_CAPTION_SPLIT_COUNT}`, {
            phase: 'longform_final_midform_caption',
            part_index: partIndex,
            total_parts: MIDFORM_CAPTION_SPLIT_COUNT
          });
          midformCaptionParts.push(await generateJson(
            buildLongformMidformCaptionPartPrompt({
              partIndex,
              totalParts: MIDFORM_CAPTION_SPLIT_COUNT,
              sourceUrl,
              filename,
              durationSec,
              candidateGuide: selectedCandidateGuide(),
              hookGuide,
              storyGuide,
              midformGuide,
              midformMetadata: midformMetadataGuide.midform_metadata || {}
            }),
            buildLongformMidformCaptionPartSchema(),
            `longform_final_midform_caption_${partIndex + 1}`,
            { includeVideo: true }
          ));
        }
        midformGuideRaw = mergeMidformSplitOutputs(midformMetadataGuide, midformCaptionParts);
        validateLongformVariantFinalGuide('midform', midformGuideRaw, {
          durationSec,
          midformWindow: asPlainObject(midformGuide).midform_clip_120s
        });
      } catch (error) {
        const failureSummary = summarizeGeminiFailure(error);
        midformGuideRaw = {
          midform_generation_status: 'failed',
          midform_generation_error: failureSummary || error.message || 'Midform generation failed',
          midform_generation_details: error.details || null
        };
        emitProgress(onProgress, `Gemini Midform failed: ${failureSummary} / other formats will continue.`, {
          phase: 'longform_final_midform',
          code: error.code || error.name || '',
          details: error.details || null
        });
      }
    }
  }

  const candidateGuide = selectedCandidateGuide();
  const candidateWindowsForUi = candidateWindowsToShortformWindows(candidateGuideRaw || candidateGuide);
  const safeStoryGuide = asPlainObject(storyGuide);
  const safeHookGuide = asPlainObject(hookGuide);
  const safeMidformGuide = asPlainObject(midformGuide);
  const koreanFullSpeechBudget = calculateKoreanFullSpeechBudget({
    targetDurationSec: durationFromWindow(safeStoryGuide.story_clip_40s)
      || durationFromWindow(candidateGuide.recommended_full_window)
      || durationSec
  });
  const baseGuide = normalizeGuide({
    ...(existingGuide && typeof existingGuide === 'object' ? existingGuide : {}),
    source_type: sourceType,
    source_workflow_mode: sourceWorkflowMode,
    source_url: sourceUrl || '',
    korean_full_speech_budget: koreanFullSpeechBudget,
    shortform_candidate_windows: candidateWindowsForUi,
    hook_candidates: candidateGuideRaw?.hook_candidates || candidateGuide.hook_candidates || [],
    story_candidates: candidateGuideRaw?.story_candidates || candidateGuide.story_candidates || [],
    midform_candidates: candidateGuideRaw?.midform_candidates || candidateGuide.midform_candidates || [],
    selected_hook_candidates: candidateGuide.selected_hook_candidates || [],
    selected_story_candidates: candidateGuide.selected_story_candidates || [],
    selected_midform_candidates: candidateGuide.selected_midform_candidates || [],
    hook_clip_10s: safeHookGuide.hook_clip_10s || existingGuide?.hook_clip_10s || null,
    story_clip_40s: safeStoryGuide.story_clip_40s || existingGuide?.story_clip_40s || null,
    midform_clip_120s: safeMidformGuide.midform_clip_120s || existingGuide?.midform_clip_120s || null,
    recommended_highlight_window: safeHookGuide.hook_clip_10s || existingGuide?.recommended_highlight_window || null,
    recommended_full_window: safeStoryGuide.story_clip_40s || existingGuide?.recommended_full_window || null,
    recommended_midform_window: safeMidformGuide.midform_clip_120s || existingGuide?.recommended_midform_window || null
  }, sourceUrl, durationSec);

  const finalGuide = normalizeLongformRecoverableFields(mergeLongformVariantGuides({
    baseGuide,
    fullGuide: fullGuideRaw,
    highlightGuide: highlightGuideRaw,
    midformGuide: midformGuideRaw,
    sourceUrl,
    durationSec
  }), sourceUrl, durationSec);

  let guideForValidation = finalGuide;
  let allowFullPartial = !wantsFullFinal || guideForValidation.full_generation_status === 'failed';
  let allowHighlightPartial = !wantsHighlightFinal || guideForValidation.highlight_generation_status === 'failed';
  let allowMidformPartial = !wantsMidformFinal || guideForValidation.midform_generation_status === 'failed';
  const requestedVariants = requestedLongformVariants({ wantsFullFinal, wantsHighlightFinal, wantsMidformFinal });
  if (allRequestedLongformVariantsFailed(guideForValidation, requestedVariants)) {
    emitProgress(onProgress, `Gemini final validation: requested format failed (${requestedVariants.join(', ')}). Failure details were preserved for retry.`, {
      phase: 'longform_final_validation',
      failed_variants: requestedVariants
    });
    return guideForValidation;
  }
  try {
    validateLongformShortsResult(guideForValidation, {
      skipEnglishFallback: true,
      skipFullValidation: allowFullPartial,
      skipHighlightValidation: allowHighlightPartial,
      skipMidformValidation: allowMidformPartial
    });
  } catch (error) {
    if (isInternalTextsReferenceError(error)) {
      throw error;
    }
    const marked = markValidationFailedVariants(guideForValidation, error, requestedVariants);
    if (!marked.handled) throw error;
    const revived = reviveHighlightCaptionBlockFailure(marked.guide, marked.info, sourceUrl, durationSec);
    guideForValidation = normalizeLongformRecoverableFields(revived.guide, sourceUrl, durationSec);
    allowFullPartial = !wantsFullFinal || guideForValidation.full_generation_status === 'failed';
    allowHighlightPartial = !wantsHighlightFinal || guideForValidation.highlight_generation_status === 'failed';
    allowMidformPartial = !wantsMidformFinal || guideForValidation.midform_generation_status === 'failed';
    emitProgress(onProgress, revived.revived
      ? 'Gemini final validation: Highlight caption block was missing, so a safe long-bottom explainer was generated.'
      : `Gemini final validation: ${marked.failedVariants.join(', ')} failed and successful formats are preserved.`, {
      phase: 'longform_final_validation',
      failed_variants: marked.failedVariants,
      missing: marked.info.missing,
      revived_highlight_caption_block: revived.revived
    });
    if (allRequestedLongformVariantsFailed(guideForValidation, requestedVariants)) {
      emitProgress(onProgress, `Gemini final validation: requested format failed (${marked.failedVariants.join(', ')}). Failure details were preserved for retry.`, {
        phase: 'longform_final_validation',
        failed_variants: marked.failedVariants,
        missing: marked.info.missing,
        invalid_japanese_captions: marked.info.invalidCaptions
      });
      return guideForValidation;
    }
    validateLongformShortsResult(guideForValidation, {
      skipEnglishFallback: true,
      skipFullValidation: allowFullPartial,
      skipHighlightValidation: allowHighlightPartial,
      skipMidformValidation: allowMidformPartial
    });
  }

  let guide = guideForValidation;
  try {
    guide = await validateOrRepairJapaneseCaptions({
      guide: normalizeLongformRecoverableFields(guideForValidation, sourceUrl, durationSec),
      generateRepairJson: (prompt, schema = OTTOGI_REVIEW_SCHEMA, phase = 'caption_repair') => generateJson(
        prompt,
        schema,
        phase,
        { includeVideo: false }
      ),
      sourceUrl,
      filename,
      durationSec,
      validationOptions: {
        skipFullValidation: allowFullPartial,
        skipHighlightValidation: allowHighlightPartial,
        skipMidformValidation: allowMidformPartial
      },
      onProgress,
      throwIfCancelled,
      fullDraftStagesDir
    });
    guide = normalizeLongformRecoverableFields(guide, sourceUrl, durationSec);
  } catch (error) {
    if (isInternalTextsReferenceError(error)) {
      throw error;
    }
    const marked = markValidationFailedVariants(guideForValidation, error, requestedVariants);
    if (!marked.handled) throw error;
    const revived = reviveHighlightCaptionBlockFailure(marked.guide, marked.info, sourceUrl, durationSec);
    guide = normalizeLongformRecoverableFields(revived.guide, sourceUrl, durationSec);
    emitProgress(onProgress, revived.revived
      ? 'Gemini 최종 보정: Highlight 긴 하단 설명 블록을 서버 보강으로 복구했습니다.'
      : `Gemini 최종 보정 실패: ${marked.failedVariants.join(', ')} 포맷만 실패 처리하고 성공 포맷은 보존합니다.`, {
      phase: 'longform_final_validation',
      failed_variants: marked.failedVariants,
      missing: marked.info.missing,
      invalid_japanese_captions: marked.info.invalidCaptions,
      revived_highlight_caption_block: revived.revived
    });
    if (allRequestedLongformVariantsFailed(guide, requestedVariants)) {
      emitProgress(onProgress, `Gemini final validation: requested format failed (${marked.failedVariants.join(', ')}). Failure details were preserved for retry.`, {
        phase: 'longform_final_validation',
        failed_variants: marked.failedVariants,
        missing: marked.info.missing,
        invalid_japanese_captions: marked.info.invalidCaptions
      });
      return guide;
    }
  }
  try {
    validateLongformShortsResult(guide, {
      skipFullValidation: allowFullPartial || guide.full_generation_status === 'failed',
      skipHighlightValidation: allowHighlightPartial || guide.highlight_generation_status === 'failed',
      skipMidformValidation: allowMidformPartial || guide.midform_generation_status === 'failed'
    });
  } catch (error) {
    if (isInternalTextsReferenceError(error)) {
      throw error;
    }
    const marked = markValidationFailedVariants(guide, error, requestedVariants);
    if (!marked.handled) throw error;
    const revived = reviveHighlightCaptionBlockFailure(marked.guide, marked.info, sourceUrl, durationSec);
    guide = normalizeLongformRecoverableFields(revived.guide, sourceUrl, durationSec);
    emitProgress(onProgress, revived.revived
      ? 'Gemini 최종 검증: Highlight 긴 하단 설명 블록을 서버 보강으로 복구했습니다.'
      : `Gemini 최종 검증 실패: ${marked.failedVariants.join(', ')} 포맷만 실패 처리하고 성공 포맷은 보존합니다.`, {
      phase: 'longform_final_validation',
      failed_variants: marked.failedVariants,
      missing: marked.info.missing,
      invalid_japanese_captions: marked.info.invalidCaptions,
      revived_highlight_caption_block: revived.revived
    });
    if (allRequestedLongformVariantsFailed(guide, requestedVariants)) {
      emitProgress(onProgress, `Gemini final validation: requested format failed (${marked.failedVariants.join(', ')}). Failure details were preserved for retry.`, {
        phase: 'longform_final_validation',
        failed_variants: marked.failedVariants,
        missing: marked.info.missing,
        invalid_japanese_captions: marked.info.invalidCaptions
      });
      return guide;
    }
    validateLongformShortsResult(guide, {
      skipFullValidation: guide.full_generation_status === 'failed',
      skipHighlightValidation: guide.highlight_generation_status === 'failed',
      skipMidformValidation: guide.midform_generation_status === 'failed'
    });
  }

  emitProgress(onProgress, 'Gemini longform independent format analysis complete', {
    phase: 'longform_final',
    hook_clip_10s: guide.hook_clip_10s,
    story_clip_40s: guide.story_clip_40s,
    midform_clip_120s: guide.midform_clip_120s,
    full_generation_status: guide.full_generation_status || 'ready',
    highlight_generation_status: guide.highlight_generation_status || 'ready',
    midform_generation_status: guide.midform_generation_status || 'ready'
  });
  return guide;
}

async function runStandardGeminiPipeline({ generateJson, sourceUrl, filename, durationSec, sourceType, sourceWorkflowMode, metadataVariantMode = 'all', assignedHookType = null, onProgress, throwIfCancelled = null, fullDraftStagesDir = '', phaseRawResponses = null }) {
  checkCancellation(throwIfCancelled);
  const normalizedMetadataVariantMode = normalizeMetadataVariantMode(metadataVariantMode);
  const effectiveMetadataVariantMode = coerceStandardMetadataVariantModeForSource({
    metadataVariantMode: normalizedMetadataVariantMode,
    durationSec,
    sourceType,
    sourceWorkflowMode
  });
  const resolvedHookType = normalizeAssignedKoreanHookType(assignedHookType, {
    seed: `${sourceUrl || ''}:${filename || ''}:${sourceType || ''}:${sourceWorkflowMode || ''}`,
    sourceUrl,
    filename,
    sourceType,
    sourceWorkflowMode
  });
  const isHighlightOnlyShortform = effectiveMetadataVariantMode === 'highlight_only'
    && sourceWorkflowMode !== 'longform_to_shorts'
    && sourceType !== 'longform';
  emitProgress(onProgress, 'Gemini 1/3 장면 전환, 컷, 하이라이트 후보 분석', { phase: 'scene' });
  const sceneGuide = normalizeGuide(
    await generateJson(
      buildScenePrompt({ sourceUrl, filename, durationSec, sourceType, sourceWorkflowMode, metadataVariantMode: effectiveMetadataVariantMode }),
      OTTOGI_SCENE_SCHEMA,
      'scene',
      {
        timeoutMs: isHighlightOnlyShortform ? SHORTFORM_HIGHLIGHT_GEMINI_TIMEOUT_MS : GEMINI_REQUEST_TIMEOUT_MS
      }
    ),
    sourceUrl,
    durationSec
  );
  sceneGuide.source_type = sourceType;
  sceneGuide.source_workflow_mode = sourceWorkflowMode;
  emitProgress(onProgress, `Gemini 1/3 완료: 장면 ${sceneGuide.scene_transitions.length}개`, {
    phase: 'scene',
    scene_count: sceneGuide.scene_transitions.length
  });

  emitProgress(onProgress, 'Gemini 2/3 시작: 제목/메타데이터 원고 생성', { phase: 'metadata' });
  let metadataGuide = await generateJson(
      buildMetadataPrompt({ sourceUrl, filename, durationSec, sceneGuide, sourceType, sourceWorkflowMode, assignedHookType: resolvedHookType, metadataVariantMode: effectiveMetadataVariantMode }),
    OTTOGI_METADATA_ONLY_SCHEMA,
    'metadata',
      {
        includeVideo: false,
        timeoutMs: isHighlightOnlyShortform ? SHORTFORM_HIGHLIGHT_GEMINI_TIMEOUT_MS : GEMINI_REQUEST_TIMEOUT_MS
      }
  );
  if (effectiveMetadataVariantMode !== 'highlight_only' && (!Array.isArray(metadataGuide.full_caption_script_ko) || metadataGuide.full_caption_script_ko.length < 20)) {
    emitProgress(onProgress, 'Gemini 2/3a 시작: 누락된 Korean Full 원고 초기 생성', { phase: 'metadata_full_script_seed' });
    const initialSeedGuide = await generateJson(
      buildInitialFullCaptionScriptSeedPrompt({
        sourceUrl,
        filename,
        durationSec,
        guide: mergeSplitGuides(sceneGuide, metadataGuide, sourceUrl, durationSec),
        assignedHookType: resolvedHookType
      }),
      OTTOGI_FULL_CAPTION_SCRIPT_REPAIR_SCHEMA,
      'metadata_full_script_seed',
      {
        includeVideo: false,
        timeoutMs: GEMINI_REQUEST_TIMEOUT_MS
      }
    );
    const seedGateIssues = collectKoreanFullRepairGateIssues(extractRepairScriptArray(initialSeedGuide, 'full_caption_script_ko'));
    if (!seedGateIssues.length) {
      metadataGuide = applyMetadataFieldRepair(metadataGuide, initialSeedGuide, {
        fullKoreanScriptSourceBasis: 'initial_full_caption_script_seed'
      });
      emitProgress(onProgress, `Gemini 2/3a 완료: Korean Full 원고 ${Array.isArray(metadataGuide.full_caption_script_ko) ? metadataGuide.full_caption_script_ko.length : 0}개 초기 채움`, {
        phase: 'metadata_full_script_seed',
        full_caption_script_ko_count: Array.isArray(metadataGuide.full_caption_script_ko) ? metadataGuide.full_caption_script_ko.length : 0
      });
    } else {
      emitProgress(onProgress, `Gemini 2/3a 게이트 차단: ${seedGateIssues[0].reason}`, {
        phase: 'metadata_full_script_seed_gate',
        gate_issues: seedGateIssues
      });
    }
  }
  const draftGuide = mergeSplitGuides(sceneGuide, metadataGuide, sourceUrl, durationSec);
  emitProgress(onProgress, 'Gemini 2/3 완료: 메타데이터 원고 병합', { phase: 'metadata' });

  emitProgress(onProgress, 'Gemini 3/3 시작: 최종 JSON 검증', { phase: 'review' });
  let reviewGuide = null;
  try {
    reviewGuide = await generateJson(
      buildReviewPrompt({ sourceUrl, filename, durationSec, draftGuide, sourceType, sourceWorkflowMode, assignedHookType: resolvedHookType, metadataVariantMode: effectiveMetadataVariantMode }),
      OTTOGI_REVIEW_SCHEMA,
      'review',
      { includeVideo: false }
    );
  } catch (error) {
    emitProgress(onProgress, `Gemini review 단계 실패: ${error.message || 'unknown'} / 생성된 메타데이터를 로컬 검증으로 살립니다`, {
      phase: 'review',
      review_failed: true,
      error_code: error.code || error.errorCode || '',
      error_status: error.status || error.statusCode || null
    });
  }
  const guideBeforeFinalValidation = {
    ...(reviewGuide ? mergeReviewedGuide(draftGuide, reviewGuide, sourceUrl, durationSec) : draftGuide),
    korean_full_speech_budget: calculateKoreanFullSpeechBudget({ targetDurationSec: durationSec })
  };
  const validationOptions = validationOptionsForMetadataVariantMode(effectiveMetadataVariantMode);
  const requestedVariants = requestedStandardVariants(effectiveMetadataVariantMode);
  let guide;
  try {
    guide = await validateOrRepairJapaneseCaptions({
      guide: guideBeforeFinalValidation,
      generateRepairJson: (prompt, schema = OTTOGI_REVIEW_SCHEMA, phase = 'caption_repair') => generateJson(
        prompt,
        schema,
        phase,
        { includeVideo: false }
      ),
      sourceUrl,
      filename,
      durationSec,
      validationOptions,
      assignedHookType: resolvedHookType,
      onProgress,
      fullDraftStagesDir,
      initialStageRawResponse: phaseRawResponses?.get('metadata') || {
        sceneGuide,
        metadataGuide,
        reviewGuide
      }
    });
  } catch (error) {
    const repairedGuideForPartial = error.guide && typeof error.guide === 'object'
      ? error.guide
      : guideBeforeFinalValidation;
    const marked = markValidationFailedVariants(repairedGuideForPartial, error, requestedVariants);
    if (!marked.handled) throw error;
    guide = enforcePublicMetadataLanguage(normalizeGuide(marked.guide, sourceUrl, durationSec));
    emitProgress(onProgress, `Gemini 최종 검증 실패: ${marked.failedVariants.join(', ')} 포맷만 실패 처리하고 성공 포맷은 보존합니다.`, {
      phase: 'metadata_partial_validation',
      failed_variants: marked.failedVariants,
      missing: marked.info.missing,
      invalid_japanese_captions: marked.info.invalidCaptions
    });
    if (allRequestedLongformVariantsFailed(guide, requestedVariants)) {
      throw error;
    }
    validateGuide(guide, {
      skipFullValidation: validationOptions.skipFullValidation || guide.full_generation_status === 'failed' || guide.full_generation_status === 'held',
      skipHighlightValidation: validationOptions.skipHighlightValidation || guide.highlight_generation_status === 'failed',
      skipMidformValidation: validationOptions.skipMidformValidation || guide.midform_generation_status === 'failed'
    });
  }
  if (effectiveMetadataVariantMode === 'highlight_only' && normalizedMetadataVariantMode !== effectiveMetadataVariantMode) {
    guide = {
      ...guide,
      full_generation_status: 'skipped',
      full_generation_error: '',
      full_generation_details: {
        reason: 'skip_full_draft_short_source',
        requested_metadata_variant_mode: normalizedMetadataVariantMode,
        effective_metadata_variant_mode: effectiveMetadataVariantMode,
        duration_sec: Number(durationSec || 0),
        short_source_full_skip_max_duration_sec: SHORTFORM_FULL_DRAFT_SKIP_MAX_DURATION_SEC,
        source_type: sourceType,
        source_workflow_mode: sourceWorkflowMode
      }
    };
    emitProgress(onProgress, 'Gemini Full script skipped: short source is highlight-only by policy.', {
      phase: 'full_skip',
      requested_metadata_variant_mode: normalizedMetadataVariantMode,
      effective_metadata_variant_mode: effectiveMetadataVariantMode,
      durationSec,
      sourceType,
      sourceWorkflowMode
    });
  }
  emitProgress(onProgress, 'Gemini 3/3 완료: 최종 JSON 검증 완료', { phase: 'review' });
  return guide;
}

async function analyzeWithVertexAdc({ filePath, sourceUrl, durationSec, originalFilename, sourceType = 'unknown', sourceWorkflowMode = 'unknown', metadataVariantMode = 'all', existingGuide = null, assignedHookType = null, onProgress, throwIfCancelled = null, fullDraftStagesDir = '' }) {
  const config = getVertexConfig();
  if (!config.project) {
    throw createHttpError(400, 'GOOGLE_CLOUD_PROJECT_REQUIRED', 'GOOGLE_CLOUD_PROJECT is required for Vertex ADC mode');
  }

  const token = await getVertexAccessToken();
  const endpoint = buildVertexEndpoint(config);
  const latestPhaseRawResponses = new Map();
  let videoPartPromise = null;
  const ensureVideoPart = async () => {
    if (!videoPartPromise) {
      videoPartPromise = Promise.resolve(buildVertexVideoPart({ filePath, sourceUrl }));
    }
    return videoPartPromise;
  };

  async function generateJson(prompt, responseSchema, phase, options = {}) {
    const includeVideo = options.includeVideo !== false;
    const parts = includeVideo
      ? [
          await ensureVideoPart(),
          {
            text: prompt
          }
        ]
      : [
          {
            text: prompt
          }
    ];

    const maxAttempts = geminiMaxAttemptsForPhase(phase, options);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      checkCancellation(throwIfCancelled);
      try {
        emitProgress(onProgress, `Gemini ${phase} 요청 시작 (${attempt}/${maxAttempts})`, {
          phase,
          attempt,
          includeVideo
        });
        const response = await withGeminiHeartbeat({
          onProgress,
          phase,
          label: `${phase} 요청 ${attempt}/${maxAttempts}`,
          timeoutMs: Number(options.timeoutMs || 0) > 0 ? Number(options.timeoutMs) : GEMINI_REQUEST_TIMEOUT_MS,
          throwIfCancelled,
          task: ({ signal }) => fetch(endpoint, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            signal,
            body: JSON.stringify({
              contents: [
                {
                  role: 'user',
                  parts
                }
              ],
              generationConfig: buildMultimodalGenerationConfig({
                responseSchema,
                includeVideo
              })
            })
          })
        });

        const data = await response.json().catch(() => ({}));
        checkCancellation(throwIfCancelled);
        if (response.ok) {
          try {
            const rawText = extractVertexResponseText(data);
            latestPhaseRawResponses.set(phase, buildPhaseRawResponseEnvelope({
              backend: 'vertex_adc',
              phase,
              response: data,
              rawText
            }));
            const parsed = extractJson(rawText, { phase, attempt, filename });
            emitProgress(onProgress, `Gemini ${phase} 응답 JSON 파싱 완료 (${attempt}/${maxAttempts})`, {
              phase,
              attempt,
              status: response.status
            });
            return parsed;
          } catch (error) {
            if (attempt < maxAttempts && isRetryableGeminiError(error)) {
              const delayMs = retryDelayMs(attempt, phase, error.status || 500, options);
              emitProgress(onProgress, `Gemini ${phase} JSON 파싱 실패: ${Math.round(delayMs / 1000)}초 뒤 같은 단계 재시도 (${attempt + 1}/${maxAttempts})`, {
                phase,
                status: error.status || 500,
                code: error.code || 'JSON_PARSE_ERROR',
                attempt,
                raw_response_path: error.details?.raw_response_path || '',
                cleaned_response_path: error.details?.cleaned_response_path || ''
              });
              await cancellableSleep(delayMs, throwIfCancelled);
              continue;
            }
            throw error;
          }
        }

        if (attempt < maxAttempts && isRetryableGeminiStatus(response.status)) {
          const delayMs = retryDelayMs(attempt, phase, response.status, options);
          emitProgress(onProgress, `Gemini ${phase} 호출 제한/일시 오류: ${Math.round(delayMs / 1000)}초 후 재시도 (${attempt + 1}/${maxAttempts})`, {
            phase,
            status: response.status,
            attempt
          });
          await cancellableSleep(delayMs, throwIfCancelled);
          continue;
        }

        throw createHttpError(response.status, 'VERTEX_GEMINI_ANALYSIS_FAILED', `Vertex Gemini ${phase} analysis failed`, {
          status: response.status,
          endpoint,
          phase,
          response: data
        });
      } catch (error) {
        if (attempt < maxAttempts && isRetryableGeminiError(error)) {
          const delayMs = retryDelayMs(attempt, phase, getGeminiErrorStatus(error), options);
          emitProgress(onProgress, `Gemini ${phase} 네트워크/JSON 오류: ${Math.round(delayMs / 1000)}초 후 재시도 (${attempt + 1}/${maxAttempts})`, {
            phase,
            status: getGeminiErrorStatus(error),
            code: error.code || error.name || '',
            attempt
          });
          await cancellableSleep(delayMs, throwIfCancelled);
          continue;
        }
        throw error;
      }
    }

    throw createHttpError(500, 'VERTEX_GEMINI_ANALYSIS_FAILED', `Vertex Gemini ${phase} analysis failed`);
  }

  const filename = originalFilename || (filePath ? path.basename(filePath) : 'youtube_url');
  if (sourceWorkflowMode === 'longform_to_shorts' || sourceType === 'longform') {
    return runLongformGeminiPipeline({ generateJson, sourceUrl, filename, durationSec, sourceType, sourceWorkflowMode, metadataVariantMode, existingGuide, assignedHookType, onProgress, throwIfCancelled, fullDraftStagesDir, phaseRawResponses: latestPhaseRawResponses });
  }
  return runStandardGeminiPipeline({ generateJson, sourceUrl, filename, durationSec, sourceType, sourceWorkflowMode, metadataVariantMode, assignedHookType, onProgress, throwIfCancelled, fullDraftStagesDir, phaseRawResponses: latestPhaseRawResponses });
}

async function analyzeWithApiKey({ filePath, sourceUrl, apiKey, durationSec, originalFilename, sourceType = 'unknown', sourceWorkflowMode = 'unknown', metadataVariantMode = 'all', existingGuide = null, assignedHookType = null, onProgress, throwIfCancelled = null, fullDraftStagesDir = '' }) {
  if (!apiKey) {
    throw createHttpError(400, 'GEMINI_API_KEY_REQUIRED', 'GEMINI_API_KEY is required when GEMINI_AUTH_MODE is api_key');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const latestPhaseRawResponses = new Map();
  let videoPartPromise = null;
  const ensureVideoPart = async () => {
    if (!videoPartPromise) {
      videoPartPromise = buildApiKeyVideoPart({ filePath, sourceUrl, apiKey, throwIfCancelled });
    }
    return videoPartPromise;
  };

  async function generateJson(prompt, responseSchema, phase = 'json', options = {}) {
    const includeVideo = options.includeVideo !== false;
    const parts = includeVideo
      ? [
          await ensureVideoPart(),
          {
            text: prompt
          }
        ]
      : [
          {
            text: prompt
          }
    ];
    const maxAttempts = geminiMaxAttemptsForPhase(phase, options);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      checkCancellation(throwIfCancelled);
      try {
        emitProgress(onProgress, `Gemini ${phase} 요청 시작 (${attempt}/${maxAttempts})`, {
          phase,
          attempt,
          includeVideo
        });
        const model = genAI.getGenerativeModel({
          model: GEMINI_MODEL,
          generationConfig: buildMultimodalGenerationConfig({
            responseSchema,
            includeVideo
          })
        });
        const result = await withGeminiHeartbeat({
          onProgress,
          phase,
          label: `${phase} 요청 ${attempt}/${maxAttempts}`,
          timeoutMs: Number(options.timeoutMs || 0) > 0 ? Number(options.timeoutMs) : GEMINI_REQUEST_TIMEOUT_MS,
          throwIfCancelled,
          task: () => model.generateContent(parts)
        });
        checkCancellation(throwIfCancelled);
        const rawText = result?.response?.text?.() || '{}';
        latestPhaseRawResponses.set(phase, buildPhaseRawResponseEnvelope({
          backend: 'api_key',
          phase,
          response: result?.response || null,
          rawText
        }));
        const parsed = extractJson(rawText, { phase, attempt, filename });
        emitProgress(onProgress, `Gemini ${phase} 응답 JSON 파싱 완료 (${attempt}/${maxAttempts})`, {
          phase,
          attempt
        });
        return parsed;
      } catch (error) {
        const status = getGeminiErrorStatus(error);
        if (attempt < maxAttempts && isRetryableGeminiError(error)) {
          const delayMs = retryDelayMs(attempt, phase, status, options);
          emitProgress(onProgress, `Gemini ${phase} JSON/호출 오류: ${Math.round(delayMs / 1000)}초 뒤 같은 단계 재시도 (${attempt + 1}/${maxAttempts})`, {
            phase,
            status,
            code: error.code || '',
            attempt,
            raw_response_path: error.details?.raw_response_path || '',
            cleaned_response_path: error.details?.cleaned_response_path || ''
          });
          await cancellableSleep(delayMs, throwIfCancelled);
          continue;
        }
        throw error;
      }
    }
    throw createHttpError(500, 'GEMINI_ANALYSIS_FAILED', 'Gemini analysis failed');
  }

  const filename = originalFilename || (filePath ? path.basename(filePath) : 'youtube_url');
  if (sourceWorkflowMode === 'longform_to_shorts' || sourceType === 'longform') {
    return runLongformGeminiPipeline({ generateJson, sourceUrl, filename, durationSec, sourceType, sourceWorkflowMode, metadataVariantMode, existingGuide, assignedHookType, onProgress, throwIfCancelled, fullDraftStagesDir, phaseRawResponses: latestPhaseRawResponses });
  }
  return runStandardGeminiPipeline({ generateJson, sourceUrl, filename, durationSec, sourceType, sourceWorkflowMode, metadataVariantMode, assignedHookType, onProgress, throwIfCancelled, fullDraftStagesDir, phaseRawResponses: latestPhaseRawResponses });
}

async function analyzeOttogiProcessMetadata({ filePath, sourceUrl = '', apiKey, durationSec = 0, originalFilename = '', sourceType = 'unknown', sourceWorkflowMode = 'unknown', metadataVariantMode = 'all', existingGuide = null, assignedHookType = null, onProgress, throwIfCancelled = null, fullDraftStagesDir = '' }) {
  if (!filePath && !isYouTubeUrl(sourceUrl)) {
    throw createHttpError(400, 'SOURCE_VIDEO_REQUIRED', 'source video file is required');
  }

  if (isVertexAdcMode()) {
    return analyzeWithVertexAdc({ filePath, sourceUrl, durationSec, originalFilename, sourceType, sourceWorkflowMode, metadataVariantMode, existingGuide, assignedHookType, onProgress, throwIfCancelled, fullDraftStagesDir });
  }

  return analyzeWithApiKey({ filePath, sourceUrl, apiKey, durationSec, originalFilename, sourceType, sourceWorkflowMode, metadataVariantMode, existingGuide, assignedHookType, onProgress, throwIfCancelled, fullDraftStagesDir });
}

module.exports = {
  analyzeOttogiProcessMetadata,
  assertOttogiGuideLanguage,
  getGeminiAuthMode,
  isVertexAdcMode,
  isYouTubeUrl,
  testVertexAdcConnection,
  getVertexConfig,
  getVertexAccessToken,
  extractVertexResponseText,
  buildYoutubeFilePart,
  OUTPUT_CONFIG,
  calculateKoreanFullSpeechBudget,
  countKoreanFullScriptVisibleChars,
  countKoreanVisibleCharsNoSpaces,
  koreanFullSpeechBudgetFromGuide,
  outputLanguageForVariant,
  selectKoreanFullHookType,
  __test: {
    applyMetadataFieldRepair,
    applyLocalMetadataFallbacks,
    buildMetadataPrompt,
    buildReviewPrompt,
    collectJapaneseCaptionIssues,
    coerceStandardMetadataVariantModeForSource,
    enforcePublicMetadataLanguage,
    isKoreanFullScriptStyleRegenerationIssue,
    koreanFullDraftStyleViolations,
    selectKoreanFullHookType,
    normalizeGuide,
    validateOrRepairJapaneseCaptions,
    calculateKoreanFullSpeechBudget,
    countKoreanFullScriptVisibleChars,
    countKoreanVisibleCharsNoSpaces,
    koreanFullSpeechBudgetFromGuide,
    koreanFullSpeechBudgetPromptLines,
    koreanFullSceneSpeechBudgetPromptLines,
    sceneTransitionIdSet,
    assertRepairNormalizationDidNotCollapse,
    OTTOGI_METADATA_FIELD_REPAIR_SCHEMA,
    OTTOGI_FULL_CAPTION_SCRIPT_REPAIR_SCHEMA
  }
};

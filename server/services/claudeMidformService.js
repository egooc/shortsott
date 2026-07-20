const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createHttpError } = require('./errorService');
const { condenseGeminiAnalysis } = require('./midformSceneCondensationService');

const PROJECT_ROOT = path.join(__dirname, '../..');
const MIDFORM_PROMPT_DIR = path.join(PROJECT_ROOT, 'midform', 'prompts');
const MIDFORM_GENERATED_DIR = path.join(PROJECT_ROOT, 'midform', 'scripts_generated');
const DEFAULT_PROMPT_FILE = 'claude_script_midform.md';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_TEMPERATURE = 0.7;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function writeJsonWithBackup(targetPath, data) {
  ensureDir(path.dirname(targetPath));
  let backupPath = null;
  if (fs.existsSync(targetPath)) {
    const parsed = path.parse(targetPath);
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    backupPath = path.join(parsed.dir, `${parsed.name}.backup.${stamp}${parsed.ext || '.json'}`);
    fs.copyFileSync(targetPath, backupPath);
  }
  fs.writeFileSync(targetPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return { targetPath, backupPath };
}

function loadMidformPrompt(fileName = DEFAULT_PROMPT_FILE) {
  const rawName = String(fileName || '');
  const safeName = path.basename(rawName);
  if (!safeName || safeName !== rawName) {
    throw createHttpError(400, 'MIDFORM_PROMPT_INVALID', 'Invalid midform prompt file name', { fileName });
  }

  const promptPath = path.join(MIDFORM_PROMPT_DIR, safeName);
  if (!fs.existsSync(promptPath)) {
    throw createHttpError(500, 'MIDFORM_PROMPT_NOT_FOUND', 'Midform prompt file not found', { promptPath });
  }
  return fs.readFileSync(promptPath, 'utf8');
}

function createAnthropicClient(apiKey) {
  let AnthropicModule;
  try {
    AnthropicModule = require('@anthropic-ai/sdk');
  } catch (error) {
    throw createHttpError(500, 'ANTHROPIC_SDK_NOT_INSTALLED', '@anthropic-ai/sdk is not installed in this project', {
      packageName: '@anthropic-ai/sdk',
      cause: error.message
    });
  }

  const Anthropic = AnthropicModule.Anthropic || AnthropicModule.default || AnthropicModule;
  return new Anthropic({ apiKey });
}

function resolveAnthropicApiKey() {
  return String(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '').trim();
}

function buildUserMessage(geminiAnalysis, options = {}) {
  const useRawScenes = options.use_raw_scenes === true;
  const promptInput = useRawScenes
    ? geminiAnalysis
    : condenseGeminiAnalysis(geminiAnalysis, options.scene_condensation || {});
  const lines = [
    useRawScenes
      ? '다음은 Gemini가 분석한 영상 소스 정보입니다.'
      : '다음은 Gemini 분석 결과를 원고 작성용 scene_beats로 압축한 정보입니다.',
    '',
    JSON.stringify(promptInput, null, 2),
    '',
    useRawScenes
      ? '위 사실 재료를 기반으로 미드폼 대본을 생성하세요.'
      : 'scene_beats를 중심으로 미드폼 대본을 생성하되, source_scenes에는 원본 scene_id를 유지하세요.'
  ];

  if (options.style_hint) {
    lines.push('', `style_hint: ${String(options.style_hint)}`);
  }

  return lines.join('\n');
}

function stripCodeFence(text) {
  return String(text || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractJson(text) {
  const cleaned = stripCodeFence(text);
  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    const match = cleaned.match(/\{[\s\S]*\}$/);
    if (!match) {
      throw createHttpError(500, 'CLAUDE_MIDFORM_JSON_PARSE_ERROR', 'Claude response was not valid JSON', {
        raw_response: String(text || ''),
        parse_error: firstError.message
      });
    }

    try {
      return JSON.parse(match[0]);
    } catch (secondError) {
      throw createHttpError(500, 'CLAUDE_MIDFORM_JSON_PARSE_ERROR', 'Claude response JSON extraction failed', {
        raw_response: String(text || ''),
        extracted_json: match[0],
        parse_error: secondError.message
      });
    }
  }
}

function extractResponseText(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function normalizeTime(value) {
  return String(value || '').trim();
}

function sceneDurationSec(scene) {
  const start = Number(scene?.start_sec);
  const end = Number(scene?.end_sec);
  if (Number.isFinite(start) && Number.isFinite(end)) return Math.max(0, end - start);
  return null;
}

function extractSegmentSceneRefs(segment) {
  const sourceScenes = Array.isArray(segment?.source_scenes) ? segment.source_scenes : [];
  return sourceScenes
    .map((scene) => ({
      scene_id: String(scene?.scene_id || '').trim(),
      start: normalizeTime(scene?.start),
      end: normalizeTime(scene?.end),
      speed_multiplier: Number.isFinite(Number(scene?.speed_multiplier)) ? Number(scene.speed_multiplier) : 1
    }))
    .filter((scene) => scene.scene_id);
}

function hasBadKoreanEnding(text) {
  return /\?{2,}|？{2,}|~\?{2,}/.test(String(text || ''));
}

function validateScript(script, geminiAnalysis) {
  const sceneMap = new Map((Array.isArray(geminiAnalysis?.scenes) ? geminiAnalysis.scenes : [])
    .map((scene) => [String(scene?.scene_id || '').trim(), scene])
    .filter(([sceneId]) => sceneId));
  const invalidSceneRefs = [];
  const longSceneRefs = [];
  let koreanEndingRulesOk = true;

  for (const segment of script.segments || []) {
    if (hasBadKoreanEnding(segment?.narration) || hasBadKoreanEnding(segment?.caption_text)) {
      koreanEndingRulesOk = false;
    }

    for (const ref of extractSegmentSceneRefs(segment)) {
      const sourceScene = sceneMap.get(ref.scene_id);
      if (!sourceScene) {
        invalidSceneRefs.push(ref.scene_id);
        continue;
      }
      const duration = sceneDurationSec(sourceScene);
      if (duration !== null && duration > 30) {
        longSceneRefs.push(ref.scene_id);
      }
    }
  }

  const estimated = Number(script?.quality_check?.estimated_total_duration_sec || 0);
  return {
    segment_count: Array.isArray(script.segments) ? script.segments.length : 0,
    estimated_total_duration_sec: Number.isFinite(estimated) ? estimated : 0,
    duration_within_60_180: Number.isFinite(estimated) && estimated >= 60 && estimated <= 180,
    all_scene_ids_exist_in_gemini_analysis: invalidSceneRefs.length === 0,
    no_source_scene_exceeds_30_sec: longSceneRefs.length === 0,
    korean_ending_rules_ok: koreanEndingRulesOk,
    invalid_scene_refs: Array.from(new Set(invalidSceneRefs)),
    source_scenes_over_30_sec: Array.from(new Set(longSceneRefs))
  };
}

function normalizeScriptPayload(rawScript, geminiAnalysis, options = {}, scriptId = crypto.randomUUID()) {
  const source = geminiAnalysis?.source || {};
  const normalized = {
    script_id: String(rawScript?.script_id || scriptId),
    source_reference: {
      gemini_analysis_source_id: String(rawScript?.source_reference?.gemini_analysis_source_id || source.source_id || source.source_video || ''),
      duration_sec: Number(rawScript?.source_reference?.duration_sec || source.duration_sec || 0)
    },
    content_context: {
      content_guess: String(rawScript?.content_context?.content_guess || source.content_type || 'movie_midform_recap'),
      genre: String(rawScript?.content_context?.genre || geminiAnalysis?.story_context?.genre || ''),
      style_hint_used: String(rawScript?.content_context?.style_hint_used || options.style_hint || '')
    },
    segments: Array.isArray(rawScript?.segments) ? rawScript.segments : [],
    quality_check: rawScript?.quality_check && typeof rawScript.quality_check === 'object' ? rawScript.quality_check : {},
    created_at: String(rawScript?.created_at || new Date().toISOString())
  };

  const computedQuality = validateScript(normalized, geminiAnalysis);
  normalized.quality_check = {
    ...computedQuality,
    ...normalized.quality_check,
    segment_count: computedQuality.segment_count,
    all_scene_ids_exist_in_gemini_analysis: computedQuality.all_scene_ids_exist_in_gemini_analysis,
    no_source_scene_exceeds_30_sec: computedQuality.no_source_scene_exceeds_30_sec,
    korean_ending_rules_ok: computedQuality.korean_ending_rules_ok
  };

  return normalized;
}

function assertGeminiAnalysis(geminiAnalysis) {
  const required = ['source', 'story_context', 'scenes', 'characters', 'safety_scan', 'integrity_check'];
  const missing = required.filter((key) => geminiAnalysis?.[key] === undefined);
  if (missing.length) {
    throw createHttpError(400, 'MIDFORM_GEMINI_ANALYSIS_INVALID', 'Gemini L3 analysis is missing required fields', { missing });
  }
  if (!Array.isArray(geminiAnalysis.scenes) || geminiAnalysis.scenes.length === 0) {
    throw createHttpError(400, 'MIDFORM_GEMINI_SCENES_REQUIRED', 'Gemini analysis must include scenes');
  }
}

function isLiveAnthropicEnabled(options = {}) {
  return options.allow_live_call === true && String(process.env.CLAUDE_MIDFORM_ALLOW_LIVE || '').toLowerCase() === 'true';
}

async function callAnthropic({ systemPrompt, userMessage, options }) {
  if (!isLiveAnthropicEnabled(options)) {
    throw createHttpError(503, 'CLAUDE_MIDFORM_API_DISABLED', 'Anthropic API calls are disabled for Phase E syntax-only implementation', {
      enablement: 'Set CLAUDE_MIDFORM_ALLOW_LIVE=true and pass options.allow_live_call=true in a later integration phase.'
    });
  }

  const apiKey = resolveAnthropicApiKey();
  if (!apiKey) {
    throw createHttpError(400, 'ANTHROPIC_API_KEY_MISSING', 'ANTHROPIC_API_KEY is required for Claude midform generation', {
      acceptedFallback: 'CLAUDE_API_KEY'
    });
  }

  const client = createAnthropicClient(apiKey);
  try {
    return await client.messages.create({
      model: String(options.model || DEFAULT_MODEL),
      max_tokens: Number(options.maxTokens || DEFAULT_MAX_TOKENS),
      temperature: Number(options.temperature ?? DEFAULT_TEMPERATURE),
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userMessage
        }
      ]
    });
  } catch (error) {
    const status = error.status || error.statusCode || 500;
    if (status === 429) {
      throw createHttpError(429, 'CLAUDE_MIDFORM_RATE_LIMITED', 'Anthropic rate limit exceeded', {
        status,
        cause: error.message
      });
    }
    throw createHttpError(status, 'CLAUDE_MIDFORM_API_ERROR', 'Anthropic API call failed', {
      status,
      cause: error.message,
      details: error.error || error.response || null
    });
  }
}

async function generateMidformScript(geminiAnalysis, options = {}) {
  assertGeminiAnalysis(geminiAnalysis);

  const scriptId = String(options.scriptId || crypto.randomUUID());
  const systemPrompt = loadMidformPrompt(DEFAULT_PROMPT_FILE);
  const userMessage = buildUserMessage(geminiAnalysis, options);
  const message = await callAnthropic({ systemPrompt, userMessage, options });
  const responseText = extractResponseText(message);
  if (!responseText) {
    throw createHttpError(500, 'CLAUDE_MIDFORM_EMPTY_RESPONSE', 'Claude returned an empty text response', { response: message });
  }

  let parsed;
  try {
    parsed = extractJson(responseText);
  } catch (error) {
    if (error.status) throw error;
    throw createHttpError(500, 'CLAUDE_MIDFORM_JSON_PARSE_ERROR', 'Claude JSON parsing failed', {
      raw_response: responseText,
      cause: error.message
    });
  }

  return normalizeScriptPayload(parsed, geminiAnalysis, options, scriptId);
}

function saveMidformScript(script, outputPath) {
  return writeJsonWithBackup(outputPath || path.join(MIDFORM_GENERATED_DIR, `${script.script_id}.json`), script);
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  MIDFORM_PROMPT_DIR,
  MIDFORM_GENERATED_DIR,
  loadMidformPrompt,
  buildUserMessage,
  extractJson,
  normalizeScriptPayload,
  generateMidformScript,
  saveMidformScript
};

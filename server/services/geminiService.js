const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const { createHttpError } = require('./errorService');
const { loadPrompt } = require('./promptService');
const { getVideoMetadata } = require('../utils/ffprobe');
const {
  isVertexAdcMode,
  getVertexConfig,
  getVertexAccessToken,
  extractVertexResponseText
} = require('./processMetadataService');

const GEMINI_MODEL = 'gemini-2.5-flash';
const FILE_POLL_INTERVAL_MS = 5000;
const FILE_POLL_MAX_RETRIES = 180;

// 577-video batch hit sustained 429 RESOURCE_EXHAUSTED partway through.
// Confirmed by direct testing: plain text Vertex calls to gemini-2.5-pro
// succeed immediately while video-fileData (YouTube URL) calls 429 -- this is
// a per-minute-style quota specific to video-understanding requests, not a
// full daily block (Gemini's 429 body carries no quota-metric name or
// Retry-After header, unlike most other GCP APIs, so we can't read the exact
// limit -- only infer it from behavior). Throttle + backoff instead of firing
// calls back-to-back: shared module-level pacing since the batch queue is
// already single-concurrency by design.
const VERTEX_CALL_MIN_INTERVAL_MS = 20_000;
const VERTEX_CALL_MAX_INTERVAL_MS = 160_000;
const VERTEX_429_MAX_RETRIES = 6;
const DEFAULT_TIMELINE_MEDIA_RESOLUTION = 'MEDIA_RESOLUTION_LOW';
let vertexCallIntervalMs = VERTEX_CALL_MIN_INTERVAL_MS;
let vertexConsecutiveSuccesses = 0;
let vertexLastCallAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttleVertexCall() {
  const wait = vertexLastCallAt + vertexCallIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  vertexLastCallAt = Date.now();
}

function onVertex429() {
  vertexCallIntervalMs = Math.min(VERTEX_CALL_MAX_INTERVAL_MS, vertexCallIntervalMs * 2);
  vertexConsecutiveSuccesses = 0;
}

// The 429 seen in production held for 7+ hours straight -- too long for the
// interval-doubling above to be the right response on its own (it would take
// hours of failed batch videos, each burning a full retry budget, to reach
// the point this resets from). Callers doing an out-of-band recovery probe
// (a single lightweight call, outside the batch queue) should call this once
// the probe succeeds, so the real batch resumes at a deliberately
// conservative pace rather than whatever the interval decayed/escalated to.
function resetVertexThrottle(intervalMs = VERTEX_CALL_MIN_INTERVAL_MS) {
  vertexCallIntervalMs = intervalMs;
  vertexConsecutiveSuccesses = 0;
  vertexLastCallAt = 0;
}

// Ease the interval back down after a sustained run of clean calls, so a
// short burst of throttling from other traffic doesn't permanently slow the
// batch once the quota window recovers.
function onVertexSuccess() {
  vertexConsecutiveSuccesses += 1;
  if (vertexConsecutiveSuccesses >= 5 && vertexCallIntervalMs > VERTEX_CALL_MIN_INTERVAL_MS) {
    vertexCallIntervalMs = Math.max(VERTEX_CALL_MIN_INTERVAL_MS, Math.round(vertexCallIntervalMs / 2));
    vertexConsecutiveSuccesses = 0;
  }
}

const GEMINI_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    source: {
      type: 'object',
      properties: {
        source_id: { type: 'string' },
        filename: { type: 'string' },
        duration_sec: { type: 'number' },
        duration_timecode: { type: 'string' },
        aspect_ratio: { type: 'string' },
        has_burned_subtitles: { type: 'boolean' },
        has_watermark: { type: 'boolean' },
        overall_summary: { type: 'string' },
        content_type: { type: 'string' }
      },
      required: ['source_id', 'duration_sec', 'duration_timecode', 'overall_summary', 'content_type']
    },
    safety_scan: {
      type: 'object',
      properties: {
        violence: {
          type: 'object',
          properties: {
            exists: { type: 'boolean' },
            timecodes: { type: 'array', items: { type: 'string' } },
            note: { type: 'string' }
          },
          required: ['exists']
        },
        sexual_content: {
          type: 'object',
          properties: {
            exists: { type: 'boolean' },
            timecodes: { type: 'array', items: { type: 'string' } },
            note: { type: 'string' }
          },
          required: ['exists']
        },
        gore_or_shocking: {
          type: 'object',
          properties: {
            exists: { type: 'boolean' },
            timecodes: { type: 'array', items: { type: 'string' } },
            note: { type: 'string' }
          },
          required: ['exists']
        },
        child_safety: {
          type: 'object',
          properties: {
            exists: { type: 'boolean' },
            timecodes: { type: 'array', items: { type: 'string' } },
            note: { type: 'string' }
          },
          required: ['exists']
        },
        monetization_risk: { type: 'string', enum: ['low', 'medium', 'high'] }
      },
      required: ['violence', 'sexual_content', 'gore_or_shocking', 'child_safety', 'monetization_risk']
    },
    characters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          character_id: { type: 'string' },
          display_name: { type: 'string' },
          safe_display_name: { type: 'string' },
          visual_description: { type: 'string' },
          role_in_story: { type: 'string' }
        },
        required: ['character_id', 'safe_display_name', 'role_in_story']
      }
    },
    story_structure: {
      type: 'object',
      properties: {
        hook: {
          type: 'object',
          properties: {
            timecode: { type: 'string' },
            visual_evidence: { type: 'string' },
            reason: { type: 'string' }
          },
          required: ['timecode', 'visual_evidence']
        },
        setup: {
          type: 'object',
          properties: {
            timecode_range: { type: 'string' },
            summary: { type: 'string' }
          },
          required: ['timecode_range', 'summary']
        },
        conflict: {
          type: 'object',
          properties: {
            timecode_range: { type: 'string' },
            summary: { type: 'string' }
          },
          required: ['timecode_range', 'summary']
        },
        turning_point: {
          type: 'object',
          properties: {
            timecode_range: { type: 'string' },
            summary: { type: 'string' }
          },
          required: ['timecode_range', 'summary']
        },
        reveal_or_climax: {
          type: 'object',
          properties: {
            timecode_range: { type: 'string' },
            summary: { type: 'string' }
          },
          required: ['timecode_range', 'summary']
        },
        ending: {
          type: 'object',
          properties: {
            timecode_range: { type: 'string' },
            summary: { type: 'string' }
          },
          required: ['timecode_range', 'summary']
        }
      },
      required: ['hook', 'setup', 'conflict', 'turning_point', 'reveal_or_climax', 'ending']
    },
    clips: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          clip_id: { type: 'string' },
          source_id: { type: 'string' },
          raw_in: { type: 'string' },
          raw_out: { type: 'string' },
          safe_in: { type: 'string' },
          safe_out: { type: 'string' },
          duration_sec: { type: 'number' },
          visual_evidence: { type: 'string' },
          characters: { type: 'array', items: { type: 'string' } },
          action: { type: 'string' },
          emotion: { type: 'string' },
          story_role: { type: 'string' },
          visual_strength: { type: 'integer' },
          story_importance: { type: 'integer' },
          dopamine_strength: { type: 'integer' },
          usable: { type: 'boolean' }
        },
        required: ['clip_id', 'source_id', 'raw_in', 'raw_out', 'safe_in', 'safe_out', 'duration_sec', 'visual_evidence', 'story_role', 'usable']
      }
    },
    dopamine_anchors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rank: { type: 'integer' },
          clip_id: { type: 'string' },
          timecode: { type: 'string' },
          type: { type: 'string' },
          strength: { type: 'integer' },
          visual_evidence: { type: 'string' },
          why_it_works: { type: 'string' }
        },
        required: ['rank', 'clip_id', 'timecode', 'strength', 'visual_evidence']
      }
    },
    recommended_story_angles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          angle_id: { type: 'string' },
          title: { type: 'string' },
          core_argument: { type: 'string' },
          recommended_duration_sec: { type: 'integer' },
          reason: { type: 'string' },
          required_clip_ids: { type: 'array', items: { type: 'string' } },
          risk_level: { type: 'string', enum: ['low', 'medium', 'high'] }
        },
        required: ['angle_id', 'title', 'core_argument', 'recommended_duration_sec']
      }
    },
    integrity_check: {
      type: 'object',
      properties: {
        all_timecodes_within_source_duration: { type: 'boolean' },
        all_clips_have_visual_evidence: { type: 'boolean' },
        all_visual_evidence_min_15_chars: { type: 'boolean' }
      },
      required: ['all_timecodes_within_source_duration', 'all_clips_have_visual_evidence', 'all_visual_evidence_min_15_chars']
    }
  },
  required: ['source', 'safety_scan', 'characters', 'story_structure', 'clips', 'dopamine_anchors', 'recommended_story_angles', 'integrity_check']
};

const ACTION_PHASE_ENUM = ['FULL_ARC', 'IMPACT_CENTERED', 'PRE_IMPACT_CUT', 'RESULT_ONLY', 'MID_PROCESS', 'UNKNOWN'];
const MOMENT_TYPE_ENUM = ['CUT_THROUGH', 'CRUSH', 'PERFECT_FIT', 'SEPARATION', 'TRANSFORMATION', 'EJECTION', 'ALIGNMENT', 'UNKNOWN'];
const CAMERA_ENUM = ['FIXED', 'HANDHELD', 'TRACKING', 'UNKNOWN'];
const SUBJECT_SCALE_ENUM = ['MACRO', 'CLOSEUP', 'MEDIUM', 'WIDE', 'UNKNOWN'];
const MOTION_DIRECTION_ENUM = ['DOWN', 'UP', 'LATERAL', 'ROTATIONAL', 'TOWARD_CAMERA', 'NONE', 'UNKNOWN'];
const HUMAN_VISIBLE_ENUM = ['HANDS_ONLY', 'FULL_PERSON', 'NONE'];
const SPEED_APPEARANCE_ENUM = ['REAL_TIME', 'SPED_UP', 'SLOWED', 'UNKNOWN'];
const TIMELINE_EVENT_TYPE_ENUM = ['IMPACT', 'RESULT_REVEAL', 'RESET'];
// v2.1: loop_seam is no longer a Gemini judgment call (autopsy of the 8 v2.0
// reproducibility failures showed 2/2 loop_seam flips happened even when SSIM
// was unambiguous -- the instability was semantic, not perceptual). Gemini now
// only reports action_is_repetitive; loop_seam is derived deterministically
// from seam_score + that boolean (see loopSeam.js's deriveLoopSeam).
const PROMPT_VERSION = 'moment-v2.1';
const TIMELINE_PROMPT_VERSION = 'timeline-v1';

const HIGHLIGHT_PATTERN_SCHEMA = {
  type: 'object',
  properties: {
    action_described: { type: 'string' },
    material: { type: 'string' },
    tool_or_machine: { type: 'string' },
    action_phase: { type: 'string', enum: ACTION_PHASE_ENUM },
    action_is_repetitive: { type: 'boolean' },
    peak_moment_time: { type: 'number' },
    moment_type: { type: 'string', enum: MOMENT_TYPE_ENUM },
    first_frame_description: { type: 'string' },
    last_frame_description: { type: 'string' },
    readable_in_half_second: { type: 'boolean' },
    camera: { type: 'string', enum: CAMERA_ENUM },
    subject_scale: { type: 'string', enum: SUBJECT_SCALE_ENUM },
    motion_direction: { type: 'string', enum: MOTION_DIRECTION_ENUM },
    human_visible: { type: 'string', enum: HUMAN_VISIBLE_ENUM },
    has_text_overlay: { type: 'boolean' },
    speed_appearance: { type: 'string', enum: SPEED_APPEARANCE_ENUM }
  },
  required: [
    'action_described',
    'action_phase',
    'action_is_repetitive',
    'moment_type',
    'first_frame_description',
    'last_frame_description',
    'readable_in_half_second',
    'camera',
    'subject_scale',
    'motion_direction',
    'human_visible',
    'has_text_overlay',
    'speed_appearance'
  ]
};

const ACTION_TIMELINE_SCHEMA = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          time: { type: 'number' },
          type: { type: 'string', enum: TIMELINE_EVENT_TYPE_ENUM },
          description: { type: 'string' }
        },
        required: ['time', 'type', 'description']
      }
    }
  },
  required: ['events']
};

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const cleaned = String(text || '')
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/, '');
    const match = cleaned.match(/\{[\s\S]*\}$/);
    if (!match) {
      throw createHttpError(500, 'GEMINI_JSON_PARSE_ERROR', 'Gemini response was not valid JSON', { snippet: text.slice(0, 400) });
    }
    return JSON.parse(match[0]);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeFileState(file) {
  return String(file?.state || '').toUpperCase();
}

function geminiPrompt(contentType) {
  const promptTemplate = loadPrompt('gemini_analysis.txt');
  return promptTemplate.replace('{contentType}', contentType || 'general');
}

function validateRequiredTopLevelFields(parsed) {
  const required = [
    'source',
    'safety_scan',
    'characters',
    'story_structure',
    'clips',
    'dopamine_anchors',
    'recommended_story_angles',
    'integrity_check'
  ];
  const missing = required.filter((key) => parsed?.[key] === undefined);
  if (missing.length > 0) {
    throw createHttpError(500, 'GEMINI_SCHEMA_VALIDATION_FAILED', 'Gemini response is missing required fields', { missing });
  }
}

async function uploadAndWaitForGeminiFile(fileManager, filePath, displayNamePrefix) {
  const uploadResult = await fileManager.uploadFile(filePath, {
    mimeType: 'video/mp4',
    displayName: `${displayNamePrefix}_${Date.now()}`
  });

  let uploadedFile = uploadResult.file;
  let tries = 0;
  while (normalizeFileState(uploadedFile) === 'PROCESSING') {
    if (tries >= FILE_POLL_MAX_RETRIES) {
      throw createHttpError(504, 'GEMINI_FILE_PROCESSING_TIMEOUT', 'Gemini file processing timed out');
    }
    await sleep(FILE_POLL_INTERVAL_MS);
    uploadedFile = await fileManager.getFile(uploadedFile.name);
    tries += 1;
  }

  if (normalizeFileState(uploadedFile) === 'FAILED') {
    throw createHttpError(500, 'GEMINI_FILE_PROCESSING_FAILED', 'Gemini file processing failed', { file: uploadedFile });
  }

  return uploadedFile;
}

async function analyzeVideo(filePath, contentType, apiKey) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const fileManager = new GoogleAIFileManager(apiKey);
  const uploadedFile = await uploadAndWaitForGeminiFile(fileManager, filePath, 'analysis');

  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: GEMINI_ANALYSIS_SCHEMA
    }
  });

  let result;
  try {
    result = await model.generateContent([
      {
        fileData: {
          mimeType: uploadedFile.mimeType,
          fileUri: uploadedFile.uri
        }
      },
      { text: geminiPrompt(contentType) }
    ]);
  } catch (error) {
    throw createHttpError(500, 'GEMINI_API_ERROR', error.message, { cause: error?.stack || String(error) });
  }

  const rawText = result?.response?.text?.() || '{}';
  const parsed = extractJson(rawText);
  validateRequiredTopLevelFields(parsed);
  return parsed;
}

function validateRequiredHighlightPatternFields(parsed) {
  const required = [
    'action_described',
    'action_phase',
    'action_is_repetitive',
    'moment_type',
    'first_frame_description',
    'last_frame_description',
    'readable_in_half_second',
    'camera',
    'subject_scale',
    'motion_direction',
    'human_visible',
    'has_text_overlay',
    'speed_appearance'
  ];
  const missing = required.filter((key) => parsed?.[key] === undefined);
  if (missing.length > 0) {
    throw createHttpError(500, 'GEMINI_SCHEMA_VALIDATION_FAILED', 'Gemini moment pattern response is missing required fields', { missing });
  }
}

const HEDGE_LANGUAGE_PATTERN = /\b(likely|probably|possibly|seems to be|appears to be a)\b/i;

// Non-fatal: the prompt explicitly tells the model never to hedge when
// classifying, so hedge words surviving into action_described are a signal the
// model guessed at something off-screen (confirmed cause of one v2.0
// reproducibility failure). Flag it rather than discarding an otherwise-usable
// analysis -- the caller decides whether to act on the warning.
function detectHallucinationGuardViolation(parsed) {
  const text = String(parsed?.action_described || '');
  return HEDGE_LANGUAGE_PATTERN.test(text) ? text : null;
}

function validateActionTimelineResponse(parsed) {
  if (!Array.isArray(parsed?.events)) {
    throw createHttpError(500, 'GEMINI_SCHEMA_VALIDATION_FAILED', 'Gemini action timeline response is missing an events array');
  }
}

function normalizeActionTimelineEvents(events = [], sourceDurationSec = 0) {
  const normalizedEvents = [];
  const stats = {
    source_duration_sec: Number(Number(sourceDurationSec || 0).toFixed(3)),
    original_event_count: Array.isArray(events) ? events.length : 0,
    kept_event_count: 0,
    clamped_event_count: 0,
    dropped_event_count: 0,
    dropped_out_of_range_count: 0,
    dropped_invalid_type_count: 0,
    dropped_invalid_time_count: 0,
    max_original_time_sec: 0,
    max_kept_time_sec: 0
  };

  const safeSourceDurationSec = Number(sourceDurationSec || 0);
  const clampToleranceSec = 0.25;
  const validTypes = new Set(['IMPACT', 'RESULT_REVEAL', 'RESET']);

  for (const rawEvent of Array.isArray(events) ? events : []) {
    const rawTime = Number(rawEvent?.time ?? rawEvent?.start_time ?? rawEvent?.end_time);
    const rawType = String(rawEvent?.type || rawEvent?.event_type || '').trim();
    if (!Number.isFinite(rawTime)) {
      stats.dropped_event_count += 1;
      stats.dropped_invalid_time_count += 1;
      continue;
    }
    stats.max_original_time_sec = Math.max(stats.max_original_time_sec, rawTime);
    if (!validTypes.has(rawType)) {
      stats.dropped_event_count += 1;
      stats.dropped_invalid_type_count += 1;
      continue;
    }

    let nextTime = rawTime;
    let clamped = false;
    if (safeSourceDurationSec > 0) {
      if (rawTime < -clampToleranceSec || rawTime > safeSourceDurationSec + clampToleranceSec) {
        stats.dropped_event_count += 1;
        stats.dropped_out_of_range_count += 1;
        continue;
      }
      const boundedTime = Math.max(0, Math.min(safeSourceDurationSec, rawTime));
      clamped = Math.abs(boundedTime - rawTime) > 0.0001;
      nextTime = boundedTime;
    }

    if (clamped) stats.clamped_event_count += 1;
    const normalizedEvent = {
      time: Number(nextTime.toFixed(3)),
      type: rawType,
      description: String(rawEvent?.description || '').trim()
    };
    normalizedEvents.push(normalizedEvent);
    stats.max_kept_time_sec = Math.max(stats.max_kept_time_sec, normalizedEvent.time);
  }

  normalizedEvents.sort((a, b) => a.time - b.time || a.type.localeCompare(b.type));
  stats.kept_event_count = normalizedEvents.length;
  stats.max_original_time_sec = Number(stats.max_original_time_sec.toFixed(3));
  stats.max_kept_time_sec = Number(stats.max_kept_time_sec.toFixed(3));
  return { events: normalizedEvents, stats };
}

async function callVertexGemini({ filePath, promptFile, schema, model, mediaResolution = '' }) {
  const config = getVertexConfig();
  if (!config.project) {
    throw createHttpError(400, 'GOOGLE_CLOUD_PROJECT_REQUIRED', 'GOOGLE_CLOUD_PROJECT is required for Vertex ADC mode');
  }

  const effectiveModel = model || config.model;
  const token = await getVertexAccessToken();
  // The 429 that stalled the batch for 13+ hours was regional Dynamic Shared
  // Quota contention on us-central1, not a real per-project/per-day limit --
  // confirmed by testing: the global endpoint (no region prefix, no per-region
  // capacity competition) returned 200 immediately while the regional one was
  // still failing. Google's own first-line recommendation for this error.
  // Uses the global endpoint unconditionally for this call; config.location is
  // still used elsewhere (e.g. channel/video metadata calls) unaffected by this.
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/${config.project}/locations/global/publishers/google/models/${effectiveModel}:generateContent`;

  // Switched from referencing the YouTube URL directly (fileData/fileUri,
  // Vertex's "YouTube video understanding" feature) to uploading the already-
  // downloaded local file as inline base64 data. The 577-video batch hit a
  // sustained (7+ hour) 429 RESOURCE_EXHAUSTED specifically on YouTube-URL
  // video calls while plain text calls kept succeeding -- consistent with
  // YouTube-URL understanding being a separate, much more constrained quota
  // from normal file-based multimodal input. Same inlineData pattern already
  // used by the legacy pipeline's analyzeWithVertexAdc for non-YouTube inputs.
  const videoPart = {
    inlineData: {
      mimeType: 'video/mp4',
      data: fs.readFileSync(filePath).toString('base64')
    }
  };

  for (let attempt = 1; attempt <= VERTEX_429_MAX_RETRIES; attempt += 1) {
    await throttleVertexCall();

    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [videoPart, { text: loadPrompt(promptFile) }]
            }
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: schema,
            temperature: 0.1,
            ...(mediaResolution ? { mediaResolution } : {})
          }
        })
      });
    } catch (error) {
      throw createHttpError(500, 'VERTEX_GEMINI_ANALYSIS_FAILED', error.message, { cause: error?.stack || String(error) });
    }

    if (response.status === 429) {
      onVertex429();
      if (attempt === VERTEX_429_MAX_RETRIES) {
        const data = await response.json().catch(() => ({}));
        throw createHttpError(429, 'VERTEX_GEMINI_ANALYSIS_FAILED', 'Vertex Gemini analysis failed', { status: 429, response: data });
      }
      const retryAfterHeader = Number(response.headers.get('retry-after'));
      const jitter = Math.random() * 5000;
      const waitMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000 + jitter
        : vertexCallIntervalMs + jitter;
      await sleep(waitMs);
      continue;
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw createHttpError(response.status, 'VERTEX_GEMINI_ANALYSIS_FAILED', 'Vertex Gemini analysis failed', {
        status: response.status,
        response: data
      });
    }

    onVertexSuccess();
    return { parsed: extractJson(extractVertexResponseText(data)), modelVersion: effectiveModel };
  }

  // Unreachable: the loop always returns or throws on its final iteration.
  throw createHttpError(500, 'VERTEX_GEMINI_ANALYSIS_FAILED', 'Vertex Gemini analysis failed after retries');
}

async function callApiKeyGemini({ filePath, promptFile, schema, apiKey, displayNamePrefix, model, mediaResolution = '' }) {
  const effectiveModel = model || GEMINI_MODEL;
  const genAI = new GoogleGenerativeAI(apiKey);
  const fileManager = new GoogleAIFileManager(apiKey);
  const uploadedFile = await uploadAndWaitForGeminiFile(fileManager, filePath, displayNamePrefix);

  const genModel = genAI.getGenerativeModel({
    model: effectiveModel,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      temperature: 0.1,
      ...(mediaResolution ? { mediaResolution } : {})
    }
  });

  let result;
  try {
    result = await genModel.generateContent([
      {
        fileData: {
          mimeType: uploadedFile.mimeType,
          fileUri: uploadedFile.uri
        }
      },
      { text: loadPrompt(promptFile) }
    ]);
  } catch (error) {
    throw createHttpError(500, 'GEMINI_API_ERROR', error.message, { cause: error?.stack || String(error) });
  }

  const rawText = result?.response?.text?.() || '{}';
  return { parsed: extractJson(rawText), modelVersion: effectiveModel };
}

// Calibration (30 videos x pro/flash x 2 repeats) showed gemini-2.5-pro is
// meaningfully more reproducible than flash overall (8/30 vs 17/30 videos had a
// key field flip between repeats) and specifically far more reliable for
// loop_seam (2/30 vs 9/30 reproducibility failures; 0/5 vs 5/5 SSIM
// contradictions -- flash systematically over-calls SEAMLESS on frames that are
// visibly different). Default to pro for real batch analysis; caller can still
// override for testing.
const MOMENT_ANALYSIS_DEFAULT_MODEL = 'gemini-2.5-pro';

async function analyzeMomentPattern({ filePath, sourceUrl, apiKey, model }) {
  const effectiveModel = model || MOMENT_ANALYSIS_DEFAULT_MODEL;
  const { parsed, modelVersion } = isVertexAdcMode()
    ? await callVertexGemini({ filePath, promptFile: 'highlight_pattern_analysis.txt', schema: HIGHLIGHT_PATTERN_SCHEMA, model: effectiveModel })
    : await callApiKeyGemini({ filePath, promptFile: 'highlight_pattern_analysis.txt', schema: HIGHLIGHT_PATTERN_SCHEMA, apiKey, displayNamePrefix: 'moment_pattern', model: effectiveModel });
  validateRequiredHighlightPatternFields(parsed);
  return { analysis: parsed, modelVersion, promptVersion: PROMPT_VERSION };
}

async function extractActionTimeline({ filePath, sourceUrl, apiKey }) {
  const preferVertexAdc = isVertexAdcMode();
  const fallbackApiKey = String(apiKey || process.env.GEMINI_API_KEY || '').trim();

  let parsed;
  let modelVersion;

  if (preferVertexAdc) {
    ({ parsed, modelVersion } = await callVertexGemini({
      filePath,
      promptFile: 'action_timeline_extraction.txt',
      schema: ACTION_TIMELINE_SCHEMA,
      mediaResolution: DEFAULT_TIMELINE_MEDIA_RESOLUTION
    }));
  }

  if (!parsed) {
    if (!fallbackApiKey) {
      throw createHttpError(400, 'GEMINI_TIMELINE_AUTH_UNAVAILABLE', 'Timeline extraction requires Vertex ADC mode or a Gemini API key fallback');
    }
    ({ parsed, modelVersion } = await callApiKeyGemini({
      filePath,
      promptFile: 'action_timeline_extraction.txt',
      schema: ACTION_TIMELINE_SCHEMA,
      apiKey: fallbackApiKey,
      displayNamePrefix: 'action_timeline',
      mediaResolution: DEFAULT_TIMELINE_MEDIA_RESOLUTION
    }));
  }

  validateActionTimelineResponse(parsed);
  const sourceDurationSec = Number(getVideoMetadata(filePath)?.duration_sec || 0);
  const normalization = normalizeActionTimelineEvents(parsed.events, sourceDurationSec);
  if (normalization.stats.clamped_event_count > 0 || normalization.stats.dropped_event_count > 0) {
    console.warn('[timeline-normalization]', JSON.stringify({
      filePath,
      sourceUrl,
      ...normalization.stats
    }));
  }
  return {
    events: normalization.events,
    modelVersion,
    promptVersion: TIMELINE_PROMPT_VERSION,
    normalization: normalization.stats
  };
}

module.exports = { analyzeVideo, analyzeMomentPattern, extractActionTimeline, detectHallucinationGuardViolation, resetVertexThrottle, normalizeActionTimelineEvents };

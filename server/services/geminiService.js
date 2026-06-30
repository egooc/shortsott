const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const { createHttpError } = require('./errorService');
const { loadPrompt } = require('./promptService');

const GEMINI_MODEL = 'gemini-2.5-flash';
const FILE_POLL_INTERVAL_MS = 5000;
const FILE_POLL_MAX_RETRIES = 180;

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

async function analyzeVideo(filePath, contentType, apiKey) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const fileManager = new GoogleAIFileManager(apiKey);

  const uploadResult = await fileManager.uploadFile(filePath, {
    mimeType: 'video/mp4',
    displayName: `analysis_${Date.now()}`
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

module.exports = { analyzeVideo };

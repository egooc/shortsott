const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true });

const claudeScriptSchema = {
  type: 'object',
  required: ['project', 'source_ref', 'story', 'segments', 'metadata', 'quality_check'],
  properties: {
    project: {
      type: 'object',
      required: ['target_duration_sec', 'language', 'tone']
    },
    source_ref: {
      type: 'object',
      required: ['source_id', 'based_on_gemini_analysis']
    },
    story: {
      type: 'object',
      required: ['title', 'core_argument']
    },
    segments: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['segment_id', 'order', 'argument_part', 'narration', 'source_clips', 'edit_instruction'],
        properties: {
          source_clips: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['clip_id', 'start', 'end', 'visual_evidence']
            }
          },
          edit_instruction: {
            type: 'object',
            required: ['visual_role', 'pace', 'transition']
          }
        }
      }
    },
    quality_check: {
      type: 'object',
      required: ['segment_count', 'estimated_total_duration_sec', 'all_clip_ids_exist_in_gemini_analysis']
    }
  }
};

const validateClaudeScript = ajv.compile(claudeScriptSchema);

function validate(data) {
  const valid = validateClaudeScript(data);
  if (!valid) {
    return { valid: false, errors: validateClaudeScript.errors };
  }
  return { valid: true };
}

function crossValidateClipIds(claudeScript, geminiAnalysis) {
  const geminiClipIds = new Set((geminiAnalysis?.clips || []).map((clip) => clip.clip_id));
  const errors = [];

  for (const segment of claudeScript?.segments || []) {
    for (const clip of segment?.source_clips || []) {
      if (!geminiClipIds.has(clip.clip_id)) {
        errors.push(`seg ${segment.segment_id}: clip_id ${clip.clip_id} not found in Gemini analysis`);
      }
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

module.exports = { validate, crossValidateClipIds };

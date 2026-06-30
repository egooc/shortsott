const { createHttpError } = require('./errorService');
const { loadPrompt } = require('./promptService');
const { validate, crossValidateClipIds } = require('../utils/validateSchema');

function extractJson(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '');

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}$/);
    if (!match) {
      throw createHttpError(500, 'CLAUDE_JSON_PARSE_ERROR', 'Claude response was not valid JSON', {
        snippet: cleaned.slice(0, 400)
      });
    }
    return JSON.parse(match[0]);
  }
}

async function generateScript(geminiAnalysis, options, apiKey) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      system: loadPrompt('claude_script.txt'),
      messages: [
        {
          role: 'user',
          content: `## Gemini 영상 분석 결과\n${JSON.stringify(geminiAnalysis, null, 2)}\n\n## 요청\n- Story Angle: ${options.storyAngle}\n- Target Duration: ${options.targetDuration}초\n- Tone: ${options.tone}\n- Content Type: ${options.contentType}\n\n위 분석 결과를 기반으로 JSON 스키마에 맞는 대본과 편집점을 생성하세요.`
        }
      ]
    })
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw createHttpError(response.status, 'CLAUDE_API_ERROR', `Claude API returned ${response.status}`, data);
  }

  const scriptText = data?.content?.find((item) => item.type === 'text')?.text || '{}';
  const parsed = extractJson(scriptText);

  const validation = validate(parsed);
  if (!validation.valid) {
    throw createHttpError(500, 'CLAUDE_SCHEMA_VALIDATION_FAILED', 'Claude output schema validation failed', {
      errors: validation.errors || []
    });
  }

  const clipValidation = crossValidateClipIds(parsed, geminiAnalysis);
  if (!clipValidation.valid) {
    throw createHttpError(500, 'CLAUDE_CLIP_ID_VALIDATION_FAILED', 'Claude output clip references are invalid', {
      errors: clipValidation.errors || []
    });
  }

  return parsed;
}

module.exports = { generateScript };

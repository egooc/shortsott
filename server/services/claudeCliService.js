const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { createHttpError } = require('./errorService');
const {
  loadTemplateBundle,
  getTemplate
} = require('./claudeTemplateService');
const { validate, crossValidateClipIds } = require('../utils/validateSchema');
const { PROJECT_ROOT, writeJsonWithBackup, readJsonIfExists, ensureProjectFolders } = require('./pipelinePaths');

const GEMINI_ANALYSIS_PATH = path.join(PROJECT_ROOT, 'analysis', 'gemini_analysis.json');
const GEMINI_REVIEW_PATH = path.join(PROJECT_ROOT, 'analysis', 'gemini_review.json');
const CLAUDE_SCRIPT_PATH = path.join(PROJECT_ROOT, 'script', 'claude_midform_story.json');
const CLAUDE_REVIEW_PATH = path.join(PROJECT_ROOT, 'script', 'claude_review.json');
const CLAUDE_ERROR_LOG_PATH = path.join(PROJECT_ROOT, 'output', 'claude_generation_error.md');
const CLAUDE_PROMPT_WORK_DIR = path.join(PROJECT_ROOT, 'work', 'prompts');

const CLAUDE_SCRIPT_SCHEMA = {
  type: 'object',
  required: ['project', 'source_ref', 'story', 'segments', 'metadata', 'quality_check'],
  properties: {
    project: {
      type: 'object',
      properties: {
        target_duration_sec: { type: 'number' },
        language: { type: 'string' },
        tone: { type: 'string' }
      }
    },
    source_ref: {
      type: 'object',
      properties: {
        source_id: { type: 'string' },
        based_on_gemini_analysis: { type: 'boolean' }
      }
    },
    story: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        core_argument: { type: 'string' }
      }
    },
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          segment_id: { type: 'string' },
          order: { type: 'integer' },
          argument_part: { type: 'string' },
          narration: { type: 'string' },
          source_clips: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                clip_id: { type: 'string' },
                scene_id: { type: 'string' },
                start: { type: 'string' },
                end: { type: 'string' },
                visual_evidence: { type: 'string' }
              }
            }
          },
          edit_instruction: { type: 'object' }
        }
      }
    },
    metadata: { type: 'object' },
    quality_check: { type: 'object' }
  }
};

function nowStamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

function getClaudeOAuthToken() {
  return process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_OAUTH_TOKEN || '';
}

function resolveClaudeCommand() {
  if (process.platform !== 'win32') {
    return { command: 'claude', args: ['-p'] };
  }

  const candidates = [];
  for (const query of ['claude.cmd', 'claude']) {
    try {
      const output = execFileSync('where.exe', [query], { encoding: 'utf8' });
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => candidates.push(line));
    } catch {
      // ignore and continue fallback
    }
  }

  const cmdCandidate = candidates.find((item) => item.toLowerCase().endsWith('.cmd'));
  const exeCandidate = candidates.find((item) => item.toLowerCase().endsWith('.exe'));
  const fallback = cmdCandidate || exeCandidate || 'claude';

  if (String(fallback).toLowerCase().endsWith('.cmd')) {
    return {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'claude -p']
    };
  }

  return { command: fallback, args: ['-p'] };
}

function buildClaudePrompt({ geminiAnalysis, geminiReview, templateBundle, options = {} }) {
  const details = {
    storyAngle: options.storyAngle || 'A-01',
    targetDuration: Number(options.targetDuration || 90),
    tone: options.tone || 'perspective',
    contentType: options.contentType || geminiAnalysis?.source?.content_type || 'movie_recap'
  };
  const selectedSource = geminiAnalysis?.selected_source || {};
  const templateMeta = templateBundle?.template || {};

  return [
    '## Common Rules',
    templateBundle?.common_rules || '',
    '',
    '## Template Prompt',
    templateBundle?.template_prompt || '',
    '',
    '## Common Output Schema',
    templateBundle?.common_output_schema || '',
    '',
    '## Runtime JSON Schema',
    JSON.stringify(CLAUDE_SCRIPT_SCHEMA, null, 2),
    '',
    '## Gemini Analysis JSON',
    JSON.stringify(geminiAnalysis, null, 2),
    '',
    '## Gemini Review JSON',
    JSON.stringify(geminiReview || {}, null, 2),
    '',
    '## Selected Source (Operational Metadata)',
    JSON.stringify(selectedSource, null, 2),
    '',
    '## Request',
    `- Template ID: ${templateMeta.template_id || 'movie_recap'}`,
    `- Story Angle: ${details.storyAngle}`,
    `- Target Duration: ${details.targetDuration} sec`,
    `- Tone: ${details.tone}`,
    `- Content Type: ${details.contentType}`,
    '',
    '## Final Instruction',
    'Return JSON only. Do not output markdown/code fences/explanations.'
  ].join('\n');
}

function captureSlice(text, size = 2000) {
  const raw = String(text || '');
  if (raw.length <= size) return raw;
  return raw.slice(0, size);
}

function captureTail(text, size = 2000) {
  const raw = String(text || '');
  if (raw.length <= size) return raw;
  return raw.slice(raw.length - size);
}

function writeClaudeErrorReport({
  command,
  args,
  exitCode,
  stderr,
  stdout,
  promptFilePath,
  promptLength,
  rawJsonText
}) {
  ensureProjectFolders();
  fs.mkdirSync(path.dirname(CLAUDE_ERROR_LOG_PATH), { recursive: true });

  const lines = [
    '# Claude Generation Error',
    '',
    `- time: ${new Date().toISOString()}`,
    `- command: ${command}`,
    `- args: ${JSON.stringify(args)}`,
    `- exit_code: ${exitCode === null || exitCode === undefined ? 'null' : exitCode}`,
    `- prompt_file_path: ${promptFilePath || '(none)'}`,
    `- prompt_length: ${promptLength || 0}`,
    '',
    '## stderr',
    '```text',
    String(stderr || ''),
    '```',
    '',
    '## stdout_head',
    '```text',
    captureSlice(stdout),
    '```',
    '',
    '## stdout_tail',
    '```text',
    captureTail(stdout),
    '```'
  ];

  if (rawJsonText !== undefined) {
    lines.push('', '## extracted_json_text', '```json', String(rawJsonText || ''), '```');
  }

  fs.writeFileSync(CLAUDE_ERROR_LOG_PATH, `${lines.join('\n')}\n`, 'utf8');
}

function savePromptFallback(prompt) {
  fs.mkdirSync(CLAUDE_PROMPT_WORK_DIR, { recursive: true });
  const promptPath = path.join(CLAUDE_PROMPT_WORK_DIR, `claude_story_prompt_${nowStamp()}.txt`);
  fs.writeFileSync(promptPath, prompt, 'utf8');
  return promptPath;
}

function runClaudeCli(prompt, oauthToken) {
  return new Promise((resolve, reject) => {
    if (!oauthToken) {
      reject(
        createHttpError(400, 'CLAUDE_OAUTH_TOKEN_MISSING', 'Missing Claude OAuth token. Set CLAUDE_CODE_OAUTH_TOKEN or CLAUDE_OAUTH_TOKEN.')
      );
      return;
    }

    const childEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;
    childEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    childEnv.CLAUDE_OAUTH_TOKEN = oauthToken;

    const spawnSpec = resolveClaudeCommand();
    const command = spawnSpec.command;
    const args = spawnSpec.args;

    let child;
    try {
      child = spawn(command, args, {
        env: childEnv,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      const promptFilePath = savePromptFallback(prompt);
      writeClaudeErrorReport({
        command,
        args,
        exitCode: null,
        stderr: error.message,
        stdout: '',
        promptFilePath,
        promptLength: prompt.length
      });
      reject(
        createHttpError(500, 'CLAUDE_CLI_SPAWN_FAILED', `Failed to start Claude CLI: ${error.message}`, {
          command,
          args,
          promptFilePath,
          promptLength: prompt.length
        })
      );
      return;
    }

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      const promptFilePath = savePromptFallback(prompt);
      writeClaudeErrorReport({
        command,
        args,
        exitCode: null,
        stderr: `${stderr}\n${error.message}`.trim(),
        stdout,
        promptFilePath,
        promptLength: prompt.length
      });

      reject(
        createHttpError(500, 'CLAUDE_CLI_SPAWN_FAILED', `Failed to start Claude CLI: ${error.message}`, {
          command,
          args,
          promptFilePath,
          promptLength: prompt.length
        })
      );
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const promptFilePath = savePromptFallback(prompt);
        writeClaudeErrorReport({
          command,
          args,
          exitCode: code,
          stderr,
          stdout,
          promptFilePath,
          promptLength: prompt.length
        });

        reject(
          createHttpError(500, 'CLAUDE_CLI_FAILED', `Claude CLI exited with code ${code}`, {
            command,
            args,
            exitCode: code,
            stderr: String(stderr || '').trim(),
            stdout: String(stdout || '').trim(),
            promptFilePath,
            promptLength: prompt.length
          })
        );
        return;
      }

      resolve({
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        exitCode: code,
        command,
        args
      });
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (error) {
      const promptFilePath = savePromptFallback(prompt);
      writeClaudeErrorReport({
        command,
        args,
        exitCode: null,
        stderr: `stdin write failed: ${error.message}`,
        stdout,
        promptFilePath,
        promptLength: prompt.length
      });
      reject(
        createHttpError(500, 'CLAUDE_CLI_STDIN_FAILED', `Failed to write prompt to Claude stdin: ${error.message}`, {
          command,
          args,
          promptFilePath,
          promptLength: prompt.length
        })
      );
    }
  });
}

function extractJson(stdout) {
  const text = String(stdout || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    writeClaudeErrorReport({
      command: '(json_extract)',
      args: [],
      exitCode: null,
      stderr: 'No JSON object found in stdout',
      stdout: text,
      promptFilePath: null,
      promptLength: 0
    });
    throw createHttpError(500, 'CLAUDE_JSON_PARSE_ERROR', 'Claude output does not include a JSON object', {
      snippet: text.slice(0, 1000)
    });
  }

  const jsonText = text.slice(start, end + 1);
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    writeClaudeErrorReport({
      command: '(json_parse)',
      args: [],
      exitCode: null,
      stderr: error.message,
      stdout: text,
      promptFilePath: null,
      promptLength: 0,
      rawJsonText: jsonText
    });
    throw createHttpError(500, 'CLAUDE_JSON_PARSE_ERROR', `Failed to parse Claude JSON: ${error.message}`, {
      snippet: jsonText.slice(0, 1000)
    });
  }
}

function normalizeClaudeScript(script, geminiAnalysis) {
  const normalized = JSON.parse(JSON.stringify(script || {}));
  const fallbackClipId = geminiAnalysis?.clips?.[0]?.clip_id || 'C-01';

  if (!Array.isArray(normalized.segments)) {
    normalized.segments = [];
  }

  normalized.segments = normalized.segments.map((segment) => {
    const nextSegment = { ...(segment || {}) };
    const sourceClips = Array.isArray(nextSegment.source_clips) ? nextSegment.source_clips : [];

    nextSegment.source_clips = sourceClips.map((clip) => {
      const nextClip = { ...(clip || {}) };
      const resolvedId = nextClip.clip_id || nextClip.scene_id || fallbackClipId;
      nextClip.clip_id = nextClip.clip_id || resolvedId;
      nextClip.scene_id = nextClip.scene_id || nextClip.clip_id;
      return nextClip;
    });

    return nextSegment;
  });

  return normalized;
}

function saveClaudeScript(scriptJson) {
  return writeJsonWithBackup(CLAUDE_SCRIPT_PATH, scriptJson);
}

function readGeminiAnalysisFile() {
  const parsed = readJsonIfExists(GEMINI_ANALYSIS_PATH);
  if (!parsed) {
    throw createHttpError(400, 'GEMINI_ANALYSIS_NOT_FOUND', `Gemini analysis file not found: ${GEMINI_ANALYSIS_PATH}`);
  }
  return parsed;
}

function readGeminiReviewFile() {
  const parsed = readJsonIfExists(GEMINI_REVIEW_PATH);
  if (!parsed) {
    throw createHttpError(400, 'GEMINI_REVIEW_NOT_FOUND', `Gemini review file not found: ${GEMINI_REVIEW_PATH}`);
  }
  return parsed;
}

function buildSummary(scriptJson) {
  const project = scriptJson?.project || {};
  const story = scriptJson?.story || {};
  const metadata = scriptJson?.metadata || {};
  const quality = scriptJson?.quality_check || {};

  return {
    target_duration_sec: project.target_duration_sec ?? null,
    core_argument: story.core_argument || '',
    segment_count: quality.segment_count ?? (Array.isArray(scriptJson?.segments) ? scriptJson.segments.length : 0),
    estimated_total_duration_sec: quality.estimated_total_duration_sec ?? null,
    title_candidates: Array.isArray(metadata.title_candidates) ? metadata.title_candidates : [],
    risk_notes: Array.isArray(metadata.risk_notes) ? metadata.risk_notes : []
  };
}

async function generateClaudeScript({ geminiAnalysis, geminiReview, options = {} } = {}) {
  const resolvedGeminiAnalysis = geminiAnalysis || readGeminiAnalysisFile();
  const resolvedGeminiReview = geminiReview || readGeminiReviewFile();
  const templateId = String(resolvedGeminiReview?.selected_claude_template || '').trim();
  if (!templateId) {
    throw createHttpError(400, 'CLAUDE_TEMPLATE_NOT_SELECTED', 'selected_claude_template is required in gemini review');
  }
  const template = getTemplate(templateId);
  if (!template) {
    throw createHttpError(400, 'CLAUDE_TEMPLATE_NOT_FOUND', `Selected Claude template was not found: ${templateId}`);
  }
  if (!template.enabled) {
    throw createHttpError(400, 'CLAUDE_TEMPLATE_DISABLED', `Selected Claude template is disabled: ${templateId}`);
  }
  const templateBundle = loadTemplateBundle(templateId);
  if (!templateBundle?.template_prompt) {
    throw createHttpError(400, 'CLAUDE_TEMPLATE_PROMPT_NOT_FOUND', `Template prompt file is missing: ${template?.prompt_path || templateId}`);
  }

  const token = getClaudeOAuthToken();
  const prompt = buildClaudePrompt({
    geminiAnalysis: resolvedGeminiAnalysis,
    geminiReview: resolvedGeminiReview,
    templateBundle,
    options
  });
  const cliResult = await runClaudeCli(prompt, token);
  const parsed = extractJson(cliResult.stdout);
  const normalized = normalizeClaudeScript(parsed, resolvedGeminiAnalysis);

  const schemaCheck = validate(normalized);
  if (!schemaCheck.valid) {
    throw createHttpError(500, 'CLAUDE_SCHEMA_VALIDATION_FAILED', 'Claude output schema validation failed', {
      errors: schemaCheck.errors || []
    });
  }

  const clipCheck = crossValidateClipIds(normalized, resolvedGeminiAnalysis);
  if (!clipCheck.valid) {
    throw createHttpError(500, 'CLAUDE_CLIP_ID_VALIDATION_FAILED', 'Claude output clip references are invalid', {
      errors: clipCheck.errors || []
    });
  }

  const { targetPath, backupPath } = saveClaudeScript(normalized);
  return {
    script: normalized,
    savedPath: targetPath,
    backupPath: backupPath || null,
    summary: {
      ...buildSummary(normalized),
      selected_template: templateId
    },
    selectedTemplate: template
  };
}

module.exports = {
  GEMINI_ANALYSIS_PATH,
  GEMINI_REVIEW_PATH,
  CLAUDE_SCRIPT_PATH,
  CLAUDE_REVIEW_PATH,
  buildClaudePrompt,
  runClaudeCli,
  extractJson,
  normalizeClaudeScript,
  saveClaudeScript,
  generateClaudeScript,
  getClaudeOAuthToken,
  buildSummary
};

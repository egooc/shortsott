const fs = require('fs');
const path = require('path');

const { createHttpError } = require('./errorService');
const { PROJECT_ROOT } = require('./pipelinePaths');
const { writeJson, writeText, rel } = require('./midformRunArtifactsService');
const { generateVertexJson } = require('./geminiMidformService');
const { assertCodexLoginStatus, runCodexCli, MIDFORM_MULTIMODAL_REVIEW_SCHEMA_PATH } = require('./gptMidformCliService');

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pass', 'needs_repair'] },
    findings: { type: 'array', items: { type: 'string' } },
    required_repairs: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' }
  },
  required: ['status', 'findings', 'required_repairs', 'confidence']
};

function normalizeMultimodalProvider(value = process.env.MIDFORM_MULTIMODAL_PROVIDER) {
  const provider = String(value || 'vertex').trim().toLowerCase();
  return ['vertex', 'gpt_cli', 'disabled'].includes(provider) ? provider : 'vertex';
}

function readJsonIfExists(filePath) {
  return filePath && fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')) : null;
}

function readTextIfExists(filePath, limit = 12000) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  const text = fs.readFileSync(filePath, 'utf8');
  return text.length > limit ? text.slice(0, limit) : text;
}

function compactJson(value, limit = 12000) {
  const text = JSON.stringify(value || {}, null, 2);
  return text.length > limit ? `${text.slice(0, limit)}\n...truncated...` : text;
}

function validateReviewResult(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push('result must be an object');
  if (!['pass', 'needs_repair'].includes(String(value?.status || ''))) errors.push('status must be pass or needs_repair');
  if (!Array.isArray(value?.findings)) errors.push('findings must be an array');
  if (!Array.isArray(value?.required_repairs)) errors.push('required_repairs must be an array');
  if (!Number.isFinite(Number(value?.confidence))) errors.push('confidence must be a number');
  if (errors.length) {
    throw createHttpError(500, 'VERTEX_SCHEMA_FAILED', 'Multimodal review response failed schema validation', { errors, response: value });
  }
  return {
    status: String(value.status),
    findings: value.findings.map((item) => String(item || '').trim()).filter(Boolean),
    required_repairs: value.required_repairs.map((item) => String(item || '').trim()).filter(Boolean),
    confidence: Math.max(0, Math.min(1, Number(value.confidence)))
  };
}

function parseReviewJson(text, provider) {
  try {
    return validateReviewResult(JSON.parse(String(text || '').trim()));
  } catch (error) {
    if (error?.code) throw error;
    throw createHttpError(500, provider === 'vertex' ? 'VERTEX_INVALID_RESPONSE' : 'GPT_CLI_INVALID_JSON', 'Multimodal review provider returned invalid JSON', {
      snippet: String(text || '').slice(0, 1000)
    });
  }
}

function classifyVertexError(error) {
  const status = Number(error?.status || error?.details?.status || 0);
  const code = String(error?.code || '').toUpperCase();
  const text = `${error?.message || ''}\n${error?.details?.response || ''}`.toLowerCase();
  if (code === 'VERTEX_SCHEMA_FAILED') return 'VERTEX_SCHEMA_FAILED';
  if (/abort|timeout|timed out/.test(text)) return 'VERTEX_TIMEOUT';
  if ([401, 403].includes(status) || /credential|auth|permission|unauthorized|forbidden/.test(text)) return 'VERTEX_AUTH_FAILED';
  if ([404, 429, 503].includes(status) || /model.*not|not found|unavailable|quota|rate limit/.test(text)) return 'VERTEX_MODEL_UNAVAILABLE';
  if (status === 408 || status === 499) return 'VERTEX_TIMEOUT';
  return 'VERTEX_INVALID_RESPONSE';
}

function buildReviewInput({ workspaceDir, normalizedRequest, qa, finalPipelineState, localeDrafts, autoDecision, required }) {
  return {
    artifact_type: 'midform_multimodal_review_input',
    source_url: normalizedRequest?.source?.url || '',
    target_length_sec: normalizedRequest?.output?.target_length_sec || 0,
    profile: normalizedRequest?.profile || '',
    provider: normalizeMultimodalProvider(),
    required: required === true,
    trigger_reason: Array.isArray(autoDecision?.reason_codes) ? autoDecision.reason_codes : [],
    original_failed_gates: Array.isArray(qa?.gateResults?.failed) ? qa.gateResults.failed : [],
    acceptance_gates: qa?.gateResults || null,
    final_overlap_report: localeDrafts?.finalOverlapReport || null,
    evidence_pack: readJsonIfExists(path.join(workspaceDir, 'evidence_pack.json')) || readJsonIfExists(path.join(workspaceDir, 'supplemental_evidence.json')),
    draft_spec_ko: readJsonIfExists(path.join(workspaceDir, 'draft_spec.ko.json')),
    draft_spec_ja: readJsonIfExists(path.join(workspaceDir, 'draft_spec.ja.json')),
    template_body_ko: readTextIfExists(path.join(workspaceDir, 'template_body.ko.md')),
    template_body_ja: readTextIfExists(path.join(workspaceDir, 'template_body.ja.md')),
    draft_input: readJsonIfExists(path.join(workspaceDir, 'draft_input.json')),
    edit_manifest: readJsonIfExists(path.join(workspaceDir, 'edit_manifest.json')),
    pipeline_run_id: finalPipelineState?.runId || '',
    pipeline_run_dir: finalPipelineState?.runDir || ''
  };
}

function buildReviewPrompt(input) {
  return [
    'You are reviewing a Korean/Japanese 60-180 second movie recap draft for multimodal/editorial quality.',
    'Use only the provided evidence. Do not invent movie facts.',
    'Return JSON only with this exact shape: {"status":"pass|needs_repair","findings":[],"required_repairs":[],"confidence":0.0}.',
    'Use status="needs_repair" only when the draft cannot be accepted without repair. Otherwise use status="pass" and include findings if useful.',
    '',
    compactJson(input, 60000)
  ].join('\n');
}

async function callVertexReview(input, options = {}) {
  try {
    const outputText = await generateVertexJson({
      prompt: buildReviewPrompt(input),
      responseSchema: REVIEW_SCHEMA,
      model: options.model || process.env.VERTEX_MULTIMODAL_REVIEW_MODEL || process.env.VERTEX_GEMINI_MODEL,
      temperature: 0.1
    });
    return { result: parseReviewJson(outputText, 'vertex'), stdout: outputText, stderr: '', report: { provider: 'vertex', status: 'completed' } };
  } catch (error) {
    const code = classifyVertexError(error);
    throw createHttpError(error?.status || 500, code, error?.message || 'Vertex multimodal review failed', {
      provider: 'vertex',
      original_code: error?.code || '',
      status: error?.status || null,
      details: error?.details || {}
    });
  }
}

async function callGptCliReview(input, options = {}) {
  assertCodexLoginStatus(options.codexAuth || {});
  const result = await runCodexCli(buildReviewPrompt(input), { outputSchemaPath: MIDFORM_MULTIMODAL_REVIEW_SCHEMA_PATH, maxAttempts: 1 });
  return { result: parseReviewJson(result.outputText || result.stdout, 'gpt_cli'), stdout: result.outputText || result.stdout, stderr: result.stderr, report: { provider: 'gpt_cli', status: 'completed', promptPath: result.promptPath, outputPath: result.outputPath } };
}

function writeReviewArtifacts(workspaceDir, { provider, input, outcome, error, stdout = '', stderr = '' }) {
  const inputPath = path.join(workspaceDir, 'multimodal_review_input.json');
  const reportPath = path.join(workspaceDir, 'multimodal_review_report.json');
  const stdoutPath = path.join(workspaceDir, 'multimodal_review_stdout.txt');
  const stderrPath = path.join(workspaceDir, 'multimodal_review_stderr.txt');
  const report = {
    artifact_type: 'midform_multimodal_review_report',
    provider,
    status: error ? 'failed' : 'completed',
    reason: error?.code || '',
    message: error?.message || '',
    required: input.required === true,
    trigger_reason: input.trigger_reason,
    original_failed_gates: input.original_failed_gates,
    review: outcome?.result || null,
    provider_report: outcome?.report || null,
    error_details: error?.details || null
  };
  writeJson(inputPath, input);
  writeJson(reportPath, report);
  writeText(stdoutPath, String(stdout || ''));
  writeText(stderrPath, String(stderr || error?.details?.stderr || error?.message || ''));
  return {
    report,
    outputPaths: {
      multimodal_review_input: rel(inputPath),
      multimodal_review_report: rel(reportPath),
      multimodal_review_stdout: rel(stdoutPath),
      multimodal_review_stderr: rel(stderrPath)
    }
  };
}

function shouldRunMultimodalReview({ provider, qa, localeDrafts, autoDecision }) {
  if (normalizeMultimodalProvider(provider) === 'disabled') return false;
  const acceptanceFailed = qa?.gateResults?.status === 'failed';
  const overlapFailed = localeDrafts?.finalOverlapReport?.final_status && localeDrafts.finalOverlapReport.final_status !== 'pass';
  if (!acceptanceFailed && !overlapFailed) return false;
  return true;
}

async function runMidformMultimodalReview({ workspaceDir, normalizedRequest, qa, finalPipelineState, localeDrafts, autoDecision, provider = normalizeMultimodalProvider(), required = false, options = {} }) {
  const selectedProvider = normalizeMultimodalProvider(provider);
  const input = buildReviewInput({ workspaceDir, normalizedRequest, qa, finalPipelineState, localeDrafts, autoDecision, required });
  input.provider = selectedProvider;
  if (selectedProvider === 'disabled') {
    const artifacts = writeReviewArtifacts(workspaceDir, { provider: selectedProvider, input, outcome: { result: { status: 'pass', findings: ['multimodal provider disabled'], required_repairs: [], confidence: 0 } } });
    return { provider: selectedProvider, status: 'skipped', result: artifacts.report.review, ...artifacts };
  }
  try {
    const outcome = selectedProvider === 'gpt_cli'
      ? (options.gptReview ? await options.gptReview(input) : await callGptCliReview(input, options))
      : (options.vertexReview ? await options.vertexReview(input) : await callVertexReview(input, options));
    const artifacts = writeReviewArtifacts(workspaceDir, { provider: selectedProvider, input, outcome, stdout: outcome.stdout, stderr: outcome.stderr });
    return { provider: selectedProvider, status: 'completed', result: outcome.result, ...artifacts };
  } catch (error) {
    const artifacts = writeReviewArtifacts(workspaceDir, { provider: selectedProvider, input, error });
    return { provider: selectedProvider, status: 'failed', error, ...artifacts };
  }
}

module.exports = {
  REVIEW_SCHEMA,
  normalizeMultimodalProvider,
  shouldRunMultimodalReview,
  runMidformMultimodalReview,
  _test: {
    buildReviewInput,
    buildReviewPrompt,
    classifyVertexError,
    parseReviewJson,
    validateReviewResult
  }
};

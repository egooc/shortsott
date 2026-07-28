const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const matter = require('gray-matter');
const Ajv = require('ajv');

const { PROJECT_ROOT } = require('./pipelinePaths');
const { runCompression, runCompressionApply, refreshCompressionPlan } = require('./midformCompressionService');
const { runBootstrapToPipeline } = require('./midformBootstrapAdapterService');
const { getRun, startRun } = require('./midformPipelineService');
const { collectRunArtifacts, copyIfExists, ensureDir, rel, writeJson, writeText } = require('./midformRunArtifactsService');

const SCHEMA_PATH = path.join(PROJECT_ROOT, 'midform', 'schemas', 'midform_run_template_schema.json');
const WORKSPACE_ROOT = path.join(PROJECT_ROOT, 'midform', 'test_runs', 'template_runs');
const COMPRESS_RUNS_DIR = path.join(PROJECT_ROOT, 'midform', 'test_runs');
const TERMINAL_PIPELINE_STATES = new Set(['completed', 'completed_with_warnings', 'failed', 'paused_review', 'blocked_preflight']);
const RESUME_STAGES = ['ingest', 'analysis', 'slot_fill', 'bootstrap', 'draft'];
const ANALYSIS_MODES = new Set(['compression', 'auto', 'multimodal']);
const MULTIMODAL_ESCALATION_GATE_REASONS = {
  high_context_teaser_recovery: 'high_context',
  callback_strength: 'weak_callback_recovery',
  first_30_conflict_clarity: 'weak_clarity'
};
const PROFILE_DEFAULTS = {
  fast: {
    preview_frame_proof: false,
    preview_limit: 4,
    subtitle_limits: { max_chars: 20, max_units_per_segment: 6 }
  },
  production: {
    preview_frame_proof: true,
    preview_limit: 8,
    subtitle_limits: { max_chars: 18, max_units_per_segment: 6 }
  },
  audit: {
    preview_frame_proof: true,
    preview_limit: 12,
    subtitle_limits: { max_chars: 18, max_units_per_segment: 6 }
  }
};

let templateValidator = null;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function readJsonIfExists(filePath) {
  return filePath && fs.existsSync(filePath) ? readJson(filePath) : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeSlug(value, fallback = 'midform_run') {
  const slug = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9가-힣_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function stableHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 10);
}

function normalizeSourceUrl(source) {
  const text = String(source || '').trim();
  const match = text.match(/(?:v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{11})/) || text.match(/^([A-Za-z0-9_-]{11})$/);
  return match ? `https://www.youtube.com/watch?v=${match[1]}` : text;
}

function nowStamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}_${hh}${mm}${ss}`;
}

function templateSchemaValidator() {
  if (templateValidator) return templateValidator;
  const ajv = new Ajv({ allErrors: true, strict: false });
  templateValidator = ajv.compile(readJson(SCHEMA_PATH));
  return templateValidator;
}

function validateTemplateData(data) {
  const validate = templateSchemaValidator();
  if (validate(data)) return;
  const details = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
  throw new Error(`Template schema validation failed: ${details}`);
}

function resolveTemplatePath(templatePath) {
  const resolved = path.isAbsolute(templatePath) ? path.normalize(templatePath) : path.resolve(PROJECT_ROOT, templatePath);
  if (!fs.existsSync(resolved)) throw new Error(`Template not found: ${templatePath}`);
  return resolved;
}

function parseTemplateFile(templatePath) {
  const resolved = resolveTemplatePath(templatePath);
  const parsed = matter.read(resolved);
  validateTemplateData(parsed.data || {});
  return {
    templatePath: resolved,
    frontmatter: parsed.data || {},
    body: String(parsed.content || '').trim(),
    raw: String(parsed.orig || '')
  };
}

function normalizeProfile(profile) {
  const value = String(profile || 'production').trim().toLowerCase();
  return PROFILE_DEFAULTS[value] ? value : 'production';
}

function normalizeAnalysisMode(mode) {
  const value = normalizeText(mode || 'auto').toLowerCase();
  return ANALYSIS_MODES.has(value) ? value : 'auto';
}

function normalizeResumeStage(stage) {
  const value = normalizeText(stage).toLowerCase();
  if (!value) return '';
  if (!RESUME_STAGES.includes(value)) throw new Error(`Unsupported resume stage: ${stage}`);
  return value;
}

function buildNormalizedRequest(parsedTemplate, cliOptions = {}) {
  const data = parsedTemplate.frontmatter || {};
  const profile = normalizeProfile(cliOptions.profile || data.profile || 'production');
  const analysisMode = normalizeAnalysisMode(cliOptions.analysisMode || cliOptions.analysis_mode || data.analysis_mode || 'auto');
  const sourceUrl = normalizeText(cliOptions.source || data?.source?.url || '');
  const targetLengthSec = Number(cliOptions.target || data?.output?.target_length_sec || 0);
  if (!sourceUrl) throw new Error('Template requires source.url or --source override');
  if (!Number.isFinite(targetLengthSec) || targetLengthSec <= 0) throw new Error('Template requires output.target_length_sec');
  return {
    version: 1,
    template: {
      path: parsedTemplate.templatePath,
      relative_path: rel(parsedTemplate.templatePath)
    },
    profile,
    analysis: {
      mode: analysisMode
    },
    source: {
      url: sourceUrl
    },
    output: {
      target_length_sec: targetLengthSec
    },
    editorial: {
      tone: normalizeText(data.tone),
      must_keep: Array.isArray(data.must_keep) ? data.must_keep.map(normalizeText).filter(Boolean) : [],
      prohibitions: Array.isArray(data.prohibitions) ? data.prohibitions.map(normalizeText).filter(Boolean) : [],
      opener_policy: data.opener_policy || '',
      callback_required: data.callback_required === true,
      spoiler_boundary: normalizeText(data.spoiler_boundary),
      subtitle_limits: data.subtitle_limits && typeof data.subtitle_limits === 'object' ? {
        max_chars: Number(data.subtitle_limits.max_chars || 0) || PROFILE_DEFAULTS[profile].subtitle_limits.max_chars,
        max_units_per_segment: Number(data.subtitle_limits.max_units_per_segment || 0) || PROFILE_DEFAULTS[profile].subtitle_limits.max_units_per_segment
      } : { ...PROFILE_DEFAULTS[profile].subtitle_limits }
    },
    render: {
      preview_frame_proof: data?.render?.preview_frame_proof === true || (data?.render?.preview_frame_proof !== false && PROFILE_DEFAULTS[profile].preview_frame_proof),
      preview_limit: Number(data?.render?.preview_limit || PROFILE_DEFAULTS[profile].preview_limit),
      use_capcut_template: data?.render?.use_capcut_template !== false,
      audio_path_mode: normalizeText(data?.render?.audio_path_mode || 'absolute') || 'absolute',
      video_placement_mode: normalizeText(data?.render?.video_placement_mode || 'source_clips') || 'source_clips'
    },
    body_markdown: parsedTemplate.body,
    advanced: {
      callback_required: data.callback_required === true,
      scene_type_hint: normalizeText(data?.source?.scene_type || ''),
      content_type: normalizeText(data?.source?.content_type || 'movie_midform_recap') || 'movie_midform_recap'
    }
  };
}

function buildWorkspacePaths(normalizedRequest) {
  const templateStem = path.basename(normalizedRequest.template.path, path.extname(normalizedRequest.template.path));
  const requestHash = stableHash({
    profile: normalizedRequest.profile,
    analysis: normalizedRequest.analysis,
    source: normalizedRequest.source,
    output: normalizedRequest.output,
    editorial: normalizedRequest.editorial,
    render: normalizedRequest.render,
    body_markdown: normalizedRequest.body_markdown
  });
  const workspaceName = `${safeSlug(templateStem, 'template')}_${requestHash}`;
  const workspaceDir = path.join(WORKSPACE_ROOT, workspaceName);
  return {
    workspaceName,
    workspaceDir,
    summaryPath: path.join(workspaceDir, 'run_summary.json'),
    requestPath: path.join(workspaceDir, 'normalized_request.json'),
    contextPath: path.join(workspaceDir, 'generated_context.md'),
    beatmapPath: path.join(workspaceDir, 'story_beatmap.json')
  };
}

function buildRunId(workspaceName) {
  return `midform_run_${nowStamp()}_${workspaceName}`;
}

function buildGeneratedContextMarkdown(normalizedRequest) {
  const mustKeep = normalizedRequest.editorial.must_keep.length
    ? normalizedRequest.editorial.must_keep.map((item) => `- ${item}`).join('\n')
    : '- none specified';
  const prohibitions = normalizedRequest.editorial.prohibitions.length
    ? normalizedRequest.editorial.prohibitions.map((item) => `- ${item}`).join('\n')
    : '- none specified';
  const body = normalizedRequest.body_markdown || '_No additional author notes provided._';
  return [
    '# Midform Run Request Context',
    '',
    'This file was generated from a reusable template contract for `midform run`.',
    'If a field is not explicitly specified here, infer it from the source, transcript, movie research, and current editorial pipeline logic.',
    '',
    '## Required contract',
    '',
    `- source.url: ${normalizedRequest.source.url}`,
    `- output.target_length_sec: ${normalizedRequest.output.target_length_sec}`,
    `- profile: ${normalizedRequest.profile}`,
    `- analysis.mode: ${normalizedRequest.analysis?.mode || 'auto'}`,
    '',
    '## Explicit overrides',
    '',
    `- tone: ${normalizedRequest.editorial.tone || 'infer from source'}`,
    `- opener_policy: ${normalizedRequest.editorial.opener_policy || 'infer from editorial logic'}`,
    `- callback_required: ${normalizedRequest.editorial.callback_required}`,
    `- spoiler_boundary: ${normalizedRequest.editorial.spoiler_boundary || 'stay grounded, do not spoil beyond the chosen structure'}`,
    `- subtitle.max_chars: ${normalizedRequest.editorial.subtitle_limits.max_chars}`,
    `- subtitle.max_units_per_segment: ${normalizedRequest.editorial.subtitle_limits.max_units_per_segment}`,
    '',
    '## Must keep',
    '',
    mustKeep,
    '',
    '## Prohibitions',
    '',
    prohibitions,
    '',
    '## Additional markdown brief',
    '',
    body,
    ''
  ].join('\n');
}

function copyCompressionArtifacts(compressionRunDir, workspaceDir) {
  copyIfExists(path.join(compressionRunDir, 'narrative_beats.json'), path.join(workspaceDir, 'narrative_beats.json'));
  copyIfExists(path.join(compressionRunDir, 'edit_plan.json'), path.join(workspaceDir, 'edit_plan.json'));
  copyIfExists(path.join(compressionRunDir, 'slot_qc_report.json'), path.join(workspaceDir, 'slot_qc_report.json'));
  copyIfExists(path.join(compressionRunDir, 'compression_slot_fills.json'), path.join(workspaceDir, 'slot_fills.generated.json'));
  copyIfExists(path.join(compressionRunDir, 'upload_text.md'), path.join(workspaceDir, 'upload_text.md'));
}

function buildStoryBeatmap(normalizedRequest, beatsObject, editPlan) {
  return {
    artifact_type: 'midform_story_beatmap',
    source_url: normalizedRequest.source.url,
    target_length_sec: normalizedRequest.output.target_length_sec,
    profile: normalizedRequest.profile,
    scene_type: String(editPlan?.scene_type || ''),
    editorial_pattern: String(editPlan?.editorial_pattern || ''),
    cold_open_selection: editPlan?.cold_open_selection || null,
    beats: Array.isArray(beatsObject?.beats) ? beatsObject.beats : [],
    timeline: Array.isArray(editPlan?.timeline) ? editPlan.timeline : []
  };
}

function shouldRunStage(resumeStage, currentStage) {
  if (!resumeStage) return true;
  return RESUME_STAGES.indexOf(currentStage) >= RESUME_STAGES.indexOf(resumeStage);
}

function requireSummaryField(summary, field, stage) {
  if (!summary?.internal?.[field]) {
    throw new Error(`Cannot resume from ${stage}: missing ${field}. Re-run from an earlier stage.`);
  }
  return summary.internal[field];
}

async function waitForPipelineRun(runId, timeoutMs = 60 * 60 * 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = getRun(runId);
    if (TERMINAL_PIPELINE_STATES.has(String(state.status || ''))) return state;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for pipeline run ${runId}`);
}

function listReusableCompressionRunsByUrl(sourceUrl, excludeRunId = '') {
  const normalized = normalizeSourceUrl(sourceUrl);
  if (!fs.existsSync(COMPRESS_RUNS_DIR)) return [];
  return fs.readdirSync(COMPRESS_RUNS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('compress_') && entry.name !== excludeRunId)
    .map((entry) => path.join(COMPRESS_RUNS_DIR, entry.name))
    .map((runDir) => {
      const manifest = readJsonIfExists(path.join(runDir, 'compression_manifest.json'));
      if (!manifest) return null;
      return { runId: manifest.runId, runDir, manifest };
    })
    .filter(Boolean)
    .filter((item) => normalizeSourceUrl(item.manifest.sourceUrl || '') === normalized)
    .sort((left, right) => fs.statSync(right.runDir).mtimeMs - fs.statSync(left.runDir).mtimeMs);
}

async function findBootstrapableCompressionFallback(sourceUrl, excludeRunId) {
  const candidates = listReusableCompressionRunsByUrl(sourceUrl, excludeRunId);
  for (const candidate of candidates) {
    try {
      const result = await runBootstrapToPipeline(candidate.runId, { preflightOnly: true, forceDownload: false });
      if (result?.preflight?.ok === true) return candidate;
    } catch {
      // keep scanning
    }
  }
  return null;
}

function buildFailureSummary(summary, error, stage) {
  return {
    ...summary,
    status: 'failed',
    warnings: Array.isArray(summary.warnings) ? summary.warnings : [],
    failure_reason: {
      stage,
      code: error.code || 'MIDFORM_TEMPLATE_RUN_FAILED',
      message: error.message || 'Midform template run failed',
      details: error.details || {}
    }
  };
}

function relIfPresent(filePath) {
  return filePath ? rel(filePath) : '';
}

function readEditorialContextForQa(workspaceDir, normalizedRequest) {
  const editPlan = readJsonIfExists(path.join(workspaceDir, 'edit_plan.json')) || {};
  return {
    sceneType: normalizeText(editPlan.scene_type || normalizedRequest.advanced?.scene_type_hint || ''),
    editorialPattern: normalizeText(editPlan.editorial_pattern || (normalizedRequest.editorial?.callback_required ? 'cold_open_callback' : ''))
  };
}

function buildAutoEscalationDecision({ gateResults, pipelineState }) {
  const failed = Array.isArray(gateResults?.failed) ? gateResults.failed : [];
  const warnings = Array.isArray(gateResults?.warnings) ? gateResults.warnings : [];
  const relevantFailures = failed
    .filter((id) => Object.prototype.hasOwnProperty.call(MULTIMODAL_ESCALATION_GATE_REASONS, id))
    .map((id) => ({ gate_id: id, reason: MULTIMODAL_ESCALATION_GATE_REASONS[id] }));
  const qualityWarnings = Array.isArray(pipelineState?.qualityWarnings) ? pipelineState.qualityWarnings : [];
  const relevantQualityWarnings = qualityWarnings
    .map((warning) => normalizeText(typeof warning === 'string' ? warning : warning?.message || warning?.code || JSON.stringify(warning)))
    .filter((warning) => /(context|clarity|callback|ground|transcript|source)/i.test(warning))
    .map((warning) => ({ warning, reason: /ground|transcript|source/i.test(warning) ? 'poor_transcript_grounding' : (/callback/i.test(warning) ? 'weak_callback_recovery' : (/clarity/i.test(warning) ? 'weak_clarity' : 'high_context')) }));
  const reasonCodes = [
    ...relevantFailures.map((item) => `gate:${item.gate_id}:${item.reason}`),
    ...relevantQualityWarnings.map((item, index) => `quality_warning:${index + 1}:${item.reason}`)
  ];
  return {
    should_escalate: reasonCodes.length > 0,
    escalated: reasonCodes.length > 0,
    reason_codes: reasonCodes,
    gate_failures: failed,
    gate_warnings: warnings,
    relevant_gate_failures: relevantFailures,
    relevant_quality_warnings: relevantQualityWarnings,
    explanation: reasonCodes.length
      ? 'Compression-first draft showed context/clarity/callback/grounding signals that justify a multimodal Vertex pass.'
      : 'Compression-first draft did not show multimodal-worthy failure signals.'
  };
}

async function runMultimodalPipelineFromTemplate(normalizedRequest) {
  const state = startRun({
    sourceUrl: normalizedRequest.source.url,
    contentType: normalizedRequest.advanced?.content_type || 'movie_midform_recap',
    pauseBeforeTts: false,
    interactiveMode: false
  });
  return waitForPipelineRun(state.runId);
}

function buildPipelineFailureSummary(summary, finalPipelineState, stage) {
  return {
    ...summary,
    status: 'failed',
    output_paths: summary.output_paths,
    gate_results: null,
    warnings: finalPipelineState?.qualityWarnings || [],
    failure_reason: {
      stage,
      code: finalPipelineState?.error?.code || 'MIDFORM_DRAFT_FAILED',
      message: finalPipelineState?.error?.message || `Pipeline ended with status ${finalPipelineState?.status || 'unknown'}`,
      details: finalPipelineState?.error?.details || {}
    }
  };
}

function finalSummaryFromQa(summary, qa, finalPipelineState, analysisRun) {
  return {
    ...summary,
    status: qa.gateResults.status === 'failed' ? 'failed' : qa.gateResults.status,
    output_paths: {
      ...qa.outputPaths,
      draft_zip: relIfPresent(finalPipelineState.artifacts?.draftZipPath || finalPipelineState.artifacts?.draft?.zipPath || '')
    },
    gate_results: qa.gateResults,
    warnings: qa.gateResults.warnings,
    analysis_run: analysisRun,
    failure_reason: qa.gateResults.status === 'failed'
      ? {
          stage: 'acceptance_gates',
          code: 'MIDFORM_ACCEPTANCE_FAILED',
          message: 'Acceptance gates failed',
          details: { failed: qa.gateResults.failed }
        }
      : null
  };
}

function collectQaForPipeline({ workspace, normalizedRequest, pipelineState }) {
  const pipelineRunDir = pipelineState.runDir;
  const draftRoot = pipelineState.artifacts?.draft?.draftPath || pipelineState.artifacts?.draft?.draft_root || '';
  if (!pipelineRunDir || !draftRoot) throw new Error('Final pipeline artifacts are missing draft paths');
  const editorialContext = readEditorialContextForQa(workspace.workspaceDir, normalizedRequest);
  return collectRunArtifacts({
    workspaceDir: workspace.workspaceDir,
    normalizedRequest,
    profile: normalizedRequest.profile,
    pipelineRunDir,
    draftRoot,
    enablePreviewFrameProof: normalizedRequest.render.preview_frame_proof,
    readability: normalizedRequest.editorial.subtitle_limits,
    sceneType: editorialContext.sceneType,
    editorialPattern: editorialContext.editorialPattern,
    previewLimit: normalizedRequest.render.preview_limit
  });
}

async function runMidformTemplateWorkflow(options = {}) {
  const parsedTemplate = parseTemplateFile(options.templatePath);
  const normalizedRequest = buildNormalizedRequest(parsedTemplate, options);
  const resumeStage = normalizeResumeStage(options.resume);
  const workspace = buildWorkspacePaths(normalizedRequest);
  ensureDir(workspace.workspaceDir);
  writeJson(workspace.requestPath, normalizedRequest);
  writeText(workspace.contextPath, buildGeneratedContextMarkdown(normalizedRequest));

  const previousSummary = readJsonIfExists(workspace.summaryPath) || {};
  const summary = {
    status: 'running',
    profile: normalizedRequest.profile,
    analysis_mode: normalizedRequest.analysis.mode,
    run_id: buildRunId(workspace.workspaceName),
    template_path: rel(parsedTemplate.templatePath),
    resume_from: resumeStage || '',
    workspace_dir: rel(workspace.workspaceDir),
    output_paths: previousSummary.output_paths || {},
    gate_results: previousSummary.gate_results || null,
    analysis_run: previousSummary.analysis_run || {
      requested_mode: normalizedRequest.analysis.mode,
      initial_path: normalizedRequest.analysis.mode === 'multimodal' ? 'multimodal' : 'compression',
      auto_escalation: {
        triggered: false,
        escalated: false,
        reason_codes: [],
        explanation: ''
      }
    },
    warnings: [],
    internal: previousSummary.internal || {}
  };
  writeJson(workspace.summaryPath, summary);

  try {
    if (normalizedRequest.analysis.mode === 'multimodal') {
      const multimodalState = await runMultimodalPipelineFromTemplate(normalizedRequest);
      summary.internal.multimodal_pipeline_run_id = multimodalState.runId;
      summary.internal.multimodal_pipeline_run_dir = multimodalState.runDir;
      summary.analysis_run = {
        ...summary.analysis_run,
        requested_mode: 'multimodal',
        initial_path: 'multimodal',
        final_path: 'multimodal',
        auto_escalation: {
          triggered: false,
          escalated: false,
          reason_codes: [],
          explanation: 'Explicit multimodal mode starts with the full Vertex analysis path.'
        },
        multimodal_pipeline_run_id: multimodalState.runId,
        multimodal_pipeline_status: multimodalState.status
      };
      writeJson(workspace.summaryPath, summary);
      if (!multimodalState || !String(multimodalState.status || '').startsWith('completed')) {
        const failedSummary = buildPipelineFailureSummary(summary, multimodalState, 'multimodal_draft');
        writeJson(workspace.summaryPath, failedSummary);
        return failedSummary;
      }
      const qa = collectQaForPipeline({ workspace, normalizedRequest, pipelineState: multimodalState });
      const finalSummary = finalSummaryFromQa(summary, qa, multimodalState, summary.analysis_run);
      writeJson(workspace.summaryPath, finalSummary);
      return finalSummary;
    }

    let compressionRunId = summary.internal.compression_run_id || '';
    let compressionRunDir = summary.internal.compression_run_dir || '';
    if (shouldRunStage(resumeStage, 'ingest') || !compressionRunId) {
      const compression = await runCompression(normalizedRequest.source.url, {
        target: normalizedRequest.output.target_length_sec
      });
      compressionRunId = compression.runId;
      compressionRunDir = compression.paths.runDir;
      summary.internal.compression_run_id = compressionRunId;
      summary.internal.compression_run_dir = compressionRunDir;
      writeJson(workspace.summaryPath, summary);
    } else {
      compressionRunId = requireSummaryField(summary, 'compression_run_id', resumeStage);
      compressionRunDir = requireSummaryField(summary, 'compression_run_dir', resumeStage);
    }

    copyCompressionArtifacts(compressionRunDir, workspace.workspaceDir);

    if (shouldRunStage(resumeStage, 'analysis') || !fs.existsSync(workspace.beatmapPath)) {
      refreshCompressionPlan(compressionRunId);
      copyCompressionArtifacts(compressionRunDir, workspace.workspaceDir);
      const beatsObject = readJson(path.join(compressionRunDir, 'narrative_beats.json'));
      const editPlan = readJson(path.join(compressionRunDir, 'edit_plan.json'));
      writeJson(workspace.beatmapPath, buildStoryBeatmap(normalizedRequest, beatsObject, editPlan));
    }

    if (shouldRunStage(resumeStage, 'slot_fill') || !fs.existsSync(path.join(workspace.workspaceDir, 'slot_fills.generated.json'))) {
      await runCompressionApply(compressionRunId, { contextFile: workspace.contextPath });
      copyCompressionArtifacts(compressionRunDir, workspace.workspaceDir);
      const beatsObject = readJson(path.join(compressionRunDir, 'narrative_beats.json'));
      const editPlan = readJson(path.join(compressionRunDir, 'edit_plan.json'));
      writeJson(workspace.beatmapPath, buildStoryBeatmap(normalizedRequest, beatsObject, editPlan));
    }

    if (shouldRunStage(resumeStage, 'bootstrap') || !fs.existsSync(path.join(workspace.workspaceDir, 'slot_map.json'))) {
      let bootstrapSourceRunId = compressionRunId;
      let bootstrapSourceRunDir = compressionRunDir;
      let preflight = await runBootstrapToPipeline(bootstrapSourceRunId, { preflightOnly: true, forceDownload: false });
      if (preflight.preflight?.ok !== true) {
        const fallback = await findBootstrapableCompressionFallback(normalizedRequest.source.url, compressionRunId);
        if (fallback) {
          bootstrapSourceRunId = fallback.runId;
          bootstrapSourceRunDir = fallback.runDir;
          preflight = await runBootstrapToPipeline(bootstrapSourceRunId, { preflightOnly: true, forceDownload: false });
          summary.internal.bootstrap_fallback_run_id = bootstrapSourceRunId;
          summary.internal.bootstrap_fallback_run_dir = bootstrapSourceRunDir;
        }
      }
      summary.internal.bootstrap_preflight = preflight;
      writeJson(workspace.summaryPath, summary);
      if (!preflight.preflight?.ok) {
        const failedSummary = {
          ...summary,
          status: 'failed',
          output_paths: summary.output_paths,
          gate_results: null,
          failure_reason: {
            stage: 'bootstrap',
            code: 'MIDFORM_BOOTSTRAP_PREFLIGHT_FAILED',
            message: 'Bootstrap preflight failed',
            details: preflight.preflight
          }
        };
        writeJson(workspace.summaryPath, failedSummary);
        return failedSummary;
      }
      summary.internal.bootstrap_source_run_id = bootstrapSourceRunId;
      summary.internal.bootstrap_source_run_dir = bootstrapSourceRunDir;
      writeJson(workspace.summaryPath, summary);
      copyIfExists(path.join(bootstrapSourceRunDir, 'bootstrap_slot_map.json'), path.join(workspace.workspaceDir, 'slot_map.json'));
      copyIfExists(path.join(bootstrapSourceRunDir, 'bootstrap_script.json'), path.join(workspace.workspaceDir, 'script.json'));
    }

    let finalPipelineState = null;
    if (shouldRunStage(resumeStage, 'draft') || !fs.existsSync(path.join(workspace.workspaceDir, 'edit_manifest.json'))) {
      const bootstrapRunId = summary.internal.bootstrap_source_run_id || compressionRunId;
      const bootstrapRun = await runBootstrapToPipeline(bootstrapRunId, { preflightOnly: false, forceDownload: false });
      summary.internal.pipeline_run_id = bootstrapRun.pipelineRunId;
      summary.internal.pipeline_run_dir = bootstrapRun.pipelineRunDir;
      writeJson(workspace.summaryPath, summary);
      finalPipelineState = await waitForPipelineRun(bootstrapRun.pipelineRunId);
    } else {
      const existingPipelineRunId = requireSummaryField(summary, 'pipeline_run_id', resumeStage);
      finalPipelineState = await waitForPipelineRun(existingPipelineRunId);
    }

    if (!finalPipelineState || !String(finalPipelineState.status || '').startsWith('completed')) {
      const failedSummary = buildPipelineFailureSummary(summary, finalPipelineState, 'draft');
      writeJson(workspace.summaryPath, failedSummary);
      return failedSummary;
    }

    const qa = collectQaForPipeline({ workspace, normalizedRequest, pipelineState: finalPipelineState });
    const autoDecision = normalizedRequest.analysis.mode === 'auto'
      ? buildAutoEscalationDecision({ gateResults: qa.gateResults, pipelineState: finalPipelineState })
      : {
          should_escalate: false,
          reason_codes: [],
          gate_failures: qa.gateResults.failed || [],
          gate_warnings: qa.gateResults.warnings || [],
          relevant_gate_failures: [],
          relevant_quality_warnings: [],
          explanation: 'Compression mode never auto-escalates.'
        };
    summary.analysis_run = {
      ...summary.analysis_run,
      requested_mode: normalizedRequest.analysis.mode,
      initial_path: 'compression',
      final_path: 'compression',
      compression_pipeline_run_id: finalPipelineState.runId,
      compression_pipeline_status: finalPipelineState.status,
      auto_escalation: {
        triggered: false,
        escalated: false,
        reason_codes: autoDecision.reason_codes,
        gate_failures: autoDecision.gate_failures,
        gate_warnings: autoDecision.gate_warnings,
        relevant_gate_failures: autoDecision.relevant_gate_failures,
        relevant_quality_warnings: autoDecision.relevant_quality_warnings,
        explanation: autoDecision.explanation
      }
    };

    if (autoDecision.should_escalate) {
      summary.analysis_run.auto_escalation.triggered = true;
      summary.analysis_run.auto_escalation.escalated = true;
      summary.analysis_run.auto_escalation.first_pass_status = qa.gateResults.status;
      summary.analysis_run.auto_escalation.first_pass_gate_results = qa.gateResults;
      writeJson(workspace.summaryPath, summary);
      const multimodalState = await runMultimodalPipelineFromTemplate(normalizedRequest);
      summary.internal.multimodal_pipeline_run_id = multimodalState.runId;
      summary.internal.multimodal_pipeline_run_dir = multimodalState.runDir;
      summary.analysis_run = {
        ...summary.analysis_run,
        final_path: 'multimodal',
        multimodal_pipeline_run_id: multimodalState.runId,
        multimodal_pipeline_status: multimodalState.status
      };
      writeJson(workspace.summaryPath, summary);
      if (!multimodalState || !String(multimodalState.status || '').startsWith('completed')) {
        const failedSummary = buildPipelineFailureSummary(summary, multimodalState, 'multimodal_escalation');
        writeJson(workspace.summaryPath, failedSummary);
        return failedSummary;
      }
      const multimodalQa = collectQaForPipeline({ workspace, normalizedRequest, pipelineState: multimodalState });
      summary.analysis_run.auto_escalation.final_pass_status = multimodalQa.gateResults.status;
      const escalatedSummary = finalSummaryFromQa(summary, multimodalQa, multimodalState, summary.analysis_run);
      writeJson(workspace.summaryPath, escalatedSummary);
      return escalatedSummary;
    }

    const finalSummary = finalSummaryFromQa(summary, qa, finalPipelineState, summary.analysis_run);
    writeJson(workspace.summaryPath, finalSummary);
    return finalSummary;
  } catch (error) {
    const failedSummary = buildFailureSummary(summary, error, resumeStage || 'run');
    writeJson(workspace.summaryPath, failedSummary);
    return failedSummary;
  }
}

module.exports = {
  PROFILE_DEFAULTS,
  RESUME_STAGES,
  buildGeneratedContextMarkdown,
  buildNormalizedRequest,
  buildStoryBeatmap,
  buildAutoEscalationDecision,
  normalizeAnalysisMode,
  normalizeResumeStage,
  parseTemplateFile,
  runMidformTemplateWorkflow
};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { PROJECT_ROOT } = require('./pipelinePaths');
const { runMidformTemplateWorkflow } = require('./midformRunTemplateService');
const { collectYouTubeComments } = require('./youtubeCommentsAdapterService');
const { collectYouTubeRetention } = require('./youtubeRetentionAdapterService');
const { collectYouTubeHeatmap } = require('./youtubeHeatmapAdapterService');
const { normalizeYouTubeWatchUrl, extractYouTubeVideoId } = require('./youtubeUrlUtils');
const { buildTemplateBody } = require('./midformTemplateWriterService');

const FULL_AUTO_INPUT_ROOT = path.join(PROJECT_ROOT, 'midform', 'test_runs', 'template_runs', 'full_auto_inputs');
const VALID_MODES = new Set(['template_only', 'drafts_only', 'full_auto']);

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(text), 'utf8');
}

function rel(filePath) {
  return path.relative(PROJECT_ROOT, filePath).replace(/\\/g, '/');
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeMode(mode) {
  const value = normalizeText(mode || 'full_auto').toLowerCase();
  return VALID_MODES.has(value) ? value : 'full_auto';
}

function stableHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

function buildSupplementalEvidence({ sourceUrl, comments, retention, heatmap }) {
  const videoId = extractYouTubeVideoId(sourceUrl);
  const retentionSignals = retention?.retention_signals || { intro: {}, top_moments: [], spikes: [], dips: [], rewatch_zones: [] };
  const heatmapSignals = heatmap?.heatmap_signals || { source: 'internal_adapter', peaks: [], high_replay_windows: [] };
  return {
    artifact_type: 'midform_full_auto_supplemental_evidence',
    video_id: videoId,
    source_url: sourceUrl,
    comment_reaction_summary: comments?.reaction_summary || { repeated_keywords: [], repeated_emotions: [], scene_mentions: [], misunderstandings: [], title_thumbnail_phrases: [] },
    top_comments: comments?.top_comments || [],
    recent_comments: comments?.recent_comments || [],
    retention_signals: retentionSignals,
    heatmap_signals: heatmapSignals,
    evidence_coverage: {
      comments: comments?.evidence_coverage === true,
      retention: retention?.evidence_coverage === true,
      heatmap: heatmap?.evidence_coverage === true,
      transcript: false
    },
    coverage_notes: {
      comments: comments?.unavailable_reason || '',
      retention: retention?.unavailable_reason || '',
      heatmap: heatmap?.unavailable_reason || ''
    },
    collected_at: new Date().toISOString()
  };
}

async function collectSupplementalEvidence(sourceUrl, options = {}) {
  const [comments, retention, heatmap] = await Promise.all([
    collectYouTubeComments(sourceUrl, options.comments || options),
    collectYouTubeRetention(sourceUrl, options.retention || options),
    collectYouTubeHeatmap(sourceUrl, options.heatmap || options)
  ]);
  return {
    comments,
    retention,
    heatmap,
    supplementalEvidence: buildSupplementalEvidence({ sourceUrl, comments, retention, heatmap })
  };
}

function buildAutoTemplateMarkdown({ sourceUrl, targetLengthSec, profile, analysisMode, body }) {
  return [
    '---',
    `profile: ${profile}`,
    `analysis_mode: ${analysisMode}`,
    'source:',
    `  url: ${sourceUrl}`,
    '  content_type: movie_midform_recap',
    'output:',
    `  target_length_sec: ${targetLengthSec}`,
    'tone: evidence-led, cinematic, grounded',
    'callback_required: true',
    'prohibitions:',
    '  - Do not invent facts outside the evidence pack.',
    '  - Do not make JA a caption-only duplicate of KO.',
    'render:',
    '  use_capcut_template: true',
    '  audio_path_mode: absolute',
    '  video_placement_mode: source_clips',
    '---',
    '',
    body,
    ''
  ].join('\n');
}

function buildFullAutoInputPaths(sourceUrl, targetLengthSec, mode) {
  const videoId = extractYouTubeVideoId(sourceUrl) || 'source';
  const hash = stableHash({ sourceUrl, targetLengthSec, mode });
  const dir = path.join(FULL_AUTO_INPUT_ROOT, `${videoId}_${hash}`);
  return {
    dir,
    templatePath: path.join(dir, 'auto_template.md'),
    templateBodyKoPath: path.join(dir, 'template_body.ko.md'),
    templateBodyJaPath: path.join(dir, 'template_body.ja.md'),
    supplementalEvidencePath: path.join(dir, 'supplemental_evidence.json'),
    collectionPath: path.join(dir, 'collection_results.json')
  };
}

async function runMidformFullAutoWorkflow(options = {}) {
  const sourceUrl = normalizeYouTubeWatchUrl(options.source || options.sourceUrl || options.source_url);
  if (!sourceUrl) throw new Error('full_auto requires source_url or --source');
  const mode = normalizeMode(options.mode);
  const targetLengthSec = Number(options.target || options.targetLengthSec || options.target_length_sec || 160) || 160;
  const profile = normalizeText(options.profile || 'production') || 'production';
  const analysisMode = normalizeText(options.analysisMode || options.analysis_mode || 'auto') || 'auto';
  const paths = buildFullAutoInputPaths(sourceUrl, targetLengthSec, mode);
  ensureDir(paths.dir);

  const collection = await collectSupplementalEvidence(sourceUrl, options);
  const templateBodies = {
    ko: buildTemplateBody('ko', collection.supplementalEvidence),
    ja: buildTemplateBody('ja', collection.supplementalEvidence)
  };
  writeText(paths.templateBodyKoPath, templateBodies.ko);
  writeText(paths.templateBodyJaPath, templateBodies.ja);
  writeJson(paths.supplementalEvidencePath, collection.supplementalEvidence);
  writeJson(paths.collectionPath, { comments: collection.comments, retention: collection.retention, heatmap: collection.heatmap });
  writeText(paths.templatePath, buildAutoTemplateMarkdown({ sourceUrl, targetLengthSec, profile, analysisMode, body: templateBodies.ko }));

  const baseSummary = {
    status: mode === 'template_only' ? 'template_only_completed' : 'running',
    mode,
    source_url: sourceUrl,
    target_locales: Array.isArray(options.target_locales) ? options.target_locales : ['ko', 'ja'],
    output_paths: {
      auto_template: rel(paths.templatePath),
      template_body_ko: rel(paths.templateBodyKoPath),
      template_body_ja: rel(paths.templateBodyJaPath),
      supplemental_evidence: rel(paths.supplementalEvidencePath),
      collection_results: rel(paths.collectionPath)
    },
    evidence_coverage: collection.supplementalEvidence.evidence_coverage
  };

  if (mode === 'template_only') return baseSummary;

  const runSummary = await runMidformTemplateWorkflow({
    templatePath: paths.templatePath,
    source: sourceUrl,
    target: targetLengthSec,
    profile,
    analysisMode,
    fullAutoMode: mode,
    generatedTemplateBodies: templateBodies,
    supplementalEvidence: collection.supplementalEvidence
  });
  return {
    ...runSummary,
    mode,
    full_auto: true,
    source_url: sourceUrl,
    evidence_coverage: runSummary.evidence_coverage || collection.supplementalEvidence.evidence_coverage,
    output_paths: {
      ...baseSummary.output_paths,
      ...(runSummary.output_paths || {})
    }
  };
}

module.exports = {
  buildAutoTemplateMarkdown,
  buildFullAutoInputPaths,
  buildSupplementalEvidence,
  collectSupplementalEvidence,
  normalizeMode,
  runMidformFullAutoWorkflow
};

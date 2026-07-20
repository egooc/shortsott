const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { requireApiKey } = require('../middleware/auth');
const {
  savePromptPackage,
  generateMidformScriptWithGptCli
} = require('../services/gptMidformCliService');
const {
  createBatchDir,
  generateAllTTS,
  TTS_ROOT
} = require('../services/elevenlabsService');
const { generateSRT } = require('../services/srtGenerator');
const { buildCaptionUnits } = require('../utils/captionUnits');
const { generateDraft } = require('../services/capcutService');
const { generateAndSaveMovieResearch } = require('../services/movieResearchService');

const router = express.Router();
const jobs = new Map();
const PROJECT_ROOT = path.join(__dirname, '../..');
const MIDFORM_GENERATED_DIR = path.join(PROJECT_ROOT, 'midform', 'scripts_generated');
const INPUT_DIR = path.join(PROJECT_ROOT, 'input');
const DEFAULT_SOURCE_VIDEO_PATH = path.join(INPUT_DIR, 'source_clean.mp4');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function resolveProjectPath(inputPath) {
  const rawPath = String(inputPath || '').trim();
  if (!rawPath) return '';
  const resolved = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(PROJECT_ROOT, rawPath);
  const relative = path.relative(PROJECT_ROOT, resolved);
  if (!(relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative)))) {
    const error = new Error('Path must stay inside the project root');
    error.status = 400;
    error.code = 'MIDFORM_PATH_OUTSIDE_PROJECT';
    error.details = { inputPath };
    throw error;
  }
  return resolved;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return readJson(filePath);
}

function timestamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

function writeJsonWithBackup(targetPath, data) {
  ensureDir(path.dirname(targetPath));
  let backupPath = null;
  if (fs.existsSync(targetPath)) {
    const parsed = path.parse(targetPath);
    backupPath = path.join(parsed.dir, `${parsed.name}.backup.${timestamp()}${parsed.ext || '.json'}`);
    fs.copyFileSync(targetPath, backupPath);
  }
  fs.writeFileSync(targetPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return { targetPath, backupPath };
}

function loadGeminiAnalysis(payload) {
  if (payload.gemini_analysis) {
    return { geminiAnalysis: payload.gemini_analysis, sourcePath: '' };
  }
  const sourcePath = resolveProjectPath(payload.gemini_analysis_path);
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    const error = new Error('gemini_analysis_path or gemini_analysis is required');
    error.status = 400;
    error.code = 'MIDFORM_GEMINI_ANALYSIS_REQUIRED';
    error.details = { gemini_analysis_path: payload.gemini_analysis_path || '' };
    throw error;
  }
  return { geminiAnalysis: readJson(sourcePath), sourcePath };
}

function midformOptions(payload) {
  const options = { ...(payload.options || {}) };
  for (const key of ['promptPath', 'prompt_path', 'outputMessagePath', 'output_message_path', 'outputSchemaPath', 'output_schema_path']) {
    delete options[key];
  }
  for (const key of ['transcript', 'sourceTranscript', 'source_transcript', 'transcriptPath', 'transcript_path', 'sourceTranscriptPath', 'slotMap', 'slot_map', 'slotMapPath', 'slot_map_path', 'storyOutline', 'story_outline', 'movieKnowledge', 'movie_knowledge', 'movieIdentity', 'movie_identity', 'movieResearch', 'movie_research', 'contentType', 'content_type', 'disableMovieResearch', 'disable_movie_research', 'sourceVideoPath', 'source_video_path', 'outputBasePath', 'output_base_path']) {
    if (payload[key] !== undefined && options[key] === undefined) options[key] = payload[key];
  }
  return options;
}

function isInsideDirectory(parentDir, candidatePath) {
  const relative = path.relative(parentDir, candidatePath);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function enrichOptionsWithMovieResearch(payload, loaded, options) {
  if (options.disableMovieResearch === true || options.disable_movie_research === true) return options;
  if (options.movieKnowledge || options.movie_knowledge || options.movieResearch || options.movie_research) return options;
  if (!loaded.sourcePath) return options;
  const research = await generateAndSaveMovieResearch({
    geminiAnalysis: loaded.geminiAnalysis,
    geminiAnalysisPath: loaded.sourcePath,
      sourceInfoPath: payload.source_info_path || payload.sourceInfoPath || options.source_info_path || options.sourceInfoPath || '',
      transcript: options.transcript || options.sourceTranscript || options.source_transcript || null,
      transcriptPath: options.transcriptPath || options.transcript_path || options.sourceTranscriptPath || '',
      preflightGate: payload.preflightGate || payload.preflight_gate || options.preflightGate || options.preflight_gate || null,
      preflightGatePath: payload.preflight_gate_path || payload.preflightGatePath || options.preflight_gate_path || options.preflightGatePath || ''
    });
  return {
    ...options,
    movieResearch: research,
    movie_research: research,
    movieIdentity: research.movie_identity,
    movie_identity: research.movie_identity,
    movieKnowledge: research.movie_knowledge,
    movie_knowledge: research.movie_knowledge
  };
}

function loadScript(payload) {
  if (payload.script && typeof payload.script === 'object') {
    return { script: payload.script, sourcePath: '' };
  }
  const sourcePath = resolveProjectPath(payload.script_path);
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    const error = new Error('script_path or script is required');
    error.status = 400;
    error.code = 'MIDFORM_SCRIPT_REQUIRED';
    error.details = { script_path: payload.script_path || '' };
    throw error;
  }
  return { script: readJson(sourcePath), sourcePath };
}

function plannedReviewPath(scriptPath) {
  return path.join(path.dirname(scriptPath), 'script_review.json');
}

function normalizeReviewStatus(checks) {
  const required = ['story_flow_ok', 'all_scenes_valid', 'korean_ending_ok', 'duration_ok', 'ready_for_tts', 'ready_for_capcut'];
  const normalized = Object.fromEntries(required.map((key) => [key, checks?.[key] === true || checks?.[key] === 'true']));
  const approved = Object.values(normalized).every((value) => value === true);
  return { checks: normalized, status: approved ? 'approved' : 'needs_revision' };
}

function assertScriptSegments(script) {
  if (!Array.isArray(script?.segments) || script.segments.length === 0) {
    const error = new Error('script.segments is required');
    error.status = 400;
    error.code = 'MIDFORM_SCRIPT_SEGMENTS_REQUIRED';
    throw error;
  }
}

function resolveReviewPathFromPayload(payload, scriptPath) {
  const explicit = String(payload.review_path || '').trim();
  if (explicit) return resolveProjectPath(explicit);
  return scriptPath ? plannedReviewPath(scriptPath) : '';
}

function loadApprovedReviewIfPresent(reviewPath) {
  if (!reviewPath || !fs.existsSync(reviewPath)) return null;
  const review = readJson(reviewPath);
  if (review?.status !== 'approved') {
    const error = new Error('Midform review exists but is not approved');
    error.status = 400;
    error.code = 'MIDFORM_REVIEW_NOT_APPROVED';
    error.details = { reviewPath, review };
    throw error;
  }
  return review;
}

function buildTtsManifestPath(batchDir) {
  return path.join(batchDir, 'gpt_midform_tts_manifest.json');
}

function resolveBatchAssetPath(batchDir, value) {
  const rawValue = String(value || '').trim();
  if (!rawValue) return '';

  const basename = path.basename(rawValue);
  if (basename) {
    const localSibling = path.join(batchDir, basename);
    if (fs.existsSync(localSibling)) return localSibling;
  }

  const localRelative = path.resolve(batchDir, rawValue);
  if (isInsideDirectory(batchDir, localRelative) && fs.existsSync(localRelative)) return localRelative;

  return '';
}

function normalizeTtsManifestAssets(batchDir, manifest) {
  const files = Array.isArray(manifest?.files)
    ? manifest.files.map((file) => ({
      ...file,
      filepath: resolveBatchAssetPath(batchDir, file.filepath || file.filename)
    }))
    : [];

  return {
    ...manifest,
    files,
    srt_path: resolveBatchAssetPath(batchDir, manifest?.srt_path || manifest?.srt_filename || 'subtitles.srt')
  };
}

function writeJsonWithBackupAndReturn(targetPath, data) {
  return writeJsonWithBackup(targetPath, data);
}

function resolveBatchDir(batchId) {
  const safe = String(batchId || '').trim();
  if (!safe) return '';
  const dir = path.resolve(TTS_ROOT, safe);
  if (!isInsideDirectory(TTS_ROOT, dir)) return '';
  return fs.existsSync(dir) ? dir : '';
}

function buildTtsResponse(script, captionData, generationResult, batchId, dir, modelId) {
  const ttsResults = generationResult.files || [];
  const failedSegments = generationResult.failedSegments || [];
  const warnings = [...(captionData.warnings || []), ...(generationResult.warnings || [])];
  const srtFilename = 'subtitles.srt';
  const srtPath = path.join(dir, srtFilename);
  fs.writeFileSync(srtPath, generateSRT(ttsResults), 'utf8');
  const totalDurationSec = ttsResults.reduce((sum, item) => sum + (item.duration_sec || 0), 0);
  const status = failedSegments.length === 0 ? 'success' : (ttsResults.length > 0 ? 'partial_success' : 'failed');
  const manifest = {
    batch_id: batchId,
    script_id: script.script_id || '',
    model_id: modelId || 'eleven_v3',
    caption_units: captionData.captionUnits,
    tts_caption_units: captionData.ttsCaptionUnits || captionData.captionUnits,
    caption_warnings: warnings,
    segment_to_caption_map: captionData.segmentToCaptionMap || {},
    max_caption_chars: captionData.maxCaptionChars || 42,
    files: ttsResults,
    failed_segments: failedSegments,
    srt_filename: srtFilename,
    srt_path: srtPath,
    total_duration_sec: totalDurationSec,
    created_at: new Date().toISOString()
  };
  fs.writeFileSync(buildTtsManifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return {
    status,
    batchId,
    caption_units: captionData.captionUnits,
    caption_units_count: captionData.captionUnits.length,
    tts_caption_units_count: (captionData.ttsCaptionUnits || captionData.captionUnits).length,
    segment_to_caption_map: captionData.segmentToCaptionMap || {},
    max_caption_chars: captionData.maxCaptionChars || 42,
    files: ttsResults.map(({ caption_id, segment_id, filename, duration_sec, filepath, text }) => ({
      caption_id,
      segment_id,
      filename,
      duration_sec,
      filepath,
      text: text || '',
      success: true
    })),
    failed_segments: failedSegments.map((item) => ({
      caption_id: item.caption_id,
      segment_id: item.segment_id,
      reason: item.reason,
      attempts: item.attempts,
      message: item.message || '',
      success: false,
      duration_sec: null
    })),
    warnings,
    srt_filename: srtFilename,
    srt_path: srtPath,
    total_duration_sec: totalDurationSec,
    manifest_path: buildTtsManifestPath(dir)
  };
}

async function withTemporarySourceVideo(sourceVideoPath, work) {
  const explicit = String(sourceVideoPath || '').trim();
  if (!explicit) {
    return work();
  }
  const resolvedSourcePath = resolveProjectPath(explicit);
  if (!fs.existsSync(resolvedSourcePath)) {
    const error = new Error('source_video_path not found');
    error.status = 400;
    error.code = 'MIDFORM_SOURCE_VIDEO_NOT_FOUND';
    error.details = { source_video_path: explicit };
    throw error;
  }
  ensureDir(INPUT_DIR);
  const backupPath = fs.existsSync(DEFAULT_SOURCE_VIDEO_PATH)
    ? `${DEFAULT_SOURCE_VIDEO_PATH}.backup.${timestamp()}`
    : '';
  try {
    if (backupPath) fs.copyFileSync(DEFAULT_SOURCE_VIDEO_PATH, backupPath);
    fs.copyFileSync(resolvedSourcePath, DEFAULT_SOURCE_VIDEO_PATH);
    return await work();
  } finally {
    if (backupPath && fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, DEFAULT_SOURCE_VIDEO_PATH);
      fs.unlinkSync(backupPath);
    }
  }
}

async function generateGptTts(payload) {
  const loaded = loadScript(payload);
  assertScriptSegments(loaded.script);
  const reviewPath = resolveReviewPathFromPayload(payload, loaded.sourcePath);
  loadApprovedReviewIfPresent(reviewPath);
  const apiKey = requireApiKey('ELEVENLABS_API_KEY');
  const voiceId = String(payload.voiceId || payload.voice_id || '').trim();
  if (!voiceId) {
    const error = new Error('voiceId is required');
    error.status = 400;
    error.code = 'VOICE_ID_REQUIRED';
    throw error;
  }
  const modelId = String(payload.modelId || payload.model_id || 'eleven_v3').trim();
  const captionData = Array.isArray(payload.captionUnits) && payload.captionUnits.length
    ? { captionUnits: payload.captionUnits, warnings: [], segmentToCaptionMap: {}, maxCaptionChars: 42 }
    : buildCaptionUnits(loaded.script.segments);
  captionData.ttsCaptionUnits = captionData.captionUnits.filter((unit) => unit.tts_enabled !== false);
  if (!Array.isArray(captionData.captionUnits) || captionData.captionUnits.length === 0) {
    const error = new Error('No valid caption units generated from script');
    error.status = 400;
    error.code = 'CAPTION_UNITS_REQUIRED';
    throw error;
  }
  if (!captionData.ttsCaptionUnits.length) {
    const error = new Error('No TTS-enabled caption units generated from script');
    error.status = 400;
    error.code = 'TTS_CAPTION_UNITS_REQUIRED';
    throw error;
  }
  const { batchId, dir } = createBatchDir();
  const generationResult = await generateAllTTS(captionData.ttsCaptionUnits, voiceId, modelId, apiKey, dir);
  return buildTtsResponse(loaded.script, captionData, generationResult, batchId, dir, modelId);
}

async function generateGptDraft(payload) {
  const loaded = loadScript(payload);
  assertScriptSegments(loaded.script);
  const batchId = String(payload.batchId || payload.batch_id || '').trim();
  if (!batchId) {
    const error = new Error('batchId is required');
    error.status = 400;
    error.code = 'BATCH_ID_REQUIRED';
    throw error;
  }
  const batchDir = resolveBatchDir(batchId);
  if (!batchDir) {
    const error = new Error('TTS batch not found');
    error.status = 404;
    error.code = 'BATCH_NOT_FOUND';
    error.details = { batchId };
    throw error;
  }
  const manifestPath = buildTtsManifestPath(batchDir);
  const manifest = normalizeTtsManifestAssets(batchDir, readJsonIfExists(manifestPath));
  if (!manifest) {
    const error = new Error('TTS manifest not found');
    error.status = 404;
    error.code = 'TTS_MANIFEST_NOT_FOUND';
    error.details = { manifestPath };
    throw error;
  }
  const reviewPath = resolveReviewPathFromPayload(payload, loaded.sourcePath);
  loadApprovedReviewIfPresent(reviewPath);
  return withTemporarySourceVideo(payload.source_video_path, async () => generateDraft(
    loaded.script.segments || [],
    manifest.files || [],
    manifest.caption_units || [],
    manifest.caption_warnings || [],
    manifest.srt_path || manifest.srt_filename || 'subtitles.srt',
    payload.resolution || { width: 1080, height: 1920 },
    payload.fps || 30,
    payload.audioPathMode || payload.audio_path_mode || 'absolute',
    payload.videoPlacementMode || payload.video_placement_mode || 'source_clips',
    payload.useCapcutTemplate !== false,
    loaded.script,
    { ...midformOptions(payload), slotMap: loaded.script.slot_map || payload.slotMap || payload.slot_map }
  ));
}

function plannedScriptPath(sourcePath, scriptId) {
  if (sourcePath) return path.join(path.dirname(sourcePath), 'script.json');
  return path.join(MIDFORM_GENERATED_DIR, `${scriptId}.json`);
}

function errorBody(error) {
  return {
    message: error.message || 'GPT midform script generation failed',
    code: error.code || 'GPT_MIDFORM_SCRIPT_FAILED',
    details: error.details || {}
  };
}

router.post('/package', (req, res, next) => {
  try {
    const payload = req.body || {};
    const loaded = loadGeminiAnalysis(payload);
    const outputDir = loaded.sourcePath ? path.dirname(loaded.sourcePath) : MIDFORM_GENERATED_DIR;
    const saved = savePromptPackage(loaded.geminiAnalysis, outputDir, midformOptions(payload));
    return res.json({
      promptPath: saved.promptPath,
      inputPath: saved.inputPath,
      originalSceneCount: saved.condensed.scene_condensation.original_scene_count,
      condensedBeatCount: saved.condensed.scene_condensation.condensed_beat_count
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/movie-research', async (req, res, next) => {
  try {
    const payload = req.body || {};
    const loaded = loadGeminiAnalysis(payload);
    const result = await generateAndSaveMovieResearch({
      geminiAnalysis: loaded.geminiAnalysis,
      geminiAnalysisPath: loaded.sourcePath,
      sourceInfoPath: payload.source_info_path || payload.sourceInfoPath || '',
      transcript: payload.transcript || payload.sourceTranscript || payload.source_transcript || null,
      transcriptPath: payload.transcriptPath || payload.transcript_path || payload.sourceTranscriptPath || '',
      outputPath: payload.output_path || payload.outputPath || ''
    });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

router.post('/script', (req, res, next) => {
  try {
    const payload = req.body || {};
    const scriptId = crypto.randomUUID();
    const loaded = loadGeminiAnalysis(payload);
    const savePath = plannedScriptPath(loaded.sourcePath, scriptId);
    jobs.set(scriptId, { status: 'processing', plannedSavePath: savePath, createdAt: Date.now() });

    (async () => {
      const options = await enrichOptionsWithMovieResearch(payload, loaded, midformOptions(payload));
      return generateMidformScriptWithGptCli(loaded.geminiAnalysis, {
        ...options,
        scriptId
      });
    })()
      .then((result) => {
        const saved = writeJsonWithBackup(savePath, result.script);
        jobs.set(scriptId, {
          status: 'completed',
          result: result.script,
          cli: result.cli,
          savedPath: saved.targetPath,
          backupPath: saved.backupPath || null,
          plannedSavePath: savePath,
          createdAt: Date.now()
        });
      })
      .catch((error) => {
        jobs.set(scriptId, {
          status: 'failed',
          error: errorBody(error),
          plannedSavePath: savePath,
          createdAt: Date.now()
        });
      });

    return res.json({ scriptId, status: 'processing', plannedSavePath: savePath });
  } catch (error) {
    return next(error);
  }
});

router.get('/script/:scriptId', (req, res) => {
  const job = jobs.get(req.params.scriptId);
  if (!job) {
    return res.status(404).json({
      error: true,
      message: 'GPT midform script job not found',
      code: 'GPT_MIDFORM_JOB_NOT_FOUND',
      details: { scriptId: req.params.scriptId }
    });
  }
  return res.json(job);
});

router.get('/latest-script', (_req, res, next) => {
  try {
    const savedPath = path.join(PROJECT_ROOT, 'midform', 'analysis', 'script.json');
    if (!fs.existsSync(savedPath)) {
      return res.status(404).json({
        error: true,
        message: 'GPT midform script not found',
        code: 'GPT_MIDFORM_SCRIPT_NOT_FOUND',
        details: { savedPath }
      });
    }
    const reviewPath = plannedReviewPath(savedPath);
    return res.json({
      script: readJson(savedPath),
      savedPath,
      review: readJsonIfExists(reviewPath),
      reviewPath: fs.existsSync(reviewPath) ? reviewPath : null
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/review', (req, res, next) => {
  try {
    const payload = req.body || {};
    const loaded = loadScript(payload);
    if (!loaded.sourcePath) {
      return res.status(400).json({ error: true, message: 'script_path is required', code: 'MIDFORM_SCRIPT_PATH_REQUIRED', details: {} });
    }
    const normalized = normalizeReviewStatus(payload.checks || {});
    const review = {
      status: normalized.status,
      approved_at: normalized.status === 'approved' ? new Date().toISOString() : '',
      script_path: loaded.sourcePath,
      checks: normalized.checks,
      reviewer_notes: String(payload.reviewer_notes || ''),
      created_at: new Date().toISOString()
    };
    const saved = writeJsonWithBackupAndReturn(plannedReviewPath(loaded.sourcePath), review);
    return res.json({ review, savedPath: saved.targetPath, backupPath: saved.backupPath || null });
  } catch (error) {
    return next(error);
  }
});

router.get('/review', (req, res, next) => {
  try {
    const scriptPath = resolveProjectPath(req.query.script_path);
    if (!scriptPath) {
      return res.status(400).json({ error: true, message: 'script_path query parameter is required', code: 'MIDFORM_SCRIPT_PATH_REQUIRED', details: {} });
    }
    const reviewPath = plannedReviewPath(scriptPath);
    if (!fs.existsSync(reviewPath)) {
      return res.status(404).json({ error: true, message: 'GPT midform review not found', code: 'GPT_MIDFORM_REVIEW_NOT_FOUND', details: { reviewPath } });
    }
    return res.json({ review: readJson(reviewPath), savedPath: reviewPath });
  } catch (error) {
    return next(error);
  }
});

router.post('/tts', async (req, res, next) => {
  try {
    const result = await generateGptTts(req.body || {});
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

router.post('/draft', async (req, res, next) => {
  try {
    const result = await generateGptDraft(req.body || {});
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

router.post('/pipeline', async (req, res, next) => {
  try {
    const payload = req.body || {};
    const existingBatchId = String(payload.batchId || payload.batch_id || '').trim();
    const tts = existingBatchId
      ? { status: 'reused', batchId: existingBatchId }
      : await generateGptTts(payload);
    if (!existingBatchId && (tts.status === 'failed' || !Array.isArray(tts.files) || !tts.files.length)) {
      return res.status(400).json({
        error: true,
        message: 'TTS generation failed before draft generation',
        code: 'GPT_MIDFORM_TTS_FAILED',
        details: tts
      });
    }
    const draft = await generateGptDraft({ ...payload, batchId: tts.batchId });
    return res.json({
      status: 'success',
      tts,
      draft
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

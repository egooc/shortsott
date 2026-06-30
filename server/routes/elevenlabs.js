const fs = require('fs');
const path = require('path');
const express = require('express');
const { readJsonIfExists } = require('../services/pipelinePaths');
const { CLAUDE_SCRIPT_PATH, CLAUDE_REVIEW_PATH } = require('../services/claudeCliService');
const { requireApiKey } = require('../middleware/auth');
const {
  TTS_ROOT,
  getVoices,
  ttsRequest,
  generateAllTTS,
  createBatchDir,
  zipDirectory
} = require('../services/elevenlabsService');
const { generateSRT } = require('../services/srtGenerator');
const { buildCaptionUnits } = require('../utils/captionUnits');

const router = express.Router();
let lastBatchId = null;

function assertClaudeReviewApproved() {
  const script = readJsonIfExists(CLAUDE_SCRIPT_PATH);
  if (!script) {
    const err = new Error('Claude script not found. Generate Phase3 script first.');
    err.status = 400;
    err.code = 'CLAUDE_SCRIPT_NOT_FOUND';
    throw err;
  }

  const review = readJsonIfExists(CLAUDE_REVIEW_PATH);
  if (!review) {
    const err = new Error('Claude result must be reviewed before TTS generation');
    err.status = 400;
    err.code = 'CLAUDE_REVIEW_NOT_FOUND';
    err.details = { path: CLAUDE_REVIEW_PATH };
    throw err;
  }

  const checks = review.checks || {};
  const ready = review.status === 'approved' && checks.ready_for_tts === true;
  if (!ready) {
    const err = new Error('Claude result must be reviewed and approved before TTS generation');
    err.status = 400;
    err.code = 'CLAUDE_REVIEW_NOT_APPROVED';
    err.details = { review };
    throw err;
  }
}

function resolveBatchDir(batchId) {
  const dir = path.join(TTS_ROOT, batchId || '');
  return fs.existsSync(dir) ? dir : null;
}

function findFileRecursive(dir, filename) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFileRecursive(full, filename);
      if (found) return found;
    } else if (entry.name === filename) {
      return full;
    }
  }
  return null;
}

router.get('/voices', async (_req, res, next) => {
  try {
    const apiKey = requireApiKey('ELEVENLABS_API_KEY');
    const voices = await getVoices(apiKey);
    res.json({ voices });
  } catch (error) {
    next(error);
  }
});

router.post('/preview', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('ELEVENLABS_API_KEY');
    const { text, voiceId, modelId } = req.body || {};
    const audio = await ttsRequest(text || '', voiceId, modelId, apiKey);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(audio);
  } catch (error) {
    next(error);
  }
});

router.post('/generate', async (req, res, next) => {
  try {
    assertClaudeReviewApproved();
    const apiKey = requireApiKey('ELEVENLABS_API_KEY');
    const { segments, captionUnits, voiceId, modelId } = req.body || {};

    if (!Array.isArray(segments) || segments.length === 0) {
      return res.status(400).json({ error: true, message: 'segments is required', code: 'SEGMENTS_REQUIRED', details: {} });
    }

    const derivedCaption = Array.isArray(captionUnits) && captionUnits.length > 0
      ? {
          captionUnits,
          warnings: [],
          segmentToCaptionMap: {},
          maxCaptionChars: 42
        }
      : buildCaptionUnits(segments);

    if (!Array.isArray(derivedCaption.captionUnits) || derivedCaption.captionUnits.length === 0) {
      return res.status(400).json({
        error: true,
        message: 'No valid caption units generated from narration',
        code: 'CAPTION_UNITS_REQUIRED',
        details: {}
      });
    }

    const { batchId, dir } = createBatchDir();
    const generationResult = await generateAllTTS(derivedCaption.captionUnits, voiceId, modelId, apiKey, dir);
    const ttsResults = generationResult.files || [];
    const failedSegments = generationResult.failedSegments || [];
    const warnings = [...(derivedCaption.warnings || []), ...(generationResult.warnings || [])];
    const srtBody = generateSRT(ttsResults);
    const srtFilename = 'subtitles.srt';
    const srtPath = path.join(dir, srtFilename);
    fs.writeFileSync(srtPath, srtBody, 'utf8');

    lastBatchId = batchId;

    const totalDurationSec = ttsResults.reduce((sum, item) => sum + (item.duration_sec || 0), 0);
    const status = failedSegments.length === 0
      ? 'success'
      : (ttsResults.length > 0 ? 'partial_success' : 'failed');

    res.json({
      status,
      batchId,
      caption_units: derivedCaption.captionUnits,
      caption_units_count: derivedCaption.captionUnits.length,
      segment_to_caption_map: derivedCaption.segmentToCaptionMap || {},
      max_caption_chars: derivedCaption.maxCaptionChars || 42,
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
      total_duration_sec: totalDurationSec
    });
  } catch (error) {
    next(error);
  }
});

router.get('/download-srt', (req, res) => {
  const batchId = req.query.batchId || lastBatchId;
  if (!batchId) {
    return res.status(400).json({ error: true, message: 'No generated batch yet', code: 'BATCH_NOT_FOUND', details: {} });
  }

  const batchDir = resolveBatchDir(batchId);
  if (!batchDir) {
    return res.status(404).json({ error: true, message: 'batch not found', code: 'BATCH_NOT_FOUND', details: { batchId } });
  }

  const srtPath = path.join(batchDir, 'subtitles.srt');
  if (!fs.existsSync(srtPath)) {
    return res.status(404).json({ error: true, message: 'SRT file not found', code: 'SRT_NOT_FOUND', details: { batchId } });
  }

  return res.download(srtPath, `${batchId}_subtitles.srt`);
});

router.get('/download/:filename', (req, res) => {
  const found = findFileRecursive(TTS_ROOT, req.params.filename);
  if (!found) {
    return res.status(404).json({ error: true, message: 'file not found', code: 'FILE_NOT_FOUND', details: {} });
  }
  res.download(found);
});

router.get('/download-all', async (req, res, next) => {
  try {
    const batchId = req.query.batchId || lastBatchId;
    if (!batchId) {
      return res.status(400).json({ error: true, message: 'No generated batch yet', code: 'BATCH_NOT_FOUND', details: {} });
    }

    const batchDir = resolveBatchDir(batchId);
    if (!batchDir) {
      return res.status(404).json({ error: true, message: 'batch not found', code: 'BATCH_NOT_FOUND', details: { batchId } });
    }

    const zipPath = path.join(TTS_ROOT, `${batchId}.zip`);
    await zipDirectory(batchDir, zipPath);
    res.download(zipPath);
  } catch (error) {
    next(error);
  }
});

module.exports = router;

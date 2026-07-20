const express = require('express');
const { generateDraft, getCapcutTemplateStatus, DRAFTS_OUTPUT_DIR } = require('../services/capcutService');

const router = express.Router();

router.post('/generate-draft', async (req, res, next) => {
  try {
    const {
      segments,
      ttsFiles,
      captionUnits,
      captionWarnings,
      srtFile,
      resolution,
      fps,
      audioPathMode,
      videoPlacementMode,
      useCapcutTemplate,
      claudeScript,
      sourceTranscript,
      source_transcript,
      sourceTranscriptPath,
      source_transcript_path,
      transcriptPath,
      transcript_path,
      sourceVideoPath,
      source_video_path,
      outputBasePath,
      output_base_path
    } = req.body || {};
    const result = await generateDraft(
      segments || [],
      ttsFiles || [],
      captionUnits || [],
      captionWarnings || [],
      srtFile || 'subtitles.srt',
      resolution || { width: 1080, height: 1920 },
      fps || 30,
      audioPathMode || 'absolute',
      videoPlacementMode || 'source_clips',
      useCapcutTemplate !== false,
      claudeScript && typeof claudeScript === 'object' ? claudeScript : {},
      {
        ...(sourceTranscript ? { sourceTranscript } : {}),
        ...(source_transcript ? { source_transcript } : {}),
        ...(sourceTranscriptPath ? { sourceTranscriptPath } : {}),
        ...(source_transcript_path ? { source_transcript_path } : {}),
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(transcript_path ? { transcript_path } : {}),
        ...(sourceVideoPath ? { sourceVideoPath } : {}),
        ...(source_video_path ? { source_video_path } : {}),
        ...(outputBasePath ? { outputBasePath } : {}),
        ...(output_base_path ? { output_base_path } : {})
      }
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/template-status', (req, res) => {
  res.json(getCapcutTemplateStatus());
});

router.get('/download/:zipFile', (req, res) => {
  const path = require('path');
  const fs = require('fs');
  const draftsDir = DRAFTS_OUTPUT_DIR;
  const requested = req.params.zipFile || '';
  const safeName = path.basename(requested);

  if (requested !== safeName) {
    return res.status(400).json({ error: true, message: 'invalid zip file name', code: 'INVALID_ZIP_NAME', details: {} });
  }

  const zipPath = path.resolve(draftsDir, safeName);
  if (!zipPath.startsWith(`${draftsDir}${path.sep}`)) {
    return res.status(400).json({ error: true, message: 'invalid zip file path', code: 'INVALID_ZIP_PATH', details: {} });
  }

  if (!fs.existsSync(zipPath)) {
    console.error('[capcut.download] zip not found at path:', zipPath);
    return res.status(404).json({ error: true, message: 'zip not found', code: 'ZIP_NOT_FOUND', details: {} });
  }
  return res.download(zipPath);
});

module.exports = router;

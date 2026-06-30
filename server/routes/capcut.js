const express = require('express');
const { generateDraft, getCapcutTemplateStatus } = require('../services/capcutService');

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
      claudeScript
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
      claudeScript && typeof claudeScript === 'object' ? claudeScript : {}
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
  const draftsDir = path.resolve(__dirname, '../output/drafts');
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

const express = require('express');
const {
  getConfig,
  saveConfig,
  getPresets,
  createProcessDraft
} = require('../services/processEditService');
const { createCapcutExportRequest } = require('../services/capcutExportService');

const router = express.Router();

router.get('/config', (_req, res) => {
  res.json(getConfig());
});

router.post('/config', (req, res) => {
  res.json(saveConfig(req.body?.config || req.body || {}));
});

router.get('/presets', (_req, res) => {
  res.json(getPresets());
});

router.post('/generate-draft', async (req, res, next) => {
  try {
    const result = await createProcessDraft({
      config: req.body?.config,
      useExistingConfig: req.body?.useExistingConfig !== false
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/export', (req, res, next) => {
  try {
    res.json(createCapcutExportRequest(req.body || {}));
  } catch (error) {
    next(error);
  }
});

module.exports = router;

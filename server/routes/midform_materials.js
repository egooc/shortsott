const express = require('express');
const {
  loadChannels,
  loadMaterials,
  filterMaterials,
  scanChannel,
  getScanStatus
} = require('../services/midformMaterialsService');

const router = express.Router();

router.get('/channels', (req, res, next) => {
  try {
    const channels = loadChannels();
    return res.json({
      channels,
      counts: {
        total: channels.length,
        graded: channels.filter((channel) => channel.analyzed).length,
        unanalyzed: channels.filter((channel) => !channel.analyzed).length
      }
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/channels/:handle/scan', async (req, res, next) => {
  try {
    const result = await scanChannel(req.params.handle, { force: req.body?.force === true });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

router.get('/channels/scan-status', (_req, res) => {
  res.json(getScanStatus());
});

router.get('/materials', (req, res, next) => {
  try {
    return res.json(filterMaterials(req.query || {}));
  } catch (error) {
    return next(error);
  }
});

router.post('/materials/reload', (_req, res, next) => {
  try {
    return res.json(loadMaterials({ reload: true }));
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

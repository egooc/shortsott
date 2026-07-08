const express = require('express');
const highlightPatternService = require('../services/highlightPatternService');
const highlightSlicerService = require('../services/highlightSlicerService');
const abExperimentService = require('../services/abExperimentService');
const highlightPatternDb = require('../services/highlightPatternDbService');

const router = express.Router();

router.post('/', async (req, res, next) => {
  try {
    const urls = req.body?.urls;
    if (!urls || (Array.isArray(urls) && urls.length === 0)) {
      return res.status(400).json({ error: true, message: 'urls is required', code: 'URLS_REQUIRED', details: {} });
    }
    const analysisMode = req.body?.analysisMode === 'slice_source' ? 'slice_source' : 'training';
    const { created, skipped } = await highlightPatternService.submitUrls(urls, { analysisMode });
    res.json({ created, skipped });
  } catch (error) {
    next(error);
  }
});

router.post('/scan-channel', async (req, res, next) => {
  try {
    const handle = req.body?.handle;
    if (!handle) {
      return res.status(400).json({ error: true, message: 'handle is required', code: 'HANDLE_REQUIRED', details: {} });
    }
    const maxDurationSeconds = Number(req.body?.maxDurationSeconds) || undefined;
    const maxResults = Number(req.body?.maxResults) || undefined;
    const result = await highlightPatternService.scanChannel({ handleOrUrl: handle, maxDurationSeconds, maxResults });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/', (_req, res, next) => {
  try {
    const { items, summary } = highlightPatternService.listAll();
    res.json({ items, summary });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    const item = highlightPatternService.getById(req.params.id);
    if (!item) {
      return res.status(404).json({ error: true, message: 'highlight pattern not found', code: 'HIGHLIGHT_PATTERN_NOT_FOUND', details: {} });
    }
    res.json({ item });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/extract-timeline', async (req, res, next) => {
  try {
    const result = await highlightSlicerService.extractTimeline(req.params.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/slice-candidates', async (req, res, next) => {
  try {
    const result = await highlightSlicerService.generateSliceCandidates(req.params.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    highlightPatternService.remove(req.params.id);
    res.json({ removed: true, id: req.params.id });
  } catch (error) {
    next(error);
  }
});

// --- Track B duration A/B (PLAYBOOK.md section 3) ---

router.post('/ab/channels', (req, res, next) => {
  try {
    const result = abExperimentService.registerChannel({
      channelId: req.body?.channelId,
      channelName: req.body?.channelName,
      role: req.body?.role,
      baselineMedian: Number(req.body?.baselineMedian)
    });
    res.json({ item: result });
  } catch (error) {
    next(error);
  }
});

router.get('/ab/channels', (_req, res, next) => {
  try {
    res.json({ items: abExperimentService.listChannels() });
  } catch (error) {
    next(error);
  }
});

router.post('/ab/pairs', async (req, res, next) => {
  try {
    const sourceVideoId = req.body?.sourceVideoId;
    if (!sourceVideoId) {
      return res.status(400).json({ error: true, message: 'sourceVideoId is required', code: 'SOURCE_VIDEO_ID_REQUIRED', details: {} });
    }
    const result = await abExperimentService.createPair(sourceVideoId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/ab/assignments', (_req, res, next) => {
  try {
    res.json({ items: highlightPatternDb.listAbAssignments() });
  } catch (error) {
    next(error);
  }
});

router.get('/ab/pairs/:pairId', (req, res, next) => {
  try {
    res.json({ members: highlightPatternDb.getAbPair(req.params.pairId) });
  } catch (error) {
    next(error);
  }
});

router.post('/ab/assignments/:id/produced', (req, res, next) => {
  try {
    const updated = abExperimentService.markProduced(req.params.id, { jobId: req.body?.jobId });
    res.json({ item: updated });
  } catch (error) {
    next(error);
  }
});

router.post('/ab/assignments/:id/published', (req, res, next) => {
  try {
    const updated = abExperimentService.markPublished(req.params.id, {
      youtubeVideoId: req.body?.youtubeVideoId,
      publishedAt: req.body?.publishedAt
    });
    res.json({ item: updated });
  } catch (error) {
    next(error);
  }
});

router.post('/ab/assignments/:id/dropped', (req, res, next) => {
  try {
    const updated = abExperimentService.markDropped(req.params.id, { reason: req.body?.reason });
    res.json({ item: updated });
  } catch (error) {
    next(error);
  }
});

router.post('/ab/assignments/:id/metrics', (req, res, next) => {
  try {
    // channelMedianAt7d is intentionally not accepted here -- recordMetrics
    // always uses the assignment's channel's frozen baseline_median
    // (PLAYBOOK.md section 3 amendment), never a caller-supplied live value.
    const updated = abExperimentService.recordMetrics(req.params.id, {
      viewCountAt7d: Number(req.body?.viewCountAt7d),
      avgViewDurationPct: req.body?.avgViewDurationPct !== undefined ? Number(req.body.avgViewDurationPct) : undefined
    });
    res.json({ item: updated });
  } catch (error) {
    next(error);
  }
});

router.get('/ab/report', (_req, res, next) => {
  try {
    res.json(abExperimentService.computeDecisionReport());
  } catch (error) {
    next(error);
  }
});

module.exports = router;

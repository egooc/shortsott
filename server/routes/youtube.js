const express = require('express');
const { requireApiKey } = require('../middleware/auth');
const { scoutYoutubeShorts } = require('../services/youtubeScoutService');
const {
  annotateVideos,
  excludeSource,
  getSourceState,
  readLibrary,
  restoreSource,
  summarizeLibrary,
  syncProducedFromProcessReports
} = require('../services/sourceDiscoveryLibrary');

const router = express.Router();

router.get('/scout', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('YOUTUBE_API_KEY');
    const result = await scoutYoutubeShorts({
      apiKey,
      hashtag: req.query.hashtag,
      period: req.query.period || '7d',
      sort: req.query.sort || 'views',
      minViews: req.query.minViews || 0,
      maxViews: req.query.maxViews || 0,
      limit: req.query.limit || 50,
      sourceMode: req.query.sourceMode || req.query.source_mode || 'shortform'
    });
    const includeExcluded = String(req.query.includeExcluded || req.query.include_excluded || '').toLowerCase() === 'true';
    syncProducedFromProcessReports();
    const annotated = annotateVideos(result.videos || [], { hideExcluded: !includeExcluded });
    res.json({
      ...result,
      videos: annotated.videos,
      videosCount: annotated.videos.length,
      hiddenExcludedCount: annotated.hiddenExcludedCount,
      sourceLibrary: annotated.librarySummary,
      includeExcluded
    });
  } catch (error) {
    next(error);
  }
});

router.get('/source-library', (_req, res, next) => {
  try {
    const library = syncProducedFromProcessReports();
    res.json({
      status: 'success',
      summary: summarizeLibrary(library),
      library
    });
  } catch (error) {
    next(error);
  }
});

router.post('/source-library/exclude', (req, res, next) => {
  try {
    const library = excludeSource({
      url: req.body?.url || req.body?.sourceUrl || req.body?.source_url,
      video: req.body?.video,
      reason: req.body?.reason || 'manual_exclude'
    });
    res.json({
      status: 'success',
      summary: summarizeLibrary(library),
      state: getSourceState(req.body?.url || req.body?.sourceUrl || req.body?.source_url)
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/source-library/exclude', (req, res, next) => {
  try {
    const library = restoreSource({
      url: req.body?.url || req.query?.url
    });
    res.json({
      status: 'success',
      summary: summarizeLibrary(library),
      state: getSourceState(req.body?.url || req.query?.url)
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

const express = require('express');
const { requireApiKey } = require('../middleware/auth');
const {
  createOrbit,
  getOrbit,
  getOrbitVideos,
  getCachedOrbitForPayload,
  createFingerprint,
  listOrbits,
  getOrbitById,
  getOrbitTrendsLatest,
  getOrbitCreatorOutliers,
  getOrbitSounds,
  getGlobalTrends,
  getTrendingHashtags,
  getTrendingSounds,
  getVideosDigest,
  getPlatformVideosDigest,
  getNiches,
  getNicheTrends,
  listComets,
  getCometById,
  getCometVideos,
  getCometSlideshows,
  getCometAds,
  getCometSounds,
  getCometCreatorOutliers,
  getCometAnalysisLatest,
  queryCometAnalysis,
  getCometTrendsLatest,
  queryCometTrends,
  createComet,
  updateComet,
  deleteComet,
  listTrackingCreators,
  listTrackingVideos,
  trackCreator,
  getTrackedCreator,
  updateTrackedCreator,
  stopTrackingCreator,
  getCreatorReport,
  getCreatorSnapshots,
  trackVideo,
  getTrackedVideo,
  updateTrackedVideo,
  stopTrackingVideo,
  getVideoReport,
  getVideoSnapshots
} = require('../services/virloService');
const {
  listCandidates,
  addCandidate,
  deleteCandidate,
  listCreatorWatchlist,
  addCreatorWatch
} = require('../services/virloDataService');

const router = express.Router();

router.get('/data/orbits', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await listOrbits(apiKey, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo orbit list fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_orbits_list' };
    next(error);
  }
});

router.get('/data/orbits/:orbitId', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getOrbitById(apiKey, req.params.orbitId);
    res.json(data);
  } catch (error) {
    error.message = `Virlo orbit detail fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_orbit_detail', orbitId: req.params.orbitId };
    next(error);
  }
});

router.get('/data/orbits/:orbitId/videos', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getOrbitVideos(apiKey, req.params.orbitId, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo orbit videos fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_orbit_videos', orbitId: req.params.orbitId };
    next(error);
  }
});

router.get('/data/orbits/:orbitId/trends/latest', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getOrbitTrendsLatest(apiKey, req.params.orbitId);
    res.json(data);
  } catch (error) {
    error.message = `Virlo orbit trends fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_orbit_trends_latest', orbitId: req.params.orbitId };
    next(error);
  }
});

router.get('/data/orbits/:orbitId/outliers', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getOrbitCreatorOutliers(apiKey, req.params.orbitId, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo orbit outliers fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_orbit_outliers', orbitId: req.params.orbitId };
    next(error);
  }
});

router.get('/data/orbits/:orbitId/sounds', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getOrbitSounds(apiKey, req.params.orbitId, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo orbit sounds fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_orbit_sounds', orbitId: req.params.orbitId };
    next(error);
  }
});

router.get('/data/trends', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getGlobalTrends(apiKey, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo trends fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_trends' };
    next(error);
  }
});

router.get('/data/hashtags', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getTrendingHashtags(apiKey, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo hashtags fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_hashtags' };
    next(error);
  }
});

router.get('/data/sounds/trending', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getTrendingSounds(apiKey, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo trending sounds fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_sounds_trending' };
    next(error);
  }
});

router.get('/data/videos/digest', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getVideosDigest(apiKey, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo videos digest fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_videos_digest' };
    next(error);
  }
});

router.get('/data/videos/:platform/digest', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getPlatformVideosDigest(apiKey, req.params.platform, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo ${req.params.platform} videos digest fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_platform_videos_digest', platform: req.params.platform };
    next(error);
  }
});

router.get('/data/niches', async (_req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getNiches(apiKey);
    res.json(data);
  } catch (error) {
    error.message = `Virlo niches fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_niches' };
    next(error);
  }
});

router.get('/data/niches/:nicheId/trends', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getNicheTrends(apiKey, req.params.nicheId);
    res.json(data);
  } catch (error) {
    error.message = `Virlo niche trends fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_niche_trends', nicheId: req.params.nicheId };
    next(error);
  }
});

router.get('/data/comets', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await listComets(apiKey, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo comets fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_comets' };
    next(error);
  }
});

router.get('/data/comets/:id', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getCometById(apiKey, req.params.id);
    res.json(data);
  } catch (error) {
    error.message = `Virlo comet detail fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_comet_detail', id: req.params.id };
    next(error);
  }
});

router.get('/data/comets/:id/videos', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getCometVideos(apiKey, req.params.id, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo comet videos fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_comet_videos', id: req.params.id };
    next(error);
  }
});

router.get('/data/comets/:id/slideshows', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getCometSlideshows(apiKey, req.params.id, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo comet slideshows fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_comet_slideshows', id: req.params.id };
    next(error);
  }
});

router.get('/data/comets/:id/ads', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getCometAds(apiKey, req.params.id, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo comet ads fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_comet_ads', id: req.params.id };
    next(error);
  }
});

router.get('/data/comets/:id/sounds', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getCometSounds(apiKey, req.params.id, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo comet sounds fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_comet_sounds', id: req.params.id };
    next(error);
  }
});

router.get('/data/comets/:id/outliers', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getCometCreatorOutliers(apiKey, req.params.id, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo comet outliers fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_comet_outliers', id: req.params.id };
    next(error);
  }
});

router.get('/data/comets/:id/analysis/latest', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getCometAnalysisLatest(apiKey, req.params.id);
    res.json(data);
  } catch (error) {
    error.message = `Virlo comet latest analysis fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_comet_analysis_latest', id: req.params.id };
    next(error);
  }
});

router.get('/data/comets/:id/analysis', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await queryCometAnalysis(apiKey, req.params.id, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo comet analysis query failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_comet_analysis_query', id: req.params.id };
    next(error);
  }
});

router.get('/data/comets/:id/trends/latest', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getCometTrendsLatest(apiKey, req.params.id);
    res.json(data);
  } catch (error) {
    error.message = `Virlo comet latest trends fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_comet_trends_latest', id: req.params.id };
    next(error);
  }
});

router.get('/data/comets/:id/trends', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await queryCometTrends(apiKey, req.params.id, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo comet trends query failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_comet_trends_query', id: req.params.id };
    next(error);
  }
});

router.post('/data/comets', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await createComet(apiKey, req.body || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo comet create failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_comet_create' };
    next(error);
  }
});

router.put('/data/comets/:id', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await updateComet(apiKey, req.params.id, req.body || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo comet update failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_comet_update', id: req.params.id };
    next(error);
  }
});

router.delete('/data/comets/:id', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await deleteComet(apiKey, req.params.id);
    res.json(data || { message: 'Comet deactivated successfully' });
  } catch (error) {
    error.message = `Virlo comet delete failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_comet_delete', id: req.params.id };
    next(error);
  }
});

router.get('/data/tracking/creators', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await listTrackingCreators(apiKey, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo tracking creators fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_tracking_creators' };
    next(error);
  }
});

router.post('/data/tracking/creators', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await trackCreator(apiKey, req.body || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo track creator failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_tracking_create_creator' };
    next(error);
  }
});

router.get('/data/tracking/creators/:id', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getTrackedCreator(apiKey, req.params.id);
    res.json(data);
  } catch (error) {
    error.message = `Virlo tracked creator detail fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_tracking_get_creator', id: req.params.id };
    next(error);
  }
});

router.patch('/data/tracking/creators/:id', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await updateTrackedCreator(apiKey, req.params.id, req.body || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo tracked creator update failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_tracking_update_creator', id: req.params.id };
    next(error);
  }
});

router.delete('/data/tracking/creators/:id', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await stopTrackingCreator(apiKey, req.params.id);
    res.json(data || { deleted: true });
  } catch (error) {
    error.message = `Virlo tracked creator delete failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_tracking_delete_creator', id: req.params.id };
    next(error);
  }
});

router.get('/data/tracking/creators/:id/report', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getCreatorReport(apiKey, req.params.id);
    res.json(data);
  } catch (error) {
    error.message = `Virlo creator report fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_tracking_creator_report', id: req.params.id };
    next(error);
  }
});

router.get('/data/tracking/creators/:id/snapshots', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getCreatorSnapshots(apiKey, req.params.id, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo creator snapshots fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_tracking_creator_snapshots', id: req.params.id };
    next(error);
  }
});

router.get('/data/tracking/videos', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await listTrackingVideos(apiKey, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo tracking videos fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_tracking_videos' };
    next(error);
  }
});

router.post('/data/tracking/videos', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await trackVideo(apiKey, req.body || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo track video failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_tracking_create_video' };
    next(error);
  }
});

router.get('/data/tracking/videos/:id', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getTrackedVideo(apiKey, req.params.id);
    res.json(data);
  } catch (error) {
    error.message = `Virlo tracked video detail fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_tracking_get_video', id: req.params.id };
    next(error);
  }
});

router.patch('/data/tracking/videos/:id', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await updateTrackedVideo(apiKey, req.params.id, req.body || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo tracked video update failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_tracking_update_video', id: req.params.id };
    next(error);
  }
});

router.delete('/data/tracking/videos/:id', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await stopTrackingVideo(apiKey, req.params.id);
    res.json(data || { deleted: true });
  } catch (error) {
    error.message = `Virlo tracked video delete failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_tracking_delete_video', id: req.params.id };
    next(error);
  }
});

router.get('/data/tracking/videos/:id/report', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getVideoReport(apiKey, req.params.id);
    res.json(data);
  } catch (error) {
    error.message = `Virlo video report fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_tracking_video_report', id: req.params.id };
    next(error);
  }
});

router.get('/data/tracking/videos/:id/snapshots', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getVideoSnapshots(apiKey, req.params.id, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo video snapshots fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'data_tracking_video_snapshots', id: req.params.id };
    next(error);
  }
});

router.get('/candidates', (_req, res) => {
  const items = listCandidates();
  res.json({ items, total: items.length });
});

router.post('/candidates', (req, res) => {
  const result = addCandidate(req.body || {});
  res.json({
    saved: result.saved,
    duplicate: result.duplicate,
    item: result.item,
    total: result.list?.length || undefined
  });
});

router.delete('/candidates/:id', (req, res) => {
  const result = deleteCandidate(req.params.id);
  if (!result.deleted) {
    return res.status(404).json({
      error: true,
      message: 'Candidate not found',
      code: 'CANDIDATE_NOT_FOUND',
      details: { id: req.params.id }
    });
  }
  return res.json({ deleted: true, total: result.list.length });
});

router.get('/creator-watchlist', (_req, res) => {
  const items = listCreatorWatchlist();
  res.json({ items, total: items.length });
});

router.post('/creator-watchlist', (req, res) => {
  const result = addCreatorWatch(req.body || {});
  res.json({
    saved: result.saved,
    duplicate: result.duplicate,
    item: result.item
  });
});

router.post('/search', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const result = await createOrbit(apiKey, req.body || {});
    res.json({
      orbitId: result.orbitId,
      status: result.reused ? (result.raw?.cachedOrbit?.status || 'queued') : 'queued',
      reused: Boolean(result.reused),
      fingerprint: result.fingerprint || null,
      raw: result.raw,
      request: {
        virloPayload: result.virloPayload,
        localMeta: result.localMeta
      }
    });
  } catch (error) {
    if (error.status === 429) {
      const payload = req.body || {};
      const { fingerprint } = createFingerprint(payload);
      const existing = getCachedOrbitForPayload(payload);
      error.details = {
        ...(error.details || {}),
        fingerprint,
        existingCachedOrbit: Boolean(existing),
        existingOrbitId: existing?.orbitId || null
      };
    }
    error.message = `Virlo search create failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'create_orbit' };
    next(error);
  }
});

router.get('/search/:orbitId', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getOrbit(apiKey, req.params.orbitId);
    res.json(data);
  } catch (error) {
    error.message = `Virlo search status polling failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'poll_orbit_status', orbitId: req.params.orbitId };
    next(error);
  }
});

router.get('/search/:orbitId/videos', async (req, res, next) => {
  try {
    const apiKey = requireApiKey('VIRLO_API_KEY');
    const data = await getOrbitVideos(apiKey, req.params.orbitId, req.query || {});
    res.json(data);
  } catch (error) {
    error.message = `Virlo videos fetch failed: ${error.message}`;
    error.details = { ...(error.details || {}), stage: 'fetch_orbit_videos', orbitId: req.params.orbitId };
    next(error);
  }
});

module.exports = router;

const path = require('path');
const express = require('express');
const {
  startRun,
  resumeRun,
  overridePreflightRun,
  getRun,
  readReviewArtifacts,
  saveReviewSlotFills,
  listRuns,
  artifactPathFor,
  zipRunDirectory
} = require('../services/midformPipelineService');

const router = express.Router();

router.post('/run', (req, res, next) => {
  try {
    const state = startRun(req.body || {});
    return res.status(202).json(state);
  } catch (error) {
    return next(error);
  }
});

router.get('/runs', (_req, res, next) => {
  try {
    return res.json({ runs: listRuns() });
  } catch (error) {
    return next(error);
  }
});

router.get('/run/:runId', (req, res, next) => {
  try {
    return res.json(getRun(req.params.runId));
  } catch (error) {
    return next(error);
  }
});

router.post('/run/:runId/resume', async (req, res, next) => {
  try {
    return res.json(await resumeRun(req.params.runId));
  } catch (error) {
    return next(error);
  }
});

router.post('/run/:runId/override-preflight', async (req, res, next) => {
  try {
    return res.json(await overridePreflightRun(req.params.runId));
  } catch (error) {
    return next(error);
  }
});

router.get('/run/:runId/review', (req, res, next) => {
  try {
    return res.json(readReviewArtifacts(req.params.runId));
  } catch (error) {
    return next(error);
  }
});

router.put('/run/:runId/review/slot-fills', (req, res, next) => {
  try {
    return res.json(saveReviewSlotFills(req.params.runId, req.body || {}));
  } catch (error) {
    return next(error);
  }
});

router.get('/run/:runId/srt', (req, res, next) => {
  try {
    return res.download(artifactPathFor(req.params.runId, 'srt'), `${req.params.runId}.srt`);
  } catch (error) {
    return next(error);
  }
});

router.get('/run/:runId/draft.zip', (req, res, next) => {
  try {
    const zipPath = artifactPathFor(req.params.runId, 'draft_zip');
    return res.download(zipPath, path.basename(zipPath));
  } catch (error) {
    return next(error);
  }
});

router.get('/run/:runId/artifacts.zip', async (req, res, next) => {
  try {
    const zipPath = await zipRunDirectory(req.params.runId);
    return res.download(zipPath, path.basename(zipPath));
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

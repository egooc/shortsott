const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { requireApiKey } = require('../middleware/auth');
const {
  QUEUE_ROOT,
  listQueue,
  addQueueItem,
  uploadQueueItems,
  uploadQueueBgm,
  uploadQueueChannelAsset,
  uploadQueueChannelFrameAsset,
  importYoutubeSourceQueueItems,
  importYoutubeQueueItems,
  replaceQueueItemSource,
  downloadQueueItemSourceFromUrl,
  getQueueItemSourceInfo,
  detectQueueItemTextRegions,
  getOcrMaskReview,
  saveOcrMaskReview,
  applyOttogiGuideToItem,
  validateOutputRoot,
  removeQueueItem,
  removeQueueItems,
  duplicateQueueItem,
  saveQueue,
  syncCaptionTemplateSettings,
  generateQueue,
  getReport
} = require('../services/processQueueService');
const { createCapcutExportRequest } = require('../services/capcutExportService');
const { analyzeOttogiProcessMetadata, isVertexAdcMode, isYouTubeUrl } = require('../services/processMetadataService');
const { getUploadExt } = require('../utils/uploadFilename');
const {
  startProcessJob,
  readJob,
  listJobs,
  getJobRuntimeInfo,
  cancelJob,
  retryFailedJob
} = require('../services/processJobService');
const {
  getJobLogs,
  getJobItemStatuses
} = require('../services/processJobDbService');

const router = express.Router();

const uploadTempDir = path.join(QUEUE_ROOT, '.uploads');
fs.mkdirSync(uploadTempDir, { recursive: true });

const upload = multer({
  dest: uploadTempDir,
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = getUploadExt(file);
    const isVideo = file.mimetype?.startsWith('video/') || ['.mp4', '.mov', '.m4v', '.avi'].includes(ext);
    if (isVideo) cb(null, true);
    else cb(new Error('Only video files are allowed'));
  }
});

const audioUpload = multer({
  dest: uploadTempDir,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = getUploadExt(file);
    const isAudio = file.mimetype?.startsWith('audio/') || ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'].includes(ext);
    if (isAudio) cb(null, true);
    else cb(new Error('Only audio files are allowed'));
  }
});

const channelAssetUpload = multer({
  dest: uploadTempDir,
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = getUploadExt(file);
    const isSupported = file.mimetype?.startsWith('image/')
      || file.mimetype?.startsWith('video/')
      || ['.gif', '.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov', '.m4v'].includes(ext);
    if (isSupported) cb(null, true);
    else cb(new Error('Only image, gif, or video files are allowed'));
  }
});

function compactJob(job = {}) {
  const runtime = getJobRuntimeInfo(job);
  return {
    job_id: job.job_id,
    status: job.status,
    stage: job.stage,
    created_at: job.created_at,
    updated_at: job.updated_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    item_ids: job.item_ids || [],
    stages: job.stages || [],
    batch_name: job.batch_name || '',
    lane: job.lane || 'metadata',
    draft_variant_mode: job.draft_variant_mode || 'all',
    metadata_variant_mode: job.metadata_variant_mode || 'all',
    continue_to_draft_after_metadata: job.continue_to_draft_after_metadata === true,
    deferred: job.deferred === true,
    queued_position: Number(job.queued_position || 0),
    queue_reason: job.queue_reason || '',
    batch_group: job.batch_group || null,
    cancel_requested: !!job.cancel_requested,
    worker_pid: job.worker_pid || null,
    worker_log_path: job.worker_log_path || '',
    worker_started_at: job.worker_started_at || '',
    worker_spawn_reason: job.worker_spawn_reason || '',
    logs: Array.isArray(job.logs) ? job.logs.slice(-120) : [],
    item_statuses: job.item_statuses || {},
    totals: job.totals || null,
    job_summary: job.job_summary || null,
    result: job.result || null,
    error: job.error || '',
    ...runtime
  };
}

function getItemsForRequest(itemIds = []) {
  const queue = listQueue();
  const itemMap = new Map(queue.queueItems.map((item) => [item.item_id, item]));
  if (Array.isArray(itemIds) && itemIds.length) {
    return itemIds.map((id) => itemMap.get(String(id))).filter(Boolean);
  }
  return queue.queueItems;
}

function getGeminiApiKeyForCurrentMode() {
  if (isVertexAdcMode()) return '';
  return requireApiKey('GEMINI_API_KEY');
}

function getAnalysisSourceInfo(itemId, itemConfig = {}) {
  try {
    return getQueueItemSourceInfo(itemId);
  } catch (error) {
    const sourceUrl = String(itemConfig.source_url || '').trim();
    if (isYouTubeUrl(sourceUrl)) {
      return {
        item_id: itemId,
        sourcePath: '',
        filename: sourceUrl
      };
    }
    throw error;
  }
}

async function analyzeMissingMetadataForItems(items = [], apiKey, options = {}) {
  const force = options.force === true;
  const metadataVariantMode = options.metadata_variant_mode || options.draft_variant_mode || 'all';
  const results = [];
  for (const item of items) {
    const itemConfig = item.item_config || {};
    const sceneTransitionsChecked = Array.isArray(itemConfig.gemini_scene_transitions)
      || Array.isArray(itemConfig.ottogi_guide_output?.scene_transitions);
    if (!force && itemConfig.ottogi_guide_output && sceneTransitionsChecked) {
      results.push({
        item_id: item.item_id,
        status: 'skipped',
        reason: 'metadata_and_scene_transition_check_already_exists'
      });
      continue;
    }

    try {
      const sourceUrl = String(itemConfig.source_url || '').trim();
      const sourceInfo = getAnalysisSourceInfo(item.item_id, itemConfig);
      const durationSec = Number(
        itemConfig.video_metadata?.duration_sec
        || item.video_metadata?.duration_sec
        || itemConfig.target_duration_sec
        || 0
      );
      const guide = await analyzeOttogiProcessMetadata({
        filePath: sourceInfo.sourcePath,
        sourceUrl,
        apiKey,
        durationSec,
        originalFilename: sourceInfo.filename,
        sourceType: itemConfig.source_type || 'unknown',
        sourceWorkflowMode: itemConfig.source_workflow_mode || 'unknown',
        metadataVariantMode
      });
      const applied = applyOttogiGuideToItem(item.item_id, guide, sourceUrl);
      results.push({
        item_id: item.item_id,
        status: 'analyzed',
        savedPath: applied.savedPath,
        packagePath: applied.item_config?.ottogi_metadata_files?.package || '',
        title: applied.item_config?.upload_title || '',
        caption: applied.item_config?.explainer_blocks?.[0]?.text || ''
      });
    } catch (error) {
      results.push({
        item_id: item.item_id,
        status: 'failed',
        stage: 'gemini_metadata',
        code: error.code || error.errorCode || '',
        statusCode: error.status || error.statusCode || null,
        message: error.message,
        details: error.details || error.data || null
      });
    }
  }
  return results;
}

router.get('/', (_req, res, next) => {
  try {
    res.json(listQueue());
  } catch (error) {
    next(error);
  }
});

router.post('/item', (req, res, next) => {
  try {
    res.json(addQueueItem(req.body || {}));
  } catch (error) {
    next(error);
  }
});

router.post('/upload-items', upload.array('files', 50), (req, res, next) => {
  try {
    res.json(uploadQueueItems(req.files || []));
  } catch (error) {
    next(error);
  }
});

router.post('/upload-bgm', audioUpload.single('file'), (req, res, next) => {
  try {
    res.json(uploadQueueBgm(req.file, {
      target: req.query?.target || req.body?.target || ''
    }));
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    next(error);
  }
});

router.post('/upload-channel-asset', channelAssetUpload.single('file'), (req, res, next) => {
  try {
    res.json(uploadQueueChannelAsset(req.file, {
      target: req.query?.target || req.body?.target || ''
    }));
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    next(error);
  }
});

router.post('/upload-channel-frame-asset', channelAssetUpload.single('file'), (req, res, next) => {
  try {
    res.json(uploadQueueChannelFrameAsset(req.file, {
      target: req.query?.target || req.body?.target || ''
    }));
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    next(error);
  }
});

router.post('/import-youtube', async (req, res, next) => {
  try {
    res.json(await importYoutubeQueueItems({
      urls: req.body?.urls,
      text: req.body?.text
    }));
  } catch (error) {
    next(error);
  }
});

router.post('/import-source-urls', (req, res, next) => {
  try {
    res.json(importYoutubeSourceQueueItems({
      videos: req.body?.videos,
      urls: req.body?.urls,
      text: req.body?.text
    }));
  } catch (error) {
    next(error);
  }
});

router.post('/item/:itemId/source', upload.single('file'), (req, res, next) => {
  try {
    res.json(replaceQueueItemSource(req.params.itemId, req.file));
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    next(error);
  }
});

router.post('/item/:itemId/youtube-source', async (req, res, next) => {
  try {
    const url = String(req.body?.url || req.body?.sourceUrl || req.body?.source_url || '').trim();
    res.json(await downloadQueueItemSourceFromUrl(req.params.itemId, url));
  } catch (error) {
    next(error);
  }
});

router.get('/item/:itemId/source-video', (req, res, next) => {
  try {
    const source = getQueueItemSourceInfo(req.params.itemId);
    res.sendFile(source.sourcePath, {
      headers: {
        'Content-Disposition': `inline; filename="${encodeURIComponent(source.filename)}"`
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post('/item/:itemId/ocr-text', async (req, res, next) => {
  try {
    const detection = await detectQueueItemTextRegions(req.params.itemId, req.body || {});
    res.json({
      status: 'success',
      detection,
      queue: listQueue()
    });
  } catch (error) {
    next(error);
  }
});

router.get('/item/:itemId/ocr-preview', (req, res, next) => {
  try {
    const review = getOcrMaskReview(req.params.itemId);
    if (!review.preview_path || !fs.existsSync(review.preview_path)) {
      const error = new Error('OCR preview not found');
      error.status = 404;
      throw error;
    }
    res.sendFile(review.preview_path, {
      headers: {
        'Content-Disposition': `inline; filename="${encodeURIComponent(`${req.params.itemId}_ocr_preview.jpg`)}"`
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get('/item/:itemId/ocr-review', (req, res, next) => {
  try {
    res.json(getOcrMaskReview(req.params.itemId));
  } catch (error) {
    next(error);
  }
});

router.post('/item/:itemId/ocr-review', (req, res, next) => {
  try {
    res.json(saveOcrMaskReview(req.params.itemId, req.body || {}));
  } catch (error) {
    next(error);
  }
});

router.post('/item/:itemId/gemini-metadata', async (req, res, next) => {
  try {
    const apiKey = getGeminiApiKeyForCurrentMode();
    const queueItem = listQueue().queueItems.find((item) => item.item_id === req.params.itemId);
    const sourceUrl = String(req.body?.sourceUrl || req.body?.source_url || queueItem?.item_config?.source_url || '').trim();
    const sourceInfo = getAnalysisSourceInfo(req.params.itemId, {
      ...(queueItem?.item_config || {}),
      source_url: sourceUrl
    });
    const durationSec = Number(req.body?.durationSec || req.body?.duration_sec || 0);
    const itemConfig = queueItem?.item_config || {};
    const guide = await analyzeOttogiProcessMetadata({
      filePath: sourceInfo.sourcePath,
      sourceUrl,
      apiKey,
      durationSec,
      originalFilename: sourceInfo.filename,
      sourceType: itemConfig.source_type || 'unknown',
      sourceWorkflowMode: itemConfig.source_workflow_mode || 'unknown'
    });
    const applied = applyOttogiGuideToItem(req.params.itemId, guide, sourceUrl);
    res.json({
      status: 'success',
      guide,
      applied,
      queue: listQueue()
    });
  } catch (error) {
    next(error);
  }
});

router.post('/validate-output-root', (req, res, next) => {
  try {
    res.json(validateOutputRoot(req.body?.output_root || ''));
  } catch (error) {
    next(error);
  }
});

router.post('/item/:itemId/duplicate', (req, res, next) => {
  try {
    res.json(duplicateQueueItem(req.params.itemId));
  } catch (error) {
    next(error);
  }
});

router.delete('/item/:itemId', (req, res, next) => {
  try {
    res.json(removeQueueItem(req.params.itemId));
  } catch (error) {
    next(error);
  }
});

router.post('/items/delete', (req, res, next) => {
  try {
    res.json(removeQueueItems(req.body?.item_ids || req.body?.itemIds || []));
  } catch (error) {
    next(error);
  }
});

router.post('/save', (req, res, next) => {
  try {
    res.json(saveQueue(req.body || {}));
  } catch (error) {
    next(error);
  }
});

router.post('/caption-template-sync', (_req, res, next) => {
  try {
    res.json(syncCaptionTemplateSettings());
  } catch (error) {
    next(error);
  }
});

router.post('/download-missing-sources', async (req, res, next) => {
  try {
    const results = [];
    const items = getItemsForRequest(req.body?.item_ids);
    for (const item of items) {
      const itemConfig = item.item_config || {};
      try {
        const source = getQueueItemSourceInfo(item.item_id);
        if (source.sourcePath && fs.existsSync(source.sourcePath)) {
          results.push({
            item_id: item.item_id,
            status: 'skipped',
            reason: 'source_already_exists',
            sourcePath: source.sourcePath
          });
          continue;
        }
      } catch {
        // Missing local source is expected for URL-imported items.
      }

      const sourceUrl = String(itemConfig.source_url || '').trim();
      if (!sourceUrl) {
        results.push({
          item_id: item.item_id,
          status: 'failed',
          stage: 'source_download',
          message: 'source_url is empty'
        });
        continue;
      }

      try {
        const downloaded = await downloadQueueItemSourceFromUrl(item.item_id, sourceUrl);
        results.push({
          item_id: item.item_id,
          status: 'downloaded',
          sourcePath: downloaded.download?.outputPath || '',
          filename: downloaded.download?.filename || ''
        });
      } catch (error) {
        results.push({
          item_id: item.item_id,
          status: 'failed',
          stage: 'source_download',
          code: error.code || error.errorCode || '',
          statusCode: error.status || error.statusCode || null,
          message: error.message,
          details: error.details || error.data || null
        });
      }
    }

    const failedCount = results.filter((item) => item.status === 'failed').length;
    res.json({
      status: failedCount ? 'completed_with_warnings' : 'success',
      total: results.length,
      failedCount,
      results,
      queue: listQueue()
    });
  } catch (error) {
    next(error);
  }
});

router.post('/analyze-metadata', async (req, res, next) => {
  try {
    const apiKey = getGeminiApiKeyForCurrentMode();
    const metadataAnalysis = await analyzeMissingMetadataForItems(getItemsForRequest(req.body?.item_ids), apiKey, {
      force: req.body?.force === true,
      metadata_variant_mode: req.body?.metadata_variant_mode || req.body?.draft_variant_mode
    });
    const failedCount = metadataAnalysis.filter((item) => item.status === 'failed').length;
    res.json({
      status: failedCount ? 'completed_with_warnings' : 'success',
      total: metadataAnalysis.length,
      failedCount,
      metadataAnalysis,
      queue: listQueue()
    });
  } catch (error) {
    next(error);
  }
});

router.post('/generate', async (req, res, next) => {
  try {
    const body = req.body || {};
    let metadataAnalysis = [];
    if (body.auto_gemini_metadata !== false) {
      const apiKey = getGeminiApiKeyForCurrentMode();
      metadataAnalysis = await analyzeMissingMetadataForItems(getItemsForRequest(body.item_ids), apiKey, {
        force: body.force_metadata === true,
        metadata_variant_mode: body.metadata_variant_mode || body.draft_variant_mode
      });
    }
    const result = await generateQueue(body);
    res.json({
      ...result,
      metadataAnalysis
    });
  } catch (error) {
    next(error);
  }
});

router.get('/jobs', (_req, res, next) => {
  try {
    const data = listJobs();
    res.json({
      ...data,
      jobs: data.jobs.map(compactJob)
    });
  } catch (error) {
    next(error);
  }
});

router.post('/jobs/start', async (req, res, next) => {
  try {
    if (req.body?.queue) {
      await saveQueue(req.body.queue);
    }
    const result = startProcessJob({
      item_ids: req.body?.item_ids,
      stages: req.body?.stages,
      batch_name: req.body?.batch_name,
      force_metadata: req.body?.force_metadata === true,
      draft_variant_mode: req.body?.draft_variant_mode,
      metadata_variant_mode: req.body?.metadata_variant_mode,
      continue_to_draft_after_metadata: req.body?.continue_to_draft_after_metadata === true,
      enqueue_if_active: req.body?.enqueue_if_active === true,
      enqueue_batches: req.body?.enqueue_batches === true,
      chunk_size: req.body?.chunk_size
    });
    res.json({
      status: result.reused ? 'already_running' : result.queued ? 'queued' : 'started',
      reused: result.reused,
      queued: result.queued === true,
      job: compactJob(result.job),
      activeJob: result.activeJob ? compactJob(result.activeJob) : null,
      queuedJobs: Array.isArray(result.queuedJobs) ? result.queuedJobs.map(compactJob) : []
    });
  } catch (error) {
    next(error);
  }
});

router.get('/jobs/:jobId', (req, res, next) => {
  try {
    const includeQueue = req.query.include_queue === 'true';
    res.json({
      job: compactJob(readJob(req.params.jobId)),
      ...(includeQueue ? { queue: listQueue() } : {})
    });
  } catch (error) {
    next(error);
  }
});

router.get('/jobs/:jobId/progress', (req, res, next) => {
  try {
    const job = readJob(req.params.jobId);
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
    const logs = getJobLogs(req.params.jobId, limit);
    const itemStatuses = getJobItemStatuses(req.params.jobId);
    const runtime = getJobRuntimeInfo({ ...job, logs });
    res.json({
      job: {
        job_id: job.job_id,
        status: job.status,
        stage: job.stage,
        updated_at: job.updated_at,
        started_at: job.started_at,
        finished_at: job.finished_at,
        item_ids: job.item_ids || [],
        stages: job.stages || [],
        batch_name: job.batch_name || '',
        lane: job.lane || 'metadata',
        draft_variant_mode: job.draft_variant_mode || 'all',
        metadata_variant_mode: job.metadata_variant_mode || 'all',
        continue_to_draft_after_metadata: job.continue_to_draft_after_metadata === true,
        deferred: job.deferred === true,
        queued_position: Number(job.queued_position || 0),
        queue_reason: job.queue_reason || '',
        cancel_requested: !!job.cancel_requested,
        worker_pid: job.worker_pid || null,
        worker_log_path: job.worker_log_path || '',
        worker_started_at: job.worker_started_at || '',
        worker_spawn_reason: job.worker_spawn_reason || '',
        logs,
        item_statuses: Object.keys(itemStatuses).length ? itemStatuses : (job.item_statuses || {}),
        totals: job.totals || null,
        job_summary: job.job_summary || null,
        error: job.error || '',
        ...runtime
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post('/jobs/:jobId/cancel', (req, res, next) => {
  try {
    res.json({
      status: 'cancel_requested',
      job: compactJob(cancelJob(req.params.jobId))
    });
  } catch (error) {
    next(error);
  }
});

router.post('/jobs/:jobId/retry-failed', (req, res, next) => {
  try {
    const result = retryFailedJob(req.params.jobId, {
      stages: req.body?.stages,
      force_metadata: req.body?.force_metadata === true,
      draft_variant_mode: req.body?.draft_variant_mode,
      metadata_variant_mode: req.body?.metadata_variant_mode,
      continue_to_draft_after_metadata: req.body?.continue_to_draft_after_metadata === true,
      enqueue_if_active: true,
      enqueue_batches: true,
      chunk_size: req.body?.chunk_size
    });
    res.json({
      status: result.reused ? 'already_running' : result.queued ? 'queued' : 'started',
      reused: result.reused,
      queued: result.queued === true,
      job: compactJob(result.job),
      activeJob: result.activeJob ? compactJob(result.activeJob) : null,
      queuedJobs: Array.isArray(result.queuedJobs) ? result.queuedJobs.map(compactJob) : []
    });
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

router.get('/report/:batchId', (req, res, next) => {
  try {
    res.json(getReport(req.params.batchId));
  } catch (error) {
    next(error);
  }
});

module.exports = router;

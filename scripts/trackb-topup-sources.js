const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const highlightPatternService = require('../server/services/highlightPatternService');
const highlightSlicerService = require('../server/services/highlightSlicerService');
const highlightDb = require('../server/services/highlightPatternDbService');
const { readSourceBasket, extractYouTubeId } = require('../server/services/sourceDiscoveryLibrary');
const { listQueue, getQueueItemSourceInfo } = require('../server/services/processQueueService');

const TARGET_READY_DEFAULT = 30;
const MAX_NEW_SOURCES_DEFAULT = 30;
const WAIT_TIMEOUT_MS = 20 * 60 * 1000;
const WAIT_STEP_MS = 5_000;
const TIMELINE_DELAY_MS = 20_000;

function parseArgs(argv = []) {
  const options = { targetReady: TARGET_READY_DEFAULT, maxNewSources: MAX_NEW_SOURCES_DEFAULT, sourceIds: [] };
  argv.forEach((arg) => {
    if (arg.startsWith('--targetReady=')) {
      const value = Number(arg.split('=')[1]);
      options.targetReady = Number.isFinite(value) ? Math.max(0, value) : TARGET_READY_DEFAULT;
    } else if (arg.startsWith('--maxNewSources=')) {
      const value = Number(arg.split('=')[1]);
      options.maxNewSources = Number.isFinite(value) ? Math.max(0, value) : MAX_NEW_SOURCES_DEFAULT;
    }
    else if (arg.startsWith('--sourceIds=')) options.sourceIds = String(arg.split('=')[1] || '').split(',').map((id) => id.trim()).filter(Boolean);
  });
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSliceSourceState() {
  const all = highlightDb.listAll().items;
  const slice = all.filter((item) => item.analysis_mode === 'slice_source');
  const ready = slice.filter((item) => item.video_path && Array.isArray(item.segments) && item.segments.length > 0);
  const noTimeline = slice.filter((item) => item.video_path && (!Array.isArray(item.segments) || item.segments.length === 0));
  const noVideo = slice.filter((item) => !item.video_path);
  return { all, slice, ready, noTimeline, noVideo };
}

function buildPhase1BasketCandidates() {
  const basket = readSourceBasket();
  return (basket.videos || []).map((video) => ({
    id: String(video.id || extractYouTubeId(video.url) || '').trim(),
    youtube_url: String(video.url || '').trim(),
    title: String(video.title || '').trim(),
    views: Number(video.views || 0),
    upload_date: String(video.publishedAt || '').trim(),
    duration_seconds: Number(video.durationSec || video.sourceClassification?.duration_sec || 0),
    sourceClassification: video.sourceClassification || null,
    raw: video
  })).filter((video) => video.id && video.youtube_url);
}

function queueItemsBySourceUrl() {
  const queue = listQueue();
  const map = new Map();
  queue.queueItems.forEach((item) => {
    const url = String(item.item_config?.source_url || '').trim();
    if (!url) return;
    map.set(url, item);
  });
  return map;
}

function buildPhase2QueueDownloadedCandidates() {
  const queue = listQueue();
  return queue.queueItems
    .filter((item) => item.source_exists && item.item_config?.source_url)
    .map((item) => ({
      id: extractYouTubeId(String(item.item_config?.source_url || '').trim()),
      youtube_url: String(item.item_config?.source_url || '').trim(),
      title: String(item.upload_title || item.item_config?.upload_title || '').trim(),
      duration_seconds: Number(item.source_classification?.duration_sec || item.video_metadata?.duration_sec || 0),
      sourceClassification: item.source_classification || item.item_config?.source_classification || null,
      queueItem: item
    }))
    .filter((item) => item.id && item.youtube_url);
}

function classifySourceRecord(record = {}) {
  const durationSeconds = Number(record.duration_seconds || 0);
  return durationSeconds > 0 && durationSeconds < 60 ? 'SHORT' : durationSeconds >= 60 ? 'LONG' : 'UNKNOWN';
}

function upsertSliceSourceFromLocal(record = {}, localVideoPath = '') {
  const now = new Date().toISOString();
  highlightDb.upsertVideo({
    id: record.id,
    youtubeUrl: record.youtube_url,
    channelId: record.channel_id || null,
    title: record.title,
    views: Number(record.views || 0),
    likes: Number(record.likes || 0),
    commentsCount: Number(record.comments_count || 0),
    durationSeconds: Number(record.duration_seconds || 0),
    uploadDate: record.upload_date || '',
    formType: classifySourceRecord(record),
    successMultiple: null,
    viewsPerDay: null,
    isDead: null,
    analysisMode: 'slice_source',
    now
  });
  if (localVideoPath) {
    highlightDb.updateVideoPath(record.id, localVideoPath, now);
    highlightDb.updateVideoSuccess(record.id, now);
  }
  return highlightDb.getById(record.id);
}

async function waitForSliceSourceReady(videoId) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const item = highlightDb.getById(videoId);
    if (item?.video_path && item.pipeline_status === 'success') return item;
    if (item?.pipeline_status === 'failed') {
      const error = new Error(`slice_source preparation failed for ${videoId}: ${item.error_message || item.error_code || 'unknown error'}`);
      error.code = item.error_code || 'SLICE_SOURCE_PREP_FAILED';
      throw error;
    }
    await sleep(WAIT_STEP_MS);
  }
  throw new Error(`slice_source preparation timed out for ${videoId}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const initial = getSliceSourceState();
  const assignments = highlightDb.listAbAssignments();
  const usedSourceIds = new Set(assignments.filter((row) => row.status !== 'dropped').map((row) => row.source_video_id).filter(Boolean));
  const existingSliceIds = new Set(initial.slice.map((item) => item.id));
  const phase1Basket = buildPhase1BasketCandidates();
  const phase2Downloaded = buildPhase2QueueDownloadedCandidates();
  const queueByUrl = queueItemsBySourceUrl();

  let candidateIds = [];
  const imported = [];
  const bridgeStats = {
    phase2QueueDownloadedTotal: phase2Downloaded.length,
    phase2QueueUnregisteredTotal: phase2Downloaded.filter((item) => !existingSliceIds.has(item.id) && !usedSourceIds.has(item.id)).length,
    phase2QueueReusedTotal: 0,
    phase1BasketTotal: phase1Basket.length,
    phase1UnregisteredTotal: phase1Basket.filter((item) => !existingSliceIds.has(item.id) && !usedSourceIds.has(item.id)).length,
    phase1QueueReusableTotal: 0,
    phase1NeedsDownloadTotal: 0,
    trainingFallbackCandidates: 0
  };

  const phase2Candidates = phase2Downloaded.filter((item) => !existingSliceIds.has(item.id) && !usedSourceIds.has(item.id));
  for (const candidate of phase2Candidates) {
    try {
      const source = getQueueItemSourceInfo(candidate.queueItem.item_id);
      const seeded = upsertSliceSourceFromLocal({
        ...candidate,
        title: candidate.title || candidate.queueItem.item_config?.upload_title || candidate.id,
        duration_seconds: candidate.duration_seconds || candidate.queueItem.source_classification?.duration_sec || candidate.queueItem.video_metadata?.duration_sec || 0
      }, source.sourcePath);
      imported.push({ id: seeded.id, title: seeded.title, video_path: seeded.video_path, source: 'phase2_queue_reuse' });
      existingSliceIds.add(seeded.id);
      bridgeStats.phase2QueueReusedTotal += 1;
    } catch {
      // queue says source_exists, but if local reuse fails we simply leave it out of the bridge count
    }
  }

  const phase1Candidates = phase1Basket.filter((item) => !existingSliceIds.has(item.id) && !usedSourceIds.has(item.id));
  for (const candidate of phase1Candidates) {
    const queueItem = queueByUrl.get(candidate.youtube_url);
    if (!queueItem) continue;
    try {
      const source = getQueueItemSourceInfo(queueItem.item_id);
      const seeded = upsertSliceSourceFromLocal({
        ...candidate,
        title: candidate.title || queueItem.upload_title || queueItem.item_config?.upload_title || candidate.id,
        duration_seconds: candidate.duration_seconds || queueItem.source_classification?.duration_sec || queueItem.video_metadata?.duration_sec || 0
      }, source.sourcePath);
      imported.push({ id: seeded.id, title: seeded.title, video_path: seeded.video_path, source: 'phase1_queue_reuse' });
      existingSliceIds.add(seeded.id);
      bridgeStats.phase1QueueReusableTotal += 1;
    } catch {
      bridgeStats.phase1NeedsDownloadTotal += 1;
    }
  }

  if (options.sourceIds.length) {
    candidateIds = options.sourceIds.filter((id) => !existingSliceIds.has(id) && !usedSourceIds.has(id));
  } else if (initial.ready.length < options.targetReady && options.maxNewSources > 0) {
    const phase1DownloadCandidates = phase1Candidates
      .filter((item) => !existingSliceIds.has(item.id))
      .slice(0, options.maxNewSources)
      .map((item) => item.id);
    if (phase1DownloadCandidates.length) {
      candidateIds = phase1DownloadCandidates;
    } else {
      const trainingCandidates = highlightDb.listAnalysisCandidates().filter((item) => !existingSliceIds.has(item.id) && !usedSourceIds.has(item.id));
      bridgeStats.trainingFallbackCandidates = trainingCandidates.length;
      const ranked = highlightSlicerService.rankSourcesForCutSelection(trainingCandidates.map((item) => item.id));
      candidateIds = ranked.slice(0, options.maxNewSources).map((row) => row.videoId);
    }
  }

  for (const videoId of candidateIds) {
    const phase1Candidate = phase1Basket.find((item) => item.id === videoId);
    const item = phase1Candidate || highlightDb.getById(videoId);
    if (!item?.youtube_url) continue;
    await highlightPatternService.submitUrls([item.youtube_url], { analysisMode: 'slice_source' });
    const ready = await waitForSliceSourceReady(videoId);
    imported.push({ id: videoId, title: ready.title, video_path: ready.video_path, source: phase1Candidate ? 'phase1_download' : 'training_fallback_download' });
  }

  const beforeTimeline = getSliceSourceState();
  const extracted = [];
  for (let index = 0; index < beforeTimeline.noTimeline.length; index += 1) {
    const item = beforeTimeline.noTimeline[index];
    const result = await highlightSlicerService.extractTimeline(item.id);
    extracted.push({ id: item.id, eventCount: (result.events || []).length });
    if (index < beforeTimeline.noTimeline.length - 1) await sleep(TIMELINE_DELAY_MS);
  }

  const after = getSliceSourceState();
  console.log(JSON.stringify({
    bridgeStats,
    imported,
    extracted,
    summary: {
      sliceSource: after.slice.length,
      ready: after.ready.length,
      noTimeline: after.noTimeline.length,
      noVideo: after.noVideo.length
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: true, message: error.message, code: error.code || '', details: error.details || null }, null, 2));
  process.exit(1);
});

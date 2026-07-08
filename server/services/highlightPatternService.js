const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PROJECT_ROOT } = require('./pipelinePaths');
const { requireApiKey } = require('../middleware/auth');
const { downloadYoutubeVideo } = require('./youtubeDownloadService');
const { getVideoMetadata } = require('../utils/ffprobe');
const { analyzeMomentPattern } = require('./geminiService');
const { computeSeamScore, deriveLoopSeam } = require('../utils/loopSeam');
const { isVertexAdcMode } = require('./processMetadataService');
const { extractYouTubeId } = require('./sourceDiscoveryLibrary');
const { getYoutubeVideoDetails, getChannelStats, resolveChannelId, listChannelShorts } = require('./youtubeScoutService');
const db = require('./highlightPatternDbService');

const STORAGE_ROOT = path.join(PROJECT_ROOT, 'server', 'data', 'highlight_patterns');
const IS_DEAD_MIN_AGE_DAYS = 14;
const IS_DEAD_VIEWS_PER_DAY_RATIO = 0.02;
const CHANNEL_SCAN_MAX_DURATION_SECONDS = 10;
// First pass at 200 showed most high-frequency channels have their entire
// under-10s catalog clustered within the last 30 days (uploads playlist is
// most-recent-first) -- 85% of videos came back PENDING. Scan deeper by
// default so enough mature history surfaces for real EXPLODED/BURIED labels.
const CHANNEL_SCAN_MAX_RESULTS = 500;

const queue = [];
let processing = false;

function nowIso() {
  return new Date().toISOString();
}

function normalizeUrls(input) {
  const raw = Array.isArray(input) ? input : [input];
  const seen = new Set();
  const urls = [];
  for (const value of raw) {
    String(value || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        if (!seen.has(line)) {
          seen.add(line);
          urls.push(line);
        }
      });
  }
  return urls;
}

// One-shot approximation: real "dead video" detection needs repeated snapshots over
// time (see view_snapshots table). We only have a single point-in-time view count,
// so this just flags videos that are old relative to upload date and far below the
// channel's typical pace.
function computeIsDead({ daysSinceUpload, viewsPerDay, medianViewsRecent30 }) {
  if (!Number.isFinite(medianViewsRecent30) || medianViewsRecent30 <= 0) return null;
  if (!Number.isFinite(daysSinceUpload) || daysSinceUpload < IS_DEAD_MIN_AGE_DAYS) return false;
  if (!Number.isFinite(viewsPerDay)) return null;
  return viewsPerDay < medianViewsRecent30 * IS_DEAD_VIEWS_PER_DAY_RATIO;
}

async function ensureChannel(channelId, youtubeApiKey, now) {
  if (!channelId) return null;
  let channel = db.getChannel(channelId);
  if (!db.isChannelStale(channel, now)) return channel;

  try {
    const stats = await getChannelStats({ channelId, apiKey: youtubeApiKey });
    db.upsertChannel({
      id: channelId,
      title: stats.title,
      subscriberCount: stats.subscriberCount,
      medianViewsRecent30: stats.medianViewsRecent30,
      medianSampleSize: stats.sampleSize,
      now
    });
    return db.getChannel(channelId);
  } catch {
    return channel;
  }
}

function computeVideoMetrics(detail, channel) {
  const views = Number(detail.views) || 0;
  const medianViewsRecent30 = Number.isFinite(channel?.median_views_recent30) ? channel.median_views_recent30 : null;
  const successMultiple = medianViewsRecent30 && medianViewsRecent30 > 0 ? views / medianViewsRecent30 : null;
  const uploadDate = detail.publishedAt || '';
  const uploadMs = uploadDate ? new Date(uploadDate).getTime() : NaN;
  const daysSinceUpload = Number.isFinite(uploadMs) ? Math.max(1, (Date.now() - uploadMs) / 86400000) : null;
  const viewsPerDay = daysSinceUpload ? views / daysSinceUpload : null;
  const isDead = computeIsDead({ daysSinceUpload, viewsPerDay, medianViewsRecent30 });
  return { views, successMultiple, uploadDate, viewsPerDay, isDead };
}

async function submitUrls(input, { analysisMode = 'training' } = {}) {
  const urls = normalizeUrls(input);
  const created = [];
  const skipped = [];

  const idToUrl = new Map();
  for (const url of urls) {
    const videoId = extractYouTubeId(url);
    if (!videoId) {
      skipped.push({ url, reason: 'NOT_A_YOUTUBE_URL' });
      continue;
    }
    idToUrl.set(videoId, url);
  }

  if (!idToUrl.size) {
    return { created, skipped };
  }

  const youtubeApiKey = requireApiKey('YOUTUBE_API_KEY');
  // getYoutubeVideoDetails caps ids at 50 per call (the YouTube Data API's own
  // per-request limit) -- for batches larger than that, a single call silently
  // truncates and every ID past the first 50 reads back as "not found".
  const allIds = [...idToUrl.keys()];
  const idChunks = [];
  for (let i = 0; i < allIds.length; i += 50) idChunks.push(allIds.slice(i, i + 50));
  const detailChunks = await Promise.all(
    idChunks.map((chunk) => getYoutubeVideoDetails({ apiKey: youtubeApiKey, ids: chunk, sourceMode: 'auto' }))
  );
  const details = detailChunks.flat();
  const detailsById = new Map(details.map((detail) => [detail.id, detail]));

  for (const [videoId, url] of idToUrl) {
    const detail = detailsById.get(videoId);
    if (!detail) {
      skipped.push({ url, reason: 'VIDEO_NOT_FOUND_OR_PRIVATE' });
      continue;
    }

    const now = nowIso();
    const channelId = detail.creatorId || '';
    const channel = await ensureChannel(channelId, youtubeApiKey, now);
    const { views, successMultiple, uploadDate, viewsPerDay, isDead } = computeVideoMetrics(detail, channel);

    const videoRow = db.upsertVideo({
      id: videoId,
      youtubeUrl: url,
      channelId: channelId || null,
      title: detail.title,
      views,
      likes: Number(detail.likes) || 0,
      commentsCount: Number(detail.comments) || 0,
      durationSeconds: detail.durationSec,
      uploadDate,
      formType: detail.durationSec < 60 ? 'SHORT' : 'LONG',
      successMultiple,
      viewsPerDay,
      isDead,
      analysisMode,
      now
    });
    db.insertViewSnapshot(videoId, views, now);
    created.push(videoRow);
    // Manual paste always analyzes -- trust the user's own curation of what's
    // worth spending a Gemini call on, regardless of computed label.
    queue.push(videoId);
  }

  if (!processing) {
    runQueue();
  }

  return { created, skipped };
}

// Bulk importer: pull a channel's recent shorts and label each purely from
// view-count math (no download needed for that). This is a labeling-only pass --
// it deliberately does NOT download or call Gemini. EXPLODED/BURIED videos are
// left at pipeline_status='queued' (the genuine contrast set, ready for a later
// explicit batch-analysis run once the moment-prompt calibration checks out).
// MID/PENDING videos get metadata + a label so they're visible, but are marked
// 'skipped' immediately since nothing will ever process them further -- weak
// signal, not worth the API cost. See enqueueQueuedTrainingVideos() for the
// separate step that actually starts downloading + analyzing the queued set.
async function scanChannel({ handleOrUrl, maxDurationSeconds = CHANNEL_SCAN_MAX_DURATION_SECONDS, maxResults = CHANNEL_SCAN_MAX_RESULTS } = {}) {
  const youtubeApiKey = requireApiKey('YOUTUBE_API_KEY');
  const channelId = await resolveChannelId({ handleOrUrl, apiKey: youtubeApiKey });
  const now = nowIso();
  const channel = await ensureChannel(channelId, youtubeApiKey, now);
  const shorts = await listChannelShorts({ channelId, apiKey: youtubeApiKey, maxDurationSeconds, maxResults });

  // NO_MEDIAN is distinct from PENDING: PENDING means the video itself is too
  // young to judge; NO_MEDIAN means the video is mature but its channel has no
  // usable median yet (getChannelStats found no mature comparison videos) --
  // collapsing these into one bucket hid which channels actually have judgeable
  // history vs which are just too new/high-volume to have a median at all.
  const counts = { EXPLODED: 0, BURIED: 0, MID: 0, PENDING: 0, NO_MEDIAN: 0 };
  const labeled = [];

  for (const detail of shorts) {
    const rowNow = nowIso();
    const { views, successMultiple, uploadDate, viewsPerDay, isDead } = computeVideoMetrics(detail, channel);
    const label = db.labelFor(successMultiple, uploadDate) || 'NO_MEDIAN';
    counts[label] = (counts[label] || 0) + 1;

    db.upsertVideo({
      id: detail.id,
      youtubeUrl: detail.url,
      channelId,
      title: detail.title,
      views,
      likes: Number(detail.likes) || 0,
      commentsCount: Number(detail.comments) || 0,
      durationSeconds: detail.durationSec,
      uploadDate,
      formType: 'SHORT',
      successMultiple,
      viewsPerDay,
      isDead,
      analysisMode: 'training',
      now: rowNow
    });
    db.insertViewSnapshot(detail.id, views, rowNow);

    if (label !== 'EXPLODED' && label !== 'BURIED') {
      db.updateVideoStatus(detail.id, 'skipped', rowNow);
    }
    // EXPLODED/BURIED rows are left at upsertVideo's default 'queued' status --
    // not pushed into the in-process download/Gemini queue here.
    labeled.push({ videoId: detail.id, label, successMultiple, views });
  }

  return {
    channel: channel ? { ...channel } : { id: channelId },
    counts,
    labeled
  };
}

async function runQueue() {
  processing = true;
  try {
    while (queue.length > 0) {
      const videoId = queue.shift();
      await processOne(videoId).catch((error) => {
        db.updateVideoFailure(videoId, {
          code: error.code || 'HIGHLIGHT_ANALYSIS_FAILED',
          message: error.message || String(error),
          now: nowIso()
        });
      });
    }
  } finally {
    processing = false;
  }
}

async function processOne(videoId) {
  const video = db.getVideoRow(videoId);
  if (!video) return;

  db.updateVideoStatus(videoId, 'downloading', nowIso());
  const targetDir = path.join(STORAGE_ROOT, videoId);
  fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, 'source.mp4');

  const downloadResult = await downloadYoutubeVideo({ url: video.youtube_url, targetPath });
  // Also the real seam-score window below: video.duration_seconds is the
  // YouTube-API-reported duration (often rounded) and can diverge from the
  // actual downloaded file (re-encoding, container differences) by enough that
  // seeking to duration_seconds - 0.15s overshoots real EOF and silently
  // starves the SSIM filter -- confirmed against a real downloaded file where
  // duration_seconds=5 but the file was actually 4.62s.
  const downloadedMetadata = getVideoMetadata(downloadResult.outputPath);
  db.updateVideoPath(videoId, downloadResult.outputPath, nowIso());

  if (video.analysis_mode === 'slice_source') {
    // Slicing is a deliberate, explicit action (extract-timeline / slice-candidates)
    // triggered from the UI once the user is ready -- not run automatically here.
    db.updateVideoSuccess(videoId, nowIso());
    return;
  }

  db.updateVideoStatus(videoId, 'analyzing', nowIso());
  const apiKey = isVertexAdcMode() ? '' : requireApiKey('GEMINI_API_KEY');

  const callOnce = () => analyzeMomentPattern({ filePath: downloadResult.outputPath, sourceUrl: video.youtube_url, apiKey });

  // Gate v2 (50-video pilot): action_phase alone, exact match; moment_type via
  // a coarse DESTRUCTION/JOINING/TRANSFORM/UNKNOWN bucket (dropped
  // action_is_repetitive -- it flips for the same root-cause error as
  // action_phase, so counting both double-charged one mistake). Pilot rate
  // under this gate was 30.0%, landing in the "arbitrate" bucket: most videos
  // only need 2 calls, but when run1/run2 disagree a 3rd call breaks the tie
  // by majority; if all 3 disagree pairwise, the row is discarded (excluded
  // from patternStats via unstable=1) rather than guessed at.
  const stable = (a, b) => String(a.action_phase) === String(b.action_phase)
    && db.momentTypeCoarse(a.moment_type) === db.momentTypeCoarse(b.moment_type);

  const run1 = await callOnce();
  const run2 = await callOnce();

  let canonical = run1;
  let unstable = false;
  let stabilitySource = 'clean';
  let run3 = null;

  if (!stable(run1.analysis, run2.analysis)) {
    run3 = await callOnce();
    if (stable(run1.analysis, run3.analysis)) {
      canonical = run1;
      stabilitySource = 'majority';
    } else if (stable(run2.analysis, run3.analysis)) {
      canonical = run2;
      stabilitySource = 'majority';
    } else {
      unstable = true;
      stabilitySource = 'discarded';
    }
  }

  const { analysis, modelVersion, promptVersion } = canonical;

  let seamScore = null;
  try {
    const durationSec = Number(downloadedMetadata?.duration_sec);
    if (Number.isFinite(durationSec) && durationSec > 0.2) {
      ({ seamScore } = await computeSeamScore(downloadResult.outputPath, { start: 0, duration: durationSec }));
    }
  } catch {
    // Non-fatal: ffmpeg SSIM is a bonus signal (and now the basis for loop_seam
    // derivation below), not required for the row to succeed.
  }
  const loopSeamSimilarity = seamScore === null ? null : Math.round(seamScore * 100);
  const loopSeamDerived = deriveLoopSeam(seamScore, analysis.action_is_repetitive);

  const now = nowIso();
  db.insertAnalysis({
    id: crypto.randomUUID(),
    videoId,
    modelVersion,
    promptVersion,
    actionDescribed: analysis.action_described,
    material: analysis.material,
    toolOrMachine: analysis.tool_or_machine,
    actionPhase: analysis.action_phase,
    peakMomentTime: analysis.peak_moment_time,
    momentType: analysis.moment_type,
    firstFrameDescription: analysis.first_frame_description,
    lastFrameDescription: analysis.last_frame_description,
    loopSeamSimilarity,
    actionIsRepetitive: analysis.action_is_repetitive,
    loopSeamDerived,
    unstable,
    stabilitySource,
    inputMethod: 'file',
    readableInHalfSecond: analysis.readable_in_half_second,
    camera: analysis.camera,
    subjectScale: analysis.subject_scale,
    motionDirection: analysis.motion_direction,
    humanVisible: analysis.human_visible,
    hasTextOverlay: analysis.has_text_overlay,
    speedAppearance: analysis.speed_appearance,
    raw: { ...analysis, repeat2: run2.analysis, repeat3: run3?.analysis || null },
    now
  });
  db.updateVideoSuccess(videoId, now);
}

function listAll() {
  return db.listAll();
}

function getById(id) {
  return db.getById(id);
}

function remove(id) {
  const record = db.getVideoRow(id);
  if (record?.video_path) {
    fs.rmSync(path.dirname(record.video_path), { recursive: true, force: true });
  }
  db.remove(id);
}

function recoverOnStartup() {
  const changed = db.failStaleActiveRows(nowIso());
  return { failed: changed };
}

module.exports = {
  submitUrls,
  scanChannel,
  listAll,
  getById,
  remove,
  recoverOnStartup
};

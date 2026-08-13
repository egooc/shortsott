// Daily longform source harvest (approved plan 2026-08-10,
// docs/daily-auto-pipeline-plan-2026-08-10.md H1).
//
// Searches YouTube (yt-dlp metadata only, nothing downloaded here) with the
// curated category query pool, filters to longform 240-1800s, dedupes against
// a permanent ledger (every URL ever queued, seeded from the job DB + queue),
// ranks by Most-Replayed heatmap peak + views, imports the top N into the
// queue with harvested:true (which is what the eligibility gate keys on), and
// returns the imported items for the caller to start a batch job with.
//
// Locale plan lives in server/data/harvest_config.json - current approved
// plan: JP 12/day; KR ramps 6 -> 12 later by editing that file, no code
// change needed.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT, readJsonIfExists, writeJsonWithBackup } = require('./pipelinePaths');
const { resolveTool } = require('../utils/toolPaths');
const {
  loadChannelLedger,
  isChannelBlocked,
  assetChannels,
  markChannelExhausted,
  noteChannelUrl
} = require('./sourceChannelLedgerService');

const CONFIG_PATH = path.join(PROJECT_ROOT, 'server', 'data', 'harvest_config.json');
const LEDGER_PATH = path.join(PROJECT_ROOT, 'server', 'data', 'source_harvest_history.json');
const JOBS_DB_PATH = path.join(PROJECT_ROOT, 'server', 'data', 'process_jobs.db');
const QUEUE_ROOT = path.join(PROJECT_ROOT, 'queue', 'process');

const SEARCH_TIMEOUT_MS = 480000;
const MIN_DURATION_SEC = 240;
const MAX_DURATION_SEC = 1800;

const DEFAULT_CONFIG = {
  daily_count: 12,
  per_query_results: 15,
  queries_per_day: 5,
  // Asset-channel mining (approved 2026-08-13). Half the day comes from
  // channels that have already produced, the rest from keyword search so new
  // channels keep entering the pool. min_views is the "did it land" bar for
  // back-catalogue picks; scan_count bounds how deep each sweep reads.
  asset_channel_share: 0.5,
  asset_channel_min_views: 300000,
  asset_channel_scan_count: 30,
  // locale_plan is consumed in order until daily_count is filled. An entry's
  // optional lane ('kr_full') routes those items to the Korean TTS Full
  // draft pipeline instead of highlights (approved 2026-08-11: 4/day Korean
  // audio signal for the KR channel retarget).
  locale_plan: [
    { locale: 'ja-JP', count: 12 },
    { locale: 'ko-KR', count: 4, lane: 'kr_full' }
  ],
  queries: [
    '金属加工 工場 製造工程',
    '食品工場 大量生産 製造過程',
    '職人 伝統工芸 製作過程',
    '工場 機械 組立工程',
    'ガラス 製造 工場 工程',
    '収穫 加工 農業機械',
    '금속가공 공장 제조과정',
    '식품공장 대량생산 제조과정',
    '장인 공예 제작과정',
    '수확 가공 농기계',
    'mass production process factory',
    'how its made manufacturing process',
    '台灣工廠 製造 過程'
  ]
};

function loadHarvestConfig() {
  const existing = readJsonIfExists(CONFIG_PATH);
  if (existing) return { ...DEFAULT_CONFIG, ...existing };
  writeJsonWithBackup(CONFIG_PATH, DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG };
}

function extractYoutubeVideoId(url = '') {
  const match = String(url).match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{6,})/);
  return match ? match[1] : '';
}

function loadLedger() {
  const ledger = readJsonIfExists(LEDGER_PATH);
  if (ledger && ledger.video_ids) return ledger;
  // First run: seed with every source URL the pipeline has ever touched so the
  // harvest never re-imports something a past batch already processed.
  const videoIds = {};
  const seedUrl = (url, origin) => {
    const videoId = extractYoutubeVideoId(url);
    if (videoId && !videoIds[videoId]) videoIds[videoId] = { url, origin, seen_at: new Date().toISOString() };
  };
  try {
    const db = require('better-sqlite3')(JOBS_DB_PATH, { readonly: true });
    for (const row of db.prepare('select status_json from process_job_items').all()) {
      try { seedUrl(JSON.parse(row.status_json).source_url || '', 'job_history'); } catch { /* skip */ }
    }
    db.close();
  } catch { /* db missing is fine */ }
  try {
    for (const name of fs.readdirSync(QUEUE_ROOT)) {
      const config = readJsonIfExists(path.join(QUEUE_ROOT, name, 'item_config.json'));
      if (config?.source_url) seedUrl(config.source_url, 'queue');
    }
  } catch { /* queue missing is fine */ }
  const seeded = { created_at: new Date().toISOString(), video_ids: videoIds };
  writeJsonWithBackup(LEDGER_PATH, seeded);
  return seeded;
}

function saveLedger(ledger) {
  writeJsonWithBackup(LEDGER_PATH, ledger);
}

function todaysQueries(config, now = new Date()) {
  const dayIndex = Math.floor(now.getTime() / 86400000);
  const pool = config.queries;
  const perDay = Math.max(1, Math.min(config.queries_per_day, pool.length));
  const start = (dayIndex * perDay) % pool.length;
  return Array.from({ length: perDay }, (_, i) => pool[(start + i) % pool.length]);
}

function searchOnce(query, count) {
  return new Promise((resolve) => {
    execFile(
      resolveTool('yt-dlp', { envKey: 'YT_DLP_PATH' }),
      [`ytsearch${count}:${query}`, '--skip-download', '--dump-json', '--no-warnings',
       '--ignore-errors', '--socket-timeout', '15',
       '--match-filter', `duration>=${MIN_DURATION_SEC} & duration<=${MAX_DURATION_SEC}`],
      { timeout: SEARCH_TIMEOUT_MS, maxBuffer: 128 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (error, stdout) => {
        const videos = [];
        for (const line of String(stdout || '').split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) continue;
          try { videos.push(JSON.parse(trimmed)); } catch { /* skip bad line */ }
        }
        resolve(videos);
      }
    );
  });
}

// --- asset-channel back-catalogue sweep (approved 2026-08-13) -------------
// A channel that has already produced a usable source is worth mining before
// spending the day's keyword budget on strangers. We pull its older videos
// that cleared a performance bar; when a channel has nothing left to give it
// is marked exhausted and the keyword search takes over - which is exactly
// how the next asset channel gets found.

function fetchChannelVideos(channelUrl, count, minViews) {
  return new Promise((resolve) => {
    execFile(
      resolveTool('yt-dlp', { envKey: 'YT_DLP_PATH' }),
      [`${channelUrl.replace(/\/+$/, '')}/videos`, '--skip-download', '--dump-json',
       '--no-warnings', '--ignore-errors', '--socket-timeout', '15',
       '--playlist-end', String(count),
       '--match-filter',
       `duration>=${MIN_DURATION_SEC} & duration<=${MAX_DURATION_SEC} & view_count>=${minViews}`],
      { timeout: SEARCH_TIMEOUT_MS * 2, maxBuffer: 128 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (error, stdout) => {
        const videos = [];
        for (const line of String(stdout || '').split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) continue;
          try { videos.push(JSON.parse(trimmed)); } catch { /* skip bad line */ }
        }
        resolve(videos);
      }
    );
  });
}

// Older ledger entries predate channel_url capture, so recover it from a
// video the channel already produced rather than guessing from its name.
function resolveChannelUrlFromVideo(videoId) {
  const bare = String(videoId || '').replace(/^youtube:/, '');
  if (!bare) return Promise.resolve('');
  return new Promise((resolve) => {
    execFile(
      resolveTool('yt-dlp', { envKey: 'YT_DLP_PATH' }),
      [`https://www.youtube.com/watch?v=${bare}`, '--skip-download', '--dump-json',
       '--no-warnings', '--ignore-errors', '--socket-timeout', '15'],
      { timeout: SEARCH_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (error, stdout) => {
        for (const line of String(stdout || '').split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) continue;
          try {
            const meta = JSON.parse(trimmed);
            resolve(meta.channel_url || meta.uploader_url || '');
            return;
          } catch { /* skip bad line */ }
        }
        resolve('');
      }
    );
  });
}

function heatmapPeak(video) {
  const heatmap = Array.isArray(video.heatmap) ? video.heatmap : [];
  return heatmap.reduce((peak, seg) => Math.max(peak, Number(seg?.value) || 0), 0);
}

const MIN_SOURCE_HEIGHT = 720;

function rankCandidates(videos) {
  const byId = new Map();
  for (const video of videos) {
    const videoId = video.id || extractYoutubeVideoId(video.webpage_url || video.original_url || '');
    if (!videoId || byId.has(videoId)) continue;
    // Refuse sub-720p sources before spending download/analysis on them
    // (midform adoption B, 2026-08-11). Unknown height passes (fail-open).
    const height = Number(video.height) || 0;
    if (height > 0 && height < MIN_SOURCE_HEIGHT) continue;
    const peak = heatmapPeak(video);
    byId.set(videoId, {
      video_id: videoId,
      url: video.webpage_url || `https://www.youtube.com/watch?v=${videoId}`,
      title: video.title || '',
      duration_sec: Number(video.duration) || 0,
      views: Number(video.view_count) || 0,
      published_at: video.upload_date || '',
      creator: video.uploader || video.channel || '',
      // Kept for the channel ledger (2026-08-13). The ledger keys on the
      // creator name because that is what survives into item_config, but the
      // id/url are what a back-catalogue sweep needs.
      channel_id: video.channel_id || video.uploader_id || '',
      channel_url: video.channel_url || video.uploader_url || '',
      heatmap_peak: Number(peak.toFixed(3)),
      // Heatmap presence means the audience already marked highlight moments;
      // it outranks raw popularity on purpose.
      score: Number((peak * 10 + Math.log10((Number(video.view_count) || 0) + 1)).toFixed(3))
    });
  }
  return [...byId.values()].sort((a, b) => b.score - a.score);
}

// Round-robin, not block assignment (approved 2026-08-13).
//
// Filling locale_plan in order handed the whole top of the ranking to
// whichever entry was listed first. Since score is heatmap_peak*10 +
// log10(views), the top ranks are the biggest-view videos, and the
// biggest-view process videos on YouTube are narrated TV documentaries -
// exactly what the eligibility gate rejects. Measured over the first 10
// harvested items: ja-JP (listed first) passed 1 of 6, ko-KR passed 3 of 4,
// and in both mixed batches ja-JP took ranks 1-2 and lost both while ko-KR
// took ranks 3-4 and kept three.
//
// Dealing one at a time to each lane gives every lane the same quality
// distribution, so a lane's pass rate reflects the lane, not its position.
function assignLocales(candidates, config) {
  const remaining = config.locale_plan.map((plan) => ({ plan, left: Number(plan.count) || 0 }));
  const slots = [];
  let dealt = true;
  while (dealt) {
    dealt = false;
    for (const entry of remaining) {
      if (entry.left <= 0) continue;
      slots.push(entry.plan);
      entry.left -= 1;
      dealt = true;
    }
  }
  return slots.slice(0, candidates.length).map((plan, index) => ({
    ...candidates[index],
    target_locale: plan.locale,
    production_lane: plan.lane || ''
  }));
}

// Importer is injected so this service never requires processQueueService
// (keeps the dependency direction one-way). dryRun skips the import AND the
// ledger write so a rehearsal never consumes candidates.
async function harvestDailySources({ importItems, now = new Date(), dryRun = false } = {}) {
  const config = loadHarvestConfig();
  const ledger = loadLedger();
  const queries = todaysQueries(config, now);

  // 1. Mine asset channels first - proven producers beat strangers.
  const assetTarget = Math.max(0, Math.round(config.daily_count * config.asset_channel_share));
  const assetVideos = [];
  const assetReport = [];
  for (const entry of assetChannels()) {
    if (assetVideos.length >= assetTarget) break;
    let channelUrl = entry.channel_url;
    if (!channelUrl) {
      channelUrl = await resolveChannelUrlFromVideo(entry.ok_video_ids?.[entry.ok_video_ids.length - 1]);
      if (channelUrl && !dryRun) noteChannelUrl(entry.creator, channelUrl);
    }
    if (!channelUrl) {
      assetReport.push({ creator: entry.creator, status: 'no_channel_url', new_count: 0 });
      continue;
    }
    const videos = await fetchChannelVideos(channelUrl, config.asset_channel_scan_count, config.asset_channel_min_views);
    const before = assetVideos.length;
    assetVideos.push(...videos);
    const usable = rankCandidates(videos).filter((c) => !ledger.video_ids[c.video_id]).length;
    // Nothing left that clears the bar and has not been used: stop paying for
    // this channel until it uploads again (a fresh success clears the flag).
    if (usable === 0 && !dryRun) markChannelExhausted(entry.creator);
    assetReport.push({
      creator: entry.creator,
      status: usable === 0 ? 'exhausted' : 'ok',
      new_count: usable,
      added: assetVideos.length - before
    });
  }

  // 2. Keyword search fills the rest - and is how new asset channels appear.
  const found = [...assetVideos];
  const perQuery = [];
  for (const query of queries) {
    const videos = await searchOnce(query, config.per_query_results);
    perQuery.push({ query, results: videos.length });
    found.push(...videos);
  }

  const ranked = rankCandidates(found);
  const unseen = ranked.filter((candidate) => !ledger.video_ids[candidate.video_id]);
  // Drop channels the eligibility gate has already rejected twice with no
  // success (2026-08-13). These are narration-led documentary channels; every
  // one of their videos costs a download plus a probe before being skipped.
  const channelLedger = loadChannelLedger();
  const blockedHits = [];
  const fresh = unseen.filter((candidate) => {
    if (!isChannelBlocked(candidate.creator, channelLedger)) return true;
    blockedHits.push({ creator: candidate.creator, title: candidate.title, url: candidate.url });
    return false;
  });
  const selected = assignLocales(fresh, config).slice(0, config.daily_count);

  const importRows = selected.map((candidate) => ({
    url: candidate.url,
    title: candidate.title,
    target_locale: candidate.target_locale,
    durationSec: candidate.duration_sec,
    views: candidate.views,
    creator: candidate.creator,
    publishedAt: candidate.published_at,
    harvested: true,
    production_lane: candidate.production_lane || ''
  }));

  let importResult = { imported: [], skipped: [], failed: [] };
  if (!dryRun && importRows.length && typeof importItems === 'function') {
    importResult = importItems(importRows);
  }

  if (!dryRun) {
    for (const candidate of selected) {
      ledger.video_ids[candidate.video_id] = {
        url: candidate.url,
        origin: 'harvest',
        seen_at: now.toISOString(),
        score: candidate.score,
        heatmap_peak: candidate.heatmap_peak,
        target_locale: candidate.target_locale
      };
    }
    saveLedger(ledger);
  }

  return {
    queries: perQuery,
    found_count: found.length,
    unique_count: ranked.length,
    fresh_count: fresh.length,
    blocked_channel_hits: blockedHits,
    asset_channels: assetReport,
    selected,
    import_result: importResult
  };
}

module.exports = {
  harvestDailySources,
  loadHarvestConfig,
  __test: {
    extractYoutubeVideoId,
    todaysQueries,
    rankCandidates,
    assignLocales,
    heatmapPeak,
    DEFAULT_CONFIG
  }
};

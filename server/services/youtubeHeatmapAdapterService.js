const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { PROJECT_ROOT } = require('./pipelinePaths');
const { extractYouTubeVideoId } = require('./youtubeUrlUtils');
const { resolveTool, getToolEnv } = require('../utils/toolPaths');

const PUBLIC_HEATMAP_SOURCE = 'youtube_public_most_replayed';
const DEFAULT_YTDLP_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_BUFFER = 30 * 1024 * 1024;
const DEFAULT_TOP_PERCENT = 0.15;
const DEFAULT_MERGE_GAP_SEC = 3;
const DEFAULT_MIN_WINDOW_SEC = 2;
const DEFAULT_MAX_WINDOWS = 15;

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function unavailable(reason, details = {}) {
  return {
    status: 'unavailable',
    heatmap_signals: { status: 'unavailable', coverage: false, source: PUBLIC_HEATMAP_SOURCE, reason, peaks: [], high_replay_windows: [] },
    evidence_coverage: false,
    unavailable_reason: reason,
    details
  };
}

function skipped(reason, details = {}) {
  return {
    status: 'skipped',
    heatmap_signals: { status: 'skipped', coverage: false, source: PUBLIC_HEATMAP_SOURCE, reason, peaks: [], high_replay_windows: [] },
    evidence_coverage: false,
    unavailable_reason: reason,
    details
  };
}

function resolveAdapterPath(options = {}) {
  const raw = normalizeText(options.adapterPath || process.env.MIDFORM_HEATMAP_ADAPTER_PATH);
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.join(PROJECT_ROOT, raw);
}

function normalizeWindow(item) {
  const start = Number(item?.start_sec ?? item?.start ?? item?.start_time ?? 0);
  const end = Number(item?.end_sec ?? item?.end ?? item?.end_time ?? 0);
  const score = Number(item?.score ?? item?.value ?? item?.heat ?? 0);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start_sec: Number(start.toFixed(3)), end_sec: Number(end.toFixed(3)), score: Number.isFinite(score) ? score : 0 };
}

function normalizeRawPoint(item) {
  const start = Number(item?.start_sec ?? item?.start ?? item?.start_time ?? 0);
  const end = Number(item?.end_sec ?? item?.end ?? item?.end_time ?? 0);
  const score = Number(item?.score ?? item?.value ?? item?.heat ?? 0);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(score)) return null;
  return {
    start_sec: Number(start.toFixed(3)),
    end_sec: Number(end.toFixed(3)),
    score: Number(Math.max(0, Math.min(1, score)).toFixed(6))
  };
}

function heatmapOptions(options = {}) {
  return {
    topPercent: Math.max(0.01, Math.min(1, Number(options.peakTopPercent || options.topPercent || DEFAULT_TOP_PERCENT))),
    mergeGapSec: Math.max(0, Number(options.mergeGapSec || DEFAULT_MERGE_GAP_SEC)),
    minWindowSec: Math.max(0, Number(options.minWindowSec || DEFAULT_MIN_WINDOW_SEC)),
    maxWindows: Math.max(1, Number(options.maxWindows || DEFAULT_MAX_WINDOWS))
  };
}

function normalizePublicHeatmap(rawHeatmap, options = {}) {
  const points = (Array.isArray(rawHeatmap) ? rawHeatmap : []).map(normalizeRawPoint).filter(Boolean);
  if (!points.length) {
    return {
      status: 'unavailable',
      coverage: false,
      source: PUBLIC_HEATMAP_SOURCE,
      reason: 'public_heatmap_unavailable',
      raw_point_count: 0,
      peaks: [],
      high_replay_windows: []
    };
  }
  const config = heatmapOptions(options);
  const sortedByScore = [...points].sort((left, right) => right.score - left.score || left.start_sec - right.start_sec);
  const peakCount = Math.max(1, Math.ceil(points.length * config.topPercent));
  const threshold = sortedByScore[Math.min(peakCount - 1, sortedByScore.length - 1)]?.score ?? sortedByScore[0].score;
  const highPoints = points
    .filter((point) => point.score >= threshold)
    .sort((left, right) => left.start_sec - right.start_sec);
  const windows = [];
  for (const point of highPoints) {
    const current = windows[windows.length - 1];
    if (current && point.start_sec <= current.end_sec + config.mergeGapSec) {
      current.end_sec = Math.max(current.end_sec, point.end_sec);
      current.peak_score = Math.max(current.peak_score, point.score);
      current._sum += point.score;
      current._count += 1;
      continue;
    }
    windows.push({ start_sec: point.start_sec, end_sec: point.end_sec, peak_score: point.score, _sum: point.score, _count: 1 });
  }
  const normalizedWindows = windows
    .map((window) => {
      const duration = window.end_sec - window.start_sec;
      const pad = Math.max(0, (config.minWindowSec - duration) / 2);
      return {
        start_sec: Number(Math.max(0, window.start_sec - pad).toFixed(3)),
        end_sec: Number((window.end_sec + pad).toFixed(3)),
        peak_score: Number(window.peak_score.toFixed(6)),
        average_score: Number((window._sum / Math.max(1, window._count)).toFixed(6))
      };
    })
    .sort((left, right) => right.peak_score - left.peak_score || left.start_sec - right.start_sec)
    .slice(0, config.maxWindows);
  const peaks = sortedByScore.slice(0, config.maxWindows).map((point) => ({
    start_sec: point.start_sec,
    end_sec: point.end_sec,
    score: point.score
  }));
  return {
    status: 'available',
    coverage: true,
    source: PUBLIC_HEATMAP_SOURCE,
    raw_point_count: points.length,
    peaks,
    high_replay_windows: normalizedWindows,
    normalization: {
      peak_top_percent: config.topPercent,
      merge_gap_sec: config.mergeGapSec,
      min_window_sec: config.minWindowSec,
      max_windows: config.maxWindows,
      threshold_score: Number(threshold.toFixed(6))
    }
  };
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: PROJECT_ROOT,
      env: getToolEnv(options.env || {}),
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: options.maxBuffer || DEFAULT_MAX_BUFFER,
      timeout: options.timeout || DEFAULT_YTDLP_TIMEOUT_MS
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = String(stdout || '').slice(-2000);
        error.stderr = String(stderr || '').replace(/(SAPISIDHASH|Authorization|Cookie):[^\r\n]+/gi, '$1:[redacted]').slice(-2000);
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function fetchPublicHeatmapWithYtDlp(sourceUrl, options = {}) {
  const ytDlp = resolveTool('yt-dlp', { envKey: 'YT_DLP_PATH' });
  const args = ['--skip-download', '--dump-single-json', '--no-warnings', '--no-playlist', sourceUrl];
  try {
    const result = await execFileAsync(ytDlp, args, { timeout: options.timeoutMs, maxBuffer: options.maxBuffer });
    const parsed = JSON.parse(result.stdout.trim());
    const heatmap = normalizePublicHeatmap(parsed?.heatmap, options);
    return {
      status: heatmap.status,
      heatmap_signals: heatmap,
      evidence_coverage: heatmap.coverage === true,
      unavailable_reason: heatmap.coverage ? '' : heatmap.reason || 'public_heatmap_unavailable'
    };
  } catch (error) {
    return unavailable('yt_dlp_heatmap_failed', { code: error.code || '', message: error.message || '', stderr: error.stderr || '' });
  }
}

function selectHeatmapEntry(data, sourceUrl) {
  const videoId = extractYouTubeVideoId(sourceUrl);
  if (Array.isArray(data)) return data.find((entry) => normalizeText(entry.video_id || entry.videoId) === videoId || normalizeText(entry.source_url || entry.sourceUrl) === normalizeText(sourceUrl)) || null;
  if (data?.videos && typeof data.videos === 'object') return data.videos[videoId] || data.videos[sourceUrl] || null;
  if (normalizeText(data?.video_id || data?.videoId) === videoId || normalizeText(data?.source_url || data?.sourceUrl) === normalizeText(sourceUrl)) return data;
  return null;
}

async function collectYouTubeHeatmap(sourceUrl, options = {}) {
  const sourceMode = normalizeText(options.heatmapSource || options.heatmap_source || 'yt_dlp').toLowerCase();
  if (sourceMode === 'disabled') return skipped('heatmap_disabled');
  const hasProvidedHeatmap = options.heatmap && typeof options.heatmap === 'object'
    && (Array.isArray(options.heatmap.peaks) || Array.isArray(options.heatmap.high_replay_windows));
  if (hasProvidedHeatmap) {
    const peaks = (Array.isArray(options.heatmap.peaks) ? options.heatmap.peaks : []).map(normalizeWindow).filter(Boolean);
    const highReplay = (Array.isArray(options.heatmap.high_replay_windows) ? options.heatmap.high_replay_windows : peaks).map(normalizeWindow).filter(Boolean);
    return { status: 'available', heatmap_signals: { status: peaks.length ? 'available' : 'unavailable', coverage: peaks.length > 0, source: 'provided_options', peaks, high_replay_windows: highReplay }, evidence_coverage: peaks.length > 0, unavailable_reason: peaks.length ? '' : 'provided_heatmap_empty' };
  }
  if (sourceMode === 'yt_dlp') {
    const publicHeatmap = await fetchPublicHeatmapWithYtDlp(sourceUrl, options);
    if (publicHeatmap.evidence_coverage === true || !resolveAdapterPath(options)) return publicHeatmap;
  }
  const adapterPath = resolveAdapterPath(options);
  if (!adapterPath) return unavailable('heatmap_adapter_not_configured');
  if (!fs.existsSync(adapterPath)) return unavailable('heatmap_adapter_file_missing', { adapterPath });
  try {
    const data = JSON.parse(fs.readFileSync(adapterPath, 'utf8').replace(/^\uFEFF/, ''));
    const entry = selectHeatmapEntry(data, sourceUrl);
    if (!entry) return unavailable('heatmap_entry_not_found', { adapterPath });
    const peaks = (Array.isArray(entry.peaks) ? entry.peaks : Array.isArray(entry.items) ? entry.items : []).map(normalizeWindow).filter(Boolean);
    const highReplay = (Array.isArray(entry.high_replay_windows) ? entry.high_replay_windows : peaks).map(normalizeWindow).filter(Boolean);
    return { status: peaks.length ? 'available' : 'unavailable', heatmap_signals: { status: peaks.length ? 'available' : 'unavailable', coverage: peaks.length > 0, source: 'internal_adapter', peaks, high_replay_windows: highReplay }, evidence_coverage: peaks.length > 0, unavailable_reason: peaks.length ? '' : 'heatmap_entry_empty' };
  } catch (error) {
    return unavailable('heatmap_adapter_parse_failed', { message: error.message });
  }
}

module.exports = {
  collectYouTubeHeatmap,
  fetchPublicHeatmapWithYtDlp,
  normalizePublicHeatmap
};

const { extractYouTubeVideoId } = require('./youtubeUrlUtils');

const DEFAULT_RETENTION_TIMEOUT_MS = 20_000;

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function unavailable(reason, details = {}) {
  return {
    status: 'unavailable',
    retention_signals: { intro: {}, top_moments: [], spikes: [], dips: [], rewatch_zones: [] },
    evidence_coverage: false,
    unavailable_reason: reason,
    details
  };
}

function skipped(reason, details = {}) {
  return {
    status: 'skipped',
    retention_signals: { status: 'skipped', coverage: false, source: 'youtube_owner_analytics', reason, intro: {}, top_moments: [], spikes: [], dips: [], rewatch_zones: [] },
    evidence_coverage: false,
    unavailable_reason: reason,
    details
  };
}

function shouldIncludeOwnerAnalytics(options = {}) {
  return options.include_owner_analytics === true || options.includeOwnerAnalytics === true;
}

function accessTokenFromOptions(options = {}) {
  return normalizeText(options.accessToken || process.env.YOUTUBE_ANALYTICS_ACCESS_TOKEN || process.env.YOUTUBE_OAUTH_ACCESS_TOKEN);
}

function dateRange(options = {}) {
  const end = options.endDate || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const startDate = new Date(`${end}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - Number(options.days || 28));
  return { startDate: options.startDate || startDate.toISOString().slice(0, 10), endDate: end };
}

function rowObject(headers, row) {
  return Object.fromEntries(headers.map((header, index) => [header.name || header.columnType || `col_${index}`, row[index]]));
}

function buildRetentionSignals(rows) {
  const sorted = rows
    .map((row) => ({
      elapsedVideoTimeRatio: Number(row.elapsedVideoTimeRatio ?? row.elapsed_video_time_ratio ?? 0),
      audienceWatchRatio: Number(row.audienceWatchRatio ?? 0),
      relativeRetentionPerformance: Number(row.relativeRetentionPerformance ?? 0),
      startedWatching: Number(row.startedWatching ?? 0),
      stoppedWatching: Number(row.stoppedWatching ?? 0),
      totalSegmentImpressions: Number(row.totalSegmentImpressions ?? 0)
    }))
    .filter((row) => Number.isFinite(row.elapsedVideoTimeRatio))
    .sort((left, right) => left.elapsedVideoTimeRatio - right.elapsedVideoTimeRatio);
  const ranked = [...sorted].sort((left, right) => Number(right.audienceWatchRatio || 0) - Number(left.audienceWatchRatio || 0));
  return {
    intro: sorted.find((row) => row.elapsedVideoTimeRatio <= 0.05) || sorted[0] || {},
    top_moments: ranked.slice(0, 8),
    spikes: ranked.filter((row) => row.audienceWatchRatio >= 1 || row.relativeRetentionPerformance > 0).slice(0, 8),
    dips: [...sorted].sort((left, right) => Number(left.audienceWatchRatio || 0) - Number(right.audienceWatchRatio || 0)).slice(0, 8),
    rewatch_zones: ranked.filter((row) => row.relativeRetentionPerformance > 0 || row.audienceWatchRatio >= 1).slice(0, 8)
  };
}

async function collectYouTubeRetention(sourceUrl, options = {}) {
  if (!shouldIncludeOwnerAnalytics(options)) return skipped('owner_analytics_not_requested');
  const videoId = extractYouTubeVideoId(sourceUrl);
  if (!videoId) return unavailable('video_id_unavailable', { sourceUrl });
  const accessToken = accessTokenFromOptions(options);
  if (!accessToken) return skipped('owner_analytics_token_missing');
  const range = dateRange(options);
  const params = new URLSearchParams({
    ids: options.ids || 'channel==MINE',
    startDate: range.startDate,
    endDate: range.endDate,
    metrics: 'audienceWatchRatio,relativeRetentionPerformance,startedWatching,stoppedWatching,totalSegmentImpressions',
    dimensions: 'elapsedVideoTimeRatio',
    filters: `video==${videoId}`,
    sort: 'elapsedVideoTimeRatio'
  });
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || options.retentionTimeoutMs || DEFAULT_RETENTION_TIMEOUT_MS) || DEFAULT_RETENTION_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetch(`https://youtubeanalytics.googleapis.com/v2/reports?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return unavailable(data?.error?.status || `http_${response.status}`, { status: response.status, message: data?.error?.message || '' });
    }
    const headers = Array.isArray(data.columnHeaders) ? data.columnHeaders : [];
    const rows = (Array.isArray(data.rows) ? data.rows : []).map((row) => rowObject(headers, row));
    if (!rows.length) return unavailable('retention_rows_empty', { videoId, startDate: range.startDate, endDate: range.endDate });
    return {
      status: 'available',
      video_id: videoId,
      retention_signals: { status: 'available', coverage: true, source: 'youtube_owner_analytics', ...buildRetentionSignals(rows) },
      evidence_coverage: true,
      unavailable_reason: '',
      date_range: range
    };
  } catch (error) {
    if (error?.name === 'AbortError') return unavailable('retention_request_timeout', { timeoutMs });
    return unavailable('retention_request_failed', { message: error.message });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  buildRetentionSignals,
  collectYouTubeRetention,
  shouldIncludeOwnerAnalytics
};

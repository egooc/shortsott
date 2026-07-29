const fs = require('fs');
const path = require('path');

const { PROJECT_ROOT } = require('./pipelinePaths');
const { extractYouTubeVideoId } = require('./youtubeUrlUtils');

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function unavailable(reason, details = {}) {
  return {
    status: 'unavailable',
    heatmap_signals: { source: 'internal_adapter', peaks: [], high_replay_windows: [] },
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

function selectHeatmapEntry(data, sourceUrl) {
  const videoId = extractYouTubeVideoId(sourceUrl);
  if (Array.isArray(data)) return data.find((entry) => normalizeText(entry.video_id || entry.videoId) === videoId || normalizeText(entry.source_url || entry.sourceUrl) === normalizeText(sourceUrl)) || null;
  if (data?.videos && typeof data.videos === 'object') return data.videos[videoId] || data.videos[sourceUrl] || null;
  if (normalizeText(data?.video_id || data?.videoId) === videoId || normalizeText(data?.source_url || data?.sourceUrl) === normalizeText(sourceUrl)) return data;
  return null;
}

async function collectYouTubeHeatmap(sourceUrl, options = {}) {
  if (options.heatmap && typeof options.heatmap === 'object') {
    const peaks = (Array.isArray(options.heatmap.peaks) ? options.heatmap.peaks : []).map(normalizeWindow).filter(Boolean);
    const highReplay = (Array.isArray(options.heatmap.high_replay_windows) ? options.heatmap.high_replay_windows : peaks).map(normalizeWindow).filter(Boolean);
    return { status: 'available', heatmap_signals: { source: 'provided_options', peaks, high_replay_windows: highReplay }, evidence_coverage: peaks.length > 0, unavailable_reason: peaks.length ? '' : 'provided_heatmap_empty' };
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
    return { status: peaks.length ? 'available' : 'unavailable', heatmap_signals: { source: 'internal_adapter', peaks, high_replay_windows: highReplay }, evidence_coverage: peaks.length > 0, unavailable_reason: peaks.length ? '' : 'heatmap_entry_empty' };
  } catch (error) {
    return unavailable('heatmap_adapter_parse_failed', { message: error.message });
  }
}

module.exports = {
  collectYouTubeHeatmap
};

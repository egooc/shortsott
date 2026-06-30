const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const LIBRARY_PATH = path.join(DATA_DIR, 'source_discovery_library.json');
const PROJECT_ROOT = path.join(__dirname, '../..');
const QUEUE_ROOT = path.join(PROJECT_ROOT, 'queue', 'process');
const BATCH_OUTPUT_ROOT = path.join(PROJECT_ROOT, 'server', 'output', 'process_batches');

function nowIso() {
  return new Date().toISOString();
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function emptyLibrary() {
  return {
    version: 1,
    produced: {},
    excluded: {}
  };
}

function readLibrary() {
  const data = readJson(LIBRARY_PATH, emptyLibrary());
  return {
    ...emptyLibrary(),
    ...(data && typeof data === 'object' ? data : {}),
    produced: data?.produced && typeof data.produced === 'object' ? data.produced : {},
    excluded: data?.excluded && typeof data.excluded === 'object' ? data.excluded : {}
  };
}

function saveLibrary(library) {
  writeJson(LIBRARY_PATH, {
    version: 1,
    produced: library.produced || {},
    excluded: library.excluded || {}
  });
}

function extractYouTubeId(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  const direct = text.match(/^[a-zA-Z0-9_-]{11}$/);
  if (direct) return direct[0];

  try {
    const parsed = new URL(text);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') {
      return parsed.pathname.split('/').filter(Boolean)[0] || '';
    }
    if (host.endsWith('youtube.com')) {
      if (parsed.pathname.startsWith('/shorts/')) {
        return parsed.pathname.split('/').filter(Boolean)[1] || '';
      }
      if (parsed.pathname.startsWith('/embed/')) {
        return parsed.pathname.split('/').filter(Boolean)[1] || '';
      }
      return parsed.searchParams.get('v') || '';
    }
  } catch {
    // Non-URL values are handled by fallback regex below.
  }

  const match = text.match(/(?:v=|shorts\/|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : '';
}

function canonicalSourceKey(value = '') {
  const youtubeId = extractYouTubeId(value);
  if (youtubeId) return `youtube:${youtubeId}`;
  const text = String(value || '').trim();
  return text ? `url:${text.toLowerCase()}` : '';
}

function getVideoUrl(video = {}) {
  return String(video.url || video.watchUrl || video.source_url || video.sourceUrl || '').trim();
}

function summarizeVideo(video = {}) {
  const url = getVideoUrl(video);
  return {
    id: String(video.id || extractYouTubeId(url) || '').trim(),
    url,
    title: String(video.title || video.description || '').trim(),
    thumbnail: String(video.thumbnail || '').trim(),
    creator: String(video.creator || video.channelTitle || '').trim(),
    views: Number(video.views || 0),
    publishedAt: String(video.publishedAt || '').trim()
  };
}

function markSourceProduced({ url, video, itemId, outputFolder, highlightOutputFolder, batchId } = {}) {
  const sourceUrl = url || getVideoUrl(video);
  const key = canonicalSourceKey(sourceUrl);
  if (!key) return readLibrary();

  const library = readLibrary();
  const previous = library.produced[key] || {};
  library.produced[key] = {
    ...previous,
    ...summarizeVideo({ ...(video || {}), url: sourceUrl }),
    key,
    produced: true,
    item_id: itemId || previous.item_id || '',
    output_folder: outputFolder || previous.output_folder || '',
    highlight_output_folder: highlightOutputFolder || previous.highlight_output_folder || '',
    batch_id: batchId || previous.batch_id || '',
    produced_at: nowIso()
  };
  saveLibrary(library);
  return library;
}

function excludeSource({ url, video, reason = 'manual_exclude' } = {}) {
  const sourceUrl = url || getVideoUrl(video);
  const key = canonicalSourceKey(sourceUrl);
  if (!key) return readLibrary();

  const library = readLibrary();
  const previous = library.excluded[key] || {};
  library.excluded[key] = {
    ...previous,
    ...summarizeVideo({ ...(video || {}), url: sourceUrl }),
    key,
    excluded: true,
    reason,
    excluded_at: nowIso()
  };
  saveLibrary(library);
  return library;
}

function restoreSource({ url } = {}) {
  const key = canonicalSourceKey(url);
  const library = readLibrary();
  if (key && library.excluded[key]) {
    delete library.excluded[key];
    saveLibrary(library);
  }
  return library;
}

function getSourceState(url = '') {
  const key = canonicalSourceKey(url);
  const library = readLibrary();
  return {
    key,
    produced: Boolean(key && library.produced[key]),
    excluded: Boolean(key && library.excluded[key]),
    producedRecord: key ? library.produced[key] || null : null,
    excludedRecord: key ? library.excluded[key] || null : null
  };
}

function annotateVideos(videos = [], { hideExcluded = true } = {}) {
  const library = readLibrary();
  const annotated = [];
  let hiddenExcludedCount = 0;

  for (const video of Array.isArray(videos) ? videos : []) {
    const url = getVideoUrl(video);
    const key = canonicalSourceKey(url || video.id);
    const producedRecord = key ? library.produced[key] || null : null;
    const excludedRecord = key ? library.excluded[key] || null : null;
    if (excludedRecord && hideExcluded) {
      hiddenExcludedCount += 1;
      continue;
    }
    annotated.push({
      ...video,
      sourceStatus: {
        key,
        produced: Boolean(producedRecord),
        excluded: Boolean(excludedRecord),
        producedAt: producedRecord?.produced_at || '',
        excludedAt: excludedRecord?.excluded_at || '',
        outputFolder: producedRecord?.output_folder || '',
        highlightOutputFolder: producedRecord?.highlight_output_folder || '',
        reason: excludedRecord?.reason || ''
      }
    });
  }

  return {
    videos: annotated,
    hiddenExcludedCount,
    librarySummary: summarizeLibrary(library)
  };
}

function summarizeLibrary(library = readLibrary()) {
  return {
    producedCount: Object.keys(library.produced || {}).length,
    excludedCount: Object.keys(library.excluded || {}).length,
    path: LIBRARY_PATH
  };
}

function readQueueSourceUrl(itemId = '') {
  const configPath = path.join(QUEUE_ROOT, itemId, 'item_config.json');
  const config = readJson(configPath, {});
  return String(config.source_url || '').trim();
}

function syncProducedFromProcessReports() {
  const library = readLibrary();
  if (!fs.existsSync(BATCH_OUTPUT_ROOT)) return library;

  for (const entry of fs.readdirSync(BATCH_OUTPUT_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const reportPath = path.join(BATCH_OUTPUT_ROOT, entry.name, 'batch_report.json');
    const report = readJson(reportPath, null);
    if (!report || !Array.isArray(report.items)) continue;

    for (const row of report.items) {
      if (!row || row.status !== 'success') continue;
      const sourceUrl = String(row.source_url || '').trim() || readQueueSourceUrl(row.item_id);
      const key = canonicalSourceKey(sourceUrl);
      if (!key || library.produced[key]) continue;
      library.produced[key] = {
        key,
        produced: true,
        id: extractYouTubeId(sourceUrl),
        url: sourceUrl,
        title: row.upload_title || '',
        thumbnail: '',
        creator: '',
        views: 0,
        publishedAt: '',
        item_id: row.item_id || '',
        output_folder: row.output_folder || '',
        highlight_output_folder: row.highlight_output_folder || '',
        batch_id: report.batch_id || entry.name,
        produced_at: report.finished_at || nowIso()
      };
    }
  }

  saveLibrary(library);
  return library;
}

module.exports = {
  LIBRARY_PATH,
  annotateVideos,
  canonicalSourceKey,
  excludeSource,
  getSourceState,
  markSourceProduced,
  readLibrary,
  restoreSource,
  summarizeLibrary,
  syncProducedFromProcessReports
};

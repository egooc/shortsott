const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { PROJECT_ROOT } = require('./pipelinePaths');
const { resolveTool, getToolEnv } = require('../utils/toolPaths');

const PHASE_A_DIR = path.join(PROJECT_ROOT, 'midform', 'phase_a_verify');
const HANDLES_PATH = path.join(PHASE_A_DIR, 'input', 'handles.txt');
const GRADED_PATH = path.join(PHASE_A_DIR, 'output', 'channels_graded.csv');
const LEGEND_PATH = path.join(PHASE_A_DIR, 'output', 'legend_videos.csv');
const SEED_PATH = path.join(PHASE_A_DIR, 'output', 'seed_videos_ranked.csv');
const TEST_RUNS_DIR = path.join(PROJECT_ROOT, 'midform', 'test_runs');
const ARCHIVED_TEST_RUNS_DIR = path.join(PROJECT_ROOT, 'removed_ottugi_20260715', 'midform', 'test_runs_archive');
const MATERIALS_DIR = path.join(PROJECT_ROOT, 'midform', 'materials');
const MATERIALS_PATH = path.join(MATERIALS_DIR, 'materials.json');
const SCAN_CACHE_PATH = path.join(MATERIALS_DIR, 'channel_scan_cache.json');
const SCAN_CACHE_MS = 24 * 60 * 60 * 1000;
const SCAN_DELAY_MIN_MS = 1000;
const SCAN_DELAY_MAX_MS = 2000;
const YTDLP_TIMEOUT_MS = Number(process.env.MIDFORM_CHANNEL_SCAN_TIMEOUT_MS || 8 * 60 * 1000);

let materialsCache = null;
let scanStatus = {
  active: false,
  queue: [],
  current: null,
  completed: 0,
  failed: 0,
  lastError: null,
  updatedAt: ''
};

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readTextIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '') : '';
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(readTextIfExists(filePath));
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(current);
      current = '';
      continue;
    }
    if (char === '\r') {
      continue;
    }
    if (char === '\n') {
      row.push(current);
      rows.push(row);
      row = [];
      current = '';
      continue;
    }
    current += char;
  }
  if (current.length || row.length) {
    row.push(current);
    rows.push(row);
  }
  return rows.filter((values) => values.some((value) => String(value || '').trim() !== ''));
}

function encodeCsvValue(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatCsv(rows, headers) {
  const lines = [headers.map(encodeCsvValue).join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => encodeCsvValue(row[header] ?? '')).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function parseCsv(filePath) {
  const text = readTextIfExists(filePath);
  if (!text.trim()) return [];
  const rows = parseCsvText(text);
  const headers = (rows.shift() || []).map((header) => String(header || '').trim());
  return rows.map((values) => {
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeHandle(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('@')) return text;
  const match = text.match(/youtube\.com\/@([^/?#]+)/i);
  if (match) return `@${match[1]}`;
  return text.startsWith('UC') ? text : `@${text}`;
}

function fallbackChannelName(handle) {
  return String(handle || '').trim().replace(/^@/, '');
}

function hasBrokenText(value) {
  return /\uFFFD/.test(String(value || ''));
}

function normalizeUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const id = videoIdFromUrl(text);
  return id ? `https://www.youtube.com/watch?v=${id}` : text.split('&')[0];
}

function videoIdFromUrl(value) {
  const text = String(value || '').trim();
  const match = text.match(/(?:v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{11})/) || text.match(/^([A-Za-z0-9_-]{11})$/);
  return match ? match[1] : '';
}

function thumbnailUrl(value) {
  const id = videoIdFromUrl(value);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '';
}

function parseUploadDate(value) {
  const text = String(value || '').trim();
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return text;
}

function formatChannelUrl(handle, suffix = 'videos') {
  const normalized = normalizeHandle(handle);
  if (hasBrokenText(normalized)) return '';
  if (normalized.startsWith('http')) return `${normalized.replace(/\/$/, '')}/${suffix}`;
  if (normalized.startsWith('UC')) return `https://www.youtube.com/channel/${normalized}/${suffix}`;
  return `https://www.youtube.com/${normalized}/${suffix}`;
}

function popularUrl(handle) {
  return `${formatChannelUrl(handle, 'videos')}?view=0&sort=p&flow=grid`;
}

function materialSignals(title, durationSec) {
  const text = String(title || '');
  const badges = [];
  if (/\([12][0-9]{3}\)|\bMovieclips\b|\s\|\s|\bS\d+E\d+\b/i.test(text)) badges.push('식별 용이');
  if (/\b(scene|moment|confrontation|dialogue|conversation|interrogation|confession|argument|fight|battle|duel)\b/i.test(text)) badges.push('대사 장면');
  const durationOk = durationSec >= 90 && durationSec <= 240;
  return { badges, durationOk };
}

function extractMovieTitle(title) {
  const text = String(title || '').trim();
  const yearMatch = text.match(/^(.+?\([12][0-9]{3}\))/);
  if (yearMatch) return yearMatch[1].trim();
  const pipePart = text.split('|')[0]?.trim() || '';
  const sceneSplit = pipePart.split(/\s+-\s+/)[0]?.trim() || '';
  return sceneSplit.length >= 3 && sceneSplit.length <= 80 ? sceneSplit : '';
}

function loadRunUsage() {
  const usage = new Map();
  const roots = [TEST_RUNS_DIR, ARCHIVED_TEST_RUNS_DIR].filter((dirPath) => fs.existsSync(dirPath));
  const stack = roots.flatMap((root) => fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name)));
  for (const runDir of stack) {
    const runId = path.basename(runDir);
    const state = readJsonIfExists(path.join(runDir, 'pipeline_state.json'));
    if (state?.input?.sourceUrl) {
      const status = state.status === 'completed' ? 'done' : state.status === 'failed' ? 'failed' : 'fresh';
      usage.set(normalizeUrl(state.input.sourceUrl), { status, runId, title: state.input.movieTitle || '', durationSec: 0, channelHandle: '' });
    }
    const candidateFiles = fs.readdirSync(runDir).filter((name) => /^(source\.info|movie_research|preflight_gate).*\.json$/.test(name));
    let legacyStatus = 'done';
    const preflight = readJsonIfExists(path.join(runDir, 'preflight_gate.json'));
    if (preflight?.status === 'fail') legacyStatus = 'rejected';
    const sourceInfo = readJsonIfExists(path.join(runDir, 'source.info.json')) || {};
    const sourceTitle = String(sourceInfo.title || preflight?.source?.title || '').trim();
    const sourceDuration = safeNumber(sourceInfo.duration || preflight?.speech?.source_duration_sec, 0);
    const sourceHandle = normalizeHandle(sourceInfo.uploader_id || sourceInfo.channel || sourceInfo.channel_id || '');
    for (const name of candidateFiles) {
      const data = readJsonIfExists(path.join(runDir, name));
      const urls = new Set();
      collectUrls(data, urls);
      for (const url of urls) usage.set(normalizeUrl(url), { status: legacyStatus, runId, title: sourceTitle, durationSec: sourceDuration, channelHandle: sourceHandle });
    }
  }
  return usage;
}

function collectUrls(value, urls) {
  if (!value) return;
  if (typeof value === 'string') {
    if (/youtube\.com\/watch\?v=|youtu\.be\//i.test(value)) urls.add(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectUrls(item, urls));
    return;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((item) => collectUrls(item, urls));
  }
}

function loadChannels() {
  const handles = readTextIfExists(HANDLES_PATH)
    .split(/\r?\n/)
    .map(normalizeHandle)
    .filter(Boolean);
  const graded = new Map(parseCsv(GRADED_PATH).map((row) => [normalizeHandle(row.handle), row]));
  const materials = loadMaterials({ reload: false }).materials;
  const videoCounts = new Map();
  const channelNames = new Map();
  const usedHandles = new Set();
  const seedRows = parseCsv(SEED_PATH);
  for (const row of seedRows) {
    const handle = normalizeHandle(row.handle);
    const channelName = String(row.channel_name || '').trim();
    if (handle && channelName && !channelNames.has(handle)) channelNames.set(handle, channelName);
  }
  for (const material of materials) {
    const handle = normalizeHandle(material.channelHandle);
    if (handle) videoCounts.set(handle, (videoCounts.get(handle) || 0) + 1);
    const channelName = String(material.channelName || '').trim();
    if (handle && channelName && !channelNames.has(handle)) channelNames.set(handle, channelName);
    if (handle && (material.runId || material.status !== 'fresh')) usedHandles.add(handle);
  }
  const scanCache = readScanCache();
  for (const [handleValue, entry] of Object.entries(scanCache)) {
    const handle = normalizeHandle(handleValue);
    for (const material of entry?.materials || []) {
      const channelName = String(material.channelName || '').trim();
      if (handle && channelName && !channelNames.has(handle)) channelNames.set(handle, channelName);
    }
  }
  return handles.map((handle) => {
    const grade = graded.get(handle) || null;
    return {
      handle,
      channelName: hasBrokenText(channelNames.get(handle)) ? fallbackChannelName(handle) : (channelNames.get(handle) || fallbackChannelName(handle)),
      grade: grade?.grade || '미분석',
      analyzed: Boolean(grade),
      videoCount: videoCounts.get(handle) || 0,
      midformRatio: safeNumber(grade?.midform_ratio, 0),
      medianViews: safeNumber(grade?.median_views, 0),
      lastScannedAt: grade?.last_upload || '',
      videosAnalyzed: safeNumber(grade?.videos_analyzed, 0),
      shortformRatio: safeNumber(grade?.shortform_ratio, 0),
      longformRatio: safeNumber(grade?.longform_ratio, 0),
      url: grade?.url || formatChannelUrl(handle),
      status: usedHandles.has(handle) ? 'used' : 'unused'
    };
  });
}

function defaultPriorityForGrade(grade) {
  if (grade === 'A') return 'high';
  if (grade === 'B') return 'medium';
  if (grade === 'X') return 'low';
  return '';
}

function loadChannelSheetRows() {
  return loadChannels().map((channel) => {
    const brokenHandle = hasBrokenText(channel.handle);
    const brokenName = hasBrokenText(channel.channelName);
    const fallbackName = fallbackChannelName(channel.handle);
    const note = brokenHandle ? 'source_handle_corrupted' : brokenName ? 'source_name_corrupted' : '';
    return {
      channel_handle: channel.handle,
      channel_name: brokenName ? fallbackName : (channel.channelName || fallbackName),
      channel_url: brokenHandle ? '' : channel.url,
      grade: channel.grade,
      analyzed: channel.analyzed ? 'yes' : 'no',
      video_count: String(channel.videoCount),
      midform_ratio: String(channel.midformRatio),
      shortform_ratio: String(channel.shortformRatio),
      longform_ratio: String(channel.longformRatio),
      median_views: String(channel.medianViews),
      videos_analyzed: String(channel.videosAnalyzed),
      last_scanned_at: channel.lastScannedAt,
      status: channel.status,
      notes: note,
      priority: defaultPriorityForGrade(channel.grade)
    };
  });
}

function exportChannelSheetCsv(filePath) {
  const rows = loadChannelSheetRows();
  const headers = [
    'channel_handle',
    'channel_name',
    'channel_url',
    'grade',
    'analyzed',
    'video_count',
    'midform_ratio',
    'shortform_ratio',
    'longform_ratio',
    'median_views',
    'videos_analyzed',
    'last_scanned_at',
    'status',
    'notes',
    'priority'
  ];
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, formatCsv(rows, headers), 'utf8');
  return { filePath, rows: rows.length, headers };
}

function normalizeSheetStatus(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'unused';
  if (['used', 'done', 'completed', 'skip', 'skipped', 'exclude', 'excluded'].includes(text)) return 'used';
  return 'unused';
}

function readChannelSheetCsv(filePath) {
  return parseCsv(filePath).map((row) => ({
    channelHandle: normalizeHandle(row.channel_handle || row.handle || ''),
    channelName: String(row.channel_name || row.channel || row.name || '').trim(),
    channelUrl: String(row.channel_url || row.url || '').trim(),
    grade: String(row.grade || '').trim(),
    status: normalizeSheetStatus(row.status),
    notes: String(row.notes || '').trim(),
    priority: String(row.priority || '').trim(),
    raw: row
  }));
}

function listUnusedChannelsFromSheet(filePath) {
  return readChannelSheetCsv(filePath)
    .filter((row) => row.channelUrl)
    .filter((row) => row.status === 'unused')
    .sort((left, right) => String(left.channelName || left.channelHandle || '').localeCompare(String(right.channelName || right.channelHandle || '')));
}

function normalizeMaterial(raw, sourceTag) {
  const url = normalizeUrl(raw.video_url || raw.url || raw.webpage_url || raw.id);
  const title = String(raw.title || '').trim();
  const durationSec = safeNumber(raw.duration_sec || raw.duration, 0);
  const signals = materialSignals(title, durationSec);
  return {
    url,
    videoId: videoIdFromUrl(url),
    thumbnailUrl: thumbnailUrl(url),
    title,
    channelHandle: normalizeHandle(raw.channel_handle || raw.handle || raw.uploader_id || raw.channel || ''),
    channelName: String(raw.channel_name || raw.uploader || '').trim(),
    durationSec,
    viewCount: safeNumber(raw.view_count || raw.view_count_text, 0),
    viewsVsChannelMedian: raw.views_vs_channel_median === undefined ? null : safeNumber(raw.views_vs_channel_median, 0),
    uploadDate: parseUploadDate(raw.upload_date || raw.date || ''),
    sourceTag,
    status: 'fresh',
    runId: '',
    suitabilityBadges: signals.badges,
    durationOk: signals.durationOk,
    movieTitleGuess: extractMovieTitle(title)
  };
}

function normalizeSourceTag(value) {
  const tags = String(value || '')
    .split('+')
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(tags)).join('+') || 'seed';
}

function mergeMaterials(baseMaterials, nextMaterials) {
  const byUrl = new Map(baseMaterials.map((item) => [normalizeUrl(item.url), { ...item, sourceTag: normalizeSourceTag(item.sourceTag) }]));
  for (const item of nextMaterials) {
    const key = normalizeUrl(item.url);
    if (!key) continue;
    const normalizedItem = { ...item, sourceTag: normalizeSourceTag(item.sourceTag) };
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, normalizedItem);
      continue;
    }
    const tags = new Set(String(existing.sourceTag || '').split('+').filter(Boolean));
    String(normalizedItem.sourceTag || '').split('+').filter(Boolean).forEach((tag) => tags.add(tag));
    byUrl.set(key, {
      ...existing,
      ...Object.fromEntries(Object.entries(normalizedItem).filter(([, value]) => value !== '' && value !== null && value !== 0)),
      sourceTag: Array.from(tags).join('+')
    });
  }
  return Array.from(byUrl.values());
}

function loadSeedMaterials() {
  const legend = parseCsv(LEGEND_PATH).map((row) => normalizeMaterial(row, 'legend'));
  const seed = parseCsv(SEED_PATH).map((row) => normalizeMaterial(row, 'seed'));
  return mergeMaterials(legend, seed);
}

function loadHistoryMaterials() {
  return Array.from(loadRunUsage().entries()).map(([url, usage]) => ({
    ...normalizeMaterial({
      video_url: url,
      title: usage.title || url,
      duration_sec: usage.durationSec || 0,
      handle: usage.channelHandle || ''
    }, 'history'),
    status: usage.status,
    runId: usage.runId
  }));
}

function applyUsage(materials) {
  const usage = loadRunUsage();
  return materials.map((material) => {
    const used = usage.get(normalizeUrl(material.url));
    return used ? { ...material, status: used.status, runId: used.runId } : material;
  });
}

function loadPersistedScannedMaterials() {
  const saved = readJsonIfExists(MATERIALS_PATH);
  if (!saved || !Array.isArray(saved.materials)) return [];
  return saved.materials.filter((item) => item?.sourceTag === 'scanned' || String(item?.sourceTag || '').includes('scanned'));
}

function loadMaterials({ reload = false } = {}) {
  if (!reload && materialsCache) return materialsCache;
  const seeded = loadSeedMaterials();
  const scanned = loadPersistedScannedMaterials();
  const history = loadHistoryMaterials();
  const seedAndScanned = applyUsage(mergeMaterials(seeded, scanned));
  const materials = mergeMaterials(seedAndScanned, history);
  materialsCache = {
    materials,
    counts: {
      legendRows: parseCsv(LEGEND_PATH).length,
      seedRows: parseCsv(SEED_PATH).length,
      initialMerged: seeded.length,
      historyRows: history.length,
      merged: materials.length
    },
    loadedAt: new Date().toISOString()
  };
  writeJson(MATERIALS_PATH, materialsCache);
  return materialsCache;
}

function filterMaterials(query = {}) {
  const data = loadMaterials({ reload: false });
  const channels = new Map(loadChannels().map((channel) => [channel.handle, channel]));
  const durationDefault = query.durationDefault !== 'false' && query.duration_default !== 'false';
  const freshDefault = query.freshDefault !== 'false' && query.fresh_default !== 'false';
  let items = data.materials.map((material) => ({ ...material, channelGrade: channels.get(material.channelHandle)?.grade || '미분석' }));
  if (durationDefault || query.duration === 'midform') items = items.filter((item) => item.durationSec >= 90 && item.durationSec <= 240);
  if (freshDefault || query.fresh === 'true') items = items.filter((item) => item.status === 'fresh');
  if (query.source_tag) items = items.filter((item) => String(item.sourceTag || '').includes(String(query.source_tag)));
  if (query.grade) {
    const allowed = new Set(String(query.grade).split(',').map((item) => item.trim()));
    items = items.filter((item) => allowed.has(item.channelGrade));
  }
  if (query.handle) items = items.filter((item) => item.channelHandle === normalizeHandle(query.handle));
  const sort = String(query.sort || 'views').trim();
  items.sort((a, b) => {
    if (sort === 'multiplier') return safeNumber(b.viewsVsChannelMedian, -1) - safeNumber(a.viewsVsChannelMedian, -1);
    if (sort === 'upload_date') return String(b.uploadDate || '').localeCompare(String(a.uploadDate || ''));
    if (sort === 'duration') return safeNumber(b.durationSec, 0) - safeNumber(a.durationSec, 0);
    return safeNumber(b.viewCount, 0) - safeNumber(a.viewCount, 0);
  });
  return { ...data, materials: items };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomScanDelay() {
  return SCAN_DELAY_MIN_MS + Math.floor(Math.random() * (SCAN_DELAY_MAX_MS - SCAN_DELAY_MIN_MS + 1));
}

function execYtDlp(args) {
  const command = resolveTool('yt-dlp', { envKey: 'YT_DLP_PATH' });
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: PROJECT_ROOT,
      env: getToolEnv(),
      encoding: 'utf8',
      windowsHide: true,
      timeout: YTDLP_TIMEOUT_MS,
      maxBuffer: 100 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(new Error(stderr || error.message), { code: 'YTDLP_SCAN_FAILED', details: { args, stderr } }));
        return;
      }
      resolve(JSON.parse(String(stdout || '{}')));
    });
  });
}

async function collectChannelVideos(handle) {
  const baseArgs = ['--skip-download', '--no-warnings', '--ignore-no-formats-error', '--socket-timeout', '25', '--extractor-retries', '2', '--dump-single-json'];
  await delay(randomScanDelay());
  const latest = await execYtDlp([...baseArgs, '--playlist-end', '30', formatChannelUrl(handle)]);
  await delay(randomScanDelay());
  const popular = await execYtDlp([...baseArgs, '--playlist-end', '30', popularUrl(handle)]);
  return mergeMaterials(
    (latest.entries || []).filter(Boolean).map((entry) => normalizeMaterial({ ...entry, handle }, 'scanned')),
    (popular.entries || []).filter(Boolean).map((entry) => normalizeMaterial({ ...entry, handle }, 'scanned'))
  );
}

function readScanCache() {
  return readJsonIfExists(SCAN_CACHE_PATH) || {};
}

function writeScanCache(cache) {
  writeJson(SCAN_CACHE_PATH, cache);
}

async function scanChannel(handle, options = {}) {
  const normalized = normalizeHandle(handle);
  if (!normalized) throw Object.assign(new Error('handle is required'), { status: 400, code: 'HANDLE_REQUIRED' });
  const cache = readScanCache();
  const cached = cache[normalized];
  if (!options.force && cached?.scannedAt && Date.now() - Date.parse(cached.scannedAt) < SCAN_CACHE_MS) {
    return { handle: normalized, cached: true, scannedAt: cached.scannedAt, added: 0, materials: cached.materials || [] };
  }
  scanStatus = { ...scanStatus, active: true, current: normalized, updatedAt: new Date().toISOString(), lastError: null };
  try {
    const scanned = await collectChannelVideos(normalized);
    const existing = loadMaterials({ reload: true }).materials;
    const merged = applyUsage(mergeMaterials(existing, scanned));
    materialsCache = { materials: merged, counts: { ...loadMaterials({ reload: false }).counts, merged: merged.length }, loadedAt: new Date().toISOString() };
    writeJson(MATERIALS_PATH, materialsCache);
    cache[normalized] = { scannedAt: new Date().toISOString(), materials: scanned };
    writeScanCache(cache);
    scanStatus = { ...scanStatus, active: false, current: null, completed: scanStatus.completed + 1, updatedAt: new Date().toISOString() };
    return { handle: normalized, cached: false, scannedAt: cache[normalized].scannedAt, added: scanned.length, materials: scanned };
  } catch (error) {
    scanStatus = { ...scanStatus, active: false, current: null, failed: scanStatus.failed + 1, lastError: { message: error.message, code: error.code || 'CHANNEL_SCAN_FAILED' }, updatedAt: new Date().toISOString() };
    throw error;
  }
}

function getScanStatus() {
  return scanStatus;
}

module.exports = {
  loadChannels,
  loadChannelSheetRows,
  exportChannelSheetCsv,
  readChannelSheetCsv,
  listUnusedChannelsFromSheet,
  loadMaterials,
  filterMaterials,
  scanChannel,
  getScanStatus,
  extractMovieTitle
};

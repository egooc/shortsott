const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const CANDIDATES_PATH = path.join(DATA_DIR, 'candidates.json');
const CREATOR_WATCHLIST_PATH = path.join(DATA_DIR, 'creator_watchlist.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJsonArray(filePath) {
  ensureDataDir();
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJsonArray(filePath, arr) {
  ensureDataDir();
  fs.writeFileSync(filePath, `${JSON.stringify(arr, null, 2)}\n`, 'utf8');
}

function compactId() {
  return `cand_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeHashtags(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeString(item)).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((item) => normalizeString(item))
      .filter(Boolean);
  }
  return [];
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeString(item)).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/[,\n]+/)
      .map((item) => normalizeString(item))
      .filter(Boolean);
  }
  return [];
}

function normalizeRawSummary(value) {
  if (!value || typeof value !== 'object') return null;
  const summary = {
    id: normalizeString(value.id),
    url: normalizeString(value.url),
    platform: normalizeString(value.platform),
    publish_date: normalizeString(value.publish_date || value.published_at || value.publishedAt),
    duration_sec: normalizeNumber(value.duration_sec || value.durationSec),
    views_per_hour: normalizeNumber(value.views_per_hour || value.viewsPerHour),
    author: value.author && typeof value.author === 'object'
      ? {
          username: normalizeString(value.author.username),
          followers: normalizeNumber(value.author.followers)
        }
      : null
  };
  return summary;
}

function buildCandidate(input = {}) {
  const nowIso = new Date().toISOString();
  const publishedAt = normalizeString(input.publishedAt || input.published_at);
  const viralityScore = normalizeNumber(input.viralityScore ?? input.virality_score);

  return {
    id: normalizeString(input.id) || compactId(),
    platform: normalizeString(input.platform),
    title: normalizeString(input.title),
    description: normalizeString(input.description),
    creator: normalizeString(input.creator),
    handle: normalizeString(input.handle),
    creatorId: normalizeString(input.creatorId),
    url: normalizeString(input.url),
    thumbnail: normalizeString(input.thumbnail),
    views: normalizeNumber(input.views),
    likes: normalizeNumber(input.likes),
    comments: normalizeNumber(input.comments),
    shares: normalizeNumber(input.shares),
    engagementRate: normalizeNumber(input.engagementRate),
    followers: normalizeNumber(input.followers),
    viralityScore,
    virality_score: viralityScore,
    hashtags: normalizeHashtags(input.hashtags),
    sound: normalizeString(input.sound),
    whyThisWorks: normalizeString(input.whyThisWorks),
    hookSummary: normalizeString(input.hookSummary),
    source_preset_id: normalizeString(input.source_preset_id),
    source_preset_name: normalizeString(input.source_preset_name),
    source_keywords: normalizeStringArray(input.source_keywords),
    source_exclude_keywords: normalizeStringArray(input.source_exclude_keywords),
    source_query: normalizeString(input.source_query),
    category: normalizeString(input.category),
    notes: normalizeString(input.notes),
    publishedAt,
    published_at: publishedAt,
    selected_at: normalizeString(input.selected_at) || nowIso,
    raw_summary: normalizeRawSummary(input.raw_summary)
  };
}

function isDuplicateCandidate(existing, incoming) {
  const existingUrl = normalizeString(existing.url);
  const incomingUrl = normalizeString(incoming.url);
  if (existingUrl && incomingUrl && existingUrl === incomingUrl) return true;

  const existingComposite = [
    normalizeString(existing.platform).toLowerCase(),
    normalizeString(existing.creator).toLowerCase(),
    normalizeString(existing.publishedAt || existing.published_at)
  ].join('::');
  const incomingComposite = [
    normalizeString(incoming.platform).toLowerCase(),
    normalizeString(incoming.creator).toLowerCase(),
    normalizeString(incoming.publishedAt || incoming.published_at)
  ].join('::');

  return existingComposite !== '::::' && existingComposite === incomingComposite;
}

function listCandidates() {
  return readJsonArray(CANDIDATES_PATH);
}

function addCandidate(payload) {
  const list = readJsonArray(CANDIDATES_PATH);
  const next = buildCandidate(payload);
  const duplicate = list.find((item) => isDuplicateCandidate(item, next));
  if (duplicate) {
    return { saved: false, duplicate: true, item: duplicate, list };
  }
  const nextList = [next, ...list];
  writeJsonArray(CANDIDATES_PATH, nextList);
  return { saved: true, duplicate: false, item: next, list: nextList };
}

function deleteCandidate(id) {
  const key = normalizeString(id);
  const list = readJsonArray(CANDIDATES_PATH);
  const next = list.filter((item) => normalizeString(item.id) !== key);
  const deleted = next.length !== list.length;
  if (deleted) writeJsonArray(CANDIDATES_PATH, next);
  return { deleted, list: next };
}

function listCreatorWatchlist() {
  return readJsonArray(CREATOR_WATCHLIST_PATH);
}

function addCreatorWatch(payload = {}) {
  const list = readJsonArray(CREATOR_WATCHLIST_PATH);
  const next = {
    id: compactId(),
    creator: normalizeString(payload.creator),
    handle: normalizeString(payload.handle),
    followers: normalizeNumber(payload.followers),
    avg_views: normalizeNumber(payload.avg_views),
    score: normalizeNumber(payload.score),
    topics: normalizeHashtags(payload.topics),
    source_query: normalizeString(payload.source_query),
    tracked_at: new Date().toISOString()
  };
  const duplicate = list.find((item) => {
    const h1 = normalizeString(item.handle).toLowerCase();
    const h2 = normalizeString(next.handle).toLowerCase();
    if (h1 && h2) return h1 === h2;
    return normalizeString(item.creator).toLowerCase() === normalizeString(next.creator).toLowerCase();
  });
  if (duplicate) {
    return { saved: false, duplicate: true, item: duplicate };
  }
  const nextList = [next, ...list];
  writeJsonArray(CREATOR_WATCHLIST_PATH, nextList);
  return { saved: true, duplicate: false, item: next };
}

module.exports = {
  CANDIDATES_PATH,
  CREATOR_WATCHLIST_PATH,
  listCandidates,
  addCandidate,
  deleteCandidate,
  listCreatorWatchlist,
  addCreatorWatch
};

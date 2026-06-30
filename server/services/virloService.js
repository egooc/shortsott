const { createHttpError } = require('./errorService');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE_URL = 'https://api.virlo.ai/v1';
const WORK_DIR = path.join(__dirname, '../../work');
const DATA_DIR = path.join(__dirname, '../data');
const LAST_REQUEST_PATH = path.join(WORK_DIR, 'virlo_last_request.json');
const LAST_ERROR_PATH = path.join(WORK_DIR, 'virlo_last_error.json');
const ORBIT_CACHE_PATH = path.join(DATA_DIR, 'orbit_cache.json');
const ORBIT_CACHE_TTL_MS = 30 * 60 * 1000;
const ACTIVE_ORBIT_STATUSES = new Set(['queued', 'processing', 'polling', 'fetching_videos', 'creating']);

function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 10) return '***';
  return `${key.slice(0, 6)}***${key.slice(-4)}`;
}

function writeDebugFile(filePath, data) {
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('[virlo debug write failed]', error.message);
  }
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readOrbitCache() {
  ensureDataDir();
  if (!fs.existsSync(ORBIT_CACHE_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(ORBIT_CACHE_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeOrbitCache(items) {
  ensureDataDir();
  fs.writeFileSync(ORBIT_CACHE_PATH, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
}

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeBoolean(value) {
  return Boolean(value);
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalizeString(item).toLowerCase()).filter(Boolean))].sort();
}

function normalizeListRaw(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalizeString(item)).filter(Boolean))];
}

function normalizeDate(value) {
  const text = normalizeString(value);
  return text;
}

function normalizeStatus(status) {
  const value = normalizeString(status).toLowerCase();
  if (!value) return 'queued';
  return value;
}

function toInt(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function buildQueryString(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, raw]) => {
    if (raw === undefined || raw === null) return;
    if (Array.isArray(raw)) {
      raw.forEach((item) => {
        const text = normalizeString(item);
        if (text) query.append(key, text);
      });
      return;
    }
    const text = normalizeString(raw);
    if (text) query.set(key, text);
  });
  const text = query.toString();
  return text ? `?${text}` : '';
}

function pruneExpiredOrbitCache(items) {
  const now = Date.now();
  return items.filter((item) => {
    const createdAt = new Date(item.created_at || '').getTime();
    if (!Number.isFinite(createdAt)) return false;
    return now - createdAt <= ORBIT_CACHE_TTL_MS;
  });
}

function canonicalizeSearchPayload(payload = {}) {
  return {
    keywords: normalizeList(payload.keywords),
    platforms: normalizeList(payload.platforms),
    minViews: normalizeNumber(payload.minViews),
    timePeriod: normalizeString(payload.timePeriod || 'this_month').toLowerCase(),
    runAnalysis: normalizeBoolean(payload.runAnalysis ?? true),
    selectedPreset: normalizeString(payload.presetId || payload.selectedPreset || '').toLowerCase()
  };
}

function createFingerprint(payload = {}) {
  const canonical = canonicalizeSearchPayload(payload);
  const key = JSON.stringify(canonical);
  const fingerprint = crypto.createHash('sha256').update(key).digest('hex');
  return { fingerprint, canonical };
}

function getCachedOrbitForPayload(payload = {}) {
  const { fingerprint } = createFingerprint(payload);
  const cache = pruneExpiredOrbitCache(readOrbitCache());
  writeOrbitCache(cache);
  const hit = cache.find((item) => item.fingerprint === fingerprint && ACTIVE_ORBIT_STATUSES.has(normalizeStatus(item.status)));
  return hit ? { ...hit } : null;
}

function upsertOrbitCacheEntry(entry = {}) {
  const cache = pruneExpiredOrbitCache(readOrbitCache());
  const next = {
    fingerprint: normalizeString(entry.fingerprint),
    orbitId: normalizeString(entry.orbitId),
    created_at: normalizeString(entry.created_at) || new Date().toISOString(),
    status: normalizeStatus(entry.status || 'queued'),
    keywords: normalizeList(entry.keywords),
    platforms: normalizeList(entry.platforms),
    minViews: normalizeNumber(entry.minViews),
    timePeriod: normalizeString(entry.timePeriod || 'this_month').toLowerCase(),
    runAnalysis: normalizeBoolean(entry.runAnalysis ?? true),
    selectedPreset: normalizeString(entry.selectedPreset || '').toLowerCase()
  };
  if (!next.fingerprint || !next.orbitId) return;

  const index = cache.findIndex((item) => item.fingerprint === next.fingerprint);
  if (index >= 0) {
    cache[index] = { ...cache[index], ...next };
  } else {
    cache.unshift(next);
  }
  writeOrbitCache(cache);
}

function updateOrbitCacheStatus(orbitId, status) {
  const targetId = normalizeString(orbitId);
  if (!targetId) return;
  const cache = pruneExpiredOrbitCache(readOrbitCache());
  const index = cache.findIndex((item) => normalizeString(item.orbitId) === targetId);
  if (index < 0) return;
  cache[index] = { ...cache[index], status: normalizeStatus(status || cache[index].status) };
  writeOrbitCache(cache);
}

function findOrbitCacheByOrbitId(orbitId) {
  const targetId = normalizeString(orbitId);
  if (!targetId) return null;
  const cache = pruneExpiredOrbitCache(readOrbitCache());
  const hit = cache.find((item) => normalizeString(item.orbitId) === targetId);
  return hit ? { ...hit } : null;
}

function extractOrbitId(data) {
  return (
    data?.orbitId
    || data?.orbit_id
    || data?.id
    || data?.jobId
    || data?.job_id
    || data?.data?.id
    || data?.data?.orbitId
    || data?.data?.orbit_id
    || data?.raw?.id
    || data?.raw?.orbitId
    || data?.raw?.orbit_id
    || null
  );
}

function extractOrbitStatus(data) {
  return (
    data?.status
    || data?.state
    || data?.data?.status
    || data?.data?.state
    || data?.raw?.status
    || data?.raw?.data?.status
    || ''
  );
}

async function virloRequest(path, apiKey, options = {}, debugContext = {}) {
  const fullUrl = `${BASE_URL}${path}`;
  const fetchOptions = { ...options };
  delete fetchOptions.__debug;

  const response = await fetch(`${BASE_URL}${path}`, {
    ...fetchOptions,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(fetchOptions.headers || {})
    }
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  const retryAfter = response.headers.get('retry-after');

  if (!response.ok) {
    writeDebugFile(LAST_ERROR_PATH, {
      generatedAt: new Date().toISOString(),
      stage: debugContext.stage || `virloRequest ${options.method || 'GET'} ${path}`,
      request: {
        url: fullUrl,
        method: options.method || 'GET',
        apiKeyMasked: maskApiKey(apiKey),
        virloPayload: debugContext.virloPayload || null,
        localMeta: debugContext.localMeta || null,
        fingerprint: debugContext.fingerprint || null,
        existingCachedOrbit: Boolean(debugContext.existingCachedOrbit)
      },
      response: {
        status: response.status,
        statusText: response.statusText,
        retryAfter,
        error: data?.error || null,
        message: data?.message || null,
        details: data?.details || data || null,
        rawBody: text
      }
    });
    throw createHttpError(response.status, 'VIRLO_API_ERROR', `Virlo API returned ${response.status}`, {
      ...(data && typeof data === 'object' ? data : { raw: data }),
      status: response.status,
      retryAfter: retryAfter || null,
      stage: debugContext.stage || null,
      fingerprint: debugContext.fingerprint || null,
      existingCachedOrbit: Boolean(debugContext.existingCachedOrbit),
      existingOrbitId: debugContext.existingOrbitId || null
    });
  }

  return data;
}

async function createOrbit(apiKey, payload) {
  const { fingerprint, canonical } = createFingerprint(payload);
  const cachedOrbit = getCachedOrbitForPayload(payload);
  const requestKeywords = normalizeListRaw(payload.keywords);
  const requestPlatforms = normalizeList(payload.platforms);

  const virloPayload = {
    name: `search_${Date.now()}`,
    keywords: requestKeywords,
    platforms: requestPlatforms,
    min_views: canonical.minViews,
    time_period: canonical.timePeriod,
    run_analysis: canonical.runAnalysis
  };

  const localMeta = {
    presetId: payload.presetId || payload.selectedPreset || '',
    excludeKeywords: Array.isArray(payload.excludeKeywords) ? payload.excludeKeywords : [],
    sourcePresetId: payload.source_preset_id || '',
    sourcePresetName: payload.source_preset_name || ''
  };

  if (cachedOrbit) {
    writeDebugFile(LAST_REQUEST_PATH, {
      generatedAt: new Date().toISOString(),
      stage: 'POST /api/virlo/search -> reuse cached orbit',
      virloApiKeyMasked: maskApiKey(apiKey),
      fingerprint,
      virloPayload,
      localMeta,
      cachedOrbit
    });
    return {
      orbitId: cachedOrbit.orbitId,
      raw: { reused: true, cachedOrbit },
      virloPayload,
      localMeta,
      fingerprint,
      reused: true
    };
  }

  writeDebugFile(LAST_REQUEST_PATH, {
    generatedAt: new Date().toISOString(),
    stage: 'POST /api/virlo/search -> virlo /orbit',
    virloApiKeyMasked: maskApiKey(apiKey),
    fingerprint,
    virloPayload,
    localMeta
  });

  const data = await virloRequest('/orbit', apiKey, {
    method: 'POST',
    body: JSON.stringify(virloPayload)
  }, {
    stage: 'create_orbit',
    virloPayload,
    localMeta,
    fingerprint,
    existingCachedOrbit: false
  });

  const orbitId = extractOrbitId(data);
  if (orbitId) {
    upsertOrbitCacheEntry({
      fingerprint,
      orbitId,
      created_at: new Date().toISOString(),
      status: extractOrbitStatus(data) || 'queued',
      keywords: canonical.keywords,
      platforms: canonical.platforms,
      minViews: canonical.minViews,
      timePeriod: canonical.timePeriod,
      runAnalysis: canonical.runAnalysis,
      selectedPreset: canonical.selectedPreset
    });
  }

  return { orbitId, raw: data, virloPayload, localMeta, fingerprint, reused: false };
}

async function getOrbit(apiKey, orbitId) {
  const cached = findOrbitCacheByOrbitId(orbitId);
  const data = await virloRequest(`/orbit/${orbitId}`, apiKey, {}, {
    stage: 'poll_orbit_status',
    localMeta: { orbitId },
    fingerprint: cached?.fingerprint || null,
    existingCachedOrbit: Boolean(cached),
    existingOrbitId: cached?.orbitId || null
  });
  const status = extractOrbitStatus(data);
  if (status) updateOrbitCacheStatus(orbitId, status);
  return data;
}

async function getOrbitVideos(apiKey, orbitId, query = {}) {
  const cached = findOrbitCacheByOrbitId(orbitId);
  const params = new URLSearchParams({
    limit: String(query.limit || 25),
    order_by: query.order_by || 'views',
    sort: query.sort || 'desc'
  });
  const data = await virloRequest(`/orbit/${orbitId}/videos?${params.toString()}`, apiKey, {}, {
    stage: 'fetch_orbit_videos',
    localMeta: { orbitId, query },
    fingerprint: cached?.fingerprint || null,
    existingCachedOrbit: Boolean(cached),
    existingOrbitId: cached?.orbitId || null
  });
  updateOrbitCacheStatus(orbitId, 'completed');
  return data;
}

async function listOrbits(apiKey, query = {}) {
  const qs = buildQueryString({
    limit: toInt(query.limit, 20),
    offset: toInt(query.offset, 0)
  });
  return virloRequest(`/orbit${qs}`, apiKey, {}, { stage: 'list_orbits' });
}

async function getOrbitById(apiKey, orbitId) {
  return getOrbit(apiKey, orbitId);
}

async function getOrbitTrendsLatest(apiKey, orbitId) {
  return virloRequest(`/orbit/${orbitId}/trends/latest`, apiKey, {}, {
    stage: 'orbit_trends_latest',
    localMeta: { orbitId }
  });
}

async function getOrbitCreatorOutliers(apiKey, orbitId, query = {}) {
  const qs = buildQueryString({
    limit: toInt(query.limit, 20),
    page: toInt(query.page, 1),
    order_by: normalizeString(query.order_by),
    sort: normalizeString(query.sort),
    platform: normalizeString(query.platform)
  });
  return virloRequest(`/orbit/${orbitId}/creators/outliers${qs}`, apiKey, {}, {
    stage: 'orbit_creators_outliers',
    localMeta: { orbitId, query }
  });
}

async function getOrbitSounds(apiKey, orbitId, query = {}) {
  const qs = buildQueryString({
    limit: toInt(query.limit, 20),
    page: toInt(query.page, 1)
  });
  return virloRequest(`/orbit/${orbitId}/sounds${qs}`, apiKey, {}, {
    stage: 'orbit_sounds',
    localMeta: { orbitId, query }
  });
}

async function getGlobalTrends(apiKey, query = {}) {
  const qs = buildQueryString({
    start_date: normalizeDate(query.start_date),
    end_date: normalizeDate(query.end_date),
    limit: toInt(query.limit, 20),
    top_exemplars: toInt(query.top_exemplars, null)
  });
  return virloRequest(`/trends${qs}`, apiKey, {}, { stage: 'global_trends', localMeta: { query } });
}

async function getTrendingHashtags(apiKey, query = {}) {
  const qs = buildQueryString({
    start_date: normalizeDate(query.start_date),
    end_date: normalizeDate(query.end_date),
    limit: toInt(query.limit, 40),
    page: toInt(query.page, 1),
    order_by: normalizeString(query.order_by),
    sort: normalizeString(query.sort)
  });
  return virloRequest(`/hashtags${qs}`, apiKey, {}, { stage: 'trending_hashtags', localMeta: { query } });
}

async function getTrendingSounds(apiKey, query = {}) {
  const qs = buildQueryString({
    platform: normalizeString(query.platform),
    limit: toInt(query.limit, 20),
    page: toInt(query.page, 1),
    sort: normalizeString(query.sort),
    commerce_only: query.commerce_only === undefined ? undefined : String(Boolean(query.commerce_only))
  });
  return virloRequest(`/sounds/trending${qs}`, apiKey, {}, { stage: 'trending_sounds', localMeta: { query } });
}

async function getVideosDigest(apiKey, query = {}) {
  const qs = buildQueryString({
    limit: toInt(query.limit, 50),
    niche: normalizeString(query.niche)
  });
  return virloRequest(`/videos/digest${qs}`, apiKey, {}, { stage: 'videos_digest', localMeta: { query } });
}

async function getPlatformVideosDigest(apiKey, platform, query = {}) {
  const target = normalizeString(platform).toLowerCase();
  if (!['youtube', 'tiktok', 'instagram'].includes(target)) {
    throw createHttpError(400, 'VIRLO_PLATFORM_INVALID', `Unsupported platform "${platform}"`, { platform });
  }
  const qs = buildQueryString({
    limit: toInt(query.limit, 50),
    niche: normalizeString(query.niche)
  });
  return virloRequest(`/${target}/videos/digest${qs}`, apiKey, {}, {
    stage: `${target}_videos_digest`,
    localMeta: { query, platform: target }
  });
}

async function getNiches(apiKey) {
  try {
    return await virloRequest('/niches', apiKey, {}, { stage: 'get_niches' });
  } catch (error) {
    if (error?.status === 404) {
      return virloRequest('/legacy/niches', apiKey, {}, { stage: 'get_niches_fallback' });
    }
    throw error;
  }
}

async function getNicheTrends(apiKey, nicheId) {
  return virloRequest(`/niches/${nicheId}/trends`, apiKey, {}, {
    stage: 'get_niche_trends',
    localMeta: { nicheId }
  });
}

async function listComets(apiKey, query = {}) {
  const qs = buildQueryString({
    include_inactive: normalizeString(query.include_inactive)
  });
  try {
    return await virloRequest(`/comet/list${qs}`, apiKey, {}, { stage: 'list_comets_primary', localMeta: { query } });
  } catch (error) {
    if ([400, 404, 405].includes(error?.status)) {
      return virloRequest(`/comet${qs}`, apiKey, {}, { stage: 'list_comets_fallback', localMeta: { query } });
    }
    throw error;
  }
}

async function getCometById(apiKey, id) {
  return virloRequest(`/comet/${id}`, apiKey, {}, { stage: 'get_comet', localMeta: { id } });
}

async function getCometVideos(apiKey, id, query = {}) {
  const qs = buildQueryString({
    limit: toInt(query.limit, 25),
    page: toInt(query.page, 1),
    min_views: toInt(query.min_views, null),
    platforms: query.platforms,
    start_date: normalizeDate(query.start_date),
    end_date: normalizeDate(query.end_date),
    order_by: normalizeString(query.order_by),
    sort: normalizeString(query.sort),
    intent_match: query.intent_match === undefined ? undefined : String(Boolean(query.intent_match))
  });
  return virloRequest(`/comet/${id}/videos${qs}`, apiKey, {}, { stage: 'get_comet_videos', localMeta: { id, query } });
}

async function getCometSlideshows(apiKey, id, query = {}) {
  const qs = buildQueryString({
    limit: toInt(query.limit, 25),
    page: toInt(query.page, 1),
    order_by: normalizeString(query.order_by),
    sort: normalizeString(query.sort)
  });
  return virloRequest(`/comet/${id}/slideshows${qs}`, apiKey, {}, {
    stage: 'get_comet_slideshows',
    localMeta: { id, query }
  });
}

async function getCometAds(apiKey, id, query = {}) {
  const qs = buildQueryString({
    limit: toInt(query.limit, 50),
    offset: toInt(query.offset, 0),
    order_by: normalizeString(query.order_by),
    order_direction: normalizeString(query.order_direction)
  });
  return virloRequest(`/comet/${id}/ads${qs}`, apiKey, {}, {
    stage: 'get_comet_ads',
    localMeta: { id, query }
  });
}

async function getCometSounds(apiKey, id, query = {}) {
  const qs = buildQueryString({
    limit: toInt(query.limit, 20),
    page: toInt(query.page, 1)
  });
  return virloRequest(`/comet/${id}/sounds${qs}`, apiKey, {}, {
    stage: 'get_comet_sounds',
    localMeta: { id, query }
  });
}

async function getCometCreatorOutliers(apiKey, id, query = {}) {
  const qs = buildQueryString({
    limit: toInt(query.limit, 20),
    page: toInt(query.page, 1),
    order_by: normalizeString(query.order_by),
    sort: normalizeString(query.sort)
  });
  return virloRequest(`/comet/${id}/creators/outliers${qs}`, apiKey, {}, {
    stage: 'get_comet_creator_outliers',
    localMeta: { id, query }
  });
}

async function getCometAnalysisLatest(apiKey, id) {
  return virloRequest(`/comet/${id}/analysis/latest`, apiKey, {}, {
    stage: 'get_comet_analysis_latest',
    localMeta: { id }
  });
}

async function queryCometAnalysis(apiKey, id, query = {}) {
  const qs = buildQueryString({
    limit: toInt(query.limit, 20),
    page: toInt(query.page, 1)
  });
  return virloRequest(`/comet/${id}/analysis${qs}`, apiKey, {}, {
    stage: 'query_comet_analysis',
    localMeta: { id, query }
  });
}

async function getCometTrendsLatest(apiKey, id) {
  return virloRequest(`/comet/${id}/trends/latest`, apiKey, {}, {
    stage: 'get_comet_trends_latest',
    localMeta: { id }
  });
}

async function queryCometTrends(apiKey, id, query = {}) {
  const qs = buildQueryString({
    limit: toInt(query.limit, 20),
    page: toInt(query.page, 1),
    stable_key: normalizeString(query.stable_key)
  });
  return virloRequest(`/comet/${id}/trends${qs}`, apiKey, {}, {
    stage: 'query_comet_trends',
    localMeta: { id, query }
  });
}

function normalizeCometPayload(input = {}, { partial = false } = {}) {
  const payload = {};
  const name = normalizeString(input.name);
  const description = normalizeString(input.description);
  const keywords = normalizeListRaw(input.keywords);
  const excludeKeywords = normalizeListRaw(input.excludeKeywords || input.exclude_keywords);
  const platforms = normalizeList(input.platforms);
  const cadence = normalizeString(input.cadence);
  const timeRange = normalizeString(input.timeRange || input.time_range);
  const minViews = toInt(input.minViews ?? input.min_views, null);

  if (name) payload.name = name;
  if (description) payload.description = description;
  if (keywords.length > 0) payload.keywords = keywords;
  if (excludeKeywords.length > 0) payload.exclude_keywords = excludeKeywords;
  if (platforms.length > 0) payload.platforms = platforms;
  if (cadence) payload.cadence = cadence;
  if (timeRange) payload.time_range = timeRange;
  if (minViews !== null) payload.min_views = minViews;

  if (input.isActive !== undefined) payload.is_active = Boolean(input.isActive);
  if (input.metaAdsEnabled !== undefined) payload.meta_ads_enabled = Boolean(input.metaAdsEnabled);
  if (input.excludeKeywordsStrict !== undefined) payload.exclude_keywords_strict = Boolean(input.excludeKeywordsStrict);

  if (!partial) {
    if (!payload.name) payload.name = `custom_niche_${Date.now()}`;
    if (!payload.keywords) payload.keywords = ['movie recap'];
    if (!payload.platforms) payload.platforms = ['youtube', 'tiktok', 'instagram'];
    if (payload.min_views === undefined) payload.min_views = 50000;
    if (!payload.time_range) payload.time_range = 'this_month';
    if (!payload.cadence) payload.cadence = 'daily';
    if (payload.is_active === undefined) payload.is_active = true;
  }

  return payload;
}

async function createComet(apiKey, payload = {}) {
  const virloPayload = normalizeCometPayload(payload, { partial: false });
  return virloRequest('/comet', apiKey, {
    method: 'POST',
    body: JSON.stringify(virloPayload)
  }, {
    stage: 'create_comet',
    virloPayload,
    localMeta: {
      requestedBy: 'phase1_custom_niche',
      sourcePresetId: normalizeString(payload.source_preset_id || payload.presetId)
    }
  });
}

async function updateComet(apiKey, id, payload = {}) {
  const virloPayload = normalizeCometPayload(payload, { partial: true });
  return virloRequest(`/comet/${id}`, apiKey, {
    method: 'PUT',
    body: JSON.stringify(virloPayload)
  }, {
    stage: 'update_comet',
    virloPayload,
    localMeta: { id }
  });
}

async function deleteComet(apiKey, id) {
  return virloRequest(`/comet/${id}`, apiKey, {
    method: 'DELETE'
  }, {
    stage: 'delete_comet',
    localMeta: { id }
  });
}

async function listTrackingCreators(apiKey, query = {}) {
  const qs = buildQueryString({
    page: toInt(query.page, 1),
    limit: toInt(query.limit, 20),
    platform: normalizeString(query.platform),
    search: normalizeString(query.search)
  });
  return virloRequest(`/tracking/creators${qs}`, apiKey, {}, { stage: 'list_tracking_creators', localMeta: { query } });
}

async function listTrackingVideos(apiKey, query = {}) {
  const qs = buildQueryString({
    page: toInt(query.page, 1),
    limit: toInt(query.limit, 20),
    platform: normalizeString(query.platform),
    search: normalizeString(query.search)
  });
  return virloRequest(`/tracking/videos${qs}`, apiKey, {}, { stage: 'list_tracking_videos', localMeta: { query } });
}

async function trackCreator(apiKey, payload = {}) {
  const body = {
    platform: normalizeString(payload.platform).toLowerCase(),
    url: normalizeString(payload.url),
    handle: normalizeString(payload.handle),
    scrape_cadence: normalizeString(payload.scrape_cadence || payload.scrapeCadence),
    collection_depth: normalizeString(payload.collection_depth || payload.collectionDepth)
  };
  return virloRequest('/tracking/creators', apiKey, {
    method: 'POST',
    body: JSON.stringify(body)
  }, { stage: 'track_creator', virloPayload: body });
}

async function getTrackedCreator(apiKey, id) {
  return virloRequest(`/tracking/creators/${id}`, apiKey, {}, { stage: 'get_tracked_creator', localMeta: { id } });
}

async function updateTrackedCreator(apiKey, id, payload = {}) {
  const body = {};
  if (payload.scrape_cadence || payload.scrapeCadence) {
    body.scrape_cadence = normalizeString(payload.scrape_cadence || payload.scrapeCadence);
  }
  if (payload.status) body.status = normalizeString(payload.status);
  return virloRequest(`/tracking/creators/${id}`, apiKey, {
    method: 'PATCH',
    body: JSON.stringify(body)
  }, { stage: 'update_tracked_creator', virloPayload: body, localMeta: { id } });
}

async function stopTrackingCreator(apiKey, id) {
  return virloRequest(`/tracking/creators/${id}`, apiKey, { method: 'DELETE' }, { stage: 'stop_tracking_creator', localMeta: { id } });
}

async function getCreatorReport(apiKey, id) {
  return virloRequest(`/tracking/creators/${id}/report`, apiKey, {}, { stage: 'get_creator_report', localMeta: { id } });
}

async function getCreatorSnapshots(apiKey, id, query = {}) {
  const qs = buildQueryString({
    page: toInt(query.page, 1),
    limit: toInt(query.limit, 20)
  });
  return virloRequest(`/tracking/creators/${id}/snapshots${qs}`, apiKey, {}, { stage: 'get_creator_snapshots', localMeta: { id, query } });
}

async function trackVideo(apiKey, payload = {}) {
  const body = {
    platform: normalizeString(payload.platform).toLowerCase(),
    url: normalizeString(payload.url),
    external_id: normalizeString(payload.external_id || payload.externalId),
    scrape_cadence: normalizeString(payload.scrape_cadence || payload.scrapeCadence)
  };
  return virloRequest('/tracking/videos', apiKey, {
    method: 'POST',
    body: JSON.stringify(body)
  }, { stage: 'track_video', virloPayload: body });
}

async function getTrackedVideo(apiKey, id) {
  return virloRequest(`/tracking/videos/${id}`, apiKey, {}, { stage: 'get_tracked_video', localMeta: { id } });
}

async function updateTrackedVideo(apiKey, id, payload = {}) {
  const body = {};
  if (payload.scrape_cadence || payload.scrapeCadence) {
    body.scrape_cadence = normalizeString(payload.scrape_cadence || payload.scrapeCadence);
  }
  if (payload.status) body.status = normalizeString(payload.status);
  return virloRequest(`/tracking/videos/${id}`, apiKey, {
    method: 'PATCH',
    body: JSON.stringify(body)
  }, { stage: 'update_tracked_video', virloPayload: body, localMeta: { id } });
}

async function stopTrackingVideo(apiKey, id) {
  return virloRequest(`/tracking/videos/${id}`, apiKey, { method: 'DELETE' }, { stage: 'stop_tracking_video', localMeta: { id } });
}

async function getVideoReport(apiKey, id) {
  return virloRequest(`/tracking/videos/${id}/report`, apiKey, {}, { stage: 'get_video_report', localMeta: { id } });
}

async function getVideoSnapshots(apiKey, id, query = {}) {
  const qs = buildQueryString({
    page: toInt(query.page, 1),
    limit: toInt(query.limit, 20)
  });
  return virloRequest(`/tracking/videos/${id}/snapshots${qs}`, apiKey, {}, { stage: 'get_video_snapshots', localMeta: { id, query } });
}

module.exports = {
  createOrbit,
  getOrbit,
  getOrbitVideos,
  listOrbits,
  getOrbitById,
  getOrbitTrendsLatest,
  getOrbitCreatorOutliers,
  getOrbitSounds,
  getGlobalTrends,
  getTrendingHashtags,
  getTrendingSounds,
  getVideosDigest,
  getPlatformVideosDigest,
  getNiches,
  getNicheTrends,
  listComets,
  getCometById,
  getCometVideos,
  getCometSlideshows,
  getCometAds,
  getCometSounds,
  getCometCreatorOutliers,
  getCometAnalysisLatest,
  queryCometAnalysis,
  getCometTrendsLatest,
  queryCometTrends,
  createComet,
  updateComet,
  deleteComet,
  listTrackingCreators,
  listTrackingVideos,
  trackCreator,
  getTrackedCreator,
  updateTrackedCreator,
  stopTrackingCreator,
  getCreatorReport,
  getCreatorSnapshots,
  trackVideo,
  getTrackedVideo,
  updateTrackedVideo,
  stopTrackingVideo,
  getVideoReport,
  getVideoSnapshots,
  virloRequest,
  createFingerprint,
  getCachedOrbitForPayload,
  findOrbitCacheByOrbitId
};

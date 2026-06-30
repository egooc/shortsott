export const PLATFORM_LABEL = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram'
};

const VIDEO_PATHS = [
  'videos',
  'data.videos',
  'results',
  'data.results',
  'items',
  'data.items',
  'data',
  'raw.videos',
  'raw.data.videos',
  'raw.results',
  'raw.items',
  'orbit.videos',
  'comet.videos',
  'data.data.videos',
  'data.data.items',
  'data.data.results'
];

const COMET_LIST_PATHS = [
  'data.configurations',
  'data.data.configurations',
  'configurations',
  'data.items',
  'items',
  'data.comets',
  'comets',
  'data'
];

function byPath(obj, path) {
  if (!obj || !path) return undefined;
  return String(path).split('.').reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);
}

export function pickFirst(obj, keys, fallback = '') {
  for (const key of keys) {
    const value = key.includes('.') ? byPath(obj, key) : obj?.[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return value;
  }
  return fallback;
}

export function safeText(value) {
  return String(value || '').trim();
}

export function safeNum(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^0-9.-]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function compactNumber(value) {
  const n = safeNum(value);
  if (!n) return '0';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function prettyDate(value) {
  const text = safeText(value);
  if (!text) return '-';
  const ms = new Date(text).getTime();
  if (!Number.isFinite(ms)) return text;
  return new Date(ms).toLocaleDateString('ko-KR');
}

export function parseKeywordList(value) {
  if (!value) return [];
  return [...new Set(
    String(value)
      .split(/[\n,]+/)
      .map((item) => safeText(item))
      .filter(Boolean)
  )];
}

export function normalizeHashtags(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return safeText(item);
        if (item && typeof item === 'object') return safeText(pickFirst(item, ['name', 'tag', 'value'], ''));
        return '';
      })
      .filter(Boolean)
      .map((x) => (x.startsWith('#') ? x : `#${x}`));
  }
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((item) => safeText(item))
      .filter(Boolean)
      .map((x) => (x.startsWith('#') ? x : `#${x}`));
  }
  return [];
}

export function normalizeVideoResult(raw, idx, sourceMeta = {}) {
  const author = raw?.author && typeof raw.author === 'object' ? raw.author : {};
  const creatorObj = raw?.creator && typeof raw.creator === 'object' ? raw.creator : {};

  const handleRaw = safeText(pickFirst(raw, ['handle', 'author.username', 'author.handle', 'creator.username', 'creator.handle', 'username', 'user.unique_id'], ''));
  const handle = handleRaw && !handleRaw.startsWith('@') ? `@${handleRaw}` : handleRaw;

  const item = {
    id: safeText(pickFirst(raw, ['id', 'video_id', 'uuid', 'post_id'], `video_${idx}`)),
    platform: safeText(pickFirst(raw, ['platform', 'source', 'channel', 'network', 'type'], '')).toLowerCase(),
    title: safeText(pickFirst(raw, ['title', 'name', 'headline', 'caption', 'description'], '')),
    description: safeText(pickFirst(raw, ['description', 'caption', 'summary', 'text', 'title'], '')),
    creator: safeText(pickFirst(raw, ['creator', 'creator_name', 'author.name', 'author.display_name', 'creator.name', 'user.nickname', 'channel_title'], '')),
    handle,
    creatorId: safeText(pickFirst(raw, ['author.id', 'creator.id', 'creator_id', 'user.id'], '')),
    followers: safeNum(pickFirst(raw, ['followers', 'author.followers', 'creator.followers', 'follower_count', 'subscriber_count'], 0)),
    views: safeNum(pickFirst(raw, ['views', 'view_count', 'play_count', 'stats.views', 'metrics.views'], 0)),
    likes: safeNum(pickFirst(raw, ['likes', 'like_count', 'digg_count', 'stats.likes', 'metrics.likes'], 0)),
    comments: safeNum(pickFirst(raw, ['comments', 'comment_count', 'stats.comments', 'metrics.comments'], 0)),
    shares: safeNum(pickFirst(raw, ['shares', 'share_count', 'stats.shares', 'metrics.shares'], 0)),
    engagementRate: safeNum(pickFirst(raw, ['engagement_rate', 'engagementRate', 'stats.engagement_rate'], 0)),
    viralityScore: safeNum(pickFirst(raw, ['virality_score', 'viralityScore', 'score', 'viral_score', 'stats.virality_score'], 0)),
    thumbnail: safeText(pickFirst(raw, ['thumbnail', 'thumbnail_url', 'cover_url', 'image', 'image_url', 'media.thumbnail', 'video.thumbnail'], '')),
    url: safeText(pickFirst(raw, ['url', 'video_url', 'permalink', 'share_url', 'link', 'source_url'], '')),
    publishedAt: safeText(pickFirst(raw, ['publish_date', 'published_at', 'publishedAt', 'created_at', 'upload_date', 'date', 'timestamp'], '')),
    hashtags: normalizeHashtags(pickFirst(raw, ['hashtags', 'tags', 'metadata.hashtags'], [])),
    whyThisWorks: safeText(pickFirst(raw, ['why_this_works', 'whyThisWorks', 'analysis', 'insight', 'reason'], '')),
    hookSummary: safeText(pickFirst(raw, ['hook_summary', 'hookSummary', 'hook', 'summary'], '')),
    sound: safeText(pickFirst(raw, ['sound', 'sound_name', 'music_name'], '')),
    sourceQuery: safeText(sourceMeta.sourceQuery || ''),
    sourcePresetId: safeText(sourceMeta.presetId || ''),
    sourcePresetName: safeText(sourceMeta.presetName || ''),
    sourceKeywords: Array.isArray(sourceMeta.keywords) ? sourceMeta.keywords : [],
    sourceExcludeKeywords: Array.isArray(sourceMeta.excludeKeywords) ? sourceMeta.excludeKeywords : [],
    raw
  };

  if (!item.creator) item.creator = safeText(pickFirst(author, ['name', 'display_name', 'username', 'handle'], ''));
  if (!item.handle) {
    const h = safeText(pickFirst(author, ['username', 'handle'], '') || pickFirst(creatorObj, ['username', 'handle'], ''));
    item.handle = h && !h.startsWith('@') ? `@${h}` : h;
  }

  return item;
}

export function extractVideosWithDebug(payload) {
  const candidates = [];

  for (const path of VIDEO_PATHS) {
    const value = byPath(payload, path);
    if (!Array.isArray(value)) continue;
    const score = value.reduce((acc, row) => {
      if (!row || typeof row !== 'object') return acc;
      const hint = pickFirst(row, ['video_url', 'url', 'permalink', 'share_url', 'thumbnail', 'thumbnail_url', 'author.name', 'author.username', 'views', 'view_count'], '');
      return acc + (hint ? 1 : 0);
    }, 0);
    candidates.push({ path, count: value.length, score, list: value });
  }

  const best = candidates
    .filter((x) => x.count > 0)
    .sort((a, b) => (b.score - a.score) || (b.count - a.count))[0];

  if (!best) {
    return {
      videos: [],
      selectedPath: null,
      selectedCount: 0,
      candidates: candidates.map((c) => ({ path: c.path, count: c.count, score: c.score }))
    };
  }

  return {
    videos: best.list,
    selectedPath: best.path,
    selectedCount: best.count,
    candidates: candidates.map((c) => ({ path: c.path, count: c.count, score: c.score }))
  };
}

export function normalizeCometList(payload) {
  const rows = COMET_LIST_PATHS
    .map((path) => byPath(payload, path))
    .find((value) => Array.isArray(value));

  if (!Array.isArray(rows)) return [];

  return rows
    .map((row, idx) => {
      const keywords = (() => {
        const value = pickFirst(row, ['keywords', 'query_terms', 'query_keywords', 'filters.keywords'], []);
        if (Array.isArray(value)) return value.map((k) => safeText(k)).filter(Boolean);
        if (typeof value === 'string') return parseKeywordList(value);
        return [];
      })();

      const platforms = (() => {
        const value = pickFirst(row, ['platforms', 'filters.platforms'], []);
        if (Array.isArray(value)) return value.map((p) => safeText(p).toLowerCase()).filter(Boolean);
        if (typeof value === 'string') return parseKeywordList(value).map((p) => p.toLowerCase());
        return [];
      })();

      return {
        id: safeText(pickFirst(row, ['id', 'comet_id', 'uuid'], `${idx}`)),
        name: safeText(pickFirst(row, ['name', 'title', 'label'], 'Untitled Comet')),
        status: safeText(pickFirst(row, ['status', 'state'], 'unknown')),
        keywords,
        platforms,
        updatedAt: safeText(pickFirst(row, ['updated_at', 'last_run', 'last_updated', 'created_at'], '')),
        lastRun: safeText(pickFirst(row, ['last_run', 'updated_at', 'last_updated'], '')),
        videosCount: safeNum(pickFirst(row, ['videos_count', 'video_count', 'stats.video_count', 'stats.total_videos'], 0)),
        totalViews: safeNum(pickFirst(row, ['total_views', 'stats.total_views'], 0)),
        raw: row
      };
    })
    .filter((item) => item.id);
}

export function normalizeOutlierCreators(payload) {
  const rows = [
    byPath(payload, 'data.outliers'),
    byPath(payload, 'outliers'),
    byPath(payload, 'data.items'),
    byPath(payload, 'items'),
    byPath(payload, 'data')
  ].find((value) => Array.isArray(value));

  if (!Array.isArray(rows)) return [];

  return rows
    .map((item, idx) => ({
      id: safeText(pickFirst(item, ['id', 'creator_url', 'handle'], `${idx}`)),
      creator: safeText(pickFirst(item, ['creator_name', 'creator', 'name', 'handle'], 'Unknown Creator')),
      handle: safeText(pickFirst(item, ['handle', 'creator_handle'], '')),
      followers: safeNum(pickFirst(item, ['followers', 'follower_count'], 0)),
      avgViews: safeNum(pickFirst(item, ['avg_views', 'average_views'], 0)),
      score: safeNum(pickFirst(item, ['weighted_score', 'score', 'outlier_ratio'], 0)),
      topics: normalizeHashtags(pickFirst(item, ['creator_topics', 'topics'], []))
    }))
    .slice(0, 20);
}

export function normalizeSounds(payload) {
  const rows = [
    byPath(payload, 'data.sounds'),
    byPath(payload, 'sounds'),
    byPath(payload, 'data.items'),
    byPath(payload, 'items'),
    byPath(payload, 'data')
  ].find((value) => Array.isArray(value));

  if (!Array.isArray(rows)) return [];

  return rows
    .map((item, idx) => ({
      id: safeText(pickFirst(item, ['id', 'sound_id'], `${idx}`)),
      title: safeText(pickFirst(item, ['title', 'name', 'sound_name'], 'Untitled Sound')),
      platform: safeText(pickFirst(item, ['platform'], '')),
      usage: safeNum(pickFirst(item, ['usage_count', 'video_count', 'videos'], 0))
    }))
    .slice(0, 20);
}

export function buildCandidatePayload(video) {
  return {
    id: video.id,
    platform: video.platform,
    title: video.title,
    description: video.description,
    creator: video.creator,
    handle: video.handle,
    creatorId: video.creatorId,
    url: video.url,
    thumbnail: video.thumbnail,
    views: video.views,
    likes: video.likes,
    comments: video.comments,
    shares: video.shares,
    followers: video.followers,
    viralityScore: video.viralityScore,
    hashtags: video.hashtags,
    whyThisWorks: video.whyThisWorks,
    hookSummary: video.hookSummary,
    source_preset_id: video.sourcePresetId,
    source_preset_name: video.sourcePresetName,
    source_keywords: video.sourceKeywords,
    source_exclude_keywords: video.sourceExcludeKeywords,
    source_query: video.sourceQuery,
    raw_summary: {
      id: video.raw?.id,
      platform: video.raw?.platform,
      url: video.raw?.url || video.raw?.video_url,
      publish_date: video.raw?.publish_date || video.raw?.published_at,
      author: video.raw?.author,
      duration_sec: video.durationSec,
      views_per_hour: video.viewsPerHour
    }
  };
}

export function makeSummary(videos, extra = {}) {
  const totalViews = videos.reduce((sum, item) => sum + safeNum(item.views), 0);
  const creators = new Set(videos.map((v) => safeText(v.creator)).filter(Boolean));
  const hashtags = new Set(videos.flatMap((v) => v.hashtags || []).filter(Boolean));
  const platforms = new Set(videos.map((v) => safeText(v.platform)).filter(Boolean));

  return {
    totalVideos: videos.length,
    totalViews,
    averageViews: videos.length ? Math.round(totalViews / videos.length) : 0,
    creatorsCount: creators.size,
    hashtagsCount: hashtags.size,
    platforms: [...platforms],
    ...extra
  };
}

export function extractOrbitId(payload) {
  return safeText(pickFirst(payload, [
    'orbitId',
    'orbit_id',
    'id',
    'jobId',
    'job_id',
    'data.id',
    'data.orbitId',
    'data.orbit_id',
    'raw.id',
    'raw.orbitId',
    'raw.orbit_id',
    'raw.data.id',
    'raw.data.orbitId',
    'raw.data.orbit_id'
  ], ''));
}

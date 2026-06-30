const { createHttpError } = require('./errorService');
const { classifySourceVideo, normalizeSourceMode } = require('../utils/sourceClassifier');

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

function normalizeHashtag(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.startsWith('#') ? text : `#${text}`;
}

function parseIsoDurationToSeconds(value = '') {
  const match = String(value || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return (hours * 3600) + (minutes * 60) + seconds;
}

function toIsoDateFromDays(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function toIsoDateFromMonths(months) {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString();
}

function getPublishWindow(period = 'older_6m') {
  const map = {
    '24h': 1,
    '3d': 3,
    '7d': 7,
    '14d': 14,
    '30d': 30
  };
  const key = String(period || '').trim();
  if (map[key]) return { publishedAfter: toIsoDateFromDays(map[key]), publishedBefore: '' };
  if (key === 'older_3m') return { publishedAfter: '', publishedBefore: toIsoDateFromMonths(3) };
  if (key === 'older_6m') return { publishedAfter: '', publishedBefore: toIsoDateFromMonths(6) };
  if (key === 'older_1y') return { publishedAfter: '', publishedBefore: toIsoDateFromMonths(12) };
  if (key === 'older_2y') return { publishedAfter: '', publishedBefore: toIsoDateFromMonths(24) };
  if (key === 'all') return { publishedAfter: '', publishedBefore: '' };
  return { publishedAfter: toIsoDateFromDays(7), publishedBefore: '' };
}

function compactQuery(params) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  });
  return query;
}

async function youtubeGet(path, params, apiKey) {
  const url = `${YOUTUBE_API_BASE}${path}?${compactQuery({ ...params, key: apiKey }).toString()}`;
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createHttpError(response.status, 'YOUTUBE_API_ERROR', data?.error?.message || 'YouTube API request failed', {
      endpoint: path,
      status: response.status,
      response: data
    });
  }
  return data;
}

function inferThumbnailOrientation(thumbnails = {}) {
  const candidates = [thumbnails.maxres, thumbnails.high, thumbnails.medium, thumbnails.standard, thumbnails.default]
    .filter(Boolean);
  const first = candidates.find((entry) => Number(entry.width) > 0 && Number(entry.height) > 0);
  return first || {};
}

function normalizeVideo(item, hashtag, sourceMode = 'shortform') {
  const snippet = item.snippet || {};
  const stats = item.statistics || {};
  const thumbnails = snippet.thumbnails || {};
  const durationSec = parseIsoDurationToSeconds(item.contentDetails?.duration);
  const thumbnailShape = inferThumbnailOrientation(thumbnails);
  const classification = classifySourceVideo({
    durationSec,
    width: thumbnailShape.width || 0,
    height: thumbnailShape.height || 0,
    requestedMode: sourceMode,
    origin: 'phase1_search'
  });
  const viewCount = Number(stats.viewCount || 0);
  const likeCount = Number(stats.likeCount || 0);
  const commentCount = Number(stats.commentCount || 0);
  const publishedAt = snippet.publishedAt || '';
  const ageHours = publishedAt ? Math.max(1, (Date.now() - new Date(publishedAt).getTime()) / 36e5) : 1;
  const viewsPerHour = viewCount / ageHours;
  const id = item.id;

  return {
    id,
    platform: 'youtube',
    title: snippet.title || '',
    description: snippet.description || '',
    creator: snippet.channelTitle || '',
    handle: '',
    creatorId: snippet.channelId || '',
    followers: 0,
    views: viewCount,
    likes: likeCount,
    comments: commentCount,
    shares: 0,
    engagementRate: viewCount > 0 ? ((likeCount + commentCount) / viewCount) : 0,
    viralityScore: Math.round(viewsPerHour),
    thumbnail: thumbnails.maxres?.url || thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url || '',
    url: classification.source_type === 'shortform'
      ? `https://www.youtube.com/shorts/${id}`
      : `https://www.youtube.com/watch?v=${id}`,
    watchUrl: `https://www.youtube.com/watch?v=${id}`,
    publishedAt,
    hashtags: [normalizeHashtag(hashtag)].filter(Boolean),
    sound: '',
    whyThisWorks: `Views/hour estimate: ${Math.round(viewsPerHour).toLocaleString()}`,
    hookSummary: '',
    durationSec,
    sourceMode,
    sourceTypeGuess: classification.source_type,
    sourceWorkflowMode: classification.source_workflow_mode,
    sourceClassification: classification.source_classification,
    viewsPerHour,
    source_query: `youtube_scout:${normalizeHashtag(hashtag)}`,
    raw: item
  };
}

function sortVideos(videos, sort = 'views') {
  const rows = [...videos];
  if (sort === 'date') {
    rows.sort((a, b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime());
  } else if (sort === 'views_per_hour') {
    rows.sort((a, b) => Number(b.viewsPerHour || 0) - Number(a.viewsPerHour || 0));
  } else {
    rows.sort((a, b) => Number(b.views || 0) - Number(a.views || 0));
  }
  return rows;
}

async function scoutYoutubeShorts({
  apiKey,
  hashtag,
  period = '7d',
  sort = 'views',
  minViews = 0,
  maxViews = 0,
  limit = 50,
  sourceMode = 'shortform'
}) {
  if (!apiKey) {
    throw createHttpError(400, 'YOUTUBE_API_KEY_REQUIRED', 'YOUTUBE_API_KEY is required');
  }
  const tag = normalizeHashtag(hashtag);
  if (!tag) {
    throw createHttpError(400, 'YOUTUBE_HASHTAG_REQUIRED', 'hashtag is required');
  }

  const requestedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const mode = normalizeSourceMode(sourceMode);
  const searchOrder = sort === 'date' ? 'date' : 'viewCount';
  const { publishedAfter, publishedBefore } = getPublishWindow(period);
  const collectedIds = [];
  const maxPages = 5;
  const targetCollection = Math.min(250, Math.max(requestedLimit * 20, 100));
  const durationBuckets = mode === 'longform'
    ? ['medium', 'long']
    : mode === 'shortform'
      ? ['short']
      : ['any'];

  for (const bucket of durationBuckets) {
    let pageToken = '';
    for (let page = 0; page < maxPages && collectedIds.length < targetCollection; page += 1) {
      const search = await youtubeGet('/search', {
        part: 'snippet',
        q: tag,
        type: 'video',
        videoDuration: bucket === 'any' ? '' : bucket,
        order: searchOrder,
        publishedAfter,
        publishedBefore,
        maxResults: 50,
        pageToken
      }, apiKey);
      for (const item of search.items || []) {
        const videoId = item.id?.videoId;
        if (videoId && !collectedIds.includes(videoId)) collectedIds.push(videoId);
      }
      pageToken = search.nextPageToken || '';
      if (!pageToken) break;
    }
    if (collectedIds.length >= targetCollection) break;
  }

  const details = [];
  for (let i = 0; i < collectedIds.length; i += 50) {
    const ids = collectedIds.slice(i, i + 50);
    if (!ids.length) continue;
    const data = await youtubeGet('/videos', {
      part: 'snippet,statistics,contentDetails',
      id: ids.join(','),
      maxResults: 50
    }, apiKey);
    details.push(...(data.items || []));
  }

  const videos = sortVideos(
    details
      .map((item) => normalizeVideo(item, tag, mode))
      .filter((video) => {
        if (video.durationSec <= 0) return false;
        if (mode === 'shortform') return video.durationSec < 60;
        if (mode === 'longform') return video.durationSec >= 90;
        return true;
      })
      .filter((video) => Number(video.views || 0) >= Number(minViews || 0))
      .filter((video) => !Number(maxViews || 0) || Number(video.views || 0) <= Number(maxViews || 0)),
    sort
  ).slice(0, requestedLimit);

  return {
    status: 'success',
    source: 'youtube_data_api',
    hashtag: tag,
    period,
    sort,
    minViews: Number(minViews || 0),
    maxViews: Number(maxViews || 0),
    sourceMode: mode,
    publishedAfter,
    publishedBefore,
    searchedVideoIds: collectedIds.length,
    videosCount: videos.length,
    videos
  };
}

module.exports = {
  parseIsoDurationToSeconds,
  scoutYoutubeShorts
};

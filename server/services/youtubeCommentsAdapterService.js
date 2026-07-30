const { extractYouTubeVideoId } = require('./youtubeUrlUtils');

const COMMENT_PAGE_SIZE = 50;
const DEFAULT_COMMENT_TIMEOUT_MS = 20_000;

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function apiKeyFromOptions(options = {}) {
  return normalizeText(options.apiKey || process.env.YOUTUBE_DATA_API_KEY || process.env.YOUTUBE_API_KEY);
}

function unavailable(reason, details = {}) {
  return {
    status: 'unavailable',
    top_comments: [],
    recent_comments: [],
    reaction_summary: buildReactionSummary([], []),
    evidence_coverage: false,
    unavailable_reason: reason,
    details
  };
}

function normalizeComment(item) {
  const snippet = item?.snippet?.topLevelComment?.snippet || item?.snippet || {};
  return {
    comment_id: normalizeText(item?.id || item?.snippet?.topLevelComment?.id || ''),
    author: normalizeText(snippet.authorDisplayName),
    text: normalizeText(snippet.textOriginal || snippet.textDisplay),
    like_count: Number(snippet.likeCount || 0),
    published_at: normalizeText(snippet.publishedAt),
    updated_at: normalizeText(snippet.updatedAt)
  };
}

async function fetchCommentOrder(videoId, order, apiKey, options = {}) {
  const params = new URLSearchParams({
    part: 'snippet',
    videoId,
    order,
    maxResults: String(options.maxResults || COMMENT_PAGE_SIZE),
    textFormat: 'plainText',
    key: apiKey
  });
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || options.commentsTimeoutMs || DEFAULT_COMMENT_TIMEOUT_MS) || DEFAULT_COMMENT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetch(`https://www.googleapis.com/youtube/v3/commentThreads?${params.toString()}`, { signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || `http_${response.status}`;
      const error = new Error(`YouTube comments ${order} request failed: ${reason}`);
      error.status = response.status;
      error.reason = reason;
      error.details = data;
      throw error;
    }
    return (Array.isArray(data.items) ? data.items : []).map(normalizeComment).filter((comment) => comment.text);
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`YouTube comments ${order} request timed out after ${timeoutMs}ms`);
      timeoutError.reason = 'comments_request_timeout';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function tokenCounts(comments) {
  const stop = new Set(['the', 'and', 'that', 'this', 'with', 'you', 'they', 'was', 'are', 'for', 'but', 'just', '영상', '진짜', '너무', '그리고', '이거', '그냥']);
  const counts = new Map();
  for (const comment of comments) {
    const tokens = normalizeText(comment.text).toLowerCase().match(/[a-z0-9가-힣]{2,}/g) || [];
    for (const token of tokens) {
      if (stop.has(token)) continue;
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function phraseHits(comments, regexes) {
  return comments
    .map((comment) => normalizeText(comment.text))
    .filter((text) => regexes.some((regex) => regex.test(text)))
    .slice(0, 12);
}

function buildReactionSummary(topComments = [], recentComments = []) {
  const combined = [...topComments, ...recentComments];
  const keywords = tokenCounts(combined).slice(0, 12).map(([keyword, count]) => ({ keyword, count }));
  return {
    repeated_keywords: keywords,
    repeated_emotions: phraseHits(combined, [/cry|sad|scared|angry|goosebumps|소름|눈물|슬프|무섭|화나|충격/i]),
    scene_mentions: phraseHits(combined, [/scene|part|moment|line|장면|대사|부분|순간/i]),
    misunderstandings: phraseHits(combined, [/confus|why|what happened|이해|왜|뭐야|무슨/i]),
    title_thumbnail_phrases: phraseHits(combined, [/title|thumbnail|제목|썸네일|click/i])
  };
}

async function collectYouTubeComments(sourceUrl, options = {}) {
  const videoId = extractYouTubeVideoId(sourceUrl);
  if (!videoId) return unavailable('video_id_unavailable', { sourceUrl });
  const apiKey = apiKeyFromOptions(options);
  if (!apiKey) return unavailable('youtube_api_key_missing');
  try {
    const [topComments, recentComments] = await Promise.all([
      fetchCommentOrder(videoId, 'relevance', apiKey, options),
      fetchCommentOrder(videoId, 'time', apiKey, options)
    ]);
    return {
      status: 'available',
      video_id: videoId,
      top_comments: topComments,
      recent_comments: recentComments,
      reaction_summary: buildReactionSummary(topComments, recentComments),
      evidence_coverage: true,
      unavailable_reason: ''
    };
  } catch (error) {
    return unavailable(error.reason || error.code || 'comments_request_failed', { status: error.status || 0, message: error.message });
  }
}

module.exports = {
  buildReactionSummary,
  collectYouTubeComments,
  extractYouTubeVideoId
};

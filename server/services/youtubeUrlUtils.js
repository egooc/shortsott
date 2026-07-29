function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractYouTubeVideoId(sourceUrl) {
  const text = normalizeText(sourceUrl);
  const match = text.match(/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/) || text.match(/^([A-Za-z0-9_-]{11})$/);
  return match ? match[1] : '';
}

function normalizeYouTubeWatchUrl(sourceUrl) {
  const videoId = extractYouTubeVideoId(sourceUrl);
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : normalizeText(sourceUrl);
}

module.exports = {
  extractYouTubeVideoId,
  normalizeYouTubeWatchUrl
};

require('dotenv').config({ path: 'D:/midform/.env' });
const KEY = process.env.YOUTUBE_API_KEY_SEARCH || process.env.YOUTUBE_API_KEY || process.env.YT_API_KEY;
const quota = require('./api_quota'); // 발굴 키 쿼터 장부(10-20) — 호출 전 기록·상한, 429/403 이면 그날 전 도구 중지
async function ytGet(url) {
  const ep = /youtube\/v3\/(\w+)/.exec(url)[1];
  quota.spend('discovery_search', ep);
  const res = await fetch(url);
  if (res.status === 429 || res.status === 403) {
    quota.markBlocked('_ja-find-channels', `${ep} ${res.status}`);
    throw new Error(`YouTube API ${res.status} — 오늘 발굴 키 중지(우회 금지)`);
  }
  return res.json();
}
const Q = ['テレビ東京 ドラマ','TBS ドラマ 公式','日テレドラマ','フジテレビ ドラマ','テレ朝 ドラマ',
           'ドラマ 公式 見逃し','カンテレ ドラマ','NHK ドラマ','ytv ドラマ','東海テレビ ドラマ'];
(async () => {
  const seen = new Map();
  for (const q of Q) {
    const r = await ytGet(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=10&q=${encodeURIComponent(q)}&key=${KEY}`);
    for (const it of r.items || []) {
      const id = it.snippet.channelId || it.id.channelId;
      if (!seen.has(id)) seen.set(id, it.snippet.channelTitle);
    }
  }
  const ids = [...seen.keys()];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await ytGet(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${ids.slice(i,i+50).join(',')}&key=${KEY}`);
    for (const c of r.items || []) {
      console.log(`${c.id}  ${String(c.statistics.videoCount).padStart(6)}편 ${String(c.statistics.subscriberCount).padStart(10)}명  ${c.snippet.title}`);
    }
  }
})().catch(e => console.log('ERR', e.message));

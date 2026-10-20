// SBS Catch 업로드를 깊게 훑어 «지역 무제한 + 10~40분» 만 추린다.
// 최근 업로드는 거의 allowed=KR 이라 일반 정찰로는 안 보인다 — 옛 업로드에 무제한이 몰려 있다.
require('dotenv').config({ path: 'D:/midform/.env' });
const KEY = process.env.YOUTUBE_API_KEY_SEARCH || process.env.YOUTUBE_API_KEY || process.env.YT_API_KEY;
const quota = require('./api_quota'); // 발굴 키 쿼터 장부(10-20) — 호출 전 기록·상한, 429/403 이면 그날 전 도구 중지
async function ytGet(url) {
  const ep = /youtube\/v3\/(\w+)/.exec(url)[1];
  quota.spend('discovery_search', ep);
  const res = await fetch(url);
  if (res.status === 429 || res.status === 403) {
    quota.markBlocked('_scan-unrestricted', `${ep} ${res.status}`);
    throw new Error(`YouTube API ${res.status} — 오늘 발굴 키 중지(우회 금지)`);
  }
  return res.json();
}
const CH = process.argv[2] || 'UC3re3ueOE_6VZK85zlEUWFA';
const PAGES = Number(process.argv[3] || 20);

const iso = (d) => {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d) || [];
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
};

(async () => {
  const ch = await ytGet(
    `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${CH}&key=${KEY}`);
  const up = ch.items[0].contentDetails.relatedPlaylists.uploads;
  let token = '', scanned = 0;
  const hits = [];
  for (let p = 0; p < PAGES; p += 1) {
    const pl = await ytGet(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${up}` +
      (token ? `&pageToken=${token}` : '') + `&key=${KEY}`);
    const ids = (pl.items || []).map((i) => i.contentDetails.videoId);
    if (!ids.length) break;
    scanned += ids.length;
    const v = await ytGet(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${ids.join(',')}&key=${KEY}`);
    for (const it of v.items || []) {
      const cd = it.contentDetails || {}, rr = cd.regionRestriction || {};
      const sec = iso(cd.duration || '');
      if (sec < 600 || sec > 2400) continue;
      if ((rr.blocked || []).length) continue;
      if ((rr.allowed || []).length) continue;        // ★allowed 가 걸리면 지역 한정이라 못 쓴다
      hits.push({
        id: it.id, sec, v: Number(it.statistics.viewCount || 0),
        at: it.snippet.publishedAt.slice(0, 10), t: it.snippet.title
      });
    }
    token = pl.nextPageToken;
    if (!token) break;
  }
  hits.sort((a, b) => b.v - a.v);
  console.log(`훑음 ${scanned}편 · 무제한+길이대 ${hits.length}편`);
  for (const h of hits.slice(0, 45)) {
    console.log(`${h.at} ${h.id} ${String(Math.round(h.sec / 60)).padStart(3)}분 ${String(h.v).padStart(8)}회  ${h.t.slice(0, 72)}`);
  }
})().catch((e) => console.log('ERR', e.message));

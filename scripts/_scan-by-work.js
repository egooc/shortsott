// 채널의 «지역 무제한 + 길이대» 영상을 훑어 **작품 해시태그별로 묶어서** 보여 준다.
//
//   node scripts/_scan-by-work.js <channelId> <pages>
//
// 왜 (2026-10-03): 소유주 지시 — 「넷플릭스에서 좀 지났어도 유행했던 게 사람들이 더 익숙하다」.
// 개별 영상 목록으로는 어느 «작품»이 몇 편이나 쓸 수 있는지가 안 보인다. 작품 단위로 세야
// 아는 제목부터 고를 수 있다.
require('dotenv').config({ path: 'D:/midform/.env' });
const KEY = process.env.YOUTUBE_API_KEY_SEARCH || process.env.YOUTUBE_API_KEY || process.env.YT_API_KEY;
const quota = require('./api_quota'); // 발굴 키 쿼터 장부(10-20) — 호출 전 기록·상한, 429/403 이면 그날 전 도구 중지
async function ytGet(url) {
  const ep = /youtube\/v3\/(\w+)/.exec(url)[1];
  quota.spend('discovery_search', ep);
  const res = await fetch(url);
  if (res.status === 429 || res.status === 403) {
    quota.markBlocked('_scan-by-work', `${ep} ${res.status}`);
    throw new Error(`YouTube API ${res.status} — 오늘 발굴 키 중지(우회 금지)`);
  }
  return res.json();
}
const CH = process.argv[2];
const PAGES = Number(process.argv[3] || 24);

const iso = (d) => {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d) || [];
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
};
// 예능·메이킹·OST 는 드라마 장면이 아니다
const SKIP = /메이킹|비하인드|미공개|런닝맨|RunningMan|OST|Playlist|캐치오락관|이모지|인터뷰|자기소개서|미우새|틈만나면|퀴즈|티저|예고/;

(async () => {
  const ch = await ytGet(
    `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${CH}&key=${KEY}`);
  const up = ch.items[0].contentDetails.relatedPlaylists.uploads;
  let token = '', scanned = 0;
  const byWork = new Map();
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
      if (sec < 540 || sec > 2400) continue;
      if ((rr.blocked || []).length || (rr.allowed || []).length) continue;
      const title = it.snippet.title;
      if (SKIP.test(title)) continue;
      // 제목의 해시태그 중 채널명이 아닌 첫 번째를 작품명으로 본다
      const tags = (title.match(/#[^\s#]+/g) || []).map((s) => s.slice(1))
        .filter((s) => !/SBSCatch|습끌올|shorts/i.test(s));
      const work = tags[0] || '(작품태그 없음)';
      if (!byWork.has(work)) byWork.set(work, []);
      byWork.get(work).push({
        id: it.id, sec, v: Number(it.statistics.viewCount || 0),
        at: it.snippet.publishedAt.slice(0, 10), t: title.replace(/#[^\s#]+/g, '').trim()
      });
    }
    token = pl.nextPageToken;
    if (!token) break;
  }
  const works = [...byWork.entries()]
    .map(([w, list]) => ({ w, n: list.length, sum: list.reduce((a, b) => a + b.v, 0), list }))
    .sort((a, b) => b.sum - a.sum);
  console.log(`훑음 ${scanned}편 · 드라마 장면(무제한) ${works.reduce((a, b) => a + b.n, 0)}편 · 작품 ${works.length}개\n`);
  for (const k of works) {
    console.log(`■ ${k.w}  —  ${k.n}편 · 합계 ${k.sum.toLocaleString()}회`);
    for (const h of k.list.sort((a, b) => b.v - a.v).slice(0, 6)) {
      console.log(`   ${h.at} ${h.id} ${String(Math.round(h.sec / 60)).padStart(2)}분 ${String(h.v).padStart(7)}회 ${h.t.slice(0, 58)}`);
    }
  }
})().catch((e) => console.log('ERR', e.message));

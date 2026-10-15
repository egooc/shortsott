// 린박스로 올린 편들의 현재 조회수를 작품별로 묶어 본다.
//
//   node scripts/_rinbox-views.js            // 전부
//   node scripts/_rinbox-views.js ja         // 로케일만
//
// 왜 (2026-10-03): 「어느 소재가 먹히는가」를 추측하지 말고 숫자로 보기 위해서다.
// rinbox_publish_state.json 의 url 에서 videoId 를 뽑아 YouTube API 로 조회수를 받는다.
// ★아직 공개 시각이 안 된 편(예약)은 조회수가 0 이다 — 공개된 편만 비교해야 뜻이 있다.
require('dotenv').config({ path: 'D:/midform/.env' });
const fs = require('fs');
const KEY = process.env.YOUTUBE_API_KEY_SEARCH || process.env.YOUTUBE_API_KEY || process.env.YT_API_KEY;
const WANT = (process.argv[2] || '').trim();

const STATE = 'D:/midform/server/data/rinbox_publish_state.json';
const CATALOG = 'D:/midform/midform/config/rinbox_catalog.json';

(async () => {
  const hist = (JSON.parse(fs.readFileSync(STATE, 'utf8')).history || [])
    .filter((e) => e.url && !e.retracted)
    .filter((e) => !WANT || e.locale === WANT);
  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8')).works || {};

  const byId = new Map();
  for (const e of hist) {
    const m = /[?&]v=([\w-]{11})/.exec(e.url);
    if (m) byId.set(m[1], e);
  }
  const ids = [...byId.keys()];
  const rows = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await (await fetch('https://www.googleapis.com/youtube/v3/videos'
      + `?part=snippet,statistics,status&id=${ids.slice(i, i + 50).join(',')}&key=${KEY}`)).json();
    for (const v of r.items || []) {
      const e = byId.get(v.id);
      rows.push({
        id: v.id,
        locale: e.locale,
        work: e.work,
        year: (catalog[e.work] || {}).year || '',
        at: (v.snippet.publishedAt || '').slice(0, 10),
        privacy: v.status.privacyStatus,
        views: Number(v.statistics.viewCount || 0),
        title: v.snippet.title.slice(0, 40)
      });
    }
  }
  rows.sort((a, b) => b.views - a.views);

  console.log('── 편별 (공개된 것만)');
  for (const r of rows.filter((x) => x.privacy === 'public')) {
    console.log(`${String(r.views).padStart(7)}회  ${r.locale}  ${r.at}  ${String(r.year).padStart(4)}  ${(r.work || '').padEnd(30)} ${r.title}`);
  }

  const agg = new Map();
  for (const r of rows.filter((x) => x.privacy === 'public')) {
    const k = `${r.locale}|${r.work}|${r.year}`;
    const a = agg.get(k) || { n: 0, sum: 0 };
    a.n += 1; a.sum += r.views; agg.set(k, a);
  }
  console.log('\n── 작품별 평균');
  [...agg.entries()].sort((x, y) => y[1].sum / y[1].n - x[1].sum / x[1].n)
    .forEach(([k, a]) => {
      const [loc, work, year] = k.split('|');
      console.log(`${String(Math.round(a.sum / a.n)).padStart(7)}회 평균  ${loc}  ${String(year).padStart(4)}  ${work}  (${a.n}편, 합계 ${a.sum})`);
    });
})().catch((e) => console.log('ERR', e.message));

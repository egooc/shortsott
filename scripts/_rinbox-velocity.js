// 공개 경과시간으로 보정한 조회 속도. 편마다 공개 시점이 달라 생조회수 비교는 오래된 쪽을 부풀린다.
//
//   node scripts/_rinbox-velocity.js [ja|ko]
require('dotenv').config({ path: 'D:/midform/.env' });
const fs = require('fs');
const KEY = process.env.YOUTUBE_API_KEY_SEARCH || process.env.YOUTUBE_API_KEY || process.env.YT_API_KEY;
const WANT = (process.argv[2] || '').trim();
const STATE = 'D:/midform/server/data/rinbox_publish_state.json';

(async () => {
  const hist = (JSON.parse(fs.readFileSync(STATE, 'utf8')).history || [])
    .filter((e) => e.url && !e.retracted).filter((e) => !WANT || e.locale === WANT);
  const byId = new Map();
  for (const e of hist) {
    const m = /[?&]v=([\w-]{11})/.exec(e.url);
    if (m) byId.set(m[1], e);
  }
  const ids = [...byId.keys()];
  const rows = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await (await fetch('https://www.googleapis.com/youtube/v3/videos'
      + `?part=snippet,statistics,contentDetails&id=${ids.slice(i, i + 50).join(',')}&key=${KEY}`)).json();
    for (const v of r.items || []) {
      const e = byId.get(v.id);
      const rr = (v.contentDetails || {}).regionRestriction || {};
      if ((rr.blocked || []).length > 150) continue;           // 차단된 편은 성과 판단에서 뺀다
      const hours = (Date.now() - Date.parse(v.snippet.publishedAt)) / 36e5;
      if (hours < 12) continue;                                 // 너무 어려서 비교 불가
      rows.push({ work: e.work, locale: e.locale, views: Number(v.statistics.viewCount || 0), hours,
        perDay: Number(v.statistics.viewCount || 0) / (hours / 24), title: v.snippet.title });
    }
  }
  rows.sort((a, b) => b.perDay - a.perDay);
  console.log('── 편별 (하루당 조회로 보정)');
  for (const r of rows) {
    console.log(`${String(Math.round(r.perDay)).padStart(7)}/일  ${String(r.views).padStart(6)}회  `
      + `${r.hours.toFixed(0).padStart(3)}시간  ${r.locale}  ${r.work.padEnd(30)} ${r.title.slice(0, 34)}`);
  }
  const g = new Map();
  for (const r of rows) {
    const k = r.locale + '  ' + r.work;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r.perDay);
  }
  console.log('\n── 작품별 (하루당 조회 중앙값 · 편수)');
  [...g.entries()].map(([k, v]) => {
    const s = [...v].sort((a, b) => a - b);
    return [k, s[Math.floor(s.length / 2)], v.length, Math.min(...s), Math.max(...s)];
  }).sort((a, b) => b[1] - a[1]).forEach(([k, med, n, lo, hi]) => {
    console.log(`${String(Math.round(med)).padStart(7)}/일 중앙값  ${n}편  (${Math.round(lo)}~${Math.round(hi)})  ${k}`);
  });
})().catch((e) => console.log('ERR', e.message));

// 린박스로 올린 편 중 «지역 차단»이 걸린 것을 찾는다.
//
//   node scripts/_rinbox-blocked.js [ja|ko]
//
// 왜 (2026-10-05): 妖術武芸帳「海の向こうは…」(DIVoLl6fTpQ) 가 조회 0 이었다.
// 비공개도 삭제도 아니고 **전 세계 차단**(regionRestriction.blocked 에 거의 모든 나라)이었다.
// Content ID 매칭이 걸리면 이렇게 조용히 죽는다 — 조회수만 보면 「반응이 없네」로 오해한다.
require('dotenv').config({ path: 'D:/midform/.env' });
const fs = require('fs');
const keyFetch = require('./lib/ytKeyFetch'); // 발굴 키 쿼터 장부(10-20)
const KEY = process.env.YOUTUBE_API_KEY_SEARCH || process.env.YOUTUBE_API_KEY || process.env.YT_API_KEY;
const WANT = (process.argv[2] || '').trim();

const STATE = 'D:/midform/server/data/rinbox_publish_state.json';

(async () => {
  const hist = (JSON.parse(fs.readFileSync(STATE, 'utf8')).history || [])
    .filter((e) => e.url && !e.retracted)
    .filter((e) => !WANT || e.locale === WANT);
  const byId = new Map();
  for (const e of hist) {
    const m = /[?&]v=([\w-]{11})/.exec(e.url);
    if (m) byId.set(m[1], e);
  }
  const ids = [...byId.keys()];
  let blocked = 0, partial = 0, ok = 0, missing = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const r = await keyFetch('rinbox-blocked', 'videos', 'https://www.googleapis.com/youtube/v3/videos'
      + `?part=snippet,status,statistics,contentDetails&id=${ids.slice(i, i + 50).join(',')}&key=${KEY}`);
    const seen = new Set();
    for (const v of r.items || []) {
      seen.add(v.id);
      const e = byId.get(v.id);
      const rr = (v.contentDetails || {}).regionRestriction || {};
      const nb = (rr.blocked || []).length;
      const na = (rr.allowed || []).length;
      const views = Number(v.statistics.viewCount || 0);
      const tag = nb > 150 ? '★전세계차단' : (nb || na ? `부분제한 blocked=${nb} allowed=${na}` : '');
      if (nb > 150) blocked += 1; else if (nb || na) partial += 1; else ok += 1;
      if (tag) {
        console.log(`${tag}  ${e.locale}  ${String(views).padStart(6)}회  ${v.id}  ${v.snippet.title.slice(0, 44)}`);
      }
    }
    for (const id of ids.slice(i, i + 50)) {
      if (!seen.has(id)) { missing += 1; console.log(`API에 안 보임(비공개/예약/삭제)  ${id}`); }
    }
  }
  console.log(`\n전세계차단 ${blocked} · 부분제한 ${partial} · 정상 ${ok} · 조회불가 ${missing} (총 ${ids.length})`);
})().catch((e) => console.log('ERR', e.message));

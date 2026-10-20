// 모든 흐름 × 모든 플랫폼을 한 번에 재고, 날짜별 스냅샷으로 쌓는다.
//
//   node scripts/flow-check.js                어제까지의 상태를 재고 보고서를 쓴다
//   node scripts/flow-check.js --days 14      측정 창(기본 10일)
//   node scripts/flow-check.js --json         사람이 읽는 표 대신 JSON 만
//
// 왜: 흐름이 셋(린박스 ko · 린박스 ja · 명화관 영화클립)이고 플랫폼이 다섯인데,
// 한 곳만 보면 매번 틀린 결론이 나왔다 — 유튜브만 보고 「ja 時代劇은 죽었다」(실제로는
// 인스타 5만), 인스타만 보고 「ja=인스타」(실제로는 페이스북 7.9만). 그래서 한 번에 잰다.
//
// 못 재는 것은 못 잰다고 적는다(추정하지 않는다):
//   · ko 페이스북 «개인 프로필» — Blotato 가 아니라 플레이라이트로 올려서 분석 API 에 없다.
//     수치는 scripts/_fb-profile-explore.js 로 대시보드에서 따로 긁는다.
//   · 틱톡 — Zernio 분석으로 잰다(2026-10-08, Blotato 는 틱톡 미지원).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const YT_KEY = process.env.YOUTUBE_API_KEY_SEARCH || process.env.YOUTUBE_API_KEY || process.env.YT_API_KEY;
const quota = require('./api_quota'); // 발굴 키 쿼터 장부(10-20) — 호출 전 기록·상한, 429/403 이면 그날 전 도구 중지
async function ytGet(url) {
  const ep = /youtube\/v3\/(\w+)/.exec(url)[1];
  quota.spend('flow_check', ep);
  const res = await fetch(url);
  if (res.status === 429 || res.status === 403) {
    quota.markBlocked('flow-check', `${ep} ${res.status}`);
    throw new Error(`YouTube API ${res.status} — 오늘 발굴 키 중지(우회 금지)`);
  }
  return res.json();
}
const BL_KEY = String(process.env.BLOTATO_API_KEY || '').trim();
const RINBOX_STATE = path.join(ROOT, 'server', 'data', 'rinbox_publish_state.json');
const MOVIE_STATE = path.join(ROOT, 'server', 'data', 'auto_publish_state.json');
const CATALOG = path.join(ROOT, 'midform', 'config', 'rinbox_catalog.json');
const OUT_DIR = path.join(ROOT, 'server', 'output', 'flow-check');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };
const DAYS = Number(arg('--days', '10'));
const SINCE = new Date(Date.now() - DAYS * 864e5);

// ── 작품 식별: 캡션에 작품명이 나오면 그 작품으로 본다 ──────────────────────────
const catalog = readJson(CATALOG, { works: {} }).works || {};
function workOf(text) {
  const t = String(text || '');
  for (const [key, v] of Object.entries(catalog)) {
    for (const name of [v.title_ko, v.title_ja, v.title_en].filter(Boolean)) {
      if (t.includes(name)) return { key, broadcaster: v.broadcaster || '?' };
    }
  }
  return null;
}
// 린박스 캡션은 「…」은 꼭 풀버전 / はぜひフルバージョン 으로 끝난다. 명화관은 영화·ドラマ『…』 꼴이다.
const streamOf = (text) => (/풀버전으로 감상|フルバージョンでご覧/.test(text) ? 'rinbox'
  : (/[『](.+?)[』]/.test(text) ? 'movie' : 'other'));
const localeOf = (text) => (/[ぁ-んァ-ヶ]/.test(text) ? 'ja' : (/[가-힣]/.test(text) ? 'ko' : '?'));

async function youtube() {
  const hist = (readJson(RINBOX_STATE, { history: [] }).history || []).filter((e) => e.url && !e.retracted);
  const movie = (readJson(MOVIE_STATE, { history: [] }).history || []).filter((e) => e.url);
  const byId = new Map();
  // 자체 렌더러(rinbox_render.py) 편은 파일 이름이 «…-local.mp4» 다 — 볼케이노 편과 갈라 놓아야
  // 렌더러를 바꾼 게 조회수에 영향을 주는지 볼 수 있다(소유주 2026-10-08).
  for (const e of hist) {
    const m = /[?&]v=([\w-]{11})/.exec(e.url);
    if (m) byId.set(m[1], { ...e, stream: /-local\.mp4$/.test(e.file || '') ? 'rinbox-self' : 'rinbox' });
  }
  for (const e of movie) { const m = /[?&]v=([\w-]{11})/.exec(e.url); if (m && !byId.has(m[1])) byId.set(m[1], { ...e, stream: 'movie' }); }
  const ids = [...byId.keys()];
  const rows = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await ytGet('https://www.googleapis.com/youtube/v3/videos'
      + `?part=snippet,statistics,contentDetails&id=${ids.slice(i, i + 50).join(',')}&key=${YT_KEY}`);
    for (const v of r.items || []) {
      const e = byId.get(v.id);
      const rr = (v.contentDetails || {}).regionRestriction || {};
      const blocked = (rr.blocked || []).length > 150;
      const hours = (Date.now() - Date.parse(v.snippet.publishedAt)) / 36e5;
      if (hours < 12) continue;                       // 너무 어려서 비교 불가
      const views = Number(v.statistics.viewCount || 0);
      rows.push({ id: v.id, stream: e.stream, locale: e.locale || '?', work: e.work || '',
        title: v.snippet.title, views, hours, perDay: views / (hours / 24), blocked,
        matched: Boolean(v.contentDetails.licensedContent) });
    }
  }
  return rows;
}

async function blotato() {
  if (!BL_KEY) return [];
  // limit 은 50 이 상한이다(200 이면 400). 플랫폼별로 따로 받아 폭을 넓힌다.
  const out = [];
  for (const platform of ['instagram', 'facebook', 'threads']) {
    const r = await fetch(`https://backend.blotato.com/v2/analytics?limit=50&platform=${platform}`,
      { headers: { 'blotato-api-key': BL_KEY } });
    if (!r.ok) { console.log(`   (analytics ${platform} -> ${r.status})`); continue; }
    const j = await r.json();
    for (const it of j.items || []) {
      const m = (it.latestMetrics || {}).metrics || {};
      const hours = (Date.now() - Date.parse(it.createdAt)) / 36e5;
      if (!(hours >= 12 && hours <= DAYS * 24)) continue;
      const views = Number(m.viewsCount || 0);
      const w = workOf(it.content);
      out.push({ platform: it.platform || platform, stream: streamOf(it.content), locale: localeOf(it.content),
        work: w ? w.key : '', broadcaster: w ? w.broadcaster : '', views, hours,
        perDay: views / (hours / 24), postUrl: it.postUrl });
    }
  }
  return out;
}

// 틱톡 — Zernio 분석(2026-10-08). 연결된 틱톡 계정의 영상을 TikTok 쪽에서 동기화해 돌려주므로
// Zernio 로 올리기 전(Blotato 시절) 영상도 잡힌다. 페이지당 50편.
const ZN_KEY = String(process.env.ZERNIO_API_KEY || '').trim();
async function zernio() {
  if (!ZN_KEY) return [];
  const out = [];
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - (DAYS + 1) * 864e5).toISOString().slice(0, 10);
  for (let page = 1; page <= 20; page += 1) {
    const r = await fetch(`https://zernio.com/api/v1/analytics?platform=tiktok&fromDate=${from}&toDate=${to}&page=${page}&limit=50`,
      { headers: { Authorization: `Bearer ${ZN_KEY}` } });
    if (!r.ok) { console.log(`   (zernio analytics -> ${r.status})`); break; }
    const j = await r.json();
    for (const it of j.posts || []) {
      const hours = (Date.now() - Date.parse(it.publishedAt)) / 36e5;
      if (!(hours >= 12 && hours <= DAYS * 24)) continue;
      const views = Number((it.analytics || {}).views || 0);
      const w = workOf(it.content);
      const acct = ((it.platforms || [])[0] || {}).accountUsername || '';
      out.push({ platform: 'tiktok', account: acct, stream: streamOf(it.content), locale: localeOf(it.content),
        work: w ? w.key : '', broadcaster: w ? w.broadcaster : '', views, hours,
        perDay: views / (hours / 24), postUrl: it.platformPostUrl });
    }
    const pg = j.pagination || {};
    if (!pg.pages || page >= pg.pages) break;
  }
  return out;
}

function table(title, rows, keyOf) {
  const g = new Map();
  for (const r of rows) {
    if (r.perDay == null) continue;
    const k = keyOf(r);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r.perDay);
  }
  const out = [...g.entries()].map(([k, v]) => {
    const s = [...v].sort((a, b) => a - b);
    return { k, n: v.length, med: Math.round(s[Math.floor(s.length / 2)]), max: Math.round(Math.max(...s)) };
  }).sort((a, b) => b.med - a.med);
  console.log(`\n── ${title} (하루당 조회 중앙값)`);
  for (const r of out) console.log(`${String(r.med).padStart(7)}/일  최고 ${String(r.max).padStart(7)}  ${String(r.n).padStart(2)}편  ${r.k}`);
  return out;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const yt = await youtube();
  const bl = await blotato();
  const tt = await zernio();
  const social = bl.concat(tt);

  const blockedYt = yt.filter((r) => r.blocked);
  const matchedYt = yt.filter((r) => r.matched);

  console.log(`측정 창 ${DAYS}일 · 유튜브 ${yt.length}편 · Blotato ${bl.length}건 · 틱톡(Zernio) ${tt.length}건`);
  table('유튜브 — 흐름×로케일', yt, (r) => `${r.stream}/${r.locale}`);
  table('소셜 — 플랫폼×로케일', social, (r) => `${r.platform}/${r.locale}`);
  table('틱톡 — 흐름×로케일', tt, (r) => `${r.stream}/${r.locale}`);
  table('소셜 — 작품(방송사)', social.filter((r) => r.work), (r) => `${r.work} [${r.broadcaster}]`);

  if (blockedYt.length) {
    console.log('\n★ 유튜브 전세계차단');
    for (const r of blockedYt) console.log(`   ${r.id}  ${r.title.slice(0, 44)}`);
  }
  if (matchedYt.length) console.log(`\n※ 유튜브 소유권 매칭 ${matchedYt.length}편 (발행을 막는 신호는 아니다)`);

  console.log('\n※ 못 잰 것 — ko 페이스북 개인 프로필 편별(플레이라이트 경로, 분석 API 밖 · 합계는 fb-profile-totals)');

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const snap = { at: new Date().toISOString(), days: DAYS, youtube: yt, blotato: bl, tiktok: tt };
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}.json`), `${JSON.stringify(snap, null, 2)}\n`, 'utf8');
  console.log(`\n스냅샷: ${path.join(OUT_DIR, `${stamp}.json`)}`);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });

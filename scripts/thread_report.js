// 레인별 «결» 탐지 — 레인 중앙값 3배를 넘은 편들의 공통 속성(작품·배우·출처·제목 틀·시각)을 표로 낸다.
//
//   node scripts/thread_report.js [--date 2026-10-16] [--lanes ja,ko_longshort,shop] [--min-age-h 72] [--x 3]
//   const { buildThreads } = require('./thread_report');  // manager-report.js 가 import
//
// 왜 (관리자 백로그 6, 10-16): 터진 편이 «왜» 터졌는지 매번 사람이 훑는다. ja 는 C 의 M2 가설
//   «近衛十四郎 浪人물이 결이다»를 수치로 검증해야 한다(ja-ebook-rules-adopted).
// 데이터:
// - 유튜브: 채널 토큰(youtube_upload_profiles.json)으로 videos.list(snippet·status·statistics·contentDetails) — 조회만, 검색 안 함.
// - 속성: rinbox_publish_state.json(작품 slug) · production_ledger.jsonl(id·title·note) · 설명란(出演·영화·출처 줄) · 제목.
// 공정성: 공개 뒤 min-age-h(기본 72시간) 지난 편만 센다(막 올린 편은 아직 자라는 중). 비공개(저조회 자동 비공개)도 조회수는 센다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'server/data');
const PROFILES = path.join(DATA, 'youtube_upload_profiles.json');
const LANES = {
  ja: { profile: 'full_draft_channel', label: 'ja 沼落ちシネマ (C 린박스)' },
  ko_longshort: { profile: 'channel_krvyh_mq', label: 'ko 지구관측소 (A 롱투숏 · 이전 ko 린박스 포함)' },
  shop: { profile: 'channel_ju89dqsw', label: '쇼핑 @ssul-mo-lab' },
  // N100 은 채널 토큰이 이 PC 에 없다 → 장부(n100_*) + 발굴용 키 공개 통계. 공개 전·비공개 편은 «조회 없음».
  n100: { ledger: true, label: 'N100 레인들 (장부 n100_* · 공개 통계)' },
};
const N100_SKIP = /쓸모연구소/; // 소유주: 쓸모연구소는 판정에서 항상 논외(ssulmo-lab-always-out-of-scope)
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');
const kst = (ms) => new Date(ms + 9 * 3600e3);

async function token(p) {
  const body = new URLSearchParams({ client_id: p.oauthClientId, client_secret: p.oauthClientSecret, refresh_token: p.refreshToken, grant_type: 'refresh_token' });
  const j = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } })).json();
  if (!j.access_token) throw new Error('토큰 갱신 실패');
  return j.access_token;
}
async function get(tk, url) {
  const r = await fetch(url, { headers: { authorization: 'Bearer ' + tk } });
  const j = await r.json();
  if (j.error) { const e = new Error(`${j.error.code} ${j.error.message}`); e.code = j.error.code; throw e; }
  return j;
}

async function channelVideos(profileId, max = 300) {
  const store = readJson(PROFILES, []);
  const p = (Array.isArray(store) ? store : store.profiles || []).find((x) => x.id === profileId);
  if (!p || !p.refreshToken) throw new Error(`프로필 ${profileId} 토큰 없음`);
  const tk = await token(p);
  const ch = await get(tk, 'https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true');
  const up = ch.items[0].contentDetails.relatedPlaylists.uploads;
  const ids = []; let page = '';
  while (ids.length < max) {
    const pl = await get(tk, `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${up}${page ? '&pageToken=' + page : ''}`);
    ids.push(...(pl.items || []).map((i) => i.contentDetails.videoId));
    if (!pl.nextPageToken) break;
    page = pl.nextPageToken;
  }
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const v = await get(tk, `https://www.googleapis.com/youtube/v3/videos?part=snippet,status,statistics,contentDetails&id=${ids.slice(i, i + 50).join(',')}`);
    out.push(...(v.items || []));
  }
  return { channel: p.channelTitle, items: out };
}

function isoSec(d) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || '') || [];
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

// ── 속성 뽑기 ────────────────────────────────────────────────────────────────
function titleShape(t) {
  const s = [];
  if (/[「『]/.test(t)) s.push('발언 인용「」');
  if (/[?？]/.test(t)) s.push('물음표');
  if (/[0-9０-９]/.test(t)) s.push('숫자');
  if (/[!！]/.test(t)) s.push('느낌표');
  const n = [...t.replace(/#\S+/g, '').trim()].length;
  s.push(n <= 12 ? '제목 ≤12자' : n <= 20 ? '제목 13~20자' : '제목 21자+');
  return s;
}
function jaAttrs(v, ctx) {
  const d = v.snippet.description || '';
  const a = {};
  const pub = ctx.rinbox.get(v.id);
  if (pub && pub.work) a['작품'] = pub.work;
  // «出演：北大路欣也（辰造）…» 또는 «近衛十四郎さん・品川隆二さんほかが出演» — 첫 이름
  const cast = /出演[:：]\s*([^\n（(・、]+)/.exec(d) || /([^\s、。「」・]{2,8})さん[^。\n]*?が出演/.exec(d);
  // «この作品は近衛十四郎さん…» 처럼 앞 낱말이 붙어 잡히면 조사 뒤만 남긴다
  if (cast) a['주연'] = cast[1].trim().split(/[はがのをも]/).pop();
  const series = /「([^」]{2,20})」はぜひ/.exec(d) || /放送[:：][^「]*「([^」]+)」/.exec(d);
  if (series && !a['작품']) a['작품'] = series[1];
  if (/浪人/.test(v.snippet.title + d.slice(0, 300))) a['浪人 언급'] = '있음';
  return a;
}
function koAttrs(v, ctx) {
  const d = v.snippet.description || '';
  const a = {};
  const pub = Date.parse(v.status.publishAt || v.snippet.publishedAt);
  if (ctx.rinbox.has(v.id)) a['하위 레인'] = 'ko 린박스(이전)';
  else if (ctx.ledgerIds.has(v.id) || pub >= Date.parse('2026-10-14T00:00:00+09:00')) a['하위 레인'] = '롱투숏';
  else a['하위 레인'] = '리캡(이전)';
  const film = /(?:영화|드라마)[:：]\s*([^\n(]+)/.exec(d);
  if (film) a['작품'] = film[1].trim();
  const src = /(?:영상|출처|원본|Source|Credit)\s*[:：]\s*([^\n]{2,40})/i.exec(d);
  if (src) a['출처'] = src[1].trim();
  const rb = ctx.rinbox.get(v.id);
  if (rb && rb.work && !a['작품']) a['작품'] = rb.work;
  return a;
}
function shopAttrs(v, ctx) {
  const a = {};
  const led = ctx.ledgerByYt.get(v.id);
  if (led) { a['편'] = led.id; if (/clean|deco/i.test(led.note || '')) a['스타일'] = /clean/i.test(led.note) ? 'clean' : 'deco'; }
  const tags = v.snippet.tags || [];
  if (tags[0]) a['첫 태그'] = tags[0];
  return a;
}
const EXTRACT = { ja: jaAttrs, ko_longshort: koAttrs, shop: shopAttrs };

function context() {
  const rinbox = new Map();
  for (const h of (readJson(path.join(DATA, 'rinbox_publish_state.json'), {}).history || [])) {
    const m = /v=([\w-]{11})/.exec(h.url || '');
    if (m) rinbox.set(m[1], h);
  }
  const ledgerByYt = new Map(); const ledgerIds = new Set();
  for (const l of fs.readFileSync(path.join(DATA, 'production_ledger.jsonl'), 'utf8').split('\n')) {
    try { const r = JSON.parse(l); if (r.youtube_id) { ledgerByYt.set(r.youtube_id, r); if (r.lane === 'ko_longshort') ledgerIds.add(r.youtube_id); } } catch { /* 빈 줄 */ }
  }
  const jaIds = new Set([...rinbox.keys()]);
  for (const h of readJson(path.join(DATA, 'youtube_upload_history.json'), [])) {
    if (h.uploadProfileId === 'full_draft_channel' && h.youtubeVideoId) jaIds.add(h.youtubeVideoId);
  }
  return { rinbox, ledgerByYt, ledgerIds, jaIds };
}

// ── N100(장부 기반) ─────────────────────────────────────────────────────────
function n100Rows() {
  const out = [];
  for (const l of fs.readFileSync(path.join(DATA, 'production_ledger.jsonl'), 'utf8').split('\n')) {
    try { const r = JSON.parse(l); if (String(r.lane || '').startsWith('n100_')) out.push(r); } catch { /* 빈 줄 */ }
  }
  return out;
}

async function publicStats(ids) {
  // 발굴용 키(YOUTUBE_API_KEY_SEARCH)로 videos.list — 공개 편만 돌아온다. 키가 없으면 빈 Map(«조회 없음»).
  const env = (() => { try { return fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch { return ''; } })();
  const line = env.split('\n').find((l) => l.startsWith('YOUTUBE_API_KEY_SEARCH='));
  const stats = new Map();
  if (!line || !ids.length) return stats;
  const key = line.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
  for (let i = 0; i < ids.length; i += 50) {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,status&id=${ids.slice(i, i + 50).join(',')}&key=${key}`);
    if (r.status === 429 || r.status === 403) { const e = new Error('공개 통계 ' + r.status); e.code = r.status; throw e; }
    for (const v of (await r.json()).items || []) {
      stats.set(v.id, { views: +v.statistics.viewCount || 0, title: v.snippet.title, pub: Date.parse(v.snippet.publishedAt), privacy: v.status.privacyStatus });
    }
  }
  return stats;
}

function analyseN100(rows, stats, { now, minAgeH, x }) {
  const lanes = {};
  for (const r of rows) {
    if (N100_SKIP.test(r.note || '')) continue;
    const L = (lanes[r.lane] = lanes[r.lane] || { lane: r.lane, made: 0, days: new Set(), render: [], rejected: 0, channel: '', items: [] });
    L.made++; L.rejected += r.rejected || 0;
    L.days.add(String(r.finished_at || r.at || '').slice(0, 10));
    if (r.render_secs != null) L.render.push(r.render_secs);
    const ch = /채널=([^·]+)/.exec(r.note || ''); if (ch) L.channel = ch[1].trim();
    const s = r.youtube_id && stats.get(r.youtube_id);
    if (s && s.pub <= now) L.items.push({ id: r.youtube_id, title: s.title, views: s.views, ageH: (now - s.pub) / 3600e3 });
  }
  return Object.values(lanes).map((L) => {
    const pool = L.items.filter((i) => i.ageH >= minAgeH);
    const med = median(pool.map((i) => i.views));
    return { lane: L.lane, channel: L.channel, made: L.made, perDay: L.days.size ? L.made / L.days.size : 0,
      renderMed: median(L.render), rejected: L.rejected, withViews: L.items.length, pool: pool.length, med,
      hot: pool.filter((i) => med > 0 && i.views >= x * med).sort((a, b) => b.views - a.views) };
  }).sort((a, b) => a.lane.localeCompare(b.lane));
}

function renderN100(res, label, x, minAgeH) {
  const L = [`## ${label}`, ''];
  if (res.error) return [...L, `_조회 실패: ${res.error}_`, ''];
  if (!res.lanes.length) return [...L, '_장부에 n100_* 행이 없다._', ''];
  L.push('| 레인 | 채널 | 만든 편 | 하루 | 렌더 중앙(초) | 반려 | 조회 있는 편 | 집계 | 중앙 조회 | ' + x + '배+ |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const r of res.lanes) {
    const views = r.withViews ? `${r.withViews}` : '조회 없음';
    L.push(`| ${r.lane} | ${r.channel} | ${r.made} | ${r.perDay.toFixed(1)} | ${fmt(r.renderMed)} | ${r.rejected} | ${views} | ${r.pool} | ${r.pool ? fmt(r.med) : '—'} | ${r.hot.length} |`);
  }
  L.push('', `조회는 발굴용 키 공개 통계 — 공개 전·비공개 편은 안 보여서 «조회 없음, 편수·렌더만». 집계는 공개 ${minAgeH}시간 지난 편. 쓸모연구소는 논외(소유주).`, '');
  const hot = res.lanes.flatMap((r) => r.hot.map((h) => ({ ...h, lane: r.lane, base: r.med })));
  if (hot.length) {
    L.push('| 레인 | 조회 | 배수 | 제목 |', '|---|---|---|---|');
    for (const h of hot.slice(0, 15)) L.push(`| ${h.lane} | ${fmt(h.views)} | ${(h.views / h.base).toFixed(1)} | ${String(h.title).replace(/\|/g, '/').slice(0, 40)} |`);
    L.push('');
  }
  return L;
}

// ── 결 표 ───────────────────────────────────────────────────────────────────
function analyse(lane, items, ctx, { now, minAgeH, x }) {
  const seenId = new Set();
  items = items.filter((v) => !seenId.has(v.id) && seenId.add(v.id));
  const rows = items.map((v) => {
    const pub = Date.parse(v.status.publishAt || v.snippet.publishedAt);
    const t = kst(pub);
    const attrs = { ...EXTRACT[lane](v, ctx) };
    for (const s of titleShape(v.snippet.title)) attrs['제목: ' + s] = '예';
    attrs['공개 시각'] = String(t.getUTCHours()).padStart(2, '0') + '시';
    attrs['요일'] = DOW[t.getUTCDay()];
    const sec = isoSec(v.contentDetails.duration);
    attrs['길이'] = sec <= 45 ? '≤45초' : sec <= 60 ? '46~60초' : sec <= 90 ? '61~90초' : '91초+';
    return { id: v.id, title: v.snippet.title, pub, ageH: (now - pub) / 3600e3, views: +v.statistics.viewCount || 0, privacy: v.status.privacyStatus, attrs };
  }).filter((r) => r.pub <= now);
  // 채널마다 다른 시대 영상이 섞여 있다: ja 는 드라마 이전(영어 크리켓·한국 공예) → 린박스 업로드 기록에 있는 편만,
  // 쇼핑 채널은 10-07 전 다른 콘텐츠 → 그 뒤 편만. ko 는 하위 레인으로 나눠 따로 본다.
  const inLane = (r) => (lane === 'ja' ? ctx.jaIds.has(r.id)
    : lane === 'shop' ? r.pub >= Date.parse('2026-10-07T00:00:00+09:00') : true);
  const pool = rows.filter((r) => r.ageH >= minAgeH && inLane(r));
  const med = median(pool.map((r) => r.views));
  // 하위 레인(ko: 리캡·린박스·롱투숏)이 있으면 그 안의 중앙값으로 잰다 — 형식이 다른 편끼리 견주지 않는다
  const groupOf = (r) => r.attrs['하위 레인'] || '전체';
  const groups = {};
  for (const r of pool) (groups[groupOf(r)] = groups[groupOf(r)] || []).push(r.views);
  const gmed = Object.fromEntries(Object.entries(groups).map(([k, vs]) => [k, { n: vs.length, med: median(vs) }]));
  for (const r of pool) r.base = gmed[groupOf(r)].med;
  const hot = pool.filter((r) => r.base > 0 && r.views >= x * r.base).sort((a, b) => b.views / b.base - a.views / a.base);
  // 속성값마다: 전체 몇 편 · 터진 편 몇 편 · 터질 확률 vs 기준
  const base = pool.length ? hot.length / pool.length : 0;
  const tally = new Map();
  for (const r of pool) {
    for (const [k, v] of Object.entries(r.attrs)) {
      const key = k + ' = ' + v;
      const t = tally.get(key) || { k, v, n: 0, hot: 0, views: [] };
      t.n++; t.views.push(r.views); if (hot.includes(r)) t.hot++;
      tally.set(key, t);
    }
  }
  const lifts = [...tally.values()].filter((t) => t.hot >= 2 && t.n >= 3)
    .map((t) => ({ ...t, rate: t.hot / t.n, lift: base ? (t.hot / t.n) / base : 0, med: median(t.views) }))
    .sort((a, b) => b.lift - a.lift || b.hot - a.hot);
  return { lane, n: rows.length, pool: pool.length, med, gmed, hot, base, lifts };
}

function render(res, label, x, minAgeH) {
  const L = [`## ${label}`, ''];
  if (res.error) return [...L, `_조회 실패: ${res.error}_`, ''];
  const gs = Object.entries(res.gmed || {});
  if (gs.length > 1) L.push('하위 레인별 중앙값: ' + gs.map(([k, g]) => `${k} ${g.n}편 ${fmt(g.med)}`).join(' · ') + ' — 배수는 각자 하위 레인 기준', '');
  L.push(`편 ${res.n} · 집계 ${res.pool}(공개 ${minAgeH}시간 지난 것) · 레인 중앙값 **${fmt(res.med)}** · ${x}배(${fmt(res.med * x)}) 넘은 편 **${res.hot.length}** (${(res.base * 100).toFixed(1)}%)`, '');
  if (res.hot.length) {
    L.push('| 조회 | 배수 | 공개 | 제목 | 속성 |', '|---|---|---|---|---|');
    for (const r of res.hot.slice(0, 15)) {
      const at = Object.entries(r.attrs).filter(([k]) => !k.startsWith('제목:') && k !== '요일').map(([k, v]) => `${k}:${v}`).join(' · ');
      L.push(`| ${fmt(r.views)} | ${(r.views / r.base).toFixed(1)} | ${kst(r.pub).toISOString().slice(5, 10)} | ${r.title.replace(/\|/g, '/').slice(0, 34)} | ${at.slice(0, 90)} |`);
    }
    L.push('');
  }
  if (res.lifts.length) {
    L.push('**공통 속성(터진 편 2편 이상·전체 3편 이상, 기준 대비 배수 순)**', '', '| 속성 | 전체 | 터짐 | 터질 확률 | 기준 대비 | 그 속성 중앙 조회 |', '|---|---|---|---|---|---|');
    for (const t of res.lifts.slice(0, 15)) L.push(`| ${t.k} = ${t.v} | ${t.n} | ${t.hot} | ${(t.rate * 100).toFixed(0)}% | ${t.lift.toFixed(1)}배 | ${fmt(t.med)} |`);
    L.push('');
  } else L.push('_공통 속성 없음(터진 편이 2편 미만이거나 속성이 흩어져 있다)._', '');
  return L;
}

async function buildThreads({ lanes = Object.keys(LANES), now = Date.now(), minAgeH = 72, x = 3 } = {}) {
  const ctx = context();
  const results = {};
  for (const lane of lanes) {
    try {
      if (LANES[lane].ledger) {
        const rows = n100Rows();
        const stats = await publicStats([...new Set(rows.map((r) => r.youtube_id).filter(Boolean))]);
        results[lane] = { lanes: analyseN100(rows, stats, { now, minAgeH, x }) };
        continue;
      }
      const { items } = await channelVideos(LANES[lane].profile);
      results[lane] = analyse(lane, items, ctx, { now, minAgeH, x });
    } catch (e) {
      results[lane] = { lane, error: e.message };
      if (e.code === 429 || e.code === 403) break; // 할당량·권한 — 우회하지 않고 멈춘다
    }
  }
  const md = [`# 레인별 결 탐지 ${kst(now).toISOString().slice(0, 10)}`, '',
    `기준: 공개 ${minAgeH}시간 지난 편의 레인 중앙값 × ${x}. 조회는 채널 토큰 videos.list(조회만). 속성은 장부·린박스 발행 기록·설명란·제목에서 뽑았다.`, ''];
  for (const lane of lanes) {
    const fn = LANES[lane].ledger ? renderN100 : render;
    md.push(...fn(results[lane] || { error: '안 돌림' }, LANES[lane].label, x, minAgeH));
  }
  return { markdown: md.join('\n') + '\n', results };
}

module.exports = { buildThreads, analyse, analyseN100, titleShape, jaAttrs, koAttrs, LANES };

if (require.main === module) {
  (async () => {
    const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
    const lanes = arg('--lanes', Object.keys(LANES).join(',')).split(',');
    const { markdown } = await buildThreads({ lanes, minAgeH: +arg('--min-age-h', 72), x: +arg('--x', 3) });
    const date = arg('--date', kst(Date.now()).toISOString().slice(0, 10));
    // 일부 레인만 돌리면 전체 보고서를 덮지 않는다
    const all = lanes.length === Object.keys(LANES).length;
    const out = path.join(ROOT, 'docs/reports', `${date}-threads${all ? '' : '-' + lanes.join('-')}.md`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, markdown, 'utf8');
    console.log(markdown);
    console.log('→', out);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}

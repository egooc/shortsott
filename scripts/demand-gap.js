// «증명된 수요 · 지금은 안 먹여지는 것»을 찾는다. 남의 영상을 다시 올리는 게 아니라,
// 남의 영상이 증명해 둔 수요 중 **아무도 지금 채우고 있지 않은 자리**를 찾는 것이다.
//
//   node scripts/demand-gap.js              스냅숏을 하나 뜨고 보고한다
//   node scripts/demand-gap.js --report     새로 안 받고 쌓인 것만 읽는다
//   node scripts/demand-gap.js --limit 400  훑을 영상 수 상한
//
// 왜 (2026-09-22 소유주: "경쟁채널에서 수치가 좋은데 지금 인게이지먼트가 죽은 영상을
//     내가 다시 올리면 그 트래픽을 가져올 수 있다더라")
//
//   ★«트래픽이 옮겨 오지»는 않는다. 조회수가 넘어오는 경로는 없다. 그런데 **수요는 남는다.**
//     500만이 본 장면은 그 장면을 보고 싶어 하는 사람이 많다는 뜻이고, 그 영상이 지금
//     안 자라고 있다면 유튜브가 그 수요를 **지금은 아무에게도 안 먹이고 있다**는 뜻이다.
//     그 자리에 새 물건을 놓는 것이 이 신호의 전부다. 남의 영상을 복제하는 것이 아니다.
//     (복제는 우리에게 특히 나쁘다 — 원본 채널의 Content ID 까지 얹혀 차단 경로가 하나 늘고,
//      우리 물건은 «다른 원고·다른 컷»이라 복제할 이유도 없다.)
//
//   ★«죽었다»는 한 장 사진으로 못 본다. 누적 조회를 나이로 나누면 초기 폭발에 가려진다.
//     그래서 **두 번 이상 재서 그 사이 증가분**을 본다. 우리 편에 쓰는 방식과 같다.
//     첫 실행은 기준점만 만든다 — 판정은 두 번째 실행부터다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch { /* 환경에서 온다 */ }

const SCOUT_DIR = path.join(ROOT, 'server', 'output', 'scout-reports');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const CATALOG = path.join(ROOT, 'midform', 'config', 'movie_catalog.json');
const YT_STATE = path.join(ROOT, 'server', 'data', 'auto_publish_state.json');
const STORE = path.join(ROOT, 'server', 'data', 'demand_gap.json');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const LIMIT = Number(arg('--limit', '600'));

// 1) 정찰 corpus 에서 «채널 평균을 넘긴» 영상만 본다. 평균 이하는 수요의 증거가 아니다.
function corpus() {
  const seen = new Map();
  let files = [];
  try { files = fs.readdirSync(SCOUT_DIR).filter((f) => /^scout-.*\.json$/.test(f)); } catch { return []; }
  for (const f of files) {
    const j = readJson(path.join(SCOUT_DIR, f), null);
    if (!j) continue;
    for (const v of [...(j.candidates || []), ...(j.needs_research || []), ...(j.dropped || [])]) {
      if (!v.id || !v.above_channel_avg) continue;
      const prev = seen.get(v.id);
      if (!prev || (v.view_count || 0) > (prev.view_count || 0)) seen.set(v.id, v);
    }
  }
  return [...seen.values()].sort((a, b) => (b.view_count || 0) - (a.view_count || 0)).slice(0, LIMIT);
}

async function accessToken(p) {
  const body = new URLSearchParams({ client_id: p.oauthClientId, client_secret: p.oauthClientSecret,
    refresh_token: p.refreshToken, grant_type: 'refresh_token' });
  const d = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body })).json();
  if (!d.access_token) throw new Error(`토큰 갱신 실패: ${JSON.stringify(d).slice(0, 140)}`);
  return d.access_token;
}

async function fetchStats(token, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${batch.join(',')}`,
      { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    if (j.error) throw new Error(`videos.list ${j.error.code}: ${String(j.error.message).slice(0, 120)}`);
    for (const it of j.items || []) {
      out[it.id] = {
        views: Number((it.statistics || {}).viewCount || 0),
        publishedAt: (it.snippet || {}).publishedAt || '',
      };
    }
  }
  return out;
}

// 이미 만든 영화는 제외한다 — 수요가 있어도 우리가 이미 채웠다.
function madeKeys() {
  const out = new Set();
  const os = require('os');
  const D = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
  const consider = (draft) => {
    if (!draft) return;
    for (const loc of ['', '-ko', '-ja']) {
      const m = readJson(path.join(D, draft + loc, 'upload_meta.json'), null);
      const k = m && m.movie && m.movie.key;
      if (k) { out.add(k); return; }
    }
  };
  for (const h of (readJson(YT_STATE, { history: [] }).history || [])) consider(h.draft);
  try { for (const n of fs.readdirSync(D)) consider(n); } catch { /* 없으면 이력만 */ }
  // ★옛 드래프트는 upload_meta 에 movie.key 가 없다(실측: 20260922b-hulk_incinerate-ko 는 undefined).
  //   그래서 이름 조각도 같이 모아 둔다. 정확한 키가 있으면 그게 이기고, 없을 때만 이름으로 맞춘다.
  const names = new Set();
  const collect = (d) => { const m = /^\d{8}[a-z]?-([a-z0-9]+)/.exec(d || ''); if (m) names.add(m[1]); };
  for (const h of (readJson(YT_STATE, { history: [] }).history || [])) collect(h.draft);
  try { for (const n of fs.readdirSync(D)) collect(n); } catch { /* 이력만 */ }
  out.names = names;
  return out;
}

// 키가 정확히 잡히면 그걸로, 아니면 드래프트 이름 조각으로 맞춘다.
function isMade(key, made) {
  if (made.has(key)) return true;
  const n = String(key).toLowerCase().replace(/^the[-_]/, '').replace(/[-_\s]/g, '');
  for (const u of (made.names || [])) if (n.startsWith(u) || u.startsWith(n)) return true;
  return false;
}

function bandOf(movies, key) {
  const raw = (movies[key] || {}).survivor_band;
  const n = raw ? Number(String(raw).split(' ')[0]) : NaN;
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const pool = corpus();
  if (!pool.length) { console.log('정찰 corpus 가 비었다.'); return; }
  const store = readJson(STORE, { snapshots: [] });

  if (!process.argv.includes('--report')) {
    const raw = readJson(PROFILES, []);
    const profiles = Array.isArray(raw) ? raw : (raw.profiles || []);
    const profile = profiles.find((p) => p.purpose === 'ko_highlight') || profiles[0];
    if (!profile) { console.error('업로드 프로필이 없다 — 토큰을 못 얻는다.'); process.exit(1); }
    const token = await accessToken(profile);
    const stats = await fetchStats(token, pool.map((v) => v.id));
    store.snapshots = [...(store.snapshots || []), { at: new Date().toISOString(), stats }].slice(-30);
    fs.writeFileSync(STORE, JSON.stringify(store, null, 2));
    console.log(`[demand] ${Object.keys(stats).length}편을 쟀다 (스냅숏 ${store.snapshots.length}개)`);
  }

  const snaps = store.snapshots || [];
  const last = snaps[snaps.length - 1];
  const prev = snaps.length >= 2 ? snaps[snaps.length - 2] : null;
  if (!last) { console.log('스냅숏이 없다.'); return; }
  if (!prev) {
    console.log('\n기준점만 만들었다. **증가분은 두 번째 실행부터 나온다** — 하루 뒤에 다시 돌려라.');
    console.log('(누적 조회만으로 «죽었다»를 판정하면 초기 폭발에 속는다.)');
    return;
  }

  const hours = Math.max(0.5, (Date.parse(last.at) - Date.parse(prev.at)) / 3600000);
  const movies = (readJson(CATALOG, {}).movies) || {};
  const made = madeKeys();

  const rows = [];
  for (const v of pool) {
    const a = last.stats[v.id]; const b = prev.stats[v.id];
    if (!a || !b) continue;
    const perDay = ((a.views - b.views) / hours) * 24;
    const age = a.publishedAt ? (Date.now() - Date.parse(a.publishedAt)) / 864e5 : null;
    const key = v.movie && v.movie.key;
    const m = key ? movies[key] : null;
    // ★차단된 영화는 수요가 아무리 커도 추천하면 안 된다 (실측 2026-09-23: 헐크가 5.1억 회로
    //   맨 위에 떴다 — banned 인데다 이미 만든 영화였다). 라이온스게이트·소니 계열도 같다.
    const banned = !m || m.distributor_tier === 'banned'
      || /lionsgate|summit|vestron|artisan|sony|columbia|screen gems/i.test(String(m.distributor || ''))
      || (Number(m.year) || 0) < 1990;
    rows.push({ id: v.id, title: v.title, ch: v.channel, views: a.views, perDay, age,
      key: key || null, band: key ? bandOf(movies, key) : null,
      made: key ? isMade(key, made) : false, banned,
      dur: v.duration_sec });
  }
  if (!rows.length) { console.log('두 스냅숏에 겹치는 영상이 없다.'); return; }

  // «증명된 수요 · 지금 안 자람»: 누적은 크고 하루 증가는 작다.
  const big = rows.filter((r) => r.views >= 300000);
  // ★«죽었다»를 «누적의 0.05% 미만»으로만 재면 큰 영상에서 무너진다 (실측 2026-09-23:
  //   5.1억 회 영상은 문턱이 25만/일이라 11만/일도 «죽었다»로 잡혔다 — 전혀 안 죽었다).
  //   그래서 상한을 씌운다: **하루 1,000회 넘게 들어오면 죽은 게 아니다.** 누가 보고 있다는 뜻이다.
  const deadLine = (r) => Math.min(r.views * 0.0005, 1000);
  const dead = big.filter((r) => r.perDay < deadLine(r));
  const fresh = dead.filter((r) => !r.made && !r.banned && (r.band ?? 0) >= 5);

  const lines = [`# 수요 빈자리 ${new Date().toLocaleString('ko-KR')}`, ''];
  lines.push(`훑은 영상 ${rows.length}편 · 간격 ${hours.toFixed(1)}시간`);
  lines.push(`누적 30만 이상 ${big.length}편 · 그중 **지금 거의 안 자라는 것 ${dead.length}편**`, '');
  lines.push('## 바로 쓸 수 있는 자리 — 안 만든 영화 · 생존자 신호 5 이상', '');
  if (!fresh.length) lines.push('_없다. 아래 전체 목록에서 신호가 낮은 것이라도 볼지 판단하라._');
  for (const r of fresh.sort((a, b) => b.views - a.views).slice(0, 20)) {
    lines.push(`- **${r.views.toLocaleString()}회** · 지금 ${Math.round(r.perDay)}/일 · 생존 ${r.band} · ${r.dur}s`);
    lines.push(`  ${r.key} — ${String(r.title).slice(0, 62)}  _(${r.ch})_`);
  }
  lines.push('', '## 수요는 증명됐으나 막힌 자리 (이미 만들었거나 신호가 약함)', '');
  for (const r of dead.filter((x) => !fresh.includes(x)).sort((a, b) => b.views - a.views).slice(0, 12)) {
    const why = r.banned ? '차단·금지 계열' : r.made ? '이미 만듦'
      : (r.band === null ? '신호 모름' : `신호 ${r.band}`);
    lines.push(`- ${r.views.toLocaleString()}회 · ${Math.round(r.perDay)}/일 · ${why} · ${r.key || '영화 미매칭'}`);
  }
  lines.push('', '_«트래픽이 옮겨 오는» 것이 아니다. 수요가 증명된 자리에 지금 아무도 안 서 있다는 뜻이다._');
  lines.push('_남의 영상을 다시 올리는 것이 아니라, 같은 장면을 우리 원고·우리 컷으로 새로 만든다._');

  const text = lines.join('\n');
  console.log('\n' + text);
  fs.mkdirSync(SCOUT_DIR, { recursive: true });
  const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  fs.writeFileSync(path.join(SCOUT_DIR, `${stamp}-demand.md`), `${text}\n`, 'utf8');
}

main().catch((e) => { console.error('demand-gap fatal:', e.message || e); process.exitCode = 1; });

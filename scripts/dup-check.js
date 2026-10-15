// dup-check — 중복도 사전 검사 (규칙집 S1·S2, 도구개발 백로그 1, 2026-10-15).
//   제목 후보·키워드마다 yt-search.js(innertube, 검색 API 할당량 0)로 쇼츠를 찾아
//   «남의 채널 · 문턱(기본 10만) 이상 · 제목이 후보와 겹침» 편이 있으면 WARN 을 낸다.
//   «같은 장면» 판정은 사람 몫이다 — 도구는 겹치는 제목과 조회수를 보여 주고 장면·틀 변경을 권할 뿐이다.
//   우리 편(midform/config/own_channels.json + 업로드 프로필 채널명)은 경고에서 빼고 «자기 잠식»으로 따로 센다.
//
//   node scripts/dup-check.js --lane ko|ja "<후보1>" "<후보2>" ... [--threshold 100000] [--period month] [--pages 3]
//        [--overlap 0.5] [--wd <작업 폴더 이름>] [--log <jsonl 경로>] [--no-log] [--json]
//   종료 코드: 0 = 전부 PASS · 4 = WARN 하나 이상 · 3 = 429(멈춤, 다른 키·우회 금지) · 2 = 인자 오류 · 1 = 기타 오류
//   기록: 기본 server/data/dup_check_log.jsonl (쇼핑 _gate_log.jsonl 형식 {at,wd,source,kind,message,detail}).
//         레인 게이트 로그에 바로 쌓으려면 --log D:/volcano-runs/_gate_log.jsonl 처럼 준다.
//   require('./dup-check').judge(query, items, opts) — 네트워크 없는 판정(회귀 테스트가 쓴다).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LANES = { ko: { gl: 'KR', hl: 'ko' }, ja: { gl: 'JP', hl: 'ja' } };
const DEFAULTS = { threshold: 100000, overlap: 0.5, top: 30 };

function norm(s) {
  return String(s || '').normalize('NFKC').toLowerCase()
    .replace(/\bshorts\b/g, ' ')               // #shorts 는 모든 쇼츠에 붙는다 — 작품명 해시태그(#열혈사제)는 남긴다
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// 글자 2-gram — 한국어·일본어는 띄어쓰기로 못 자르니 낱말 대신 2글자 조각으로 겹침을 잰다.
function grams(s) {
  const out = new Set();
  for (const w of norm(s).split(' ')) {
    if (!w) continue;
    if (w.length === 1) { out.add(w); continue; }
    for (let i = 0; i < w.length - 1; i++) out.add(w.slice(i, i + 2));
  }
  return out;
}

// 후보 쪽 조각 중 결과 제목에 들어 있는 비율(0~1). 짧은 키워드는 결과 제목에 통째로 있으면 1.
function overlap(query, title) {
  const q = grams(query);
  if (!q.size) return 0;
  const t = grams(title);
  let hit = 0;
  for (const g of q) if (t.has(g)) hit++;
  return hit / q.size;
}

function handleOf(item) {
  const h = item.channel_id || '';
  try { return decodeURIComponent(h); } catch { return h; }
}

function loadOwn(file = path.join(ROOT, 'midform', 'config', 'own_channels.json')) {
  const names = new Set(), handles = new Set();
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    (j.names || []).forEach((n) => names.add(norm(n)));
    (j.handles || []).forEach((h) => handles.add(String(h).toLowerCase()));
  } catch { /* 목록이 없으면 우리 편 구분 없이 돈다 */ }
  try {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json'), 'utf8'));
    for (const x of (Array.isArray(p) ? p : (p.profiles || []))) if (x.channelTitle) names.add(norm(x.channelTitle));
  } catch { /* 프로필 파일이 없어도 된다 */ }
  return { names, handles };
}

function isOwn(item, own) {
  if (!own) return false;
  return own.handles.has(handleOf(item).toLowerCase()) || (item.channel && own.names.has(norm(item.channel)));
}

// 판정 — items 는 yt-search 결과(관련도순). 반환 {query, verdict, hits, own_hits, own_top10, max_other, n}
function judge(query, items, opts = {}) {
  const { threshold, overlap: minOverlap, top } = { ...DEFAULTS, ...opts };
  const own = opts.own || null;
  const list = (items || []).slice(0, top).map((v, rank) => ({
    rank, id: v.id, title: v.title, views: v.view_count ?? null,
    handle: handleOf(v), channel: v.channel || null,
    own: isOwn(v, own), overlap: Number(overlap(query, v.title).toFixed(2)),
  }));
  const big = list.filter((v) => (v.views || 0) >= threshold && v.overlap >= minOverlap);
  const hits = big.filter((v) => !v.own).sort((a, b) => b.views - a.views);
  const ownHits = big.filter((v) => v.own);
  const others = list.filter((v) => !v.own).map((v) => v.views || 0);
  return {
    query,
    verdict: hits.length ? 'WARN' : 'PASS',
    n: list.length,
    hits,
    own_hits: ownHits,
    own_top10: list.slice(0, 10).filter((v) => v.own).length,
    max_other: others.length ? Math.max(...others) : 0,
  };
}

function logLine(r, { wd, lane }) {
  const top = r.hits[0];
  return {
    at: new Date().toISOString().slice(0, 19),
    wd: wd || null,
    source: 'dup-check',
    kind: r.verdict === 'WARN' ? 'dup_scene' : 'dup_clear',
    message: r.verdict === 'WARN'
      ? `«${r.query}» 남의 쇼츠 ${r.hits.length}편이 ${top.views.toLocaleString()}회까지 — 장면이 같으면 장면·틀을 바꿔라`
      : `«${r.query}» 문턱 넘는 남의 겹침 없음 (결과 ${r.n}편, 우리 편 상위10 ${r.own_top10})`,
    detail: {
      lane,
      hits: r.hits.slice(0, 5).map((v) => ({ id: v.id, views: v.views, handle: v.handle, overlap: v.overlap, title: v.title })),
      own_top10: r.own_top10,
      max_other: r.max_other,
    },
  };
}

async function run(queries, o) {
  const { search } = require('./ops/yt-search');
  const own = loadOwn();
  const out = [];
  for (const q of queries) {
    const items = await search(q, o.period, o.pages, { ...LANES[o.lane], channels: true });
    out.push(judge(q, items, { threshold: o.threshold, overlap: o.overlap, own }));
    await new Promise((r) => setTimeout(r, 1500));
  }
  return out;
}

module.exports = { judge, overlap, grams, loadOwn, logLine };

if (require.main === module) {
  const a = process.argv.slice(2);
  const valued = new Set(['--lane', '--threshold', '--period', '--pages', '--overlap', '--wd', '--log']);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const queries = a.filter((x, i) => !x.startsWith('--') && !(i && valued.has(a[i - 1])));
  const o = {
    lane: opt('--lane', 'ko'),
    threshold: Number(opt('--threshold', DEFAULTS.threshold)),
    overlap: Number(opt('--overlap', DEFAULTS.overlap)),
    period: opt('--period', 'month'),
    pages: Number(opt('--pages', 3)),
    wd: opt('--wd', null),
    log: a.includes('--no-log') ? null : opt('--log', path.join(ROOT, 'server', 'data', 'dup_check_log.jsonl')),
  };
  if (!queries.length || !LANES[o.lane]) {
    console.error('사용: node scripts/dup-check.js --lane ko|ja "<제목 후보>" ["<키워드>" ...]');
    process.exit(2);
  }
  run(queries, o).then((res) => {
    if (o.log) fs.appendFileSync(o.log, res.map((r) => JSON.stringify(logLine(r, o))).join('\n') + '\n', 'utf8');
    if (a.includes('--json')) { process.stdout.write(JSON.stringify({ lane: o.lane, threshold: o.threshold, results: res }, null, 2) + '\n'); }
    else {
      for (const r of res) {
        console.log(`[${r.verdict}] «${r.query}» 결과 ${r.n}편 · 남의 최고 ${r.max_other.toLocaleString()}회 · 우리 편 상위10 ${r.own_top10}`);
        for (const v of r.hits.slice(0, 5)) console.log(`    ${String(v.views.toLocaleString()).padStart(11)}  겹침 ${v.overlap.toFixed(2)}  ${v.handle}  ${v.title.slice(0, 50)}  https://youtube.com/shorts/${v.id}`);
        for (const v of r.own_hits.slice(0, 3)) console.log(`    (우리 편) ${v.views.toLocaleString()}  ${v.handle}  ${v.title.slice(0, 40)}`);
      }
    }
    process.exit(res.some((r) => r.verdict === 'WARN') ? 4 : 0);
  }).catch((e) => { console.error(e.message); process.exit(e.code === 429 ? 3 : 1); });
}

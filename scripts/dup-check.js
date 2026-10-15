// dup-check — 중복도 사전 검사 (규칙집 S1·S2, 도구개발 백로그 1, 2026-10-15 · 수정 1판 같은 날 밤).
//   검색어마다 yt-search.js(innertube, 검색 API 할당량 0)로 쇼츠를 찾아 판정한다.
//   주 신호(C·A·쇼핑 회신 10-15): «키워드(작품명·인물명)가 남의 제목 본문에 통째로 + 10만+» 편 수.
//     WARN = 그런 편이 하나라도 있음 (종료 코드 4)
//     NOTE = 10만+ 편은 있지만 키워드가 해시태그에만 있거나(태그 편승) 제목에 통째로 없음 — 참고로만
//     PASS = 문턱 넘는 남의 편 없음
//     INFO = --info(쇼핑 키워드 모드): 판정 없이 «10만+ 편 수»와 상위 편만 보여 준다
//   키워드: --key "<작품명>" (여러 번 가능, 모두 들어 있어야 함). 안 주면 검색어 자체가 키워드다.
//     단, 검색어가 길면(띄어쓰기 3덩이 이상 또는 공백 뺀 13자 이상) «제목 모드» — 완성 제목은 검색 판정력이 없어 NOTE 이하만 낸다.
//   글자 2-gram 겹침(overlap)은 참고 열로만 남긴다(뜻을 못 가린다 — 浪人の一言 vs 浪人生).
//   우리 편(midform/config/own_channels.json 핸들·이름 + 업로드 프로필 채널명)은 판정에서 빼고 «자기 잠식»으로 센다.
//
//   node scripts/dup-check.js --lane ko|ja "<검색어>" ... [--key "<작품명>"] [--info] [--tag-anchor]
//        [--threshold 100000] [--period year] [--pages 3] [--wd <작업 폴더>] [--log <jsonl>] [--no-log] [--json]
//   --tag-anchor : 해시태그에만 있는 키워드도 WARN 으로 친다(기본은 NOTE).
//   종료 코드: 0 = WARN 없음 · 4 = WARN 하나 이상 · 3 = 429(멈춤, 다른 키·우회 금지) · 2 = 인자 오류 · 1 = 기타 오류
//   기록: 기본 server/data/dup_check_log.jsonl (쇼핑 _gate_log.jsonl 형식 {at,wd,source,kind,message,detail}).
//         같은 레인·검색어의 지난 기록(다른 날짜)과 비교해 «우리 편 상위10·WARN 편 수» 변동을 출력한다.
//   require('./dup-check').judge(query, items, opts) — 네트워크 없는 판정(회귀 테스트가 쓴다).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LANES = { ko: { gl: 'KR', hl: 'ko' }, ja: { gl: 'JP', hl: 'ja' } };
const DEFAULTS = { threshold: 100000, top: 30 };
const DEFAULT_LOG = path.join(ROOT, 'server', 'data', 'dup_check_log.jsonl');

function norm(s) {
  return String(s || '').normalize('NFKC').toLowerCase()
    .replace(/\bshorts\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
const squash = (s) => norm(s).replace(/\s+/g, '');

// 제목을 본문과 해시태그로 나눈다.
function split(title) {
  const t = String(title || '').normalize('NFKC');
  const tags = t.match(/#[^\s#]+/g) || [];
  return { body: t.replace(/#[^\s#]+/g, ' '), tags: tags.join(' ') };
}

// 글자 2-gram — 참고 열(overlap)용.
function grams(s) {
  const out = new Set();
  for (const w of norm(s).split(' ')) {
    if (!w) continue;
    if (w.length === 1) { out.add(w); continue; }
    for (let i = 0; i < w.length - 1; i++) out.add(w.slice(i, i + 2));
  }
  return out;
}
function overlap(query, title) {
  const q = grams(query);
  if (!q.size) return 0;
  const t = grams(title);
  let hit = 0;
  for (const g of q) if (t.has(g)) hit++;
  return hit / q.size;
}

function isTitleMode(query) {
  return norm(query).split(' ').filter(Boolean).length >= 3 || squash(query).length >= 13;
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

// 판정 — items 는 yt-search 결과(관련도순).
function judge(query, items, opts = {}) {
  const { threshold, top } = { ...DEFAULTS, ...opts };
  const own = opts.own || null;
  const keys = (opts.keys && opts.keys.length ? opts.keys : [query]).map(squash).filter(Boolean);
  const titleMode = !(opts.keys && opts.keys.length) && isTitleMode(query);
  const list = (items || []).slice(0, top).map((v, rank) => {
    const { body, tags } = split(v.title);
    const inBody = keys.every((k) => squash(body).includes(k));
    const inTags = !inBody && keys.every((k) => squash(body + ' ' + tags).includes(k));
    return {
      rank, id: v.id, title: v.title, views: v.view_count ?? null,
      handle: handleOf(v), channel: v.channel || null, own: isOwn(v, own),
      anchor: inBody ? 'body' : inTags ? 'tag' : 'none',
      overlap: Number(overlap(query, v.title).toFixed(2)),
    };
  });
  const big = list.filter((v) => (v.views || 0) >= threshold);
  const others = big.filter((v) => !v.own).sort((a, b) => b.views - a.views);
  const strongAnchor = (v) => v.anchor === 'body' || (opts.tagAnchor && v.anchor === 'tag');
  const hits = titleMode ? [] : others.filter(strongAnchor);
  const notes = others.filter((v) => !hits.includes(v));
  let verdict = hits.length ? 'WARN' : notes.length ? 'NOTE' : 'PASS';
  if (opts.info) verdict = 'INFO';
  return {
    query,
    keys: opts.keys && opts.keys.length ? opts.keys : [query],
    title_mode: titleMode,
    verdict,
    n: list.length,
    big_others: others.length,                // 남의 10만+ 편 수(키워드 무관) — 쇼핑 INFO 의 주 숫자
    hits: opts.info ? [] : hits,
    notes: opts.info ? others : notes,
    own_hits: big.filter((v) => v.own),
    own_top10: list.slice(0, 10).filter((v) => v.own).length,
    max_other: list.filter((v) => !v.own).reduce((m, v) => Math.max(m, v.views || 0), 0),
  };
}

function logLine(r, { wd, lane, period }) {
  const top = r.hits[0];
  const msg = {
    WARN: () => `«${r.query}» 키워드가 제목에 든 남의 쇼츠 ${r.hits.length}편, 최고 ${top.views.toLocaleString()}회 — 장면이 같으면 장면·틀을 바꿔라`,
    NOTE: () => `«${r.query}» 10만+ 남의 편 ${r.big_others}편은 키워드가 제목에 없음(태그 편승·다른 뜻) — 참고${r.title_mode ? ' · 제목 모드' : ''}`,
    PASS: () => `«${r.query}» 문턱 넘는 남의 편 없음 (결과 ${r.n}편, 우리 편 상위10 ${r.own_top10})`,
    INFO: () => `«${r.query}» 10만+ 남의 편 ${r.big_others}편 (키워드 모드, 판정 없음)`,
  }[r.verdict]();
  return {
    at: new Date().toISOString().slice(0, 19),
    wd: wd || null,
    source: 'dup-check',
    kind: { WARN: 'dup_scene', NOTE: 'dup_note', PASS: 'dup_clear', INFO: 'dup_info' }[r.verdict],
    message: msg,
    detail: {
      lane, period, query: r.query, keys: r.keys, title_mode: r.title_mode,
      warn_n: r.hits.length, big_others: r.big_others, own_top10: r.own_top10, max_other: r.max_other,
      hits: r.hits.slice(0, 5).map((v) => ({ id: v.id, views: v.views, handle: v.handle, title: v.title })),
      notes: r.notes.slice(0, 5).map((v) => ({ id: v.id, views: v.views, handle: v.handle, anchor: v.anchor, title: v.title })),
    },
  };
}

// 같은 레인·검색어의 가장 최근 «다른 날» 기록.
function previous(logFile, lane, query, today) {
  try {
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').reverse();
    for (const l of lines) {
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.source === 'dup-check' && j.detail?.lane === lane && j.detail?.query === query && j.at.slice(0, 10) !== today) return j;
    }
  } catch { /* 기록 없음 */ }
  return null;
}

function changeLine(prev, r) {
  if (!prev) return null;
  const d = prev.detail;
  const parts = [];
  if (d.own_top10 !== r.own_top10) parts.push(`우리 편 상위10 ${d.own_top10} → ${r.own_top10}`);
  if (d.warn_n !== undefined && d.warn_n !== r.hits.length) parts.push(`WARN 편 ${d.warn_n} → ${r.hits.length}`);
  if (d.big_others !== undefined && d.big_others !== r.big_others) parts.push(`10만+ 남의 편 ${d.big_others} → ${r.big_others}`);
  return `지난 기록 ${prev.at.slice(0, 10)}: ${parts.length ? parts.join(' · ') : '변동 없음'}`;
}

async function run(queries, o) {
  const { search } = require('./ops/yt-search');
  const own = loadOwn();
  const out = [];
  for (const q of queries) {
    const items = await search(q, o.period, o.pages, { ...LANES[o.lane], channels: true });
    out.push(judge(q, items, { threshold: o.threshold, own, keys: o.keys, info: o.info, tagAnchor: o.tagAnchor }));
    await new Promise((r) => setTimeout(r, 1500));
  }
  return out;
}

module.exports = { judge, overlap, grams, loadOwn, logLine, isTitleMode, previous, changeLine };

if (require.main === module) {
  const a = process.argv.slice(2);
  const valued = new Set(['--lane', '--threshold', '--period', '--pages', '--wd', '--log', '--key']);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const queries = a.filter((x, i) => !x.startsWith('--') && !(i && valued.has(a[i - 1])));
  const o = {
    lane: opt('--lane', 'ko'),
    threshold: Number(opt('--threshold', DEFAULTS.threshold)),
    period: opt('--period', 'year'),
    pages: Number(opt('--pages', 3)),
    wd: opt('--wd', null),
    keys: a.map((x, i) => (x === '--key' ? a[i + 1] : null)).filter(Boolean),
    info: a.includes('--info'),
    tagAnchor: a.includes('--tag-anchor'),
    log: a.includes('--no-log') ? null : opt('--log', DEFAULT_LOG),
  };
  if (!queries.length || !LANES[o.lane]) {
    console.error('사용: node scripts/dup-check.js --lane ko|ja "<짧은 키워드>" ... [--key "<작품명>"] [--info]');
    process.exit(2);
  }
  run(queries, o).then((res) => {
    const today = new Date().toISOString().slice(0, 10);
    const changes = res.map((r) => (o.log ? changeLine(previous(o.log, o.lane, r.query, today), r) : null));
    if (o.log) fs.appendFileSync(o.log, res.map((r) => JSON.stringify(logLine(r, o))).join('\n') + '\n', 'utf8');
    if (a.includes('--json')) { process.stdout.write(JSON.stringify({ lane: o.lane, period: o.period, threshold: o.threshold, results: res }, null, 2) + '\n'); }
    else {
      res.forEach((r, i) => {
        console.log(`[${r.verdict}] «${r.query}»${r.title_mode ? ' (제목 모드 — 짧은 키워드나 --key 로 다시)' : ''} 결과 ${r.n}편 · 10만+ 남의 편 ${r.big_others} · 남의 최고 ${r.max_other.toLocaleString()}회 · 우리 편 상위10 ${r.own_top10}`);
        for (const v of r.hits.slice(0, 5)) console.log(`    WARN ${String(v.views.toLocaleString()).padStart(11)}  ${v.handle}  ${v.title.slice(0, 50)}  https://youtube.com/shorts/${v.id}`);
        for (const v of r.notes.slice(0, 5)) console.log(`    참고 ${String(v.views.toLocaleString()).padStart(11)}  ${v.anchor === 'tag' ? '태그만' : '키워드 없음'}  ${v.handle}  ${v.title.slice(0, 44)}`);
        for (const v of r.own_hits.slice(0, 3)) console.log(`    (우리 편) ${v.views.toLocaleString()}  ${v.handle}  ${v.title.slice(0, 40)}`);
        if (changes[i]) console.log(`    ${changes[i]}`);
      });
    }
    process.exit(res.some((r) => r.verdict === 'WARN') ? 4 : 0);
  }).catch((e) => { console.error(e.message); process.exit(e.code === 429 ? 3 : 1); });
}

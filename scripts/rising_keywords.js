// 올라오는 검색 키워드 관문(10-19 소유주 «롱폼 주제는 데이터로만 고른다» → 관리자 배정) — 새 계정·키 없이 되는 소스만.
//
//   node scripts/rising_keywords.js --lane politics_ko [--lane nenkin_ja ...] | --all   [--no-trends] [--top 20]
//
// 소스
//   ① 구글 트렌드 급상승 RSS(trends.google.com/trending/rss?geo=KR|JP) — 제목·대략 검색량·뉴스 제목
//   ② 자동완성 스냅샷: 구글·유튜브(suggestqueries), 네이버(ac.search.naver.com, ko 만) — 후보 낱말마다, 시각 표시
//      → 전 스냅샷(20시간+ 전 = 전일비, 6.5일+ 전 = 7일비)과 비교해 «새로 생긴 보조어 수»
//   ③ 네이버 데이터랩 검색어 트렌드(ko 레인만): 키는 ~/.volcano/keys/naver_hub_id·naver_hub_secret(쇼핑 naver_trend.py 와 같은 앱).
//      후보 5개씩 묶어 최근 4주 일 단위 상대값 → «최근 3일 평균 / 이전 7일 평균» = datalab_ratio, 점수에 가산.
//      파일이 없으면 skipped. 일 1,000건 한도라 레인당 호출 수를 표에 적는다. 키 값은 찍지 않는다.
// 출력: server/data/rising_keywords/<lane>/<YYYYMMDD-HHMM>.json(스냅샷) · <lane>_latest.json({후보: rising_score, 전일비, 7일비, 근거}) · 표
// 후보 사전: config/rising_seeds.json(rising = 상승률 순, evergreen = 자동완성 폭 순)
// 요청은 1초 간격, 429·403 이 나면 그 소스는 그날 멈춘다(우회 금지). 키·토큰 값은 찍지 않는다.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEEDS = path.join(ROOT, 'config', 'rising_seeds.json');
const OUT = path.join(ROOT, 'server', 'data', 'rising_keywords');
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
const DAY = 864e5;
const blocked = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = path.join(require('os').homedir(), '.volcano', 'keys');

// 데이터랩: {키워드: ratio|null}, 호출 수, 상태
async function datalab(cands) {
  const idf = path.join(KEYS, 'naver_hub_id'), sef = path.join(KEYS, 'naver_hub_secret');
  if (!fs.existsSync(idf) || !fs.existsSync(sef)) return { ratio: {}, calls: 0, status: 'skipped: ~/.volcano/keys/naver_hub_* 없음' };
  const headers = { 'X-Naver-Client-Id': fs.readFileSync(idf, 'utf8').trim(), 'X-Naver-Client-Secret': fs.readFileSync(sef, 'utf8').trim(), 'Content-Type': 'application/json' };
  const kst = (d) => new Date(d.getTime() + 9 * 36e5).toISOString().slice(0, 10);
  const end = new Date(Date.now() - DAY), start = new Date(end.getTime() - 27 * DAY);
  const ratio = {};
  let calls = 0, status = 'ok';
  for (let i = 0; i < cands.length; i += 5) {
    const group = cands.slice(i, i + 5);
    const body = { startDate: kst(start), endDate: kst(end), timeUnit: 'date',
      keywordGroups: group.map((k) => ({ groupName: k.slice(0, 20), keywords: [k] })) };
    await sleep(300);
    calls += 1;
    const r = await fetch('https://openapi.naver.com/v1/datalab/search', { method: 'POST', headers, body: JSON.stringify(body) });
    if (r.status === 429 || r.status === 401 || r.status === 403) { status = `stopped: HTTP ${r.status}`; break; }
    if (!r.ok) { status = `partial: HTTP ${r.status}`; continue; }
    const j = await r.json();
    (j.results || []).forEach((res, n) => {
      const byDay = Object.fromEntries((res.data || []).map((x) => [x.period, x.ratio]));
      const days = [];
      for (let d = 0; d < 10; d++) days.push(byDay[kst(new Date(end.getTime() - d * DAY))] || 0);
      const recent = (days[0] + days[1] + days[2]) / 3, prev = days.slice(3, 10).reduce((a, b) => a + b, 0) / 7;
      ratio[group[n]] = prev > 0 ? Math.round((recent / prev) * 100) / 100 : (recent > 0 ? 9.99 : null);
    });
  }
  return { ratio, calls, status };
}

async function get(src, url) {
  if (blocked.has(src)) return null;
  await sleep(1000);
  const r = await fetch(url, { headers: UA });
  if (r.status === 429 || r.status === 403) { blocked.add(src); console.log(`  [${src}] ${r.status} — 이 소스는 오늘 멈춤`); return null; }
  if (!r.ok) return null;
  return r.text();
}

function decode(s) {
  return s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

async function trends(geo) {
  const xml = await get('trends', `https://trends.google.com/trending/rss?geo=${geo}`);
  if (!xml) return [];
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => ({
    title: decode((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ''),
    traffic: Number(((it.match(/<ht:approx_traffic>([\d,]+)/) || [])[1] || '0').replace(/,/g, '')),
    at: (it.match(/<pubDate>([^<]+)/) || [])[1] || '',
    news: [...it.matchAll(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/g)].map((m) => decode(m[1])),
  }));
}

async function suggest(q, lang) {
  const hl = lang === 'ja' ? 'ja&gl=jp' : 'ko&gl=kr';
  const e = encodeURIComponent(q);
  const out = {};
  const g = await get('google', `https://suggestqueries.google.com/complete/search?client=firefox&hl=${hl}&q=${e}`);
  out.google = g ? JSON.parse(g)[1] : null;
  const y = await get('youtube', `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=${hl}&q=${e}`);
  out.youtube = y ? JSON.parse(y)[1] : null;
  if (lang === 'ko') {
    const n = await get('naver', `https://ac.search.naver.com/nx/ac?q=${e}&con=1&frm=nv&ans=2&r_format=json&r_enc=UTF-8&r_unicode=0&t_koreng=1&run=2&rev=4&q_enc=UTF-8&st=100`);
    try { out.naver = n ? (JSON.parse(n).items[0] || []).map((x) => x[0]) : null; } catch { out.naver = null; }
  }
  return out;
}

function stamp(d = new Date()) {
  const k = new Date(d.getTime() + 9 * 36e5).toISOString();
  return k.slice(0, 10).replace(/-/g, '') + '-' + k.slice(11, 16).replace(':', '');
}

function snapAt(name) {   // 20261019-1730 → KST Date
  const m = name.match(/^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)\.json$/);
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00`) : null;
}

function previous(dir, now, minAge) {   // minAge 이상 지난 것 중 가장 최근
  if (!fs.existsSync(dir)) return null;
  const c = fs.readdirSync(dir).map((f) => ({ f, at: snapAt(f) })).filter((x) => x.at && now - x.at >= minAge).sort((a, b) => b.at - a.at)[0];
  return c ? JSON.parse(fs.readFileSync(path.join(dir, c.f), 'utf8')) : null;
}

function autoSeeds(glob) {   // politics-hour/episodes/*/keywords.json → 최근 2편 keywords
  const [base, , file] = glob.split('/*/').length === 2 ? [glob.split('/*/')[0], null, glob.split('/*/')[1]] : [null];
  if (!base) return [];
  const dir = path.join(ROOT, base);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().reverse().slice(0, 2).flatMap((ep) => {
    const p = path.join(dir, ep, file);
    try { return (JSON.parse(fs.readFileSync(p, 'utf8')).keywords || []).map((k) => (typeof k === 'string' ? k : k.keyword)); } catch { return []; }
  });
}

const words = (ac) => new Set(Object.values(ac || {}).flatMap((v) => v || []));
const fresh = (now, old) => (old ? [...now].filter((w) => !old.has(w)) : null);

async function runLane(name, L, opts) {
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date();
  const tr = opts.trends ? await trends(L.geo) : [];
  const filt = L.trend_filter || [];
  const trendCands = L.mode === 'rising'
    ? tr.filter((t) => filt.some((w) => t.title.includes(w) || t.news.some((n) => n.includes(w)))) : [];
  const cands = [...new Set([...(L.seeds || []), ...(L.auto_from ? autoSeeds(L.auto_from) : []), ...trendCands.map((t) => t.title)])];
  const ac = {};
  for (const q of cands) ac[q] = await suggest(q, L.lang);
  const snap = { at: now.toISOString(), lane: name, trends: tr, ac };
  fs.writeFileSync(path.join(dir, `${stamp(now)}.json`), JSON.stringify(snap, null, 2) + '\n', 'utf8');

  const dl = L.lang === 'ko' ? await datalab(cands) : { ratio: {}, calls: 0, status: 'skipped: ja 레인(네이버는 ko 전용)' };
  const day = previous(dir, now, 20 * 36e5);
  const week = previous(dir, now, 6.5 * DAY);
  const rows = cands.map((q) => {
    const w = words(ac[q]);
    const t = tr.find((x) => x.title === q || x.title.includes(q) || q.includes(x.title));
    const dNew = fresh(w, day && day.ac[q] ? words(day.ac[q]) : null);
    const wNew = fresh(w, week && week.ac[q] ? words(week.ac[q]) : null);
    const trendPts = t ? Math.round(5 * Math.log10(Math.max(10, t.traffic))) : 0;
    const width = w.size;
    const dr = dl.ratio[q] ?? null;
    const dlPts = dr === null ? 0 : Math.max(-5, Math.min(10, 5 * (dr - 1)));   // 1.0 = 평소, 2.0 = +5, 3.0 이상 = +10
    const score = (L.mode === 'rising'
      ? 2 * (dNew ? dNew.length : 0) + 0.5 * (wNew ? wNew.length : 0) + trendPts + 0.2 * width
      : width + (wNew ? wNew.length : 0)) + dlPts;
    return {
      keyword: q, rising_score: Math.round(score * 10) / 10,
      day_new: dNew ? dNew.length : null, week_new: wNew ? wNew.length : null, ac_width: width, datalab_ratio: dr,
      evidence: {
        trend: t ? { title: t.title, traffic: t.traffic, at: t.at, news: t.news.slice(0, 2) } : null,
        new_today: (dNew || []).slice(0, 6), new_week: (wNew || []).slice(0, 6),
        ac: Object.fromEntries(Object.entries(ac[q]).map(([k, v]) => [k, v ? v.length : 'blocked'])),
      },
    };
  }).sort((a, b) => b.rising_score - a.rising_score);
  const datalabInfo = `${dl.status} · 호출 ${dl.calls}건(일 1,000건 한도)`;
  const res = { at: now.toISOString(), lane: name, mode: L.mode, baseline: { day: day ? day.at : null, week: week ? week.at : null }, datalab: datalabInfo, datalab_calls: dl.calls, blocked: [...blocked], rows };
  fs.writeFileSync(path.join(OUT, `${name}_latest.json`), JSON.stringify(res, null, 2) + '\n', 'utf8');

  console.log(`\n== ${name} (${L.mode}) · 후보 ${rows.length} · 기준 전일 ${day ? stamp(new Date(day.at)) : '없음'} · 7일 ${week ? stamp(new Date(week.at)) : '없음'} · 데이터랩 ${datalabInfo}`);
  console.log('순위 | 낱말 | 점수 | 전일 새 보조어 | 7일 새 | 자동완성 폭 | 데이터랩 3일/7일 | 급상승');
  rows.slice(0, opts.top).forEach((r, i) => console.log(
    `${i + 1} | ${r.keyword} | ${r.rising_score} | ${r.day_new ?? '-'} | ${r.week_new ?? '-'} | ${r.ac_width} | ${r.datalab_ratio ?? '-'} | ${r.evidence.trend ? r.evidence.trend.traffic + '+' : ''}`));
  return res;
}

async function main() {
  const argv = process.argv.slice(2);
  const S = JSON.parse(fs.readFileSync(SEEDS, 'utf8')).lanes;
  const lanes = argv.includes('--all') ? Object.keys(S) : argv.flatMap((a, i) => (argv[i - 1] === '--lane' ? [a] : []));
  if (!lanes.length || lanes.some((l) => !S[l])) {
    console.log(`usage: --lane <${Object.keys(S).join('|')}> | --all`);
    process.exit(2);
  }
  const ti = argv.indexOf('--top');
  const opts = { trends: !argv.includes('--no-trends'), top: ti > 0 ? Number(argv[ti + 1]) : 20 };
  for (const l of lanes) await runLane(l, S[l], opts);
}

// views_check 등에서: 특정 키워드의 최신 점수(«공개 시점 상승 지속» 칸). 없으면 null.
//   const { keywordScore } = require('D:/midform/scripts/rising_keywords.js');
//   keywordScore('politics_ko', '한동훈') → { at, rising_score, day_new, week_new, ac_width, rank, of, trend_traffic }
function keywordScore(lane, keyword) {
  const p = path.join(OUT, `${lane}_latest.json`);
  if (!fs.existsSync(p)) return null;
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const i = d.rows.findIndex((r) => r.keyword === keyword);
  const j = i >= 0 ? i : d.rows.findIndex((r) => r.keyword.includes(keyword) || keyword.includes(r.keyword));
  if (j < 0) return null;
  const r = d.rows[j];
  return { at: d.at, rising_score: r.rising_score, day_new: r.day_new, week_new: r.week_new, ac_width: r.ac_width, datalab_ratio: r.datalab_ratio ?? null,
    rank: j + 1, of: d.rows.length, trend_traffic: r.evidence.trend ? r.evidence.trend.traffic : 0 };
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { trends, suggest, runLane, keywordScore };

// 뉴스 채널 아웃라이어 — 레인별 뉴스 채널의 최근 48시간 정치 롱폼 중 «채널 평소의 3배 이상» 조회를 뽑아 키워드 후보로 낸다
// (10-20 소유주 지시, 관리자 명세). 발굴용 키(.env YOUTUBE_API_KEY_SEARCH)로 channels·playlistItems·videos.list 만 — 검색 0.
//
//   node scripts/yt_news_outliers.js --lane politics_ko|politics_ja | --all  [--hours 48] [--ratio 3] [--thumbs] [--dry]
//
// 기준: 채널 업로드 목록(UU…)에서 최근 롱폼(8분+, 쇼츠·짧은 클립 제외) 30편의 조회 중앙값(48시간 안 편은 기준에서 뺀다,
//       모자라면 최대 4쪽=200편까지 넘겨 본다). 48시간 안 롱폼 중 배수 ≥ 3 + 정치 낱말(rising_seeds trend_filter·seeds)이 제목에 있으면 아웃라이어.
// 낱말: 제목 명사·인물(조사 떼기)·«» “” ‘’ 「」 안 발언 인용. --thumbs 면 썸네일 큰 글자를 GPT 1회(여러 장 한 번에, 하루 10장 한도)로 읽는다.
// 출력: server/data/news_outliers/<lane>_latest.json = { at, quota_units, channels:[…], candidates:[{keyword, news_outlier:{channel, video_id, views, ratio, title_words, thumb_words, quotes}}] }
//       — 정치 세션 keywords.json candidates 에 그대로 옮겨 쓸 수 있는 꼴. 레인 파일은 건드리지 않는다.
//       rising_keywords.js 가 이 파일을 읽어 같은 낱말 후보에 배수 점수를 더한다(newsOutlierScore).
// 403/429·키 없음 = 멈추고 소리 낸다(gate_errors.jsonl), 다른 키로 넘어가지 않는다.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CFG = path.join(ROOT, 'config', 'news_channels.json');
const SEEDS = path.join(ROOT, 'config', 'rising_seeds.json');
const OUT = path.join(ROOT, 'server', 'data', 'news_outliers');
const LEDGER = path.join(ROOT, 'server', 'data', 'gate_errors.jsonl');
const THUMB_DAY = 10;
let units = 0;

function apiKey() {
  const env = (() => { try { return fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch { return ''; } })();
  const line = env.split(/\r?\n/).find((l) => l.startsWith('YOUTUBE_API_KEY_SEARCH='));
  return line ? line.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '') : null;
}

class Stop extends Error {}

const quota = require('./api_quota');   // 발굴 키 쿼터 장부(10-20) — 호출마다 기록, 상한·중지면 호출 전에 멈춤

async function yt(key, endpoint, params) {
  const q = new URLSearchParams({ ...params, key }).toString();
  try { quota.spend('yt_news_outliers', endpoint); } catch (e) { if (e instanceof quota.QuotaStop) throw new Stop(e.message); throw e; }
  units += 1;
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${q}`);
  if (r.status === 403 || r.status === 429) { quota.markBlocked('yt_news_outliers', `${endpoint} ${r.status}`); throw new Stop(`${endpoint} ${r.status} — 발굴용 키 한도·권한, 오늘은 멈춤`); }
  if (!r.ok) throw new Error(`${endpoint} ${r.status}`);
  return r.json();
}

const isoSec = (d) => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || '') || []; return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0); };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };

async function resolve(key, lane, chans) {
  const cache = path.join(OUT, 'channels_resolved.json');
  const C = fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, 'utf8')) : {};
  for (const c of chans) {
    const k = c.id || c.handle;
    if (C[k]) continue;
    if (c.id) { C[k] = { id: c.id, title: c.name }; continue; }
    const j = await yt(key, 'channels', { part: 'snippet', forHandle: c.handle.replace(/^@/, '') });
    const it = (j.items || [])[0];
    C[k] = it ? { id: it.id, title: it.snippet.title } : { id: null, title: null };
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(C, null, 2) + '\n', 'utf8');
  return chans.map((c) => ({ ...c, ...C[c.id || c.handle] }));
}

async function channelVideos(key, chId, since, minBase = 30) {
  const pl = 'UU' + chId.slice(2);
  let page = '', vids = [];
  for (let n = 0; n < 4; n++) {
    const j = await yt(key, 'playlistItems', { part: 'contentDetails', playlistId: pl, maxResults: 50, ...(page ? { pageToken: page } : {}) });
    const ids = (j.items || []).map((x) => x.contentDetails.videoId);
    if (!ids.length) break;
    const v = await yt(key, 'videos', { part: 'snippet,statistics,contentDetails', id: ids.join(','), maxResults: 50 });
    vids = vids.concat((v.items || []).map((x) => ({
      id: x.id, title: x.snippet.title, pub: Date.parse(x.snippet.publishedAt), sec: isoSec(x.contentDetails.duration),
      views: +x.statistics.viewCount || 0, thumb: (x.snippet.thumbnails.high || x.snippet.thumbnails.medium || x.snippet.thumbnails.default || {}).url,
    })));
    const base = vids.filter((x) => x.sec >= 480 && x.pub < since);
    if (base.length >= minBase || !j.nextPageToken) break;
    page = j.nextPageToken;
  }
  return vids;
}

const JOSA_KO = /(은|는|이|가|을|를|에|의|도|로|으로|과|와|께|에게|에서|까지|부터|만|이란|란|라|이라)$/;
function titleWords(title, lang, channel = '') {
  // 꼬리(« / 채널명», « - [LIVE] 프로그램 날짜», «(26.10.19)»)와 [대괄호 꼭지명]은 낱말에서 뺀다
  title = title.replace(/\s+\/\s+[^/]*$/, '').replace(/\s+-\s+\[[^\]]*\].*$/, '').replace(/\(\d{2}\.\d{1,2}\.\d{1,2}\)/g, ' ')
    .replace(/\[[^\]]*\]|【[^】]*】/g, ' ');
  const quotes = [...title.matchAll(/[«“"‘'「『]([^»”"’'」』]{2,40})[»”"’'」』]/g)].map((m) => m[1].trim());
  let t = title;
  for (const q of quotes) t = t.replace(q, ' ');
  const toks = lang === 'ko'
    ? t.split(/[\s,·…!?|/\[\]()<>{}:;~"'“”‘’«»「」『』.]+/).map((w) => w.replace(JOSA_KO, '')).filter((w) => /^[가-힣A-Za-z0-9]{2,}$/.test(w))
    : (t.match(/[一-龯々ァ-ヶー]{2,}/g) || []);
  const stop = new Set(['단독', '속보', '영상', '뉴스', '오늘', '이번', '현장', '라이브', 'LIVE', '풀영상', '다시보기', 'live', 'shorts', 'News', 'NEWS']);
  const chan = new Set(String(channel).split(/[\s()（）]+/).filter(Boolean));
  const keep = (w) => !stop.has(w) && !chan.has(w) && !/^\d+(년|월|일|시|분)?$/.test(w) &&
    !(lang === 'ko' && w.length >= 3 && /(한|던|린|힌|온|운|된|진|난|친|는)$/.test(w));   // «경고한·짓눌린·막힌» 같은 꾸밈말
  return { words: [...new Set(toks.filter(keep))].slice(0, 8), quotes };
}

function thumbsToday() {
  const f = path.join(OUT, 'thumb_calls.json');
  const day = new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10);
  const d = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  return { f, day, used: d[day] || 0, d };
}

async function readThumbs(rows) {
  const T = thumbsToday();
  const room = Math.max(0, THUMB_DAY - T.used);
  const pick = rows.slice(0, room);
  if (!pick.length) return { calls: 0, note: `썸네일 판독 하루 ${THUMB_DAY}장 한도 소진` };
  const dir = path.join(OUT, 'thumbs');
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const r of pick) {
    const f = path.join(dir, `${r.video_id}.jpg`);
    if (!fs.existsSync(f)) fs.writeFileSync(f, Buffer.from(await (await fetch(r.thumb)).arrayBuffer()));
    files.push(f);
  }
  const prompt = `첨부한 유튜브 썸네일 ${files.length}장(순서대로 ${pick.map((r) => r.video_id).join(', ')})에 크게 박힌 글자만 읽어라. ` +
    'JSON 한 줄만 답: {"<video_id>": ["큰 글자 덩어리", ...], ...}. 글자가 없으면 빈 배열. 해석·설명 금지.';
  const args = [path.join(ROOT, 'scripts', 'gpt-ask.js'), '--no-search', '--session', '도구개발 news_outliers', ...files.flatMap((f) => ['--attach', f]), prompt];
  let out = '';
  try { out = execFileSync('node', args, { encoding: 'utf8', timeout: 15 * 60 * 1000 }); } catch (e) { return { calls: 1, note: `GPT 실패(${e.status}) — 썸네일 낱말 비움` }; }
  T.d[T.day] = T.used + pick.length;
  fs.writeFileSync(T.f, JSON.stringify(T.d, null, 2) + '\n', 'utf8');
  const m = out.match(/\{[\s\S]*\}/);
  try {
    const j = JSON.parse(m ? m[0] : '{}');
    for (const r of pick) r.thumb_words = Array.isArray(j[r.video_id]) ? j[r.video_id] : [];
    return { calls: 1, note: `썸네일 ${pick.length}장 판독` };
  } catch { return { calls: 1, note: 'GPT 답이 JSON 이 아님 — 썸네일 낱말 비움' }; }
}

async function runLane(lane, opts, key) {
  const CF = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  const cfg = CF.lanes[lane];
  const flt = (CF.filters || {})[lane] || { foreign: [], domestic: [] };
  const S = JSON.parse(fs.readFileSync(SEEDS, 'utf8')).lanes[lane] || {};
  const lang = S.lang || (lane.endsWith('_ja') ? 'ja' : 'ko');
  const polWords = [...(S.trend_filter || []), ...(S.seeds || []), ...(((JSON.parse(fs.readFileSync(CFG, 'utf8')).filters || {})[lane] || {}).political_extra || [])];
  const now = Date.now();
  const since = now - opts.hours * 36e5;
  const chans = await resolve(key, lane, cfg);
  const chanRows = [];
  const rows = [];
  for (const c of chans) {
    if (!c.id) { chanRows.push({ name: c.name, handle: c.handle, error: 'handle 못 풂 — config 에 id 를 적어라' }); continue; }
    let vids;
    try { vids = await channelVideos(key, c.id, since); } catch (e) {
      if (e instanceof Stop) throw e;
      chanRows.push({ name: c.name, handle: c.handle, id: c.id, error: `업로드 목록 못 읽음(${e.message}) — handle 이 다른 채널을 가리키는지 확인` });
      continue;
    }
    const longs = vids.filter((v) => v.sec >= 480);
    const base = longs.filter((v) => v.pub < since).slice(0, 30);
    // 하루 수십 편 올리는 방송사는 200편 안에 48시간 넘은 롱폼이 없다 → 그때는 «최근 롱폼 30편»(명세 그대로) 중앙값
    const med = median((base.length >= 5 ? base : longs.slice(0, 30)).map((v) => v.views));
    const recent = longs.filter((v) => v.pub >= since);
    chanRows.push({ name: c.name, title: c.title, id: c.id, scanned: vids.length, long_recent: recent.length, base_n: base.length, median: med });
    for (const v of recent) {
      const ratio = med ? v.views / med : 0;
      const foreign = flt.foreign.some((w) => v.title.includes(w)) && !flt.domestic.some((w) => v.title.includes(w));
      const political = polWords.some((w) => v.title.includes(w)) && !foreign;
      if (ratio >= opts.ratio && political) {
        const tw = titleWords(v.title, lang, c.title || c.name);
        rows.push({ channel: c.title || c.name, video_id: v.id, title: v.title, views: v.views, ratio: Math.round(ratio * 10) / 10,
          hours: Math.round((now - v.pub) / 36e5), sec: v.sec, title_words: tw.words, quotes: tw.quotes, thumb_words: [], thumb: v.thumb });
      }
    }
  }
  rows.sort((a, b) => b.ratio - a.ratio);
  const th = opts.thumbs && rows.length ? await readThumbs(rows) : { calls: 0, note: opts.thumbs ? '아웃라이어 없음' : '썸네일 판독 안 함(--thumbs)' };
  const kw = new Map();
  for (const r of rows) for (const w of [...r.title_words, ...r.quotes]) if (!kw.has(w)) kw.set(w, r);
  const candidates = [...kw.entries()].map(([keyword, r]) => ({ keyword, news_outlier: { channel: r.channel, video_id: r.video_id, views: r.views, ratio: r.ratio,
    title_words: r.title_words, thumb_words: r.thumb_words, quotes: r.quotes } }));
  const res = { at: new Date(now).toISOString(), lane, hours: opts.hours, ratio_min: opts.ratio, quota_units: units, gpt: th, channels: chanRows,
    outliers: rows.map(({ thumb, ...r }) => r), candidates };
  if (!opts.dry) {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${lane}_latest.json`), JSON.stringify(res, null, 2) + '\n', 'utf8');
  }
  console.log(`\n== ${lane} · 채널 ${chanRows.length} · 아웃라이어 ${rows.length} · 후보 낱말 ${candidates.length} · 쿼터 누적 ${units}단위 · ${th.note}`);
  for (const c of chanRows) console.log(c.error ? `  ✗ ${c.name} ${c.handle}: ${c.error}` : `  ${c.title} · 훑음 ${c.scanned} · 48h 롱폼 ${c.long_recent} · 기준 ${c.base_n}편 중앙 ${Math.round(c.median).toLocaleString()}`);
  for (const r of rows.slice(0, 10)) console.log(`  ★ ${r.ratio}× ${r.views.toLocaleString()} ${r.channel} «${r.title}» → ${r.title_words.join('·')}${r.quotes.length ? ' / 인용 ' + r.quotes.join('·') : ''}`);
  return res;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
  const lanes = argv.includes('--all') ? Object.keys(JSON.parse(fs.readFileSync(CFG, 'utf8')).lanes) : [opt('--lane')].filter(Boolean);
  if (!lanes.length) { console.log('usage: --lane politics_ko|politics_ja | --all [--hours 48] [--ratio 3] [--thumbs] [--dry]'); process.exit(2); }
  const opts = { hours: +opt('--hours', 48), ratio: +opt('--ratio', 3), thumbs: argv.includes('--thumbs'), dry: argv.includes('--dry') };
  const key = apiKey();
  const loud = (msg) => {
    console.log(`⚠ 뉴스 아웃라이어 중단: ${msg}`);
    fs.appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), gate: 'yt_news_outliers', lane: lanes.join(','), error: msg }) + '\n', 'utf8');
  };
  if (!key) { loud('.env 에 YOUTUBE_API_KEY_SEARCH 없음'); process.exit(5); }
  try {
    for (const l of lanes) await runLane(l, opts, key);
  } catch (e) {
    loud(`${e.message} (쿼터 ${units}단위 쓴 뒤)`);
    process.exit(e instanceof Stop ? 9 : 5);
  }
  console.log(`쿼터 사용 ${units}단위(검색 0)`);
}

// rising_keywords 가 부른다: 낱말 q 가 최신 아웃라이어 낱말·인용·제목에 있으면 { ratio, pts(최대 10), video_id, channel }
function newsOutlierScore(lane, q) {
  const f = path.join(OUT, `${lane}_latest.json`);
  if (!fs.existsSync(f)) return null;
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (Date.now() - Date.parse(d.at) > 3 * 864e5) return null;   // 사흘 지난 결과는 쓰지 않는다
  const parts = q.split(/\s+/).filter(Boolean);
  const hit = (d.outliers || []).filter((r) => parts.every((w) => r.title.includes(w) || r.thumb_words.some((t) => t.includes(w))));
  if (!hit.length) return null;
  const best = hit.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  return { ratio: best.ratio, pts: Math.min(10, Math.round(3 * Math.log2(best.ratio) * 10) / 10), video_id: best.video_id, channel: best.channel, n: hit.length };
}

module.exports = { newsOutlierScore, titleWords };

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

// 경쟁 제목 나란히(10-21 자료 점검 G18 · 하늘구름땅바람 S1) — 키워드로 최근 N일 조회순 영상 제목·조회를 우리 제목 옆에 놓는다. 월 1회·포장 바꿀 때.
//
//   node scripts/title_words.js "<키워드>" [--ours "<우리 제목>"] [--lang ko|ja] [--days 30] [--n 10] [--lane politics_ko]
//
// 발굴용 키(.env YOUTUBE_API_KEY_SEARCH) — search.list 100단위 + videos.list 1단위 = 키워드당 101단위, api_quota «title_words» 상한 안에서만.
// 403·429 는 api_quota.markBlocked 하고 그 자리에서 멈춘다(우회 금지). 키 값은 찍지 않는다.
// 출력: 표(순위·제목·조회·채널·공개일·앞 10자) + 상위 제목 반복 낱말 + 우리 제목 앞 10자 → server/data/title_words/<날짜>_<키워드>.{json,md}
const fs = require('fs');
const path = require('path');
const quota = require('./api_quota');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'server', 'data', 'title_words');
const TOOL = 'title_words';

class Stop extends Error {}

function apiKey() {
  const env = (() => { try { return fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch { return ''; } })();
  const line = env.split(/\r?\n/).find((l) => l.startsWith('YOUTUBE_API_KEY_SEARCH='));
  return line ? line.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '') : null;
}

async function yt(key, endpoint, params) {
  const b = quota.blocked();
  if (b) throw new Stop(`오늘 발굴 키 중지 상태(${b})`);
  try { quota.spend(TOOL, endpoint); } catch (e) { if (e instanceof quota.QuotaStop) throw new Stop(e.message); throw e; }
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${new URLSearchParams({ ...params, key })}`);
  if (r.status === 403 || r.status === 429) { quota.markBlocked(TOOL, `${endpoint} ${r.status}`); throw new Stop(`${endpoint} ${r.status} — 오늘은 멈춤`); }
  const j = await r.json();
  if (!r.ok) throw new Error(`${endpoint} ${r.status} ${(j.error && j.error.message || '').slice(0, 80)}`);
  return j;
}

function repeated(titles, k = 10) {
  const c = {};
  for (const t of titles) for (const w of new Set(String(t).replace(/#\S+/g, ' ').match(/[가-힣]{2,}|[一-龥々]{2,}|[ァ-ヶー]{2,}|[A-Za-z]{3,}/g) || [])) c[w] = (c[w] || 0) + 1;
  return Object.entries(c).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, k);
}

function md(res) {
  const L = [`# 경쟁 제목 — «${res.keyword}» 최근 ${res.days}일 조회순 (${res.at.slice(0, 10)})`, ''];
  if (res.ours) L.push(`- 우리 제목: «${res.ours}» · 앞 10자 «${res.ours.slice(0, 10)}»`);
  L.push(`- 상위 제목 반복 낱말: ${res.repeated.map(([w, n]) => `${w} ${n}`).join(' · ') || '-'}`, '',
    '| # | 제목 | 조회 | 채널 | 공개일 | 앞 10자 |', '|---|---|---|---|---|---|',
    ...res.rows.map((r, i) => `| ${i + 1} | ${r.title.replace(/\|/g, '/')} | ${r.views.toLocaleString()} | ${r.channel} | ${r.published.slice(0, 10)} | ${r.title.slice(0, 10)} |`), '');
  return L.join('\n');
}

async function titleWords(keyword, { ours = null, lang = 'ko', days = 30, n = 10 } = {}) {
  const key = apiKey();
  if (!key) throw new Stop('.env 에 YOUTUBE_API_KEY_SEARCH 없음');
  const s = await yt(key, 'search', { part: 'snippet', q: keyword, type: 'video', order: 'viewCount', maxResults: n,
    publishedAfter: new Date(Date.now() - days * 864e5).toISOString(), regionCode: lang === 'ja' ? 'JP' : 'KR', relevanceLanguage: lang });
  const ids = (s.items || []).map((x) => x.id.videoId).filter(Boolean);
  const v = ids.length ? await yt(key, 'videos', { part: 'snippet,statistics', id: ids.join(',') }) : { items: [] };
  const rows = (v.items || []).map((x) => ({ id: x.id, title: x.snippet.title, channel: x.snippet.channelTitle, published: x.snippet.publishedAt, views: +x.statistics.viewCount || 0 }))
    .sort((a, b) => b.views - a.views);
  const res = { at: new Date().toISOString(), keyword, ours, lang, days, rows, repeated: repeated(rows.map((r) => r.title)) };
  fs.mkdirSync(OUT, { recursive: true });
  const base = path.join(OUT, `${new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10).replace(/-/g, '')}_${keyword.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(res, null, 2) + '\n', 'utf8');
  fs.writeFileSync(`${base}.md`, md(res), 'utf8');
  return { ...res, out: `${base}.md` };
}

module.exports = { titleWords, repeated, md };

if (require.main === module) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  const kw = a.find((x, i) => !x.startsWith('--') && (i === 0 || !a[i - 1].startsWith('--')));
  if (!kw) { console.log('usage: node scripts/title_words.js "<키워드>" [--ours "<우리 제목>"] [--lang ko|ja] [--days 30] [--n 10]'); process.exit(2); }
  titleWords(kw, { ours: opt('--ours'), lang: opt('--lang') || 'ko', days: +(opt('--days') || 30), n: +(opt('--n') || 10) })
    .then((r) => { console.log(md(r)); console.log(`→ ${path.relative(ROOT, r.out)} · 쿼터 ${quota.summary()}`); })
    .catch((e) => { console.error(`멈춤: ${e.message}`); process.exit(e instanceof Stop ? 3 : 1); });
}

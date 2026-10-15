// 소재 고르기 전 경쟁 강도 — «인기는 있는데 지금 아무도 안 올리는» 작품을 찾는다.
//
//   node scripts/rinbox-competition.js "중증외상센터" ["무빙" ...] [--days 30] [--lang ko|ja] [--must "토큰|토큰"]
//   검색어@토큰1|토큰2  — 작품별로 «제목·설명에 반드시 있어야 할 말»을 따로 준다. 예: "룸 영화@룸|Room"
//   모듈로: const { checkWork } = require('./rinbox-competition'); await checkWork('세인트 빈센트', { must: ['세인트빈센트'] })
//
// 오염 필터 (2026-10-12 명화관 요청): 흔한 제목은 검색 결과가 딴 영상으로 찬다
//   («세인트 빈센트» → 연봉·스포츠·성경 채널, «기프티드 핸즈» → 인도 채널 16편). 그래서 수요·공급 둘 다
//   제목+설명(띄어쓰기·대소문자 무시)에 토큰이 실제로 든 결과만 센다. 기본 토큰 = 띄어쓰기 뺀 작품명.
//   걸러진 개수를 같이 찍는다 — 많이 걸러졌으면 토큰을 다시 보라.
//
// 왜 (2026-10-12 소유주 전자책 2장, «다 사실이니 시스템으로»):
//   · 결국 소재 싸움이다. 이미 10개 채널이 올리고 있는 소재는 중복도에 걸리고 재사용까지 맞는다.
//   · 반대로 신고로 경쟁 채널이 쓸려 나간 소재는 인기는 그대로인데 올리는 사람이 없다(왕좌의 게임 사례).
//   · 판정은 두 가지를 같이 본다 — 수요(그 작품 쇼츠가 역대 얼마나 나왔나) · 공급(최근 N일에 몇 채널이 올리나).
// 비용: search.list 1회 100 단위 × 작품당 2회. 하루 기본 한도 10,000 이면 50작품까지.
require('dotenv').config({ path: 'D:/midform/.env' });
const KEY = process.env.YOUTUBE_API_KEY_SEARCH || process.env.YOUTUBE_API_KEY || process.env.YT_API_KEY;


// 공식·방송사 채널은 경쟁 상대가 아니다(우리가 소재로 쓰는 쪽).
const OFFICIAL = /(netflix|넷플릭스|disney|디즈니|tving|티빙|wavve|웨이브|coupang|쿠팡|sbs|kbs|mbc|jtbc|tvn|ena|채널a|mbn|tv조선|東映|toei|テレビ|abema)/i;

async function search(q, extra, lang) {
  const u = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=50'
    + `&videoDuration=short&relevanceLanguage=${lang}&q=${encodeURIComponent(q)}${extra}&key=${KEY}`;
  const r = await (await fetch(u)).json();
  if (r.error) throw new Error(r.error.message);
  return r.items || [];
}

async function stats(ids) {
  if (!ids.length) return new Map();
  const r = await (await fetch('https://www.googleapis.com/youtube/v3/videos?part=statistics&id='
    + ids.slice(0, 50).join(',') + `&key=${KEY}`)).json();
  return new Map((r.items || []).map((v) => [v.id, Number(v.statistics.viewCount || 0)]));
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const fmt = (n) => (n >= 1e4 ? `${(n / 1e4).toFixed(n >= 1e5 ? 0 : 1)}만` : String(n));

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
const relevant = (x, tokens) => {
  const hay = norm(`${x.snippet.title} ${x.snippet.description}`);
  return tokens.some((tk) => hay.includes(tk));
};

function verdictOf(demand, supply, recMedian) {
  if (demand >= 1e6 && supply <= 3) return '★빈 자리 — 수요 크고 올리는 채널 적음';
  if (demand >= 1e5 && supply <= 5) return '진입 가능';
  if (supply >= 10 && recMedian < 1e4) return '포화 — 다들 올리는데 안 나온다, 넘겨라';
  if (demand < 1e5) return '수요 약함';
  return '경쟁 있음 — 덜 다뤄진 인물·장면으로 좁혀라';
}

// 검색 2회(200 단위) + 통계 2회(2 단위)
async function checkWork(query, { days = 30, lang = 'ko', must } = {}) {
  if (!KEY) throw new Error('YOUTUBE_API_KEY 가 .env 에 없다');
  const tokens = (must && must.length ? must : [query]).map(norm).filter(Boolean);
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const topAll = await search(query, '&order=viewCount', lang);
  const recAll = await search(query, `&order=date&publishedAfter=${since}`, lang);
  const top = topAll.filter((x) => relevant(x, tokens));
  const recent = recAll.filter((x) => relevant(x, tokens));
  const topViews = await stats(top.map((x) => x.id.videoId));
  const recViews = await stats(recent.map((x) => x.id.videoId));
  const tv = top.map((x) => topViews.get(x.id.videoId) || 0).sort((a, b) => b - a);
  const rec = recent.filter((x) => !OFFICIAL.test(x.snippet.channelTitle));
  const chans = new Map();
  for (const x of rec) chans.set(x.snippet.channelTitle, (chans.get(x.snippet.channelTitle) || 0) + 1);
  const rv = rec.map((x) => recViews.get(x.id.videoId) || 0);
  const demand = median(tv.slice(0, 20));
  return {
    query, tokens, days,
    demand, demand_max: tv.length ? tv[0] : 0,
    supply_channels: chans.size, supply_videos: rec.length, supply_median: median(rv),
    dropped: { top: topAll.length - top.length, recent: recAll.length - recent.length },
    busiest: [...chans.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    verdict: verdictOf(demand, chans.size, median(rv)),
  };
}

async function cli() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const days = Number(opt('--days', 30));
  const lang = opt('--lang', 'ko');
  const mustAll = opt('--must', '');
  const works = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  if (!works.length) { console.log('쓰는 법: node scripts/rinbox-competition.js "작품명[@토큰|토큰]" [...] [--days 30] [--lang ko|ja] [--must "토큰|토큰"]'); process.exitCode = 2; return; }
  console.log(`작품  | 수요: 역대 상위 쇼츠 조회 중앙값 · 최고 | 공급: 최근 ${days}일 올린 비공식 채널 수 · 편수 · 조회 중앙값 | 판정`);
  for (const arg of works) {
    const [query, own] = arg.split('@');
    const must = (own || mustAll).split('|').filter(Boolean);
    const r = await checkWork(query, { days, lang, must });
    console.log(`${query} | ${fmt(r.demand)} · ${fmt(r.demand_max)} | ${r.supply_channels}채널 · ${r.supply_videos}편 · ${fmt(r.supply_median)} | ${r.verdict}`);
    console.log(`   토큰 ${r.tokens.join('|')} · 오염 제거 상위 ${r.dropped.top}/50 · 최근 ${r.dropped.recent}/50`);
    if (r.busiest.length) console.log(`   최근 올리는 곳: ${r.busiest.map(([c, n]) => `${c}(${n})`).join(', ')}`);
  }
}

module.exports = { checkWork };
if (require.main === module) cli().catch((e) => { console.log('ERR', e.message); process.exitCode = 1; });

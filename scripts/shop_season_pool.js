// 작년 같은 시즌 쇼핑 레퍼런스 풀 — 10-28 소유주 «시즌별로 팔리는 상품은 비슷하다, 쇼핑 쇼츠가 하루 이틀 된 것도 아니고».
// 작년 오늘-45일 ~ 작년 오늘+60일에 올라온 한국 쇼핑 쇼츠 중 조회 상위를 YouTube Data API 공식 검색으로 모은다(검색 1회 100유닛).
// 터진 첫 장면(훅)은 그 영상에서 자르지 않는다 — 기록만 하고, 원본(더우인 등)을 TikHub 로 찾아 우리 편집으로 쓴다(중복 판정 회피).
// 쓰임: node scripts/shop_season_pool.js [--min-views 100000] [--kw "난방비 절약,문풍지"]
// 출력: server/data/shop_season_pool.json (정본) · docs/shop-season-pool.md (사본) · 호출마다 reference/shop_season_pool/<날짜>/ 캐시
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const KEY = env.YOUTUBE_API_KEY_SEARCH || env.YOUTUBE_API_KEY;
const OUT = path.join(ROOT, 'server', 'data', 'shop_season_pool.json');
const DOC = path.join(ROOT, 'docs', 'shop-season-pool.md');
const SHOP = /쿠팡|파트너스|구매|프로필|링크|제품|인포크|꿀템|추천템|필수템/;
const KW = ['난방비 절약 꿀템', '외풍 차단', '방풍비닐', '문풍지', '창문 단열', '방한 커튼', '난방텐트', '전기요 추천', '온수매트',
  '가습기 추천', '결로 방지', '수면양말', '발난로', '손난로', '김장 꿀템', '김치 보관', '크리스마스 장식', '차량 성에 제거',
  '패딩 세탁', '실내 빨래 건조', '정전기 방지', '겨울 필수템', '보온병 추천', '현관 외풍', '욕실 난방'];

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const MIN_VIEWS = Number(arg('--min-views', 100000));
const kws = arg('--kw') ? arg('--kw').split(',').map((s) => s.trim()).filter(Boolean) : KW;

const today = new Date();
const day = today.toISOString().slice(0, 10);
const from = new Date(today); from.setFullYear(from.getFullYear() - 1); from.setDate(from.getDate() - 45);
const to = new Date(today); to.setFullYear(to.getFullYear() - 1); to.setDate(to.getDate() + 60);
const CACHE = path.join(ROOT, 'reference', 'shop_season_pool', day);
fs.mkdirSync(CACHE, { recursive: true });

async function api(ep, q, cacheName) {
  const cf = path.join(CACHE, cacheName + '.json');
  if (fs.existsSync(cf)) return JSON.parse(fs.readFileSync(cf, 'utf8'));
  const u = `https://www.googleapis.com/youtube/v3/${ep}?${new URLSearchParams({ ...q, key: KEY })}`;
  const r = await fetch(u);
  const j = await r.json();
  if (!r.ok) throw new Error(`${ep} ${r.status} ${JSON.stringify(j.error && j.error.message)}`);
  fs.writeFileSync(cf, JSON.stringify(j, null, 2) + '\n', 'utf8');
  return j;
}

(async () => {
  if (!KEY) throw new Error('.env 에 YOUTUBE_API_KEY_SEARCH/YOUTUBE_API_KEY 없음');
  const hits = new Map();   // id → {kw}
  for (const kw of kws) {
    let j;
    try {
      j = await api('search', { part: 'snippet', q: kw, type: 'video', videoDuration: 'short', order: 'viewCount', regionCode: 'KR', relevanceLanguage: 'ko',
        publishedAfter: from.toISOString(), publishedBefore: to.toISOString(), maxResults: 25 }, 'search_' + kw.replace(/\s+/g, '_'));
    } catch (e) {
      console.error(`검색 멈춤 «${kw}»: ${e.message}`);   // 한도·403 이면 거기서 멈춘다(우회 금지)
      break;
    }
    for (const it of j.items || []) if (!hits.has(it.id.videoId)) hits.set(it.id.videoId, { kw });
  }
  const ids = [...hits.keys()];
  const rows = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const j = await api('videos', { part: 'snippet,statistics,contentDetails', id: chunk.join(','), maxResults: 50 }, `videos_${i}`);
    for (const v of j.items || []) {
      const views = Number(v.statistics.viewCount || 0);
      const title = v.snippet.title || '';
      const blob = `${title}\n${v.snippet.description || ''}\n${(v.snippet.tags || []).join(' ')}`;
      if (views < MIN_VIEWS || !/[가-힣]/.test(title) || !SHOP.test(blob)) continue;
      rows.push({ id: v.id, url: `https://www.youtube.com/shorts/${v.id}`, channel: v.snippet.channelTitle, channel_id: v.snippet.channelId,
        title, views, likes: Number(v.statistics.likeCount || 0), comments: Number(v.statistics.commentCount || 0),
        posted: v.snippet.publishedAt.slice(0, 10), kw: hits.get(v.id).kw });
    }
  }
  rows.sort((a, b) => b.views - a.views);
  const pool = { updated: day, window: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }, min_views: MIN_VIEWS, keywords: kws,
    note: '작년 같은 시즌에 터진 쇼핑 쇼츠. 소재·훅 장면 기록용 — 화면은 이 영상에서 자르지 않고 원본을 찾아 쓴다.', rows };
  fs.writeFileSync(OUT, JSON.stringify(pool, null, 2) + '\n', 'utf8');
  const md = [`# 작년 같은 시즌 쇼핑 레퍼런스 (자동 생성 ${day})`, '',
    `정본은 \`server/data/shop_season_pool.json\`. 창 ${pool.window.from} ~ ${pool.window.to}, 조회 ${MIN_VIEWS.toLocaleString()} 이상, ${rows.length}편.`,
    '화면은 이 영상에서 자르지 않는다 — 첫 장면을 기록하고 더우인 원본을 찾아 우리 편집으로 쓴다.', '',
    '| 제목 | 채널 | 조회 | 올린 날 | 검색어 |', '|---|---|---|---|---|',
    ...rows.map((r) => `| [${r.title.replace(/\|/g, '/')}](${r.url}) | ${r.channel} | ${r.views.toLocaleString()} | ${r.posted} | ${r.kw} |`)].join('\n');
  fs.writeFileSync(DOC, md + '\n', 'utf8');
  console.log(`작년 시즌 풀 ${rows.length}편 (후보 ${ids.length}) · ${pool.window.from}~${pool.window.to} → ${path.relative(ROOT, OUT)}`);
})().catch((e) => { console.error(e.message); process.exit(1); });

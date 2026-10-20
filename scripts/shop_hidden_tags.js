// 경쟁 영상 숨은 태그 → 메타 ref_tags (10-21 관리자 G23, 전자책 06·카이안 7-2 «숨은 태그»).
// 유튜브 화면에는 안 보이는 snippet.tags 를 같은 키워드로 검색한 상위 영상에서 읽어 2편 이상 겹친 것만 남긴다.
// buildTags(shop_yt_tags.js)가 키워드 3개 뒤에 넣고, 다른 태그처럼 원고에 없는 낱말은 거른다(tag_gate 원고 일치 ≥50%).
// 같은 때 meta.shopping_tag(유튜브 쇼핑 상품 태그 형식)를 채운다 — 제휴 진입 전이라 상품 id 는 비워 두고 status 만 «제휴 전».
//
//   node scripts/shop_hidden_tags.js <메타.json> [--dry-run]     — search.list 100 + videos.list 1 단위(쇼핑 업로드 프로필 OAuth)
const fs = require('fs');
const { headers } = require('./shop_yt_tags');

const TOP = 10;      // 키워드마다 상위 몇 편
const MIN_N = 2;     // 몇 편 이상에서 겹친 태그만

async function hiddenTags(kw, H) {
  const q = new URLSearchParams({ part: 'snippet', q: kw, type: 'video', regionCode: 'KR', relevanceLanguage: 'ko', maxResults: String(TOP) });
  const s = await (await fetch(`https://www.googleapis.com/youtube/v3/search?${q}`, { headers: H })).json();
  if (s.error) throw new Error(`search ${JSON.stringify(s.error).slice(0, 200)}`);
  const ids = (s.items || []).map((x) => x.id.videoId).filter(Boolean);
  if (!ids.length) return [];
  const v = await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids.join(',')}`, { headers: H })).json();
  return (v.items || []).map((x) => ({ id: x.id, tags: (x.snippet.tags || []).map((t) => t.trim()).filter(Boolean) }));
}

async function run(metaPath, { dryRun = false } = {}) {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const kws = (Array.isArray(meta.keywords) ? meta.keywords : []).map((k) => k && k.kw).filter(Boolean);
  if (!kws.length) throw new Error('meta.keywords 없음 — shop_keyword_check 앞 단계부터');
  const H = await headers();
  const count = new Map();
  let seen = 0, tagged = 0;
  for (const kw of kws.slice(0, 1)) {   // 쿼터: 첫 키워드 하나만(search.list 100 단위)
    for (const v of await hiddenTags(kw, H)) {
      seen++;
      if (v.tags.length) tagged++;
      for (const t of new Set(v.tags)) { const c = count.get(t) || { tag: t, n: 0, from: [] }; c.n++; c.from.push(v.id); count.set(t, c); }
    }
  }
  const ref = [...count.values()].filter((c) => c.n >= MIN_N && !kws.includes(c.tag)).sort((a, b) => b.n - a.n).slice(0, 15);
  meta.ref_tags = { kw: kws[0], videos: seen, with_tags: tagged, at: new Date().toISOString(), tags: ref };
  meta.shopping_tag = meta.shopping_tag || { product: meta.product || '', url: meta.affiliate_link || '', yt_product_id: null, status: '제휴 전' };
  console.log(`[숨은 태그] «${kws[0]}» 상위 ${seen}편(태그 있는 편 ${tagged}) → ${MIN_N}편+ 겹친 ${ref.length}개: ${ref.map((c) => `${c.tag}(${c.n})`).join(', ') || '없음'}`);
  console.log(`[쇼핑 태그] ${meta.shopping_tag.product.slice(0, 40)} · ${meta.shopping_tag.status}`);
  if (!dryRun) fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return meta.ref_tags;
}

module.exports = { run };

if (require.main === module) {
  const f = process.argv[2];
  if (!f) { console.error('쓰임: node scripts/shop_hidden_tags.js <메타.json> [--dry-run]'); process.exit(2); }
  run(f, { dryRun: process.argv.includes('--dry-run') }).catch((e) => { console.error(`✗ 숨은 태그: ${e.message}`); process.exit(5); });
}

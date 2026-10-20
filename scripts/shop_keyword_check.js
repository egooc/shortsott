// 쇼핑 검색 키워드 관문 — 제목 앞 10자·설명 첫 줄·태그 앞 3개에 meta.keywords 낱말이 없으면 FAIL(종료 코드 4).
// 10/20 소유주 «쇼핑 제목에는 검색 키워드를 넣어야 한다. 왜 반영 안 하나.» — 쇼핑은 상품·문제 검색 의도 레인이라 숏폼이어도 키워드가 맞다.
//   meta.keywords = [{ kw: "논슬립 옷걸이", source: "유튜브 자동완성|네이버 자동완성|네이버 쇼핑 자동완성|쿠팡 검색어", evidence: "<조회한 검색어 → 나온 후보 그대로>" }, ×3]
//   (상품명·문제 낱말·용도 각 1 — 실제로 조회해서 나온 것만)
// 쓰임: node scripts/shop_keyword_check.js <메타.json>
const fs = require('fs');
const path = require('path');

const SOURCES = ['유튜브 자동완성', '네이버 자동완성', '네이버 쇼핑 자동완성', '쿠팡 검색어'];
const squash = (s) => String(s || '').replace(/[\s#/?？!！.,~…'"«»·:;()]/g, '');

function check(metaPath) {
  const out = [];
  const add = (ok, item, msg) => out.push({ ok, item, msg });
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) { return { code: 5, out: [{ ok: false, item: '입력', msg: `메타를 못 읽음: ${e.message}` }] }; }
  const kws = Array.isArray(meta.keywords) ? meta.keywords : [];
  const bad = kws.filter((k) => !k || !squash(k.kw) || !SOURCES.includes(k.source) || !String(k.evidence || '').trim());
  add(kws.length === 3 && !bad.length, '키워드 3개',
    kws.length !== 3 ? `keywords 는 3개여야 함(지금 ${kws.length})` : bad.length ? `kw·source(${SOURCES.join('/')})·evidence 빠진 항목 ${bad.length}개`
      : kws.map((k) => `«${k.kw}»(${k.source})`).join(' · '));
  const K = kws.map((k) => squash(k && k.kw)).filter(Boolean);
  const title = squash(String(meta.title || '').replace(/#\S+/g, ''));
  const head = title.slice(0, 10);
  const inHead = K.filter((k) => head.includes(k));
  add(inHead.length > 0, '제목 앞 10자', `«${String(meta.title || '').replace(/#\S+/g, '').trim()}» 앞 10자 «${head}»${inHead.length ? ` ← ${inHead.join(',')}` : ' — 키워드 없음'}`);
  const first = String(meta.description || '').split('\n').find((l) => l.trim()) || '';
  const inDesc = K.filter((k) => squash(first).includes(k));
  add(inDesc.length > 0, '설명 첫 줄', `${inDesc.length ? inDesc.join(',') : '키워드 없음'} — «${first.slice(0, 50)}…»`);
  const tags = require('./shop_yt_tags').buildTags(meta).slice(0, 3).map(squash);
  const tagOk = K.length === 3 && K.every((k) => tags.includes(k));
  add(tagOk, '태그 앞 3개', `${tags.join(', ')}${tagOk ? '' : ' — keywords 3개와 다름'}`);
  return { code: out.every((x) => x.ok) ? 0 : 4, out };
}

module.exports = { check, SOURCES };

if (require.main === module) {
  const f = process.argv[2];
  if (!f) { console.error('쓰임: node scripts/shop_keyword_check.js <메타.json>'); process.exit(2); }
  const r = check(f);
  for (const x of r.out) console.log(`${x.ok ? '✓' : '✗'} ${x.item}: ${x.msg}`);
  if (r.code) console.error(`\x07✗✗✗ 키워드 관문 ${r.code === 5 ? '검사 불가' : 'FAIL'} — ${path.basename(f)} 업로드 금지`);
  else console.log(`✓ 키워드 관문 통과 — ${path.basename(f)}`);
  process.exit(r.code);
}

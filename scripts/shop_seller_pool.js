// 쇼핑 소재 후보표 — 경쟁 쇼핑 채널 레퍼런스 풀(10-25 소유주: «터졌던 영상 기준 재가공·풀 계속 늘리기·인스타 위주»).
// 풀: reference/shop_comp_1025/hits30.json(발굴 납품 162편) + D:/volcano-runs/_cand/refs/seller_pool_extra.json(발굴이 늘리는 쪽, 같은 항목 모양·인스타는 platform:'instagram').
// 항목: {id,ch,views,x,date:'YYYYMMDD',title,url?,platform?}.  후보 = 배수≥3 · 올린 지 90일 안(10-25 소유주: 30→90, 계절은 따로) · 이미 쓴 영상 제외. 계절 맞는 것(지금 10~2월 = 겨울 상품) 먼저, 계절 반대 상품은 뺀다. 그다음 최근 30일 → 상품군이 겹친 채널 수 많은 순.
//   node scripts/shop_seller_pool.js         → D:/volcano-runs/_cand/refs/seller_pool_YYYYMMDD.md 와 .json
const fs = require('fs');
const path = require('path');
const GROUPS = [['겨울 외풍·방풍', /외풍|방풍|바람막이|단열|틈막이|문풍지|뽁뽁/], ['공간 분리·수납', /공간 ?분리|가림막|파티션|2층 ?침대|틈새 ?선반|수납/], ['비닐·온실', /비닐|온실|하우스|보온/], ['차량', /차량|세차|데칼|코인 ?타월|자동차|트럭/], ['밭일·농기구', /밭|농기구|비료|도랑|파라솔|텃밭/], ['배수구', /배수구|하수구/], ['주방 손질', /주방|칼|도마|손질|스푼|채칼/]];
// 계절(10-25 소유주 «90일로 늘리고 계절을 따로 고려»): 10~2월 = 겨울, 5~8월 = 여름, 3·4·9월 = 간절기(제한 없음)
const WINTER = /외풍|방풍|바람막이|단열|뽁뽁|난방|히터|전기장판|보온|핫팩|온실|비닐하우스|김장|겨울|제설|성에|결로/;
const SUMMER = /선풍기|에어컨|모기|제습|냉감|쿨|여름|물놀이|캠핑 ?의자|아이스|제초|벌레/;
const season = () => { const m = new Date(Date.now() + 9 * 3600000).getUTCMonth() + 1; return m >= 10 || m <= 2 ? 'winter' : (m >= 5 && m <= 8 ? 'summer' : 'mid'); };
const REFS = 'D:/volcano-runs/_cand/refs';
const load = (f) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(j) ? j : Object.values(j); } catch (e) { return []; } };
const kst = () => new Date(Date.now() + 9 * 3600000);
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const urlOf = (h) => h.url || (h.platform === 'instagram' ? `https://www.instagram.com/reel/${h.id}/` : `https://www.youtube.com/shorts/${h.id}`);

const hits = [...load('D:/midform/reference/shop_comp_1025/hits30.json'), ...load(`${REFS}/seller_pool_extra.json`)];
const used = new Set();
for (const f of fs.readdirSync('D:/volcano-runs/_upload').filter((x) => /^ff.*\.json$/.test(x))) {
  try { const m = JSON.parse(fs.readFileSync(`D:/volcano-runs/_upload/${f}`, 'utf8')); const u = m.ref_seller && m.ref_seller.url; if (u) used.add(u); } catch (e) { /* 건너뜀 */ }
}
const nowMs = kst().getTime();
const age = (h) => { const d = String(h.date || ''); return Math.floor((nowMs - Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) - 9 * 3600000) / 86400000); };
const groupOf = (h) => (GROUPS.find(([, re]) => re.test(`${h.title} ${h.desc || ''}`)) || ['기타'])[0];
let c = hits.filter((h) => h.x >= 3 && age(h) <= 90 && !used.has(urlOf(h))).map((h) => ({ ...h, url: urlOf(h), group: groupOf(h), age: age(h), inSeason: season() === 'winter' ? WINTER.test(`${h.title} ${h.desc || ''}`) : season() === 'summer' ? SUMMER.test(`${h.title} ${h.desc || ''}`) : false, offSeason: season() === 'winter' ? SUMMER.test(`${h.title} ${h.desc || ''}`) : season() === 'summer' ? WINTER.test(`${h.title} ${h.desc || ''}`) : false })).filter((h) => !h.offSeason);
const chans = {};
for (const h of c) (chans[h.group] = chans[h.group] || new Set()).add(h.ch);
c.forEach((h) => { h.overlap = h.group === '기타' ? 1 : chans[h.group].size; });
c.sort((a, b) => (b.inSeason - a.inSeason) || ((b.age <= 30) - (a.age <= 30)) || ((b.overlap >= 2) - (a.overlap >= 2)) || (b.overlap - a.overlap) || (b.x - a.x));
const out = [`# 쇼핑 소재 후보 — 경쟁 채널 레퍼런스 풀 ${ymd(kst())}`, '', `후보 ${c.length}개(배수≥3·90일 안·미사용·계절 반대 제외). «겹침» = 같은 상품군을 올린 채널 수(2+ 먼저). plan.ref_seller 에 채널·url·views·mult·posted 를 그대로 옮긴다.`, '', '| 계절 | 겹침 | 상품군 | 채널 | 조회 | 배수 | 올린 날 | 제목 | 링크 |', '|---|---:|---|---|---:|---:|---|---|---|'];
for (const h of c) out.push(`| ${h.inSeason ? '★제철' : (h.age <= 30 ? '최근' : '-')} | ${h.overlap} | ${h.group} | ${h.ch} | ${h.views.toLocaleString()} | ×${Math.round(h.x)} | ${String(h.date).replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3')} | ${String(h.title).replace(/\|/g, '/').slice(0, 50)} | ${h.url} |`);
const day = ymd(kst());
fs.writeFileSync(`${REFS}/seller_pool_${day}.md`, out.join('\n') + '\n', 'utf8');
fs.writeFileSync(`${REFS}/seller_pool_${day}.json`, JSON.stringify(c, null, 2) + '\n', 'utf8');
console.log(`후보 ${c.length}개 → ${REFS}/seller_pool_${day}.md (겹침 2+ ${c.filter((h) => h.overlap >= 2).length}개)`);

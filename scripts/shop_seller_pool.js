// 쇼핑 소재 후보표 — 경쟁 쇼핑 채널 레퍼런스 풀(10-25 소유주: «터졌던 영상 기준 재가공·풀 계속 늘리기·인스타 위주»).
// 풀: reference/shop_comp_1025/hits30.json(발굴 납품 162편) + D:/volcano-runs/_cand/refs/seller_pool_extra.json(발굴이 늘리는 쪽, 같은 항목 모양·인스타는 platform:'instagram').
// 항목: {id,ch,views,x,date:'YYYYMMDD',title,url?,platform?}.  후보 = 배수≥3 · 올린 지 30일 안 · 이미 쓴 영상 제외. 상품군이 겹친 채널 수 많은 것 먼저.
//   node scripts/shop_seller_pool.js         → D:/volcano-runs/_cand/refs/seller_pool_YYYYMMDD.md 와 .json
const fs = require('fs');
const path = require('path');
const GROUPS = [['겨울 외풍·방풍', /외풍|방풍|바람막이|단열|틈막이|문풍지|뽁뽁/], ['공간 분리·수납', /공간 ?분리|가림막|파티션|2층 ?침대|틈새 ?선반|수납/], ['비닐·온실', /비닐|온실|하우스|보온/], ['차량', /차량|세차|데칼|코인 ?타월|자동차|트럭/], ['밭일·농기구', /밭|농기구|비료|도랑|파라솔|텃밭/], ['배수구', /배수구|하수구/], ['주방 손질', /주방|칼|도마|손질|스푼|채칼/]];
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
let c = hits.filter((h) => h.x >= 3 && age(h) <= 30 && !used.has(urlOf(h))).map((h) => ({ ...h, url: urlOf(h), group: groupOf(h), age: age(h) }));
const chans = {};
for (const h of c) (chans[h.group] = chans[h.group] || new Set()).add(h.ch);
c.forEach((h) => { h.overlap = h.group === '기타' ? 1 : chans[h.group].size; });
c.sort((a, b) => (b.overlap >= 2) - (a.overlap >= 2) || b.overlap - a.overlap || b.x - a.x);
const out = [`# 쇼핑 소재 후보 — 경쟁 채널 레퍼런스 풀 ${ymd(kst())}`, '', `후보 ${c.length}개(배수≥3·30일 안·미사용). «겹침» = 같은 상품군을 올린 채널 수(2+ 먼저). plan.ref_seller 에 채널·url·views·mult·posted 를 그대로 옮긴다.`, '', '| 겹침 | 상품군 | 채널 | 조회 | 배수 | 올린 날 | 제목 | 링크 |', '|---:|---|---|---:|---:|---|---|---|'];
for (const h of c) out.push(`| ${h.overlap} | ${h.group} | ${h.ch} | ${h.views.toLocaleString()} | ×${Math.round(h.x)} | ${String(h.date).replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3')} | ${String(h.title).replace(/\|/g, '/').slice(0, 50)} | ${h.url} |`);
const day = ymd(kst());
fs.writeFileSync(`${REFS}/seller_pool_${day}.md`, out.join('\n') + '\n', 'utf8');
fs.writeFileSync(`${REFS}/seller_pool_${day}.json`, JSON.stringify(c, null, 2) + '\n', 'utf8');
console.log(`후보 ${c.length}개 → ${REFS}/seller_pool_${day}.md (겹침 2+ ${c.filter((h) => h.overlap >= 2).length}개)`);

// 남은 소재가 며칠치인지 센다. 바닥나기 전에 정찰을 돌리라고 알려 주는 것이 전부다.
//
//   node scripts/catalog-pool.js [--per-title 3] [--per-day 6] [--warn-days 10] [--json]
//
// 왜 (2026-09-21 소유주 지시: "그사이에 정찰로 더 채우는 것도 규칙 작업화 해야 될 것 같아")
//   소재가 떨어지면 생산이 «조용히» 멈춘다. 지금까지는 그걸 사람이 눈치채야 알았다.
//   재고(만들어 둔 영상)는 chain-status 가 세지만, **소재 풀**(아직 만들 수 있는 영화)은 아무도 안 셌다.
//
// 무엇이 "쓸 수 있는 영화"인가 — 세 문을 다 통과한 것만이다.
//   1) `distributor_tier` 가 banned 가 아니다.
//   2) 배급사가 **라이온스게이트·소니 계열이 아니다** (사례 74: 두 계열 25/25 전부 차단).
//   3) 연대가 **1990년 이후**다. 그 이전은 소유주가 지정한 넷만 예외(사례 74 뒤 지시).
//   4) 아직 안 만들었다.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CATALOG = path.join(ROOT, 'midform', 'config', 'movie_catalog.json');
const YT_STATE = path.join(ROOT, 'server', 'data', 'auto_publish_state.json');
const DRAFTS_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
const REPORT_DIR = path.join(ROOT, 'server', 'output', 'scout-reports');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

const perTitle = Number(arg('--per-title', '3'));   // 영화 한 편에서 뽑는 클립 수(보수적으로)
const perDay = Number(arg('--per-day', '6'));       // 하루 생산 목표(KO+JA 합)
const warnDays = Number(arg('--warn-days', '10'));

// 사례 74. 이름이 바뀌어도 계열은 남는다 — Summit·Vestron·Artisan 은 라이온스게이트다.
const BANNED_FAMILY = /lionsgate|summit|vestron|artisan|sony|columbia|screen gems/i;
// 소유주가 콕 집은 1990년 이전 예외 넷. "옛날 영화"가 아니라 "아는 영화"로 읽히는 것들.
const PRE1990_ALLOWED = new Set(['jaws', 'robocop-1987', 'the-warriors', 'rocky-horror']);
const ERA_FLOOR = 1990;

// 드래프트 이름은 영화 키의 축약형이다(`wolf_hypocrite` = wolf-of-wall-street).
// 하이픈과 선행 the 를 털고, 앞자리 일치나 머리글자로 맞춘다.
const norm = (s) => String(s).toLowerCase().replace(/^the[-_]/, '').replace(/[-_\s]/g, '');
const acronym = (key) => key.split('-').map((w) => w[0]).join('');

function usedKeys() {
  const out = new Set();
  const st = readJson(YT_STATE, { history: [] });
  for (const h of st.history || []) {
    const m = /^\d{8}[a-z]?-([a-z0-9]+)/.exec(h.draft || '');
    if (m) out.add(m[1]);
  }
  try {
    for (const n of fs.readdirSync(DRAFTS_DIR)) {
      const m = /^\d{8}[a-z]?-([a-z0-9]+)/.exec(n);
      if (m) out.add(m[1]);
    }
  } catch { /* 드래프트 폴더가 없으면 발행 이력만으로 센다 */ }
  return out;
}

function isUsed(key, used) {
  const n = norm(key);
  const ac = acronym(key);
  for (const u of used) {
    if (n.startsWith(u) || u.startsWith(n) || u === ac) return true;
  }
  return false;
}

const catalog = readJson(CATALOG, {});
const movies = catalog.movies || catalog;
const used = usedKeys();
const usedNames = used;

const rows = [];
for (const [key, v] of Object.entries(movies)) {
  if (!v || typeof v !== 'object' || !v.distributor_tier) continue;
  const year = Number(v.year) || 0;
  const dist = String(v.distributor || '');
  const r = { key, year, dist, tier: v.distributor_tier };
  if (v.distributor_tier === 'banned') r.drop = '차단됨';
  else if (BANNED_FAMILY.test(dist)) r.drop = '배급사 계열(라이온스게이트·소니)';
  else if (year < ERA_FLOOR && !PRE1990_ALLOWED.has(key)) r.drop = `연대 하한 ${ERA_FLOOR} 미만`;
  else if (isUsed(key, used)) r.drop = '이미 만듦';
  rows.push(r);
}

const usable = rows.filter((r) => !r.drop);
const runwayDaysRaw = (usable.length * perTitle) / perDay;

// ★풀을 액면가로 믿지 않는다 (2026-09-22).
//   프로브가 CLEAR 라고 해도 올린 뒤에 막히는 편이 있다. «CLEAR 는 아직 안 막혔다는 뜻이지
//   보증이 아니다»(생산 프롬프트 2번)를 숫자로 옮긴 것이다.
//   발행 이력에 있는 영화 중 지금 banned 인 것의 비율 = **올린 뒤 차단율**.
//   막힌 영화는 그 영화의 클립이 통째로 날아가므로 풀에서 그만큼을 미리 뺀다.
const made = rows.filter((r) => r.drop === '이미 만듦' || (usedNames.size && isUsed(r.key, usedNames)));
const madeBlocked = made.filter((r) => r.tier === 'banned');
// 표본이 너무 적으면 할인하지 않는다 — 한두 편으로 풀 전체를 깎으면 헛경보가 난다.
const blockRate = made.length >= 8 ? madeBlocked.length / made.length : 0;
const runwayDays = runwayDaysRaw * (1 - blockRate);
// ★규칙 위반 감시: 안전하다고 표시돼 있는데 사실은 금지 계열인 것. 사람이 손으로 넣으면 생긴다.
const violations = rows.filter((r) => r.tier === 'preflight' && BANNED_FAMILY.test(r.dist));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ usable: usable.map((r) => r.key), runwayDays, runwayDaysRaw, blockRate, violations }, null, 2));
  process.exit(violations.length || runwayDays < warnDays ? 1 : 0);
}

const lines = [];
lines.push(`# 소재 풀 ${new Date().toLocaleString('ko-KR')}`, '');
lines.push(`쓸 수 있는 영화 **${usable.length}편** · 편당 ${perTitle}클립 · 하루 ${perDay}편 기준`);
lines.push(`→ 액면 ${runwayDaysRaw.toFixed(0)}일치 · **실질 ${runwayDays.toFixed(0)}일치**`
  + `${runwayDays < warnDays ? `  ★${warnDays}일 미만 — 정찰을 돌려 카탈로그를 채워라` : ''}`);
if (blockRate > 0) {
  lines.push(`_올린 뒤 차단율 ${(blockRate * 100).toFixed(0)}% (발행한 ${made.length}편 중 ${madeBlocked.length}편) 만큼 깎은 값이다._`);
  lines.push(`_하루 ${perDay}편을 남기려면 실제로는 **${Math.ceil(perDay / (1 - blockRate))}편**을 만들어야 한다._`);
}
lines.push('');

const byReason = {};
for (const r of rows) if (r.drop) (byReason[r.drop] = byReason[r.drop] || []).push(r.key);
lines.push('## 빠진 이유');
for (const [why, ks] of Object.entries(byReason).sort((a, b) => b[1].length - a[1].length)) {
  lines.push(`- ${why}: ${ks.length}편`);
}
lines.push('');
lines.push('## 다음에 쓸 것 (최신순)');
for (const r of usable.sort((a, b) => b.year - a.year).slice(0, 25)) {
  lines.push(`- ${r.year}  ${r.key.padEnd(26)} ${r.dist.slice(0, 34)}`);
}
if (violations.length) {
  lines.push('', '## ★규칙 위반 — 금지 계열인데 preflight 로 남아 있다');
  for (const r of violations) lines.push(`- ${r.key} (${r.dist}) — banned 로 내려라`);
}

const text = lines.join('\n');
console.log(text);
fs.mkdirSync(REPORT_DIR, { recursive: true });
const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
fs.writeFileSync(path.join(REPORT_DIR, `${stamp}-pool.md`), `${text}\n`, 'utf8');

process.exit(violations.length || runwayDays < warnDays ? 1 : 0);

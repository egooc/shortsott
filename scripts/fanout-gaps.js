// 만들어 놓고 «어느 플랫폼에 안 올라갔는지»를 전수로 센다.
//
//   node scripts/fanout-gaps.js            빠진 것을 표로 보여 준다
//   node scripts/fanout-gaps.js --json
//
// 왜 (2026-09-23 소유주: "나머지 플랫폼에 안 올라간 거 확인해서 ... 안 올라간 거 없게 해 줘")
//   유튜브 차단이 전 플랫폼의 문지기였던 탓에(사례 101) 만들어 놓고 아무 데도 못 간 편이 쌓였다.
//   그걸 고쳤으니 이제 «무엇이 어디에 빠졌는가»를 한 장으로 봐야 메울 수 있다.
//
// 세는 기준
//   · 대상 = 내보내기 폴더(또는 보류함)에 mp4 가 있는 드래프트 전부. 만든 것은 다 센다.
//   · 유튜브 = auto_publish_state 에 url 이 있으면 올라간 것. 차단은 «올라갔으나 죽음»으로 따로 센다.
//   · 네이버·페이스북 = web_publish_state 의 (draft, site)
//   · 틱톡·인스타·스레드 등 = blotato_publish_state 의 (draft, platform)
//   ★ja 는 네이버를 안 쓴다(일본어 미지원). 그건 «빠짐»이 아니다.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DRAFTS = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
const EXPORT = path.join(DRAFTS, '_automation factory');
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

// ★웹 경로와 블로타토 경로는 «다른 대상»이다 (실측 2026-09-23):
//   web_publish  = naverclip · facebook_profile(개인 프로필, 브라우저 자동화)
//   blotato      = facebook(페이지) · instagram · tiktok · threads
//   전에 여기에 'facebook' 을 적어 두어 같은 판을 두 번 셌다.
// ★«올릴 수 있는 판»은 로케일마다 다르다. 추측하지 말고 설정에서 읽는다
//   (midform/config/blotato_accounts.json, 실측 2026-09-23):
//     ko  tiktok·instagram·threads = blotato 자동
//         facebook = manual_only(수익화가 개인 프로필에 있어 서드파티 불가) → 브라우저 facebook_profile
//         naver_clip = blotato 미지원 → 브라우저 naverclip
//     ja  facebook·instagram·tiktok·threads = blotato 자동 · 네이버는 일본어 미지원
//   못 올리는 조합을 «빠짐»으로 세면 영원히 안 메워지는 빚이 장부에 남는다.
function routesFor(locale) {
  const cfg = readJson(path.join(ROOT, 'midform', 'config', 'blotato_accounts.json'), {});
  const plats = ((cfg.locales || {})[locale] || {}).platforms || {};
  const blotato = Object.entries(plats)
    .filter(([name, o]) => name !== 'youtube' && o && o.status === 'connected')
    .map(([name]) => name);
  const web = [];
  if (locale === 'ko') {
    // 네이버는 ko 전용(일본어 미지원), 페이스북 개인 프로필도 ko 수익화 축이다.
    if ((plats.naver_clip || {}).status === 'unsupported') web.push('naverclip');
    if ((plats.facebook || {}).status === 'manual_only') web.push('facebook_profile');
  }
  return { web, blotato };
}
// 블로타토가 실제로 쓰는 판들. 상태 이력에 나타난 것을 기준으로 삼는다.
const blotatoState = readJson(path.join(ROOT, 'server', 'data', 'blotato_publish_state.json'), { history: [] });
const BLO = [...new Set((blotatoState.history || []).map((h) => h.platform).filter(Boolean))].sort();

// ★mp4 로 세면 안 된다 — 업로드가 끝나면 내보내기 폴더에서 빠진다. 드래프트 «폴더»가 남는 증거다.
//   캡컷 시절(~2026-09-08) 드래프트가 96건 남아 있으므로 볼케이노 체제가 시작된 날부터 센다.
const VOLCANO_SINCE = '20260918';
function drafts() {
  const out = new Set();
  try {
    for (const n of fs.readdirSync(DRAFTS)) {
      if (!/^\d{8}[a-z]?-.+-(ko|ja)$/.test(n)) continue;
      if (n.slice(0, 8) < VOLCANO_SINCE) continue;
      out.add(n);
    }
  } catch { /* 폴더가 없으면 빈 목록 */ }
  return [...out].sort();
}

const yt = readJson(path.join(ROOT, 'server', 'data', 'auto_publish_state.json'), { history: [] });
const web = readJson(path.join(ROOT, 'server', 'data', 'web_publish_state.json'), { history: [] });
const ytBy = {};
for (const h of yt.history || []) if (h.draft) ytBy[h.draft] = h;
const webDone = new Set((web.history || []).map((h) => `${h.draft}:${h.site}`));
const bloDone = new Set((blotatoState.history || []).map((h) => `${h.draft}:${h.platform}`));

const rows = [];
for (const d of drafts()) {
  const locale = /-ja$/.test(d) ? 'ja' : 'ko';
  const y = ytBy[d];
  const ytState = !y ? '없음' : (y.blockedAt ? '차단' : (y.publishAt ? '예약' : '올림'));
  const routes = routesFor(locale);
  const missWeb = routes.web.filter((site) => !webDone.has(`${d}:${site}`));
  const missBlo = routes.blotato.filter((pl) => !bloDone.has(`${d}:${pl}`));
  rows.push({ draft: d, locale, ytState, missWeb, missBlo, missTotal: missWeb.length + missBlo.length });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ routes: { ko: routesFor('ko'), ja: routesFor('ja') }, rows }, null, 2));
  process.exit(0);
}

const gaps = rows.filter((r) => r.missTotal > 0);
console.log(`# 팬아웃 빠짐 ${new Date().toLocaleString('ko-KR')}`);
console.log(`\n만든 것 ${rows.length}편 · 어딘가 빠진 것 **${gaps.length}편**`);
console.log(`판: ko ${routesFor('ko').web.concat(routesFor('ko').blotato).join('·')}`
  + ` / ja ${routesFor('ja').web.concat(routesFor('ja').blotato).join('·')}\n`);

for (const r of gaps.sort((a, b) => b.missTotal - a.missTotal)) {
  const miss = [...r.missWeb, ...r.missBlo];
  console.log(`  ${String(r.ytState).padEnd(4)} ${r.draft.padEnd(34)} 빠짐 ${String(r.missTotal).padStart(2)}개: ${miss.join(', ')}`);
}

const byPlatform = {};
for (const r of gaps) for (const p of [...r.missWeb, ...r.missBlo]) byPlatform[p] = (byPlatform[p] || 0) + 1;
console.log('\n## 판별 빠진 편 수');
for (const [p, n] of Object.entries(byPlatform).sort((a, b) => b[1] - a[1])) console.log(`  ${p.padEnd(16)} ${n}편`);
console.log('\n_유튜브 상태가 «차단»이어도 다른 판에는 올린다(사례 101). 여기 빠짐으로 센다._');

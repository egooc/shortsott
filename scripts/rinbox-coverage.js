// 린박스 편이 «갈 곳 11군데»에 다 갔는지 하루 단위로 센다.
//
//   node scripts/rinbox-coverage.js            오늘
//   node scripts/rinbox-coverage.js 2026-09-30
//   node scripts/rinbox-coverage.js --days 7   최근 7일
//
// 왜 (2026-10-01)
//   오늘 두 군데가 몇 주째 비어 있었다는 걸 소유주가 알려 줘서 알았다 — 린박스가
//   네이버 클립·페이스북 경로에 아예 연결돼 있지 않았고, 나는 「수동이라 못 간다」고 잘못 보고했다.
//   빠진 걸 사람이 눈으로 찾게 두면 또 몇 주가 간다. 기계가 매일 세게 한다.
//
// 목표 (소유주 확인 2026-10-01)
//   ① 편수: **채널당 하루 3편** — ja 3 + ko 3 = 6편
//   ② 갈 곳: 두 채널 합쳐 매일 11곳
//        ko 6 — youtube · instagram · tiktok · threads · naver_clip · facebook_profile
//        ja 5 — youtube · instagram · tiktok · threads · facebook(페이지)
//   ★ja 에 네이버 클립이 없는 것은 빠짐이 아니다(일본어 미지원). 페이스북도 ko 는 개인 프로필,
//     ja 는 페이지로 경로가 다르다 — 수익화가 ko 프로필에 걸려 있어서다.
//   ★둘은 다른 기준이다. 한 채널이 3편을 올려도 그 채널의 6곳이 다 차야 하고, 11곳이 다 차도
//     편수가 모자라면 목표 미달이다. 그래서 따로 센다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RINBOX = path.join(ROOT, 'server', 'data', 'rinbox_publish_state.json');
const SOCIAL = path.join(ROOT, 'server', 'data', 'rinbox_social_state.json');
const WEB = path.join(ROOT, 'server', 'data', 'web_publish_state.json');
const CATALOG = path.join(ROOT, 'midform', 'config', 'rinbox_catalog.json');

const WANT = {
  // 스레드는 끔·틱톡은 보류(2026-10-13 소유주, blotato_accounts status=disabled) — 빈 자리로 세지 않는다.
  ko: ['youtube', 'instagram', 'naver_clip', 'facebook_profile'],
  ja: ['youtube', 'instagram', 'facebook']
};
const EPISODES_PER_CHANNEL = 3;   // 소유주 확인 2026-10-01: 채널당 하루 3편 (슬롯 08·12·18 KST)

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const kst = (iso) => new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString().slice(0, 10);

function main() {
  const daysArg = (() => { const i = process.argv.indexOf('--days'); return i > 0 ? Number(process.argv[i + 1]) : 0; })();
  const dayArg = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const todayKst = kst(new Date().toISOString());

  // ★retracted 가 붙은 편은 세지 않는다. 올렸다가 되물린 편(유튜브 예약 해제 + 소셜 예약 삭제)을
  //   그대로 세면 슬롯이 비었는데도 「충족」으로 나온다 — 2026-10-02 「変身忍者 嵐」을 자막 오류로
  //   되물리고 고친 판을 다시 올렸을 때 실제로 그랬다.
  const eps = (readJson(RINBOX, { history: [] }).history || [])
    .filter((e) => e.file && e.publishAt && !e.retracted);
  const social = readJson(SOCIAL, { history: [] }).history || [];
  const web = readJson(WEB, { history: [] }).history || [];
  const catalog = readJson(CATALOG, { works: {} });

  // file:platform 으로 간 곳을 모은다
  const hit = new Map();
  const add = (file, plat) => { if (!hit.has(file)) hit.set(file, new Set()); hit.get(file).add(plat); };
  for (const e of eps) if (e.url) add(e.file, 'youtube');
  for (const s of social) add(s.file, s.platform);
  for (const w of web) add(w.draft, w.site === 'naverclip' ? 'naver_clip' : w.site);

  const days = [];
  if (dayArg) days.push(dayArg);
  else if (daysArg > 0) {
    for (let i = daysArg - 1; i >= 0; i -= 1) {
      days.push(new Date(Date.parse(todayKst) - i * 864e5).toISOString().slice(0, 10));
    }
  } else days.push(todayKst);

  let totalMissing = 0;
  let totalShort = 0;
  for (const day of days) {
    const ofDay = eps.filter((e) => kst(e.publishAt) === day);
    // ① 편수 — 채널당 3편
    const byLoc = { ko: ofDay.filter((e) => e.locale === 'ko').length, ja: ofDay.filter((e) => e.locale === 'ja').length };
    const short = Math.max(0, EPISODES_PER_CHANNEL - byLoc.ko) + Math.max(0, EPISODES_PER_CHANNEL - byLoc.ja);
    totalShort += short;
    console.log(`\n■ ${day} — 린박스 ${ofDay.length}편 (ko ${byLoc.ko}/${EPISODES_PER_CHANNEL} · ja ${byLoc.ja}/${EPISODES_PER_CHANNEL})`
      + (short ? `  ★${short}편 모자람` : '  ✅ 편수 충족'));
    if (!ofDay.length) { console.log('  (발행 없음)'); totalMissing += 11; continue; }

    const covered = new Set();
    const blockedAll = {}; // locale:platform → 그날 그 로케일 편이 전부 권리자 차단이면 빈 곳으로 세지 않는다
    for (const e of ofDay) {
      const meta = { locale: e.locale };
      // ★권리자 플랫폼 차단(holder_platform_blocks, 10-12 SBS → 인스타·페북)은 일부러 안 보낸 것이다 — 빠짐이 아니다.
      //   10-15 관리자 세션이 rinbox95ko(열혈사제) 인스타·페북 «빠짐»을 원인 불명으로 보고해서 넣었다.
      const w = (catalog.works || {})[e.work] || {};
      const hb = (catalog.holder_platform_blocks || {})[String(w.rights_holder_ko || w.broadcaster || '')] || {};
      const blocked = new Set(Object.keys(hb).flatMap((k) => (k === 'facebook' ? ['facebook', 'facebook_profile'] : [k])));
      const want = (WANT[meta.locale] || []).filter((p) => !blocked.has(p));
      for (const p of WANT[meta.locale] || []) {
        const k = `${e.locale}:${p}`;
        blockedAll[k] = (blockedAll[k] ?? true) && blocked.has(p);
      }
      const got = hit.get(e.file) || new Set();
      const miss = want.filter((p) => !got.has(p));
      for (const p of want) if (got.has(p)) covered.add(`${e.locale}:${p}`);
      const mark = miss.length ? '★' : ' ';
      console.log(`  ${mark} [${e.locale}] ${e.file}  ${want.length - miss.length}/${want.length}`
        + (miss.length ? `  빠짐: ${miss.join(', ')}` : ''));
      if (blocked.size) console.log(`      (권리자 차단으로 안 보냄: ${[...blocked].filter((p) => (WANT[meta.locale] || []).includes(p)).join(', ')})`);
      // 로케일 금지로 일부러 안 보낸 것은 빠짐이 아니다
      const block = ((catalog.works || {})[e.work] || {}).locale_block?.[e.locale];
      if (block) console.log(`      (이 편은 ${e.locale} 발행 금지 대상이다 — 빠짐으로 세지 않는다)`);
    }
    const all = [...WANT.ko.map((p) => `ko:${p}`), ...WANT.ja.map((p) => `ja:${p}`)];
    const dayMiss = all.filter((k) => !covered.has(k) && !blockedAll[k]);
    totalMissing += dayMiss.length;
    console.log(`  → 그날 채운 곳 ${all.length - dayMiss.length}/11`
      + (dayMiss.length ? `  빈 곳: ${dayMiss.join(', ')}` : '  ✅ 전부'));
  }
  console.log(`\n모자란 편수 ${totalShort} · 빈 자리 ${totalMissing}`);
  // 둘 중 하나라도 모자라면 exit 1 — 작업 로그에 실패로 남아 눈에 띈다.
  process.exitCode = (totalMissing || totalShort) ? 1 : 0;
}

main();

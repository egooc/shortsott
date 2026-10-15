// 린박스 편을 브라우저 발행 두 곳(네이버 클립 · 페이스북 개인 프로필)으로 보낸다.
//
//   node scripts/rinbox-web.js --dry-run
//   node scripts/rinbox-web.js
//   node scripts/rinbox-web.js --only final-xxx.mp4
//
// 왜 따로 두나 (2026-10-01)
//   `web-publish.js` 는 **캡컷 드래프트 폴더**를 훑는다. 린박스는 드래프트를 만들지 않으므로
//   그 목록에 영원히 안 뜬다 — Blotato 때와 똑같은 구멍이었다. 받을 입구(`--rinbox <mp4>`)는
//   이미 있었는데 부르는 쪽이 없었다. 이 스크립트가 부르는 쪽이다.
//
// ★명화관 드래프트는 건드리지 않는다. `midform-webpublish-*` 를 켜면 중지한 명화관 14편이
//   쏟아지므로, 린박스는 이 전용 경로로만 돈다(소유주 2026-09-30: 명화관 업로드 중지).
//
// 네이버는 그 자리에서 게시된다. 페이스북 개인 프로필은 예약이 없어, web-publish 가
// «그 시각에 도는 1회성 작업»을 스스로 만든다 — 여기서 할 일은 그걸 부르는 것뿐이다.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RINBOX_STATE = path.join(ROOT, 'server', 'data', 'rinbox_publish_state.json');
const WEB_STATE = path.join(ROOT, 'server', 'data', 'web_publish_state.json');
const CATALOG = path.join(ROOT, 'midform', 'config', 'rinbox_catalog.json');
const RUNS_ROOT = 'D:/volcano-runs';

// 네이버 클립은 ko 전용이다(일본어 미지원). 페이스북 개인 프로필도 ko 자산이다.
const SITES_BY_LOCALE = { ko: ['naverclip', 'facebook_profile'], ja: [] };

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

function findMp4(filename) {
  let runs = [];
  try { runs = fs.readdirSync(RUNS_ROOT); } catch { return ''; }
  for (const run of runs) {
    // 자체 렌더러(rinbox_render.py) 완성본은 <런>/_render/ 에 바로 놓인다(2026-10-08 볼케이노 자립).
    const own = path.join(RUNS_ROOT, run, '_render', filename);
    if (fs.existsSync(own)) return own;
    let hashes = [];
    try { hashes = fs.readdirSync(path.join(RUNS_ROOT, run, 'edits')); } catch { continue; }
    for (const h of hashes) {
      const c = path.join(RUNS_ROOT, run, 'edits', h, filename);
      if (fs.existsSync(c)) return c;
    }
  }
  return '';
}

function run(args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'web-publish.js'), ...args],
    { cwd: ROOT, encoding: 'utf8', timeout: 25 * 60 * 1000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { ok: r.status === 0, out };
}

function taskExists(name) {
  const r = spawnSync('schtasks', ['/Query', '/TN', name], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

function main() {
  const dry = process.argv.includes('--dry-run');
  const only = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? process.argv[i + 1] : ''; })();
  const catalog = readJson(CATALOG, { works: {} });
  const done = new Set(((readJson(WEB_STATE, { history: [] }).history) || [])
    .map((h) => `${h.draft}:${h.site}`));

  // ★retracted 가 붙은 편은 보내지 않는다 — rinbox-coverage·rinbox-publish 와 같은 규칙이다.
  //   되물린 편의 유튜브 예약만 풀고 여기를 안 걸렀더니, 같은 슬롯을 물려받은 «고친 판»과
  //   나란히 네이버 클립·페이스북 예약이 다시 만들어졌다(2026-10-03 사마귀 final-8bbe60f8f92ae163).
  const hist = (readJson(RINBOX_STATE, { history: [] }).history || [])
    .filter((e) => e.file && !e.retracted).filter((e) => !only || e.file === only);
  let shipped = 0;

  for (const e of hist) {
    const mp4 = findMp4(e.file);
    if (!mp4) { console.log(`건너뜀 mp4 없음  ${e.file}`); continue; }
    const meta = readJson(`${mp4}.rinbox.json`, null);
    if (!meta) { console.log(`건너뜀 메타 없음 ${e.file}`); continue; }

    // ★로케일 금지 게이트 — rinbox-publish·rinbox-social 과 같은 규칙이다.
    const block = ((catalog.works || {})[meta.work] || {}).locale_block?.[meta.locale];
    if (block) { console.log(`★발행 금지 ${meta.locale} ${meta.work}: ${block}`); continue; }

    const pkg = `${mp4}.social.${meta.locale}.txt`;
    if (!fs.existsSync(pkg)) {
      console.log(`건너뜀 패키지 없음 ${e.file} — 먼저 node scripts/rinbox-webpackage.js`);
      continue;
    }
    // ★플랫폼별 권리자 차단 — rinbox-social 과 같은 카탈로그 칸을 본다(2026-10-12 SBS 예능팩토리 메타 차단).
    //   사이트 이름 facebook_profile 은 카탈로그에선 facebook 으로 적는다.
    const work = (catalog.works || {})[meta.work] || {};
    const holder = String(work.rights_holder_ko || work.broadcaster || '');
    const siteBlock = (site) => {
      const pf = site === 'facebook_profile' ? 'facebook' : site;
      return (work.platform_blocks || {})[pf] || Object.entries(catalog.holder_platform_blocks || {})
        .filter(([h]) => h && holder.includes(h)).map(([, v]) => v[pf]).find(Boolean);
    };
    for (const site of (SITES_BY_LOCALE[meta.locale] || [])) {
      if (done.has(`${e.file}:${site}`)) continue;
      if (siteBlock(site)) { if (dry) console.log(`[차단] ${site} <- ${e.file}: ${siteBlock(site)}`); continue; }
      // ★이미 «그 시각에 도는 1회성 작업»으로 넘긴 편은 다시 보내지 않는다(2026-10-08 중복 게시 사고).
      //   예약 작업이 08:00 에 게시하는 중에 08:05 정기 실행이 «기록 없음 + 시각 지남»으로 보고 즉시 또 올렸다.
      //   작업이 성공하면 web_publish_state 에 기록되고, 실패하면 coverage 보고에 빈 자리로 드러난다 — 중복보다 낫다.
      if (taskExists(`midform-${site}-${e.file}`)) { if (dry) console.log(`[넘김] ${site} <- ${e.file} (예약 작업 있음)`); continue; }
      if (dry) { console.log(`[dry] ${site} <- ${e.file} (${meta.locale})`); continue; }
      console.log(`[보냄] ${site} <- ${e.file}`);
      // ★네이버의 네이티브 «등록 예약» 달력은 쓰지 않는다(2026-10-02 실측): 시각은 들어가는데
      //   날짜가 오늘로 남아 예약 시각이 과거가 되고 등록 버튼이 영원히 잠긴다(초안 908643 외 1건).
      //   web-publish.js 안의 주석도 «달력 경로는 운영에서 한 번도 안 쓰였다»고 적어 두었다.
      //   페이스북 개인 프로필과 같은 «그 시각에 다시 도는 윈도우 작업» 경로로 보낸다.
      const r = run(['--site', site, '--rinbox', mp4, '--headless', '--no-native-schedule']);
      const tail = r.out.split('\n').filter((l) => /\[ok\]|\[예약\]|\[fail\]|\[skip\]|Error/.test(l));
      console.log('   ' + (tail.join('\n   ') || '(출력 없음)'));
      if (r.ok) shipped += 1;
    }
  }
  console.log(`\n보낸 건수 ${shipped}`);
}

main();

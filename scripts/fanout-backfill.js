// 빠진 팬아웃을 «한 번에 조금씩» 메운다. 유튜브 정기 슬롯(08·12·18시) 밖에서 돈다.
//
//   node scripts/fanout-backfill.js [--limit 4] [--dry-run] [--platform tiktok]
//
// 왜 (2026-09-23 소유주: "나머지 플랫폼에 안 올라간 거 확인해서 추석 기간 내내 유튜브 정기
//     업로드 시간 외로 추가 업로드 진행해서 안 올라간 거 없게 해 줘")
//   유튜브 차단이 전 플랫폼의 문지기였던 탓에(사례 101) 만들어 놓고 아무 데도 못 간 편이 쌓였다.
//   실측 2026-09-23: 22편에 걸쳐 85건.
//
// 어떻게 — 새 발행기를 만들지 않는다
//   `fanout-gaps.js --json` 이 «무엇이 어디에 빠졌는가»를 안다. 그 목록에서 앞에서부터 집어
//   **이미 있는 발행기**를 `--only <드래프트>` 로 부른다. 캡션·태그·계정 매핑은 그쪽이 이미 안다.
//   블로타토를 그냥 `--limit N` 으로 부르면 캡컷 시절 옛 드래프트를 먼저 집는다 — 그래서 반드시
//   드래프트를 지정해 부른다(실측 2026-09-23: `20260827c-jacob_wolf_v7` 가 먼저 잡혔다).
//
// 한 번에 조금씩 하는 이유
//   85건을 한꺼번에 쏘면 플랫폼이 스팸으로 본다. 슬롯마다 몇 건씩 나눠 며칠에 걸쳐 흘린다.
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const LIMIT = Number(arg('--limit', '4'));
const ONLY_PLATFORM = arg('--platform', '');
const DRY = process.argv.includes('--dry-run');

// 브라우저 자동화로 가는 판과 블로타토로 가는 판이 다르다.
const WEB = new Set(['naverclip', 'facebook_profile']);

function gaps() {
  const raw = execFileSync(process.execPath, [path.join(__dirname, 'fanout-gaps.js'), '--json'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const j = JSON.parse(raw);
  const jobs = [];
  for (const r of j.rows || []) {
    for (const site of r.missWeb) jobs.push({ draft: r.draft, platform: site, route: 'web' });
    for (const pl of r.missBlo) jobs.push({ draft: r.draft, platform: pl, route: 'blotato' });
  }
  // 오래된 것부터 메운다 — 오래 묵을수록 더 오래 낭비된 것이다.
  jobs.sort((a, b) => a.draft.localeCompare(b.draft));
  return ONLY_PLATFORM ? jobs.filter((x) => x.platform === ONLY_PLATFORM) : jobs;
}

// ★종료코드로 판정하지 마라 (2026-09-23, 내가 여기서 당했다).
//   blotato-publish 는 올릴 수 없을 때도 «SKIP» 한 줄을 찍고 **0 으로 끝난다.**
//   그걸 «올림»으로 세어 21건을 성공이라 보고했는데 장부는 한 칸도 안 늘었다.
//   사례 88(시도≠산출)·96(돌았다≠맞다)과 같은 병이다. 그래서 **장부가 늘었는지**를 본다.
const LEDGERS = {
  web: path.join(ROOT, 'server', 'data', 'web_publish_state.json'),
  blotato: path.join(ROOT, 'server', 'data', 'blotato_publish_state.json'),
};
function ledgerCount(route) {
  try { return (JSON.parse(require('fs').readFileSync(LEDGERS[route], 'utf8')).history || []).length; }
  catch { return -1; }
}

function run(job) {
  const argv = job.route === 'web'
    ? [path.join(__dirname, 'web-publish.js'), '--site', job.platform, '--only', job.draft, '--now']
    : [path.join(__dirname, 'blotato-publish.js'), '--only', job.draft, '--platforms', job.platform];
  if (DRY) argv.push('--dry-run');
  const before = DRY ? 0 : ledgerCount(job.route);
  const r = require('child_process').spawnSync(process.execPath, argv,
    { encoding: 'utf8', cwd: ROOT, timeout: 12 * 60 * 1000 });
  const raw = `${r.stdout || ''}${r.stderr || ''}`.trim().split(/\r?\n/);
  // 왜 안 됐는지는 SKIP/오류 줄에 적혀 있다. 그 줄을 우선해서 들고 온다.
  const why = raw.filter((l) => /SKIP|error|fail|없|실패/i.test(l)).slice(-1)[0] || raw.slice(-1)[0] || '';
  if (DRY) return { ok: r.status === 0, tail: why.slice(0, 220) };
  const grew = ledgerCount(job.route) > before;
  return { ok: r.status === 0 && grew, tail: why.trim().slice(0, 220) };
}

const all = gaps();
const todo = all.slice(0, LIMIT);
console.log(`# 팬아웃 백필 ${new Date().toLocaleString('ko-KR')}`);
console.log(`빠짐 ${all.length}건 중 이번에 ${todo.length}건${DRY ? ' (시험)' : ''}\n`);
if (!todo.length) { console.log('메울 것이 없다.'); process.exit(0); }

let ok = 0;
for (const job of todo) {
  const res = run(job);
  if (res.ok) ok += 1;
  console.log(`  ${res.ok ? '올림' : '실패'}  ${job.platform.padEnd(16)} ${job.draft}`);
  if (!res.ok) console.log(`        ${res.tail}`);
}
console.log(`\n${ok}/${todo.length} 성공 · 남은 빠짐 약 ${all.length - ok}건`);

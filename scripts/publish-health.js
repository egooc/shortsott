// 명화관 발행이 **실제로 나가고 있는지** 본다. 유튜브를 뺀 뒤 이 눈이 없어서 이틀을 놓쳤다.
//
//   node scripts/publish-health.js              오늘·어제 상태
//   node scripts/publish-health.js --days 5     기간을 넓힌다
//
// 왜 (2026-10-08 소유주: "지금 유튜브 빼고 다 발행 잘 되고 있어?" → 재 보니 안 되고 있었다)
//   소유주가 2026-10-06 에 명화관을 유튜브 없이 돌리기로 한 뒤, **유튜브 시각에 매달린 자리**가
//   하나씩 조용히 멎었다. 전부 «실패»가 아니라 «대상 0건»이라 로그만 봐서는 멀쩡해 보였다:
//     · produce-guard   재고가 «유튜브에 안 올라간 것» 이라 영원히 안 빠져 생산이 매시간 건너뜀
//     · web-publish     --due 가 유튜브 publishAt 을 기준으로 삼아 08·12·18시가 매번 «(출력 없음)»
//     · fanout-backfill 회차당 4건인데 하루 필요량이 21건이라 빠짐이 5→41→55 로 벌어짐
//     · cleanup-*       «올라간 것»을 유튜브로만 세어 보호 가드가 무력화
//   린박스에는 flow-check.js 가 있었지만 명화관에는 이런 눈이 아예 없었다.
//
// 무엇을 보나 — «움직였나»를 본다. 오류가 없다고 건강한 것이 아니다.
//   1) 오늘·어제 플랫폼별로 몇 편이 나갔나 (0 이면 크게 알린다)
//   2) 남은 빠짐이 늘고 있나 줄고 있나
//   3) 생산이 돌고 있나 (재고·일일 상한)
//   4) 슬롯 작업이 «대상 0건»으로 헛돌고 있나
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const D = path.join(ROOT, 'server', 'data');
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DAYS = Number(arg('--days', 2));

const PLATFORMS = ['naverclip', 'facebook_profile', 'instagram', 'threads', 'facebook', 'tiktok'];

// ★라인을 갈라서 센다(소유주 2026-10-08: "지금 나간 그 네이버 클립이라는 게 명화관 스타일로
//   나간 거 맞냐고"). 명화관과 린박스가 **같은 계정으로** 나가므로 합쳐 세면
//   명화관이 0건인데 린박스가 채워서 멀쩡해 보인다 — 오늘 겪은 눈속임과 같은 종류다.
//     명화관  20261007-dh_road-ko   (날짜-슬러그-로케일)
//     린박스  final-<해시>.mp4
//     쇼핑    ffshop… · ffstory…
const lineOf = (draft) => {
  const d = String(draft || '');
  if (/^\d{8}[a-z]?-.+-(ko|ja)$/.test(d)) return '명화관';
  if (/^final-[0-9a-f]+\.mp4$/i.test(d)) return '린박스';
  if (/^ff(shop|story)/i.test(d)) return '쇼핑';
  return '기타';
};
const LINES = ['명화관', '린박스', '쇼핑', '기타'];

// ★날짜는 **KST 로 센다.** 기록의 `at` 은 UTC 라 그대로 자르면 아침 9시 전까지 «어제»가 된다 —
//   «오늘 0건» 경고가 매일 아침 헛울린다(2026-10-08 실측).
const KST = (iso) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const kstHour = () => new Date(Date.now() + 9 * 3600e3).getUTCHours();

function dayKeys(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(new Date(Date.now() + 9 * 3600e3 - i * 864e5).toISOString().slice(0, 10));
  }
  return out.reverse();
}

const days = dayKeys(DAYS);
const bl = readJson(path.join(D, 'blotato_publish_state.json'), { history: [] });
const wp = readJson(path.join(D, 'web_publish_state.json'), { history: [] });

const grid = {};
for (const d of days) {
  grid[d] = {};
  for (const L of LINES) { grid[d][L] = {}; for (const p of PLATFORMS) grid[d][L][p] = new Set(); }
}
const put = (at, plat, draft) => {
  const d = at ? KST(at) : '';
  if (!grid[d] || !plat) return;
  const L = lineOf(draft);
  if (grid[d][L] && grid[d][L][plat]) grid[d][L][plat].add(draft);
};
for (const h of (bl.history || [])) put(h.at, h.platform, h.draft);
for (const h of (wp.history || [])) put(h.at, h.site, h.draft);
const cell = (d, p, L) => (L ? grid[d][L][p].size
  : LINES.reduce((a, x) => a + grid[d][x][p].size, 0));

console.log('# 명화관 발행 상태  ' + new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' KST');
console.log('');
console.log('라인    날짜         ' + PLATFORMS.map((p) => p.slice(0, 9).padEnd(10)).join(''));
for (const L of LINES) {
  const any = days.some((d) => PLATFORMS.some((p) => grid[d][L][p].size));
  if (!any && L !== '명화관') continue;              // 안 쓰는 라인은 줄을 비우지 않는다
  for (const d of days) {
    console.log(L.padEnd(8) + d.padEnd(13)
      + PLATFORMS.map((p) => String(grid[d][L][p].size).padEnd(10)).join(''));
  }
  console.log('');
}

// 오늘 아무 데도 안 나갔으면 크게 알린다 — 새벽이면 아직 슬롯 전일 수 있으니 시각을 같이 적는다.
const today = days[days.length - 1];
// ★명화관만 본다. 합계로 보면 린박스가 채워 가린다.
const todayTotal = PLATFORMS.reduce((a, p) => a + grid[today]['명화관'][p].size, 0);
const hour = kstHour();
if (todayTotal === 0) {
  console.log(`\n★오늘 아직 한 건도 안 나갔다 (지금 ${hour}시).`
    + (hour >= 11 ? '  ← 10시 백필이 돌았어야 한다. 로그를 봐라.' : '  (10시 백필 전이면 정상)'));
}
for (const p of PLATFORMS) {
  const recent = days.reduce((a, d) => a + grid[d]['명화관'][p].size, 0);
  if (recent === 0) console.log(`★명화관 ${p}: 최근 ${DAYS}일 동안 0건 — 경로가 멎었는지 봐라`);
}

// 빠짐 추세
const spawn = require('child_process').spawnSync;
const g = spawn(process.execPath, [path.join(ROOT, 'scripts', 'fanout-gaps.js')],
  { encoding: 'utf8', timeout: 120000 });
const m = (g.stdout || '').match(/^\s{2}(\w+)\s+(\d+)편$/gm) || [];
if (m.length) {
  console.log('\n남은 빠짐');
  let total = 0;
  for (const line of m) {
    const [, p, n] = line.match(/^\s{2}(\w+)\s+(\d+)편$/);
    total += Number(n);
    console.log(`  ${p.padEnd(18)}${n}편`);
  }
  console.log(`  ${'합계'.padEnd(18)}${total}편`);
  // 백필이 따라잡을 수 있나 — 회차당 limit × 회차 수 대 하루 생산이 만드는 빠짐
  const cmd = (() => { try {
    return fs.readFileSync(path.join(ROOT, 'scripts', 'tasks', 'midform-fanout-backfill.cmd'), 'utf8');
  } catch { return ''; } })();
  const lim = Number((cmd.match(/--limit\s+(\d+)/) || [])[1] || 0);
  if (lim) {
    const perDay = lim * 5;            // 10·14·16·20·22시
    console.log(`  백필 처리량 하루 약 ${perDay}건 (회차당 ${lim} × 5회)`);
    if (total > perDay * 2) console.log(`  ★빠짐이 이틀치 처리량을 넘는다 — --limit 을 올리거나 원인을 봐라`);
  }
}

// 생산
const guard = spawn(process.execPath, [path.join(ROOT, 'scripts', 'produce-guard.js')],
  { encoding: 'utf8', timeout: 60000 });
const last = (guard.stdout || '').trim().split('\n').pop() || '';
console.log('\n생산  ' + last);
if (/건너뜀/.test(last) && /재고/.test(last)) {
  console.log('  ★재고가 안 빠져서 건너뛰는 중이라면, 발행이 멎은 것이 원인일 수 있다.');
}

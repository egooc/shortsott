// 생산→승인→발행 고리가 끊겼는지 한 눈에 본다.
//
//   node scripts/chain-status.js
//
// 왜 (2026-09-20)
//   09-18 에 승인이 멈추자 **발행도 생산도 같이 멈췄다.** 재고가 14편에서 안 빠지니 시간당 생산이
//   매시간 건너뛰었고, 아무도 그걸 알려 주지 않았다. 이틀을 그렇게 흘렀다.
//   고리가 하나라도 끊기면 나머지가 조용히 멈추므로, 링크마다 "마지막으로 움직인 시각"을 본다.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RUNS = path.join(os.homedir(), 'volcano-runs');
const EXPORT_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts', '_automation factory');
const HELD_DIR = path.join(EXPORT_DIR, 'held');
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const hoursAgo = (iso) => (Date.now() - Date.parse(iso)) / 3600000;
const fmt = (h) => (Number.isFinite(h) ? `${h.toFixed(0)}시간 전` : '기록 없음');

const out = [];
let stalled = 0;
const link = (name, lastIso, limitH, extra = '') => {
  const h = lastIso ? hoursAgo(lastIso) : NaN;
  const bad = !Number.isFinite(h) || h > limitH;
  if (bad) stalled += 1;
  out.push(`${bad ? '멈춤' : '정상'}  ${name.padEnd(12)} 마지막 ${fmt(h)}${extra ? '  · ' + extra : ''}`);
};

// 1) 생산 — 내보낸 mp4 중 가장 최근
const exported = fs.existsSync(EXPORT_DIR)
  ? fs.readdirSync(EXPORT_DIR).filter((f) => /\.mp4$/.test(f))
    .map((f) => fs.statSync(path.join(EXPORT_DIR, f)).mtime.toISOString()).sort() : [];

// ★파일 시각만 보면 «오늘 아침에 한 편 나왔으니 정상»으로 읽힌다 (2026-09-22).
//   실제로는 그 뒤 여섯 회차가 연속으로 중단됐는데 30시간 창 안이라 정상으로 떴다.
//   TTS 크레딧처럼 **사람이 손대야 풀리는 막힘**은 그대로 몇 시간을 조용히 흘려보낸다.
//   그래서 오늘 일지의 «회차»를 세서, 끝에서부터 중단이 몇 번 이어졌는지 본다.
function haltStreak() {
  const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  let text;
  try { text = fs.readFileSync(path.join(ROOT, 'server', 'output', 'produce-hourly', stamp + '.md'), 'utf8'); }
  catch { return null; }
  const heads = text.split(/\r?\n/).filter((l) => /^# 시간당 생산/.test(l));
  let n = 0;
  for (let i = heads.length - 1; i >= 0 && /중단|실패/.test(heads[i]); i -= 1) n += 1;
  if (n < 2) return null;
  // 왜 멈췄는지는 일지가 이미 적어 뒀다. 마지막 «사람이 할 일» 한 줄을 그대로 옮긴다.
  const blocks = text.split('## 사람이 할 일');
  const todo = blocks.length > 1
    ? (blocks[blocks.length - 1].split(/\r?\n/).find((l) => l.trim().startsWith('- ')) || '').replace(/^\s*-\s*/, '')
    : '';
  return { n, todo };
}
const halt = haltStreak();
if (halt) {
  stalled += 1;
  out.push(`멈춤  ${'명화관 생산'.padEnd(12)} 오늘 ${halt.n}회차 연속 중단  · 재고 ${exported.length}편`);
  if (halt.todo) out.push(`     ${''.padEnd(12)} └ 사람이 할 일: ${halt.todo.slice(0, 90)}`);
} else {
  link('명화관 생산', exported[exported.length - 1], 30, `재고 ${exported.length}편`);
}

// 2) 승인
const approvals = readJson(path.join(ROOT, 'server', 'data', 'publish_approvals.json'), {});
// 대장의 칸 이름은 approved_at 이다. at 으로 읽으면 전부 빈 값이 되어 "기록 없음"으로 잘못 뜬다.
const approvedAt = Object.values(approvals).map((a) => a && a.approved_at).filter(Boolean).sort();
link('승인', approvedAt[approvedAt.length - 1], 30, `누적 ${approvedAt.length}건`);

// 3) 유튜브 예약 — 가장 늦게 잡힌 공개 시각이 지났으면 고리가 끊긴 것이다
const st = readJson(path.join(ROOT, 'server', 'data', 'auto_publish_state.json'), { history: [] });
const pubs = (st.history || []).map((h) => h.publishAt).filter(Boolean).sort();
const lastPub = pubs[pubs.length - 1];
const ahead = lastPub ? -hoursAgo(lastPub) : NaN;
// ★2026-09-21 수리: 앞으로 잡힌 것이 없다고 곧바로 '멈춤'을 띄우면 **매일 저녁 거짓 경보**가 난다.
//   auto-publish 는 하루 한 번(06:45) 그날 몫을 한꺼번에 예약하므로, 마지막 편이 나간 뒤부터
//   다음 새벽까지는 '앞으로 잡힌 것'이 원래 없다. 그래서 하루 안에 예약이 돌았으면 정상으로 본다.
const sincePub = lastPub ? hoursAgo(lastPub) : NaN;
if (Number.isFinite(ahead) && ahead >= 0) {
  out.push(`정상  ${'유튜브 예약'.padEnd(12)} ${ahead.toFixed(0)}시간 뒤까지 잡혀 있음`);
} else if (Number.isFinite(sincePub) && sincePub <= 24) {
  out.push(`정상  ${'유튜브 예약'.padEnd(12)} 오늘 몫은 ${sincePub.toFixed(0)}시간 전에 나갔다 (다음 편성은 새벽 06:45)`);
} else {
  stalled += 1;
  out.push(`멈춤  ${'유튜브 예약'.padEnd(12)} 앞으로 잡힌 것 없음 (마지막 ${fmt(sincePub)})`);
}
const ytOk = (Number.isFinite(ahead) && ahead >= 0) || (Number.isFinite(sincePub) && sincePub <= 24);

// 4) 브라우저 발행(네이버·페이스북)
//    ★'마지막 실행'으로 판단하면 안 된다. 이 경로는 **발행 시각이 된 것만** 올리므로,
//      올릴 것이 없어서 조용한 것과 고장 나서 조용한 것이 똑같이 보인다.
//      그래서 «앞으로 잡힌 유튜브 예약이 있는지»로 본다 — 있으면 그 시각에 같이 나간다.
const web = readJson(path.join(ROOT, 'server', 'data', 'web_publish_state.json'), { history: [] });
const wh = (web.history || []).map((h) => h.at).filter(Boolean).sort();
if (ytOk) {
  out.push(`대기  ${'네이버·페북'.padEnd(12)} 다음 발행 시각에 함께 나간다 (마지막 ${fmt(hoursAgo(wh[wh.length - 1]))})`);
} else {
  link('네이버·페북', wh[wh.length - 1], 30);
}

// 5) 어랍숏 생산
const arab = fs.existsSync(RUNS)
  ? fs.readdirSync(RUNS).filter((w) => /^arab\d+$/.test(w))
    .map((w) => path.join(RUNS, w, 'final_tight.mp4')).filter((p) => fs.existsSync(p))
    .map((p) => fs.statSync(p).mtime.toISOString()).sort() : [];
link('어랍숏 생산', arab[arab.length - 1], 30, `재고 ${arab.length}편`);
// 어랍숏은 헤드리스 클로드 세션으로 만든다. 주간 사용량 한도에 걸리면 매시간 조용히 실패하는데,
// 그 원인이 로그에만 남아 사람이 코드 고장으로 오해한다. 마지막 실패 사유를 그대로 옮겨 둔다.
try {
  // 줄을 이어 붙이면 정규식이 끝까지 삼켜 로그 여섯 줄이 통째로 찍힌다. 줄 단위로 찾는다.
  const tail = fs.readFileSync(path.join(ROOT, 'server', 'output', 'task-logs', 'midform-arabshot-hourly.log'), 'utf8')
    .trim().split(/\r?\n/).slice(-6);
  const limit = tail.find((l) => /weekly limit/i.test(l));
  if (limit) out.push(`     ${''.padEnd(12)} └ 마지막 시도는 코드가 아니라 사용량 한도에서 멈췄다: ${limit.trim()}`);
} catch { /* 로그가 없으면 그만 */ }

// 6) 소재 풀 — 만들 영화가 남았는가. 재고(만든 영상)와 다르다.
//    풀이 마르면 생산이 «조용히» 멈춘다. 그때 알면 늦으므로 남은 일수를 여기에 같이 띄운다.
try {
  // ★변수명을 out 으로 두면 바깥의 출력 배열을 가린다. raw 로 둔다.
  const raw = require('child_process')
    .execFileSync(process.execPath, [path.join(__dirname, 'catalog-pool.js'), '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const pool = JSON.parse(raw);
  const thin = pool.runwayDays < 10;
  if (thin) stalled += 1;
  out_push_pool(pool, thin);
} catch (e) {
  // exit 1 = 풀이 얇거나 규칙 위반. execFileSync 는 그때 throw 하므로 stdout 을 다시 읽는다.
  try {
    const pool = JSON.parse(String(e.stdout || '{}'));
    if (pool.runwayDays !== undefined) { stalled += 1; out_push_pool(pool, true); }
    else out.push(`확인  ${'소재 풀'.padEnd(12)} 셀 수 없음`);
  } catch { out.push(`확인  ${'소재 풀'.padEnd(12)} 셀 수 없음`); }
}
function out_push_pool(pool, thin) {
  out.push(`${thin ? '멈춤' : '정상'}  ${'소재 풀'.padEnd(12)} 쓸 수 있는 영화 ${pool.usable.length}편 = ${pool.runwayDays.toFixed(0)}일치`
    + (thin ? '  ★정찰로 카탈로그를 채워라' : ''));
  for (const v of pool.violations || []) {
    out.push(`     ${''.padEnd(12)} └ 규칙 위반: ${v.key} (${v.dist}) — 금지 계열인데 preflight 다`);
  }
}

// 7) 보류함 — 쌓이면 사람이 들어 봐야 한다
const held = fs.existsSync(HELD_DIR) ? fs.readdirSync(HELD_DIR).filter((f) => /\.mp4$/.test(f)) : [];
if (held.length) out.push(`확인  ${'보류함'.padEnd(12)} ${held.length}편 — 동기 검사에 걸린 것, 사람이 들어 봐야 푼다`);

console.log(`# 고리 점검 ${new Date().toLocaleString('ko-KR')}\n`);
console.log(out.join('\n'));
console.log(stalled ? `\n★ 끊긴 고리 ${stalled}개. 위 '멈춤' 줄부터 보라.` : '\n고리가 전부 돌고 있다.');
process.exit(stalled ? 1 : 0);

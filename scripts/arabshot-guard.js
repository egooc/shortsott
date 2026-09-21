// 어랍숏 생산 문지기. 재고가 목표에 닿았거나 이미 돌고 있으면 그 시간은 건너뛴다.
//
//   node scripts/arabshot-guard.js [--target 7] [--daily-cap 3] [--claim] [--release]
//
// exit 10 = 이번 시간은 건너뛴다. exit 0 = 진행.
//
// 왜 (2026-09-20 소유주 지시: "어랍숏 이대로 생산하자")
//   명화관 쪽 produce-guard 와 같은 구조다. 다른 점은 재고를 세는 곳뿐이다 —
//   어랍숏은 캡컷 드래프트가 아니라 volcano-runs 의 arab* 작업 폴더에 완성본으로 쌓인다.
//
// ★락을 반드시 푼다. 안 풀면 그 뒤 모든 시간이 영원히 건너뛴다(명화관에서 겪은 것).
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RUNS = path.join(os.homedir(), 'volcano-runs');
const LOCK = path.join(ROOT, 'server', 'data', 'arabshot_produce.lock');
const STALE_MIN = 90;

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const target = Number(arg('--target', '7'));
const dailyCap = Number(arg('--daily-cap', '3'));

function say(code, msg) { console.log(msg); process.exit(code); }

if (process.argv.includes('--release')) {
  try { fs.unlinkSync(LOCK); } catch { /* 없으면 그만 */ }
  say(0, '락 해제');
}

// 완성본이 있는 arab* 폴더를 재고로 센다. final_tight.mp4 가 최종 산출물이다.
const stock = [];
// ★2026-09-22 수리: UTC 로 «오늘»을 잡고 있었다. 그러면 하루 경계가 자정이 아니라
//   오전 9시(KST)가 된다 — 실제로 04:29 에 "오늘 6편으로 한도 도달"이 떠서 자정부터
//   아침까지 생산이 막혔다. 명화관 문지기(produce-guard)는 처음부터 KST 를 썼다. 맞춘다.
const KST = 9 * 3600 * 1000;
const today = new Date(Date.now() + KST).toISOString().slice(0, 10);
let madeToday = 0;
if (fs.existsSync(RUNS)) {
  for (const w of fs.readdirSync(RUNS)) {
    if (!/^arab\d+$/.test(w)) continue;
    const out = path.join(RUNS, w, 'final_tight.mp4');
    if (!fs.existsSync(out)) continue;
    stock.push(w);
    try {
      if (new Date(fs.statSync(out).mtimeMs + KST).toISOString().slice(0, 10) === today) madeToday += 1;
    } catch { /* 통계일 뿐 */ }
  }
}

if (stock.length >= target) say(10, `건너뜀: 재고 ${stock.length}편으로 목표 ${target}편 충족`);
if (madeToday >= dailyCap) say(10, `건너뜀: 오늘 ${madeToday}편으로 하루 한도 ${dailyCap}편 도달`);

if (fs.existsSync(LOCK)) {
  const age = (Date.now() - fs.statSync(LOCK).mtimeMs) / 60000;
  if (age < STALE_MIN) say(10, `건너뜀: 이미 돌고 있다 (락 ${age.toFixed(0)}분)`);
  console.log(`오래된 락(${age.toFixed(0)}분) 무시하고 진행`);
}

if (process.argv.includes('--claim')) {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, new Date().toISOString());
}
say(0, `진행: 재고 ${stock.length}/${target}편, 오늘 ${madeToday}/${dailyCap}편`);

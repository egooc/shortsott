// 쇼핑쇼츠 밤 생산 관문(2026-10-13 소유주 "진행하자" — 재고 0 으로 10/13 08:00 이 비었다).
//   node scripts/shop-produce-guard.js --claim     만들 차례면 잠금을 걸고 0, 아니면 10(이번엔 건너뜀)
//   node scripts/shop-produce-guard.js --release   잠금을 푼다(성공·실패와 무관하게 항상)
//   node scripts/shop-produce-guard.js --status    재고·잠금만 보여 준다
// 재고 = stock_new_channel.json 의 ready 중 아직 예약 안 된 편(shop_schedule fill 과 같은 계산).
// 하루 2편(08·18시)이라 재고가 TARGET 미만이면 만든다. 한 밤에 MAX_PER_NIGHT 편까지.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = 'D:/volcano-runs/_upload';
const LOCK = path.join(DIR, 'produce.lock');
const STATE = path.join(DIR, 'produce_state.json');
const TARGET = 14;         // 상시 재고 14편(2편/일×1주) — 10/20 소유주 «쇼핑 밤 생산 한도 상향»(4였을 땐 생산=소비라 재고가 안 쌓였다)
const MAX_PER_NIGHT = 4;   // 00:30·03:30 회차 × MAX_PER_RUN (10/20 2→4)
const MAX_PER_RUN = 2;     // 한 회차 3시간 안에 끝낼 수 있는 편수 — 03:30 회차도 07:20 fill 전에 끝나야 한다
const LOCK_STALE_MS = 4 * 3600e3;

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

function stockLeft() {
  const stock = readJson(path.join(DIR, 'stock_new_channel.json'), { ready: [] });
  const q = readJson(path.join(DIR, 'schedule_shopping.json'), { items: [] });
  const used = new Set(q.items.map((i) => path.basename(i.meta)));
  const skip = new Set(stock.skip || []);
  return stock.ready.filter((n) => !used.has(n) && !skip.has(n));
}

const mode = process.argv[2];
const left = stockLeft();
const st = readJson(STATE, { days: {} });
const today = st.days[kstDay()] || { made: 0, runs: 0 };

if (mode === '--status') {
  console.log(`재고 ${left.length}편 (${left.join(', ') || '-'}) · 목표 ${TARGET} · 오늘 만든 편 ${today.made} · 잠금 ${fs.existsSync(LOCK) ? '있음' : '없음'}`);
  process.exit(0);
}

if (mode === '--claim') {
  // 10/16 관리자 규칙: 무거운 일 겹침으로 정치 렌더가 메모리 부족으로 꺼졌다 — 시작 로그에 빈 메모리·다른 레인 잠금을 남긴다(막지는 않는다)
  const locks = ['D:/midform/politics-hour/RENDERING.lock', 'D:/midform/politics-hour/RENDERING-ja.lock'].filter((p) => fs.existsSync(p)).map((p) => path.basename(p));
  console.log(`[guard] 빈 메모리 ${(os.freemem() / 2 ** 30).toFixed(1)}GB / ${(os.totalmem() / 2 ** 30).toFixed(0)}GB · 다른 레인 잠금 ${locks.join(', ') || '없음'}`);
  if (fs.existsSync(LOCK)) {
    const age = Date.now() - fs.statSync(LOCK).mtimeMs;
    if (age < LOCK_STALE_MS) { console.log(`[guard] 다른 회차가 돌고 있다(${Math.round(age / 60e3)}분) — 건너뜀`); process.exit(10); }
    console.log('[guard] 오래된 잠금을 치운다');
  }
  if (left.length >= TARGET) { console.log(`[guard] 재고 ${left.length}편 ≥ ${TARGET} — 건너뜀`); process.exit(10); }
  const need = Math.min(MAX_PER_RUN, MAX_PER_NIGHT - today.made, TARGET - left.length);
  if (need <= 0) { console.log(`[guard] 오늘 한도(${MAX_PER_NIGHT}편) 다 씀 — 건너뜀`); process.exit(10); }
  fs.writeFileSync(LOCK, `${JSON.stringify({ at: new Date().toISOString(), stockBefore: left, need }, null, 2)}\n`, 'utf8');
  console.log(`[guard] 재고 ${left.length}편 → ${need}편 만든다`);
  process.exit(0);
}

if (mode === '--release') {
  const lock = readJson(LOCK, null);
  const made = lock ? left.filter((n) => !lock.stockBefore.includes(n)).length : 0;
  st.days[kstDay()] = { made: today.made + made, runs: today.runs + 1 };
  fs.writeFileSync(STATE, `${JSON.stringify(st, null, 2)}\n`, 'utf8');
  try { fs.unlinkSync(LOCK); } catch {}
  console.log(`[guard] 잠금 해제 · 이번 회차 ${made}편 · 재고 ${left.length}편`);
  process.exit(0);
}

console.error('usage: --claim | --release | --status');
process.exit(2);

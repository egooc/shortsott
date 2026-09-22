// 시간당 생산 실행 전 "지금 만들어도 되는가"를 판정한다. 만들어도 되면 종료코드 0, 아니면 10.
//
//   node scripts/produce-guard.js [--target 14] [--daily-cap 6] [--claim]
//   node scripts/produce-guard.js --release      락 해제(비정상 종료로 락이 남았을 때)
//
// 왜 필요한가
//   1) 볼케이노 편집은 워크디렉토리에 editor.lock 을 잡는다. 생산 세션 둘이 겹치면 서로의 편집을 깨뜨린다.
//   2) 한 편마다 Speechmatics(ASR) + Typecast(TTS) 실비가 나간다. 시간당 무제한으로 돌면 재고도 비용도 넘친다.
//   3) 목표는 상시 재고 14편(2편/일×1주), 하루 생산은 채널당 3편 = 6편. 그 위로는 만들 이유가 없다.
//
// 재고 정의: 최근 STOCK_DAYS 일 안에 만든 드래프트 중 아직 유튜브에 올라가지 않은 것.
// 날짜 제한이 핵심이다 — 폴더에는 캡컷 시절(~2026-09-08) 미발행분이 96건 남아 있는데, 프레임도 BGM도
// 지금 규격과 달라 재고로 칠 수 없다. 날짜를 안 자르면 재고가 140편으로 보여 생산이 영원히 멈춘다(2026-09-18 실측).
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const DRAFTS_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
const YT_STATE = path.join(ROOT, 'server', 'data', 'auto_publish_state.json');
const LOCK = path.join(ROOT, 'server', 'data', 'produce.lock');
const LEDGER = path.join(ROOT, 'server', 'data', 'produce_ledger.json');
const LOCK_STALE_MIN = 90;   // 생산 한 바퀴가 이보다 길면 죽은 것으로 본다
const STOCK_DAYS = 7;        // 재고로 셀 드래프트의 나이 상한(일)

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const say = (code, msg) => { console.log(msg); process.exit(code); };

// 설치된 드래프트 폴더 목록. «생산했다»의 유일한 증거다 — 로그도 종료코드도 아니다.
function installedDrafts() {
  try {
    return fs.readdirSync(DRAFTS_DIR).filter((n) => /^\d{8}[a-z]?-.+-(ko|ja)$/.test(n));
  } catch { return []; }
}

if (process.argv.includes('--release')) {
  fs.rmSync(LOCK, { force: true });
  // ★2026-09-21 수리: --claim 이 «시도»를 세고 아무도 되돌리지 않았다. 그래서 세션이 실패한 날은
  //   한 편도 안 나왔는데 장부가 6/6 으로 차고, 남은 시간이 전부 건너뛰었다.
  //   실측: 09-21 10:45~12:45 세 번 모두 주간 사용량 한도로 실패했는데 장부는 3→6 으로 올랐고
  //   13:45 부터 "일일 상한 도달"로 하루가 끝났다. 그날 완성본은 0편이다.
  //   호출자가 실패 코드를 들고 오면 그 한 칸을 돌려준다.
  //   ★2026-09-22 재수리: 종료코드로는 모자랐다. 세션이 «만들 수 없어서 기록만 남기고» 끝내면
  //   그건 정상 종료(0)라 환불이 안 걸린다. 오늘 실제로 그랬다 — TTS 크레딧이 떨어져 다섯 회차가
  //   깨끗하게 0편으로 끝났는데 장부는 6/6 이 차서 하루가 닫혔다. 완성본은 두 편뿐이다.
  //   그래서 «드래프트가 늘었는가»로 본다. 종료코드도 로그도 아닌 결과물이 판정 기준이다.
  const t = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const l = readJson(LEDGER, { days: {} });
  l.days = l.days || {};
  const before = Number((l.pending || {}).drafts);
  const now = installedDrafts().length;
  const idle = Number.isFinite(before) && now <= before;
  if (process.argv.includes('--refund') || idle) {
    l.days[t] = Math.max(0, Number(l.days[t] || 0) - 1);
    delete l.pending;
    fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2));
    say(0, `락 해제됨 · ${idle ? '드래프트가 늘지 않아' : '실패 코드를 받아'} 장부에서 한 칸 돌려줌 (오늘 ${l.days[t]}편)`);
  }
  delete l.pending;
  fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2));
  say(0, '락 해제됨');
}

const target = Number(arg('--target', '14'));
const dailyCap = Number(arg('--daily-cap', '6'));

// 1) 락 — 생산 세션은 한 번에 하나
if (fs.existsSync(LOCK)) {
  const age = (Date.now() - fs.statSync(LOCK).mtimeMs) / 60000;
  if (age < LOCK_STALE_MIN) say(10, `건너뜀: 다른 생산이 ${age.toFixed(0)}분째 돌고 있다`);
  console.log(`오래된 락(${age.toFixed(0)}분) 무시하고 진행`);
}

// 2) 재고 — 설치됐으나 아직 유튜브에 안 올라간 드래프트
const uploaded = new Set((readJson(YT_STATE, { history: [] }).history || []).map((h) => h.draft));
const cutoff = new Date(Date.now() - STOCK_DAYS * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
const installed = installedDrafts();
const stock = installed.filter((n) => !uploaded.has(n) && n.slice(0, 8) >= cutoff);
if (stock.length >= target) say(10, `건너뜀: 재고 ${stock.length}편으로 목표 ${target}편 충족`);

// 3) 오늘 생산량 — 채널당 3편(합 6편)을 넘기지 않는다
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const ledger = readJson(LEDGER, { days: {} });
const madeToday = Number((ledger.days || {})[today] || 0);
if (madeToday >= dailyCap) say(10, `건너뜀: 오늘 ${madeToday}편 생산으로 일일 상한 ${dailyCap}편 도달`);

// 4) 통과 — 락을 잡고 카운트를 올린다(실제 생산은 호출자가 한다)
if (process.argv.includes('--claim')) {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, `${new Date().toISOString()} pid=${process.pid}`);
  ledger.days = ledger.days || {};
  ledger.days[today] = madeToday + 1;
  // 이 회차가 시작할 때의 드래프트 수. --release 가 이것과 비교해 환불을 판정한다.
  ledger.pending = { at: new Date().toISOString(), drafts: installedDrafts().length };
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
}
say(0, `진행: 재고 ${stock.length}/${target}편, 오늘 ${madeToday}/${dailyCap}편`);

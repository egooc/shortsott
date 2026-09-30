// 발행 파이프라인이 남긴 찌꺼기를 치운다.
//
//   node scripts/tidy-leftovers.js           무엇을 치울지 보여주기만 한다
//   node scripts/tidy-leftovers.js --apply   실제로 치운다
//
// 왜 (2026-09-28 소유주: "찌꺼기 정리해줘")
//   대장과 폴더가 조금씩 어긋나 있었다. 지금은 무해하지만 쌓이면 판단을 흐린다 —
//   군림보 테스트 드래프트는 **폴더를 지웠는데 승인만 남아** 있었고(소유주가 2026-09-25 에
//   삭제를 지시한 것들이다), 승인 대장 78건 중 67건이 이미 발행된 편이라 «대기 목록»이
//   실제보다 커 보였다.
//
// ★지우지 않는 것
//   · `_recut_backup/`   재커팅 전 원본. 되돌릴 수 있어야 한다
//   · `claim_probes.json` 프로브가 왜 안 맞았는지의 기록(사례 149 의 근거)
//   · 발행 이력           무엇이 언제 막혔는지가 유일한 실측 자료다
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DRAFTS = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
const EXPORT = path.join(DRAFTS, '_automation factory');
const APPROVALS = path.join(ROOT, 'server', 'data', 'publish_approvals.json');
const STATE = path.join(ROOT, 'server', 'data', 'auto_publish_state.json');
const APPLY = process.argv.includes('--apply');

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

const approvals = readJson(APPROVALS, {});
const state = readJson(STATE, { history: [] });
const published = new Set((state.history || []).filter((h) => h.url).map((h) => h.draft));

// ① 폴더가 사라진 승인 — 드래프트를 지웠는데 승인만 남은 것
const orphan = Object.keys(approvals).filter((n) => !fs.existsSync(path.join(DRAFTS, n)));
// ② 이미 발행된 편의 승인 — 역할이 끝났다. 발행 이력에 남으므로 승인은 지워도 된다
const done = Object.keys(approvals).filter((n) => published.has(n) && !orphan.includes(n));
// ③ 동기화 감사 부산물 — 프레임 시트. 통과한 편의 것은 남길 이유가 없다
let auditDirs = [];
try {
  auditDirs = fs.readdirSync(EXPORT)
    .filter((n) => n.endsWith('.sync_audit'))
    .filter((n) => published.has(n.replace(/\.sync_audit$/, '')))
    .map((n) => path.join(EXPORT, n));
} catch { /* 폴더가 없으면 건너뛴다 */ }

const mb = (p) => {
  let total = 0;
  const walk = (x) => {
    const st = fs.statSync(x);
    if (st.isDirectory()) fs.readdirSync(x).forEach((c) => walk(path.join(x, c)));
    else total += st.size;
  };
  try { walk(p); } catch { /* 없어도 그만 */ }
  return total / 1e6;
};

console.log(`① 폴더가 사라진 승인       ${orphan.length}건`);
orphan.forEach((n) => console.log(`     ${n}`));
console.log(`② 이미 발행된 편의 승인    ${done.length}건  (발행 이력에 남으므로 안전하다)`);
console.log(`③ 통과한 편의 감사 부산물  ${auditDirs.length}건  ${mb2(auditDirs).toFixed(1)}MB`);
function mb2(list) { return list.reduce((a, p) => a + mb(p), 0); }

if (!APPLY) {
  console.log('\n계산만 · 실제로 치우려면 --apply');
  process.exit(0);
}

for (const n of [...orphan, ...done]) delete approvals[n];
fs.writeFileSync(APPROVALS, `${JSON.stringify(approvals, null, 2)}\n`, 'utf8');
let freed = 0;
for (const d of auditDirs) { freed += mb(d); fs.rmSync(d, { recursive: true, force: true }); }

console.log(`\n승인 대장 ${orphan.length + done.length}건 정리 → 남은 ${Object.keys(approvals).length}건`);
console.log(`감사 부산물 ${auditDirs.length}건 삭제 · ${freed.toFixed(1)}MB 회수`);
console.log('★_recut_backup · claim_probes.json · 발행 이력은 건드리지 않았다');

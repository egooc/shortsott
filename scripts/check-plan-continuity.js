// Does the cut stay in one place long enough to be followed?
//
//   node scripts/check-plan-continuity.js <compress run dir | run id> [--json]
//   node scripts/check-plan-continuity.js --all
//
// Draft Day was unfollowable and the obvious explanation - too many scenes - turned out to be
// wrong: it has 8.6 scenes per minute, the same as Jacob, which reads fine. What separates them
// is how far the cut TRAVELS. Consecutive kept slots sit 19s apart in Jacob, 31s in Volterra,
// and 55s in Draft Day: there, almost every slot lands in a different moment of the film, so no
// amount of seam narration rescues it - it would need one seam per slot, and narration would
// eat the video.
//
// Measured after compress phase 1, which is before fills, TTS and the draft: the plan alone
// answers this, so a source that cannot be followed can be dropped before it costs anything.
//
// Calibrated on three runs. Treat the thresholds as provisional and re-check them as the
// ledger grows.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEST_RUNS = path.join(ROOT, 'midform', 'test_runs');

const JUMP_WARN_SEC = 40;
const JUMP_FAIL_SEC = 50;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function analyzePlan(runDir) {
  const name = path.basename(runDir);
  const plan = readJson(path.join(runDir, 'edit_plan.json'), null);
  if (!plan) return { run: name, error: 'edit_plan.json 없음' };
  const kept = (plan.timeline || []).filter((slot) => String(slot.decision || '') !== 'SKIP');
  if (kept.length < 2) return { run: name, error: '슬롯이 2개 미만 — 판정 불가' };

  const centers = kept.map((slot) => {
    const a = Number(slot.visual_source_start_sec ?? slot.start_sec ?? 0);
    const b = Number(slot.visual_source_end_sec ?? slot.end_sec ?? a);
    return (a + b) / 2;
  });
  const jumps = [];
  for (let i = 1; i < centers.length; i += 1) jumps.push(Math.abs(centers[i] - centers[i - 1]));
  const avg = jumps.reduce((x, y) => x + y, 0) / jumps.length;
  const max = Math.max(...jumps);

  const sourceCase = readJson(path.join(runDir, 'source_case.json'), {});
  const verdict = avg >= JUMP_FAIL_SEC ? 'FAIL' : (avg >= JUMP_WARN_SEC ? 'WARN' : 'PASS');
  return {
    run: name,
    slots: kept.length,
    avg_jump_sec: Number(avg.toFixed(1)),
    max_jump_sec: Number(max.toFixed(1)),
    big_jumps: jumps.filter((j) => j > 30).length,
    source_duration_sec: Number(sourceCase.duration_sec || 0),
    speech_density: sourceCase.speech_density ?? null,
    verdict
  };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const targets = args.includes('--all')
    ? fs.readdirSync(TEST_RUNS).filter((d) => d.startsWith('compress_'))
      .map((d) => path.join(TEST_RUNS, d))
      .filter((d) => fs.existsSync(path.join(d, 'edit_plan.json')))
    : [path.resolve(args.find((a) => !a.startsWith('--')) || '')]
      .map((p) => (fs.existsSync(p) ? p : path.join(TEST_RUNS, path.basename(p))));

  const results = targets.map(analyzePlan);
  if (json) { console.log(JSON.stringify(results, null, 2)); return; }

  for (const r of results) {
    if (r.error) { console.log(`${r.run}: ${r.error}`); continue; }
    if (args.includes('--all') && r.verdict === 'PASS') continue;
    console.log(`[${r.verdict}] ${r.run}`);
    console.log(`   슬롯 ${r.slots} | 평균 점프 ${r.avg_jump_sec}s | 최대 ${r.max_jump_sec}s | 30s 초과 ${r.big_jumps}회`
      + ` | 원본 ${r.source_duration_sec}s | 발화밀도 ${r.speech_density}`);
    if (r.verdict !== 'PASS') {
      console.log('   → 컷이 원본을 너무 멀리 건너뛴다. 슬롯마다 다른 장면이라 이음매 해설로 메울 수 없다.');
    }
  }
  if (args.includes('--all')) {
    const fail = results.filter((r) => r.verdict === 'FAIL').length;
    const warn = results.filter((r) => r.verdict === 'WARN').length;
    console.log(`\n총 ${results.filter((r) => !r.error).length}건 | FAIL ${fail} / WARN ${warn}`);
  }
  if (results.some((r) => r.verdict === 'FAIL')) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { analyzePlan, JUMP_WARN_SEC, JUMP_FAIL_SEC };

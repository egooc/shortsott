// Do the plan and the captions describe the same lines?
//
//   node scripts/check-plan-caption-parity.js <compress run id | dir> [--json]
//   node scripts/check-plan-caption-parity.js --all
//
// Repairing a draft is only worth it when the compress artifacts still agree with each other.
// BD2 Aro's Verdict took six rebuild cycles before the reason surfaced: slot_008's caption said
// "피, 인간의 음식." while its recorded source line was "These children are much like us." - a
// different sentence. With the mapping broken there is no way to decide which planned lines to
// keep, so every slot-by-slot fix just uncovered the next one (2026-09-03).
//
// Two failures are worth telling apart, because they cost very differently:
//   COUNT   - the plan keeps lines the fills never captioned. Mechanical: drop the extra plan
//             lines and rebuild. This is the repairable kind.
// TIMING MATTERS: bootstrap re-derives dialogue windows (clampDialogueWindowsToOwnCue,
// trimDialogueWindowsToSpeech), so a plan that reads CLEAN here can come out mismatched after
// the rebuild - and a different slot surfaces each round. Measured on BD2 Aro's Verdict, which
// took seven cycles before that became clear. Use this gate to DECIDE (repair vs replan), not
// to certify: a run that keeps producing fresh mismatches after each rebuild needs a fresh
// compress, because the repair target moves.
//
//   CONTENT - a caption's recorded source line is not the line the plan holds at that index.
//             The mapping itself is wrong, so nothing downstream can be trusted. Rebuild the
//             source from compress instead of repairing.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEST_RUNS = path.join(ROOT, 'midform', 'test_runs');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9가-힣ぁ-んァ-ヴ一-龥]+/g, '').slice(0, 40);

function analyze(runDir) {
  const name = path.basename(runDir);
  const plan = readJson(path.join(runDir, 'edit_plan.json'), null);
  const fills = readJson(path.join(runDir, 'compression_slot_fills.json'), null);
  if (!plan) return { run: name, error: 'edit_plan.json 없음' };
  if (!fills) return { run: name, error: 'compression_slot_fills.json 없음' };

  const bySlot = new Map((fills.slot_fills || []).map((f) => [String(f.slot_id || ''), f]));
  const countIssues = [];
  const contentIssues = [];
  let slots = 0;

  for (const slot of plan.timeline || []) {
    if (slot.decision !== 'KEEP_DIALOGUE') continue;
    const fill = bySlot.get(String(slot.slot_id || ''));
    if (!fill) continue;
    slots += 1;
    const planLines = slot.dialogue_focus_lines || [];
    const captions = fill.caption_kr_dialogue || [];
    const sourceLines = fill.caption_source_lines || [];

    if (planLines.length !== captions.length) {
      countIssues.push({
        slot: slot.slot_id,
        planLines: planLines.length,
        captions: captions.length
      });
    }

    // Every source line the fills recorded should be findable in the plan's lines for that slot.
    // One that is not means the caption was written against something the plan does not hold.
    for (const [index, source] of sourceLines.entries()) {
      if (!source) continue;
      if (planLines.some((line) => norm(line) === norm(source))) continue;
      contentIssues.push({
        slot: slot.slot_id,
        index,
        recordedSource: String(source).slice(0, 60),
        caption: String(captions[index] || '').slice(0, 40),
        planHas: planLines.map((l) => String(l).slice(0, 34))
      });
    }
  }

  const verdict = contentIssues.length ? 'DISCARD' : (countIssues.length ? 'REPAIRABLE' : 'CLEAN');
  return {
    run: name,
    dialogue_slots: slots,
    count_mismatches: countIssues.length,
    content_mismatches: contentIssues.length,
    countIssues,
    contentIssues,
    verdict
  };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const targets = args.includes('--all')
    ? fs.readdirSync(TEST_RUNS).filter((d) => d.startsWith('compress_'))
      .map((d) => path.join(TEST_RUNS, d))
      .filter((d) => fs.existsSync(path.join(d, 'edit_plan.json'))
        && fs.existsSync(path.join(d, 'compression_slot_fills.json')))
    : [path.resolve(args.find((a) => !a.startsWith('--')) || '')]
      .map((p) => (fs.existsSync(p) ? p : path.join(TEST_RUNS, path.basename(p))));

  const results = targets.map(analyze);
  if (json) { console.log(JSON.stringify(results, null, 2)); return; }

  for (const r of results) {
    if (r.error) { if (!args.includes('--all')) console.log(`${r.run}: ${r.error}`); continue; }
    if (args.includes('--all') && r.verdict === 'CLEAN') continue;
    console.log(`[${r.verdict}] ${r.run} — 대사 슬롯 ${r.dialogue_slots} | 줄수 불일치 ${r.count_mismatches} | 내용 불일치 ${r.content_mismatches}`);
    for (const c of r.countIssues.slice(0, 4)) {
      console.log(`   줄수 ${c.slot}: 계획 ${c.planLines} / 자막 ${c.captions}`);
    }
    for (const c of r.contentIssues.slice(0, 3)) {
      console.log(`   내용 ${c.slot}[${c.index}]: 기록된 원문 "${c.recordedSource}"`);
      console.log(`        자막 "${c.caption}" | 계획이 가진 줄: ${c.planHas.join(' / ')}`);
    }
  }
  if (args.includes('--all')) {
    const d = results.filter((r) => r.verdict === 'DISCARD').length;
    const rep = results.filter((r) => r.verdict === 'REPAIRABLE').length;
    const clean = results.filter((r) => r.verdict === 'CLEAN').length;
    console.log(`\n총 ${d + rep + clean}건 | 폐기 ${d} / 수리가능 ${rep} / 정상 ${clean}`);
  }
  if (results.some((r) => r.verdict === 'DISCARD')) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { analyze };

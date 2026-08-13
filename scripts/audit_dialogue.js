#!/usr/bin/env node
// Audits a compress run's per-line dialogue translation against the English source.
// Pairs edit_plan.dialogue_focus_lines (EN) with slot_fills.caption_kr_dialogue (KO) and
// speakers, judges each KEEP_DIALOGUE scene with judgeDialogueTranslation, prints a report.
// Usage: node scripts/audit_dialogue.js <compress_run_dir> [ko|ja]
const fs = require('fs');
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch { /* optional */ }
const { judgeDialogueTranslation } = require('../server/services/geminiMidformService');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); }

async function main() {
  const dir = process.argv[2];
  const loc = (process.argv[3] || 'ko').toLowerCase();
  const apply = process.argv.includes('--apply');
  if (!dir || !fs.existsSync(dir)) { console.error('compress run dir required'); process.exit(1); }
  const plan = readJson(path.join(dir, 'edit_plan.json'));
  const fillsFile = loc === 'ja' ? 'compression_slot_fills.ja.json' : 'compression_slot_fills.json';
  const sf = readJson(path.join(dir, fillsFile));
  const targetLang = loc === 'ja' ? 'Japanese' : 'Korean';
  const fillBySlot = new Map((sf.slot_fills || []).map((f) => [String(f.slot_id), f]));
  const timeline = Array.isArray(plan.timeline) ? plan.timeline : [];
  let total = 0; let flagged = 0; const report = [];
  for (const item of timeline) {
    if (item.decision !== 'KEEP_DIALOGUE') continue;
    const en = item.dialogue_focus_lines || item.dialogue_focus_quotes || [];
    const fill = fillBySlot.get(String(item.slot_id)) || {};
    const tr = fill.caption_kr_dialogue || [];
    const speakers = fill.speakers || [];
    if (!en.length || !tr.length) continue;
    const lines = en.map((e, i) => ({ speaker: speakers[i] || '', en: e, tr: tr[i] || '' }));
    total += lines.length;
    let verdict;
    try { verdict = await judgeDialogueTranslation({ lines, targetLang }); }
    catch (err) { console.error(`  ${item.slot_id}: judge error ${err.message}`); continue; }
    for (const issue of (verdict.issues || [])) {
      const ln = lines[issue.index] || {};
      flagged += 1;
      // Keep the deliberate localization: the drug name "Molly" is softened to a generic word
      // on purpose (monetization safety), so skip fixes that re-introduce it.
      const isMolly = /molly/i.test(ln.en || '');
      const willApply = apply && !isMolly && issue.suggested_tr && Number.isInteger(issue.index) && issue.index < tr.length;
      if (willApply) tr[issue.index] = issue.suggested_tr;
      report.push({ slot: item.slot_id, ...issue, speaker: ln.speaker, en: ln.en, tr: ln.tr, applied: willApply, skippedMolly: isMolly });
    }
  }
  if (apply) {
    fs.writeFileSync(path.join(dir, fillsFile), JSON.stringify(sf, null, 1));
  }
  console.log(`\n=== ${path.basename(dir)} [${loc}] : ${flagged} issue(s) / ${total} lines ===`);
  for (const r of report) {
    const tag = r.skippedMolly ? 'SKIP(molly)' : (r.applied ? 'APPLIED' : (apply ? 'not-applied' : ''));
    console.log(`\n  ${r.slot} [${r.speaker}] ${r.problem}  ${tag}`);
    console.log(`    EN : ${r.en}`);
    console.log(`    TR : ${r.tr}`);
    console.log(`    fix: ${r.suggested_tr || '(none)'}   (${r.reason || ''})`);
  }
  if (!report.length) console.log('  clean.');
}
main().catch((e) => { console.error(e); process.exit(1); });

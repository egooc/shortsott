#!/usr/bin/env node
'use strict';

// Apply the machine eye's own suggested_rewrite to a compress run's slot fills.
//
// When narration_visual_match fails it does not just say "wrong" - for every sentence it rejects
// it reports what the frames actually show and writes a replacement sentence grounded in that.
// Until now the batch threw all of that away and either re-rolled the fills blind (the generator
// cannot see the frames, so it can miss the same way twice) or queued the source for a human.
// Applying the suggested rewrite is deterministic, costs no generation tokens, and is exactly the
// surgery a person would perform by hand.
//
//   node midform/scripts/apply_mismatch_rewrites.js <compress_run_dir> --issues <file|-> [--apply]
//
// --issues takes the JSON array the gate emits (also embedded in the failure text recorded in
// production_failure_queue.json). Without --apply this is a dry run and prints the diff.
//
// Rewritten slots are marked "authored": true so compress-apply does not overwrite them, per the
// rebuild-loop doctrine. Run compress-refresh and resume from bootstrap afterwards.

const fs = require('fs');
const path = require('path');

// Matches the shape the generator produces: chunks of roughly a phrase, split on spaces, never
// mid-word. Observed units run 9-15 characters.
const CAPTION_UNIT_TARGET_CHARS = 14;
// A trailing "있습니다." on its own line reads as a fragment, so a scrap this short is folded back
// into the unit before it.
const CAPTION_UNIT_MIN_CHARS = 6;

// The rewrite is grounded in the frames but written as flat description, and flat description in
// Korean lands on a declarative ending. The narration economy rule allows at most one of those per
// cut, so a rewrite can trade a machine-eye failure for an economy failure. Warn rather than
// refuse - the sentence is still true, and a human may want it.
const DECLARATIVE_CLOSER = { ko: /(습니다|했다|이다|입니다|됩니다|합니다|였다)\.?$/, ja: /(ました|します|しました|です|でした|である|だった)。?$/ };

function chunkSentence(sentence) {
  const words = String(sentence || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const units = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    // Take the word if the chunk is still short, or if dropping it would leave a chunk so small
    // it reads as a fragment.
    if (candidate.length <= CAPTION_UNIT_TARGET_CHARS || current.length < CAPTION_UNIT_MIN_CHARS) {
      current = candidate;
      continue;
    }
    units.push(current);
    current = word;
  }
  if (current) {
    // A trailing scrap gets folded back rather than shipped as its own subtitle.
    if (units.length && current.length < CAPTION_UNIT_MIN_CHARS) units[units.length - 1] += ` ${current}`;
    else units.push(current);
  }
  return units;
}

// caption_units must concatenate back to the narration with spaces only, so the units covering the
// replaced sentence have to be found as a contiguous run rather than matched one by one.
function rewriteCaptionUnits(units, oldSentence, newSentence) {
  const list = Array.isArray(units) ? units.map((u) => String(u || '').trim()).filter(Boolean) : [];
  if (!list.length) return chunkSentence(newSentence);
  const target = String(oldSentence || '').replace(/\s+/g, '');
  for (let start = 0; start < list.length; start += 1) {
    let joined = '';
    for (let end = start; end < list.length; end += 1) {
      joined += list[end].replace(/\s+/g, '');
      if (joined.length > target.length) break;
      if (joined === target) {
        return [...list.slice(0, start), ...chunkSentence(newSentence), ...list.slice(end + 1)];
      }
    }
  }
  return null; // caller decides - a silent append would desync captions from narration
}

function applyToFill(fill, oldSentence, newSentence) {
  const narration = String(fill.narration || '');
  if (!narration.includes(oldSentence)) return { ok: false, reason: 'sentence not found in narration' };
  const nextNarration = narration.replace(oldSentence, newSentence);
  const nextUnits = rewriteCaptionUnits(fill.caption_units, oldSentence, newSentence);
  if (!nextUnits) return { ok: false, reason: 'caption_units do not spell the sentence - needs a hand pass' };
  const captionKey = typeof fill.caption_kr === 'string' ? 'caption_kr' : null;
  const next = { ...fill, narration: nextNarration, caption_units: nextUnits, authored: true };
  if (captionKey) next[captionKey] = nextUnits.join(' ');
  return { ok: true, fill: next, before: narration, after: nextNarration };
}

function loadIssues(source) {
  const raw = source === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(source, 'utf8');
  const text = raw.trim();
  // Accept either the bare array or the whole failure record the queue stores.
  const start = text.indexOf('[');
  const parsed = JSON.parse(text.startsWith('[') ? text : text.slice(start));
  return Array.isArray(parsed) ? parsed : [];
}

function main() {
  const argv = process.argv.slice(2);
  const runDir = argv.find((a) => !a.startsWith('--'));
  const issuesArg = argv[argv.indexOf('--issues') + 1];
  const apply = argv.includes('--apply');
  if (!runDir || !argv.includes('--issues')) {
    console.error('usage: apply_mismatch_rewrites.js <compress_run_dir> --issues <file|-> [--apply]');
    process.exit(2);
  }

  const issues = loadIssues(issuesArg);
  if (!issues.length) {
    console.error('no issues to apply');
    process.exit(2);
  }

  const byLocale = new Map();
  for (const issue of issues) {
    const locale = String(issue.locale || 'ko').toLowerCase();
    if (!byLocale.has(locale)) byLocale.set(locale, []);
    byLocale.get(locale).push(issue);
  }

  let applied = 0;
  let skipped = 0;
  for (const [locale, localeIssues] of byLocale) {
    const file = path.join(runDir, locale === 'ko' ? 'compression_slot_fills.json' : `compression_slot_fills.${locale}.json`);
    if (!fs.existsSync(file)) {
      console.error(`SKIP ${locale}: ${path.basename(file)} not found`);
      skipped += localeIssues.length;
      continue;
    }
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const fills = Array.isArray(doc.slot_fills) ? doc.slot_fills : [];
    let touched = false;
    for (const issue of localeIssues) {
      const index = fills.findIndex((f) => String(f.slot_id) === String(issue.segment_id));
      if (index < 0) {
        console.error(`SKIP ${locale} ${issue.segment_id}: slot not in fills`);
        skipped += 1;
        continue;
      }
      const result = applyToFill(fills[index], issue.sentence, issue.suggested_rewrite);
      if (!result.ok) {
        console.error(`SKIP ${locale} ${issue.segment_id}: ${result.reason}`);
        skipped += 1;
        continue;
      }
      fills[index] = result.fill;
      touched = true;
      applied += 1;
      console.log(`${locale} ${issue.segment_id}`);
      console.log(`  - ${issue.sentence}`);
      console.log(`  + ${issue.suggested_rewrite}`);
      console.log(`    units: ${result.fill.caption_units.join(' | ')}`);
      const closer = DECLARATIVE_CLOSER[locale];
      if (closer && closer.test(String(issue.suggested_rewrite).trim())) {
        console.log('    WARN: declarative ending - check narration_economy after the rebuild');
      }
    }
    if (touched && apply) {
      fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
      console.log(`wrote ${path.basename(file)}`);
    }
  }

  console.log(`\napplied ${applied}, skipped ${skipped}${apply ? '' : '  (dry run - pass --apply to write)'}`);
  // A partial application still leaves the run failing the gate, so the caller must know.
  process.exit(skipped > 0 ? 1 : 0);
}

if (require.main === module) main();
module.exports = { chunkSentence, rewriteCaptionUnits, applyToFill };

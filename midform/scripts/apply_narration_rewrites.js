#!/usr/bin/env node
'use strict';

// Splice AUTHORED replacement sentences into a compress run's slot fills.
//
// This is the hand-surgery tool for the rebuild loop: you have decided what a slot should say, and
// this puts it in without desyncing anything. Editing narration by hand is easy to get wrong -
// caption_units must still concatenate to the narration, and a shifted unit slides every subtitle
// after it - so the splice is done by finding the contiguous run of units that spells the old
// sentence and refusing the edit outright if they do not add up.
//
//   node midform/scripts/apply_narration_rewrites.js <compress_run_dir> --edits <file|-> [--apply]
//
// --edits takes a JSON array of {locale, segment_id, sentence, replacement}. Without --apply this
// is a dry run and prints the diff. Rewritten slots are marked "authored": true so compress-apply
// does not overwrite them. Run compress-refresh and resume from bootstrap afterwards.
//
// DO NOT feed this the machine eye's suggested_rewrite. That field describes what is in the frame;
// it is evidence for writing a sentence, not the sentence. Pasted verbatim it turns narration into
// a caption ("두 여자가 넓은 부엌에서 이야기를 나눕니다" - a real incident, and the reason the
// mismatch report leads with that warning). Write from the frame fact what actually HAPPENED, or
// drop the slot's narration - subtraction is the house rule. The nightly batch feeds rejected
// sentences plus the frame fact back into regeneration instead; see recordNarrationRejections.

const fs = require('fs');
const path = require('path');

// Matches the shape the generator produces: chunks of roughly a phrase, split on spaces, never
// mid-word. Observed units run 9-15 characters.
const CAPTION_UNIT_TARGET_CHARS = 14;
// A trailing "있습니다." on its own line reads as a fragment, so a scrap this short is folded back
// into the unit before it.
const CAPTION_UNIT_MIN_CHARS = 6;

// The narration economy rule allows at most one declarative ending per cut, so a hand edit can
// trade one gate failure for another. Warn rather than refuse - it is the author's call.
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

// Re-chunk a whole narration when its existing units cannot be trusted. Sentences stay apart so a
// unit never straddles a full stop, which is where a subtitle break reads worst.
function splitNarrationIntoUnits(narration) {
  const sentences = String(narration || '')
    .split(/(?<=[.!?…。！？])\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  return sentences.flatMap((sentence) => chunkSentence(sentence));
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
  let nextUnits = rewriteCaptionUnits(fill.caption_units, oldSentence, newSentence);
  let rechunked = false;
  if (!nextUnits) {
    // The splice needs the units to spell the sentence, and in about a fifth of generated slots
    // they do not - the model drops a word or two when chunking. That used to abort the edit.
    // It does not have to: the draft builder re-chunks captions from the narration sentences
    // themselves (verified against a shipped ja draft, whose caption text concatenates to its
    // narration exactly), so compression's caption_units are not what reaches the timeline.
    // Re-chunk the whole narration instead of refusing - it leaves the two fields consistent,
    // which is strictly better than the state we found (2026-08-24).
    nextUnits = splitNarrationIntoUnits(nextNarration);
    rechunked = true;
  }
  const captionKey = typeof fill.caption_kr === 'string' ? 'caption_kr' : null;
  const next = { ...fill, narration: nextNarration, caption_units: nextUnits, authored: true };
  if (captionKey) next[captionKey] = nextUnits.join(' ');
  return { ok: true, fill: next, before: narration, after: nextNarration, rechunked };
}

function loadEdits(source) {
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
  const editsArg = argv[argv.indexOf('--edits') + 1];
  const apply = argv.includes('--apply');
  if (!runDir || !argv.includes('--edits')) {
    console.error('usage: apply_narration_rewrites.js <compress_run_dir> --edits <file|-> [--apply]');
    process.exit(2);
  }

  const issues = loadEdits(editsArg);
  if (!issues.length) {
    console.error('no edits to apply');
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
      const result = applyToFill(fills[index], issue.sentence, issue.replacement);
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
      console.log(`  + ${issue.replacement}`);
      console.log(`    units: ${result.fill.caption_units.join(' | ')}`);
      if (result.rechunked) console.log('    (existing units did not spell the sentence - whole narration re-chunked)');
      const closer = DECLARATIVE_CLOSER[locale];
      if (closer && closer.test(String(issue.replacement).trim())) {
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
module.exports = { chunkSentence, rewriteCaptionUnits, applyToFill, splitNarrationIntoUnits };

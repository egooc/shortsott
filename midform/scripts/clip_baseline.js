// Freeze a source's accepted dialogue clip ranges, and fail any rebuild that quietly moves them.
//
// Two of this project's worst days were silent drift, not visible errors: a run that fell back to an
// older compression plan and kept going, and a gate-failed build that got installed because the
// batch never read run_summary.status. Both shipped clips nobody had approved. A committed baseline
// turns that into a diff.
//
//   node midform/scripts/clip_baseline.js write <draft/edit_manifest.json> <baseline.json> [--note "..."]
//   node midform/scripts/clip_baseline.js check <draft/edit_manifest.json> <baseline.json> [--tolerance 0.05]
//
// check exits 1 on drift, so it can gate an install.
const fs = require('fs');

const mode = process.argv[2];
const manifestPath = process.argv[3];
const baselinePath = process.argv[4];
const noteIdx = process.argv.indexOf('--note');
const note = noteIdx > 0 ? process.argv[noteIdx + 1] : '';
const tolIdx = process.argv.indexOf('--tolerance');
const TOLERANCE = tolIdx > 0 ? Number(process.argv[tolIdx + 1]) : 0.05;

if (!['write', 'check'].includes(mode) || !manifestPath || !baselinePath) {
  console.error('usage: clip_baseline.js write|check <edit_manifest.json> <baseline.json>');
  process.exit(2);
}

const toSec = (value) => {
  const [h, m, s] = String(value).split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const clips = {};
for (const segment of manifest.segments || []) {
  if (segment.segment_type !== 'dialogue_quote') continue;
  const clip = (segment.source_clips || [])[0];
  if (!clip || clips[segment.segment_id]) continue;
  clips[segment.segment_id] = {
    start: +toSec(clip.start).toFixed(3),
    end: +toSec(clip.end).toFixed(3),
    speaker: segment.speaker || '',
  };
}

if (mode === 'write') {
  const payload = {
    draft_name: manifest.draft_name || '',
    // Lineage travels with the baseline: a diff against clips built from a different compression run
    // is not drift, it is a different edit, and saying so beats a page of range mismatches.
    source_duration_sec: manifest.source_duration_sec,
    dialogue_clips: Object.keys(clips).length,
    note,
    clips,
  };
  fs.writeFileSync(baselinePath, JSON.stringify(payload, null, 1));
  console.log(`baseline written: ${payload.dialogue_clips} dialogue clips -> ${baselinePath}`);
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const expected = baseline.clips || {};
const drift = [];
for (const [id, want] of Object.entries(expected)) {
  const got = clips[id];
  if (!got) {
    drift.push(`${id}: clip is gone (was ${want.start}-${want.end})`);
    continue;
  }
  if (Math.abs(got.start - want.start) > TOLERANCE || Math.abs(got.end - want.end) > TOLERANCE) {
    drift.push(`${id}: ${want.start}-${want.end} -> ${got.start}-${got.end}`);
  }
  if (want.speaker && got.speaker && want.speaker !== got.speaker) {
    drift.push(`${id}: speaker ${want.speaker} -> ${got.speaker}`);
  }
}
for (const id of Object.keys(clips)) {
  if (!expected[id]) drift.push(`${id}: new clip ${clips[id].start}-${clips[id].end}`);
}

console.log(`baseline ${baselinePath}: ${Object.keys(expected).length} clips, drift ${drift.length}`);
for (const line of drift) console.log(`  DRIFT ${line}`);
if (drift.length) {
  console.log('  (a deliberate edit? re-run with `write` and commit the new baseline as part of that change)');
}
process.exit(drift.length ? 1 : 0);

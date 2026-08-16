// How much of each dialogue clip is not the line being spoken.
//
// A clip that opens two seconds before its first word plays two seconds of score or room tone under
// a caption, and the trim that is supposed to prevent that runs on an energy threshold which counts
// music as speech. Before rewiring the trim onto a real VAD - which would move every clip in every
// source and cost a full rebuild - measure what the current clips actually carry.
//
//   node midform/scripts/report_clip_dead_air.js <edit_manifest.json> <alignment.json> [--vad <ranges.json>]
//
// With --vad it also says whether that head/tail is silence or something audible (music, effects),
// which is the part the energy detector gets wrong.
const fs = require('fs');

const manifestPath = process.argv[2];
const alignmentPath = process.argv[3];
const vadIdx = process.argv.indexOf('--vad');
const vadPath = vadIdx > 0 ? process.argv[vadIdx + 1] : '';

if (!manifestPath || !alignmentPath) {
  console.error('usage: report_clip_dead_air.js <edit_manifest.json> <alignment.json> [--vad ranges.json]');
  process.exit(2);
}

const toSec = (value) => {
  const [h, m, s] = String(value).split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const alignment = JSON.parse(fs.readFileSync(alignmentPath, 'utf8'));
const vad = vadPath && fs.existsSync(vadPath) ? JSON.parse(fs.readFileSync(vadPath, 'utf8')).ranges || [] : [];

const speechIn = (from, to) => {
  let covered = 0;
  for (const [start, end] of vad) {
    if (end <= from) continue;
    if (start >= to) break;
    covered += Math.min(to, end) - Math.max(from, start);
  }
  return covered;
};

const aligned = new Map();
for (const line of alignment.lines || []) {
  if (line.status === 'aligned' && (line.words || []).length) aligned.set(String(line.utt_id), line);
}

const rows = [];
const seen = new Set();
for (const segment of manifest.segments || []) {
  if (segment.segment_type !== 'dialogue_quote') continue;
  const clip = (segment.source_clips || [])[0];
  if (!clip || seen.has(segment.segment_id)) continue;
  seen.add(segment.segment_id);
  const line = aligned.get(String(segment.source_utterance_id || segment.segment_id));
  if (!line) continue;
  const start = toSec(clip.start);
  const end = toSec(clip.end);
  const words = line.words;
  const head = Math.max(0, Math.min(words[0].s, end) - start);
  const tail = Math.max(0, end - Math.max(words[words.length - 1].e, start));
  rows.push({
    id: segment.segment_id,
    head: +head.toFixed(2),
    tail: +tail.toFixed(2),
    // Of that head/tail, how much is audible to a real VAD - i.e. music the energy trim would keep.
    head_voiced: vad.length ? +speechIn(start, Math.min(words[0].s, end)).toFixed(2) : null,
    tail_voiced: vad.length ? +speechIn(Math.max(words[words.length - 1].e, start), end).toFixed(2) : null,
    line: String(line.line).slice(0, 40),
  });
}

const q = (values, p) => (values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length * p)] : 0);
const heads = rows.map((r) => r.head);
const tails = rows.map((r) => r.tail);
console.log(`clips ${rows.length}`);
console.log(`head dead air: p50 ${q(heads, 0.5)}s p90 ${q(heads, 0.9)}s max ${q(heads, 0.999)}s`);
console.log(`tail dead air: p50 ${q(tails, 0.5)}s p90 ${q(tails, 0.9)}s max ${q(tails, 0.999)}s`);
console.log(`total dead air ${rows.reduce((sum, r) => sum + r.head + r.tail, 0).toFixed(1)}s across the dialogue clips`);
if (vad.length) {
  const voiced = rows.reduce((sum, r) => sum + (r.head_voiced || 0) + (r.tail_voiced || 0), 0);
  console.log(`of that, ${voiced.toFixed(1)}s is audible to the VAD (music/effects the energy trim keeps)`);
}
for (const row of rows.filter((r) => r.head > 1 || r.tail > 1).sort((a, b) => (b.head + b.tail) - (a.head + a.tail)).slice(0, 8)) {
  console.log(`  head ${row.head}s tail ${row.tail}s  ${row.id}  "${row.line}"`);
}

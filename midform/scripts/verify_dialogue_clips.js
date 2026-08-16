// Check a rendered draft's dialogue clips against where the words are actually spoken.
//
// Input is an edit_manifest.json plus the alignment produced by align_dialogue_lines.py. The
// alignment is per-word, so this can answer the three questions the caption-based gates cannot:
//
//   1. containment - does the clip carry its own line's words, or does it open after the line is
//      already over (the "발화 장면인데 끝단어만 들린다" failure)
//   2. mid-word cut - does a boundary land inside a word, which is audible as a chopped syllable
//   3. duplicate audio - do two clips replay the same spoken words (the timeline stutters)
//
//   node midform/scripts/verify_dialogue_clips.js <edit_manifest.json> <alignment.json> [--json out]
//
// Exit code is 1 when any FAIL-level finding survives, so a caller can gate on it.
const fs = require('fs');

const manifestPath = process.argv[2];
const alignmentPath = process.argv[3];
const jsonIdx = process.argv.indexOf('--json');
const jsonOut = jsonIdx > 0 ? process.argv[jsonIdx + 1] : '';
// Optional second opinion: a full-source ASR word stream (faster-whisper). Alignment can only speak
// about words we asked it about, so it can never notice a SECOND voice inside the clip - the
// failure where a clip plays three people and captions one of them.
const asrIdx = process.argv.indexOf('--asr');
const asrPath = asrIdx > 0 ? process.argv[asrIdx + 1] : '';

if (!manifestPath || !alignmentPath) {
  console.error('usage: verify_dialogue_clips.js <edit_manifest.json> <alignment.json> [--json out]');
  process.exit(2);
}

// A clip may legitimately stop where the next line starts, and a word may be half-swallowed by the
// cut that ends the shot. These are the tolerances measured as inaudible on this channel's output.
const CONTAINMENT_FAIL = 0.55;   // below this the viewer cannot follow the line from the audio
const CONTAINMENT_WARN = 0.85;
const MIDWORD_TOLERANCE = 0.06;  // a boundary this deep into a word is not audible as a cut
const DUPLICATE_MIN_SEC = 0.35;  // shorter shared audio is a padding overlap, not a stutter
// Calibrated on 117 aligned lines across five sources: lines the plan already places within 0.3s
// (presumed correct) sit at p10 0.6, while lines disagreeing by 2s+ sit at p50 0.56 and are 92%
// ambiguous. Below this we report but never accuse.
const CONFIDENCE_FLOOR = 0.6;
const FOREIGN_EDGE_GUARD = 0.15;  // padding at each end may clip a neighbouring word
const FOREIGN_MIN_WORDS = 3;      // fewer than this is a bleed, not a second speaker

const toSec = (value) => {
  const [h, m, s] = String(value).split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};

const norm = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();

const asrWords = [];
if (asrPath && fs.existsSync(asrPath)) {
  for (const segment of JSON.parse(fs.readFileSync(asrPath, 'utf8'))) {
    for (const word of segment.words || []) {
      const text = norm(word.w);
      if (text && Number.isFinite(word.s) && Number.isFinite(word.e)) asrWords.push({ t: text, s: word.s, e: word.e });
    }
  }
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const alignment = JSON.parse(fs.readFileSync(alignmentPath, 'utf8'));

const alignedByUtt = new Map();
for (const line of alignment.lines || []) {
  if (line.status === 'aligned') alignedByUtt.set(String(line.utt_id), line);
}

// One entry per rendered dialogue clip. A segment repeats per caption chunk, so dedupe by id.
const clips = new Map();
for (const segment of manifest.segments || []) {
  if (segment.segment_type !== 'dialogue_quote') continue;
  const clip = (segment.source_clips || [])[0];
  if (!clip || clips.has(segment.segment_id)) continue;
  clips.set(segment.segment_id, {
    id: segment.segment_id,
    utt: String(segment.source_utterance_id || segment.segment_id),
    start: toSec(clip.start),
    end: toSec(clip.end),
    speaker: segment.speaker || '',
  });
}

// A line whose tail is carried by the NEXT clip is still fully heard - back-to-back exchanges are
// cut that way on purpose. So the number that gates is coverage by the timeline as a whole; per-clip
// coverage stays informational, otherwise every rapid-fire exchange reads as a defect.
const timeline = [...clips.values()].map((c) => [c.start, c.end]).sort((a, b) => a[0] - b[0]);
const coveredByTimeline = (from, to) => {
  let covered = 0;
  for (const [start, end] of timeline) {
    if (end <= from) continue;
    if (start >= to) break;
    covered += Math.min(to, end) - Math.max(from, start);
  }
  return covered;
};

const findings = [];
const rows = [];
for (const clip of clips.values()) {
  const line = alignedByUtt.get(clip.utt);
  if (!line) {
    rows.push({ ...clip, status: 'no_alignment' });
    continue;
  }
  const words = line.words || [];
  const spoken = words.length ? words[words.length - 1].e - words[0].s : 0;
  const inside = words.filter((w) => w.e > clip.start && w.s < clip.end);
  const heard = inside.reduce((sum, w) => sum + (Math.min(clip.end, w.e) - Math.max(clip.start, w.s)), 0);
  const containment = spoken > 0 ? heard / spoken : 0;
  const heardAnywhere = words.reduce((sum, w) => sum + coveredByTimeline(w.s, w.e), 0);
  const spokenWords = words.reduce((sum, w) => sum + (w.e - w.s), 0);
  const timelineContainment = spokenWords > 0 ? heardAnywhere / spokenWords : 0;
  const trusted = (line.confident_word_ratio ?? 1) >= CONFIDENCE_FLOOR && !line.weak_tokens && !line.ambiguous;

  // A boundary inside a word: the syllable is audibly cut in half.
  const cuts = [];
  for (const w of words) {
    const dur = Math.max(0.001, w.e - w.s);
    const startsInside = clip.start > w.s + MIDWORD_TOLERANCE && clip.start < w.e - MIDWORD_TOLERANCE;
    const endsInside = clip.end > w.s + MIDWORD_TOLERANCE && clip.end < w.e - MIDWORD_TOLERANCE;
    if (startsInside) cuts.push({ edge: 'start', word: w.w, at: clip.start, into: +((clip.start - w.s) / dur).toFixed(2) });
    if (endsInside) cuts.push({ edge: 'end', word: w.w, at: clip.end, into: +((clip.end - w.s) / dur).toFixed(2) });
  }

  rows.push({
    ...clip,
    status: 'checked',
    line: line.line,
    spoken_start: line.start_sec,
    spoken_end: line.end_sec,
    containment: +containment.toFixed(2),
    timeline_containment: +timelineContainment.toFixed(2),
    confidence: line.confident_word_ratio,
    mid_word_cuts: cuts.length,
  });

  // Auto-captions merge two utterances into one line and then repeat the shared words in the next
  // line. The tail cut off here is spoken again under the neighbouring caption, so the viewer hears
  // it - that is a caption-splitting artifact, not a lost line.
  const missing = words.filter((w) => coveredByTimeline(w.s, w.e) < (w.e - w.s) * 0.5).map((w) => w.w);
  const neighbourText = [...alignedByUtt.values()]
    .filter((other) => other.utt_id !== line.utt_id && Math.abs((other.start_sec ?? 0) - line.start_sec) < 12)
    .map((other) => String(other.line).toLowerCase())
    .join(' ');
  const carriedByNeighbour = missing.length > 0 && missing.every((w) => neighbourText.includes(w));

  if (trusted && timelineContainment < CONTAINMENT_FAIL && carriedByNeighbour) {
    findings.push({
      level: 'WARN', kind: 'containment_split', clip: clip.id,
      detail: `${(timelineContainment * 100).toFixed(0)}% of its line is in the timeline, but the missing words (${missing.join(' ')}) are spoken again under a neighbouring caption`,
    });
  } else if (trusted && timelineContainment < CONTAINMENT_FAIL) {
    findings.push({
      level: 'FAIL', kind: 'containment', clip: clip.id,
      detail: `only ${(timelineContainment * 100).toFixed(0)}% of "${String(line.line).slice(0, 40)}" is anywhere in the timeline (spoken ${line.start_sec}-${line.end_sec}, clip ${clip.start.toFixed(2)}-${clip.end.toFixed(2)})`,
    });
  } else if (trusted && timelineContainment < CONTAINMENT_WARN) {
    findings.push({
      level: 'WARN', kind: 'containment', clip: clip.id,
      detail: `${(timelineContainment * 100).toFixed(0)}% of its line reaches the timeline (own clip ${(containment * 100).toFixed(0)}%, spoken ${line.start_sec}-${line.end_sec})`,
    });
  }
  // Words audible inside the clip that belong to neither this line nor its neighbours are a voice
  // the viewer hears with no caption on screen.
  if (asrWords.length) {
    const own = new Set(norm(line.line).split(' ').filter(Boolean));
    const neighbourWords = new Set(neighbourText.split(' ').filter(Boolean));
    const heardWords = asrWords.filter((w) => w.s >= clip.start + FOREIGN_EDGE_GUARD && w.e <= clip.end - FOREIGN_EDGE_GUARD);
    const foreign = heardWords.filter((w) => !own.has(w.t) && !neighbourWords.has(w.t));
    if (heardWords.length >= FOREIGN_MIN_WORDS && foreign.length >= FOREIGN_MIN_WORDS
      && foreign.length / heardWords.length > 0.5) {
      findings.push({
        level: 'FAIL', kind: 'uncaptioned_speech', clip: clip.id,
        detail: `${foreign.length}/${heardWords.length} words heard inside the clip belong to no caption here: "${foreign.slice(0, 8).map((w) => w.t).join(' ')}"`,
      });
    }
  }

  for (const cut of cuts) {
    findings.push({
      level: 'WARN', kind: 'mid_word_cut', clip: clip.id,
      detail: `${cut.edge} boundary at ${cut.at.toFixed(2)} falls ${Math.round(cut.into * 100)}% into "${cut.word}"`,
    });
  }
}

// The same words played twice reads as a stutter in the timeline.
const ordered = [...clips.values()].sort((a, b) => a.start - b.start);
for (let i = 0; i < ordered.length - 1; i++) {
  for (let j = i + 1; j < ordered.length; j++) {
    if (ordered[j].start >= ordered[i].end) break;
    const shared = Math.min(ordered[i].end, ordered[j].end) - ordered[j].start;
    if (shared < DUPLICATE_MIN_SEC) continue;
    findings.push({
      level: 'FAIL', kind: 'duplicate_audio', clip: `${ordered[i].id}+${ordered[j].id}`,
      detail: `${shared.toFixed(2)}s of source audio is played by both clips (${ordered[j].start.toFixed(2)}-${Math.min(ordered[i].end, ordered[j].end).toFixed(2)})`,
    });
  }
}

const checked = rows.filter((r) => r.status === 'checked');
const containments = checked.map((r) => r.timeline_containment).sort((a, b) => a - b);
const summary = {
  manifest: manifestPath,
  clips: clips.size,
  checked: checked.length,
  no_alignment: rows.length - checked.length,
  containment_p50: containments.length ? containments[Math.floor(containments.length / 2)] : null,
  containment_min: containments.length ? containments[0] : null,
  fail: findings.filter((f) => f.level === 'FAIL').length,
  warn: findings.filter((f) => f.level === 'WARN').length,
};

console.log(`clips ${summary.clips} (aligned ${summary.checked}, unaligned ${summary.no_alignment})`);
console.log(`containment p50 ${summary.containment_p50} min ${summary.containment_min} | FAIL ${summary.fail} WARN ${summary.warn}`);
for (const finding of findings.sort((a, b) => (a.level === b.level ? 0 : a.level === 'FAIL' ? -1 : 1))) {
  console.log(`  ${finding.level} ${finding.kind} ${finding.clip}: ${finding.detail}`);
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ summary, findings, rows }, null, 1));
process.exit(summary.fail > 0 ? 1 : 0);

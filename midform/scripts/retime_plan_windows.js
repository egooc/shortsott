// Re-time an APPROVED edit plan against a corrected transcript (and, when available, the audio).
//
// The plan's line selection and the Korean script stay exactly as approved; only each dialogue
// window's coordinates move to where the line is actually spoken, so the review gate sees an
// unchanged script. Use this - not compress-refresh - to carry a transcript-coordinate fix into a
// source whose script the owner already approved: a refresh re-derives which lines are kept.
//
//   node midform/scripts/retime_plan_windows.js <edit_plan.json> <transcript_timed.json> \
//        [--whisper <whisper_words.json>] [--apply]
//
// The whisper file is optional and is the stronger truth: word-level timings straight from the
// audio. It is only ever an oracle for WHERE a line is spoken - the caption text always stays the
// plan's. Lines it cannot confirm fall back to the transcript cues, and lines neither can place
// keep their approved timing.
const fs = require('fs');

const planPath = process.argv[2];
const transcriptPath = process.argv[3];
const apply = process.argv.includes('--apply');
const whisperIdx = process.argv.indexOf('--whisper');
const whisperPath = whisperIdx > 0 ? process.argv[whisperIdx + 1] : '';
const gapIdx = process.argv.indexOf('--gap');
// Downstream stages (the short-clip floor, the VAD trim) move these edges again, so a source whose
// clips still collide after a re-time just needs a wider margin here.
const GAP = gapIdx > 0 ? Number(process.argv[gapIdx + 1]) : 0.35;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
const toks = (s) => norm(s).split(' ').filter(Boolean);

// One flat stream of spoken tokens. Cue text and whisper words both reduce to this shape, so a line
// that straddles two cues ("Sonny." + "How can I help you?") is found the same way as one inside a
// single cue - the old per-cue probe missed every one of those.
function streamFromCues(cues) {
  const out = [];
  for (const cue of cues) {
    const s = Number(cue.start_sec);
    const e = Number(cue.end_sec);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    for (const t of toks(cue.text)) out.push({ t, s, e });
  }
  return out;
}

function streamFromWhisper(segments) {
  const out = [];
  for (const seg of segments) {
    for (const w of seg.words || []) {
      const t = norm(w.w);
      const s = Number(w.s);
      const e = Number(w.e);
      if (t && Number.isFinite(s) && Number.isFinite(e)) out.push({ t, s, e });
    }
  }
  return out;
}

// Walk the line's tokens through the stream from `i`, allowing a couple of stray stream tokens
// between them (auto-captions insert ">>", repeat a word, or whisper hears a filler).
function runFrom(stream, i, lineTokens) {
  let matched = 0;
  let k = 0;
  let j = i;
  let last = i;
  const hits = [];
  const budget = lineTokens.length * 2 + 4;
  while (k < lineTokens.length && j < stream.length && j - i < budget) {
    if (stream[j].t === lineTokens[k]) { matched += 1; last = j; hits.push(j); k += 1; j += 1; continue; }
    // let the line skip a token it does not share with the stream, but only once in a row
    if (j + 1 < stream.length && stream[j + 1].t === lineTokens[k]) { j += 1; continue; }
    k += 1;
  }
  // A dramatic pause inside a line ("The... number one pick") leaves the first word stranded seconds
  // ahead of the rest. Starting the clip there buys four seconds of silence, so open after the gap.
  let first = hits[0] ?? i;
  for (let h = 1; h < hits.length && h <= Math.ceil(hits.length / 3); h++) {
    if (stream[hits[h]].s - stream[hits[h - 1]].e > 1.5) first = hits[h];
  }
  return { matched, last, first };
}

function makeLocator(stream) {
  return function locate(line, hint, bounds) {
    const lt = toks(line);
    if (!lt.length) return null;
    const single = lt.length < 2;
    const reach = single ? 8 : 45;
    const lo = Number.isFinite(bounds?.lo) ? bounds.lo : -Infinity;
    const hi = Number.isFinite(bounds?.hi) ? bounds.hi : Infinity;
    let best = null;
    for (let i = 0; i < stream.length; i++) {
      if (stream[i].t !== lt[0]) continue;
      const start = stream[i].s;
      if (start < lo || start > hi) continue;
      const dist = Number.isFinite(hint) ? Math.abs(start - hint) : 0;
      if (dist > reach) continue;
      const { matched, last, first } = runFrom(stream, i, lt);
      const score = matched / lt.length;
      // Below 0.75 the run is as likely to be a neighbouring line sharing a few words - the approved
      // timing is the safer answer than a confident-looking move onto the wrong sentence.
      if (score < (single ? 1 : 0.75)) continue;
      if (lt.length >= 4 && matched < 3) continue;
      if (!best || score > best.score + 0.001 || (Math.abs(score - best.score) <= 0.001 && dist < best.dist)) {
        best = { score, dist, s: stream[first].s, e: stream[last].e };
      }
    }
    return best;
  };
}

const cueLocate = makeLocator(streamFromCues(JSON.parse(fs.readFileSync(transcriptPath, 'utf8'))));
const audioLocate = whisperPath && fs.existsSync(whisperPath)
  ? makeLocator(streamFromWhisper(JSON.parse(fs.readFileSync(whisperPath, 'utf8'))))
  : null;

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

let moved = 0;
let kept = 0;
let unmatched = 0;
let reverted = 0;
let fromAudio = 0;
const report = [];
const ordered = [];
for (const item of plan.timeline || []) {
  for (const win of item.dialogue_line_windows || []) {
    ordered.push({ win, slot: item.slot_id, orig: { s: win.start_sec, e: win.end_sec, rs: win.raw_start_sec, re: win.raw_end_sec } });
  }
}

for (let idx = 0; idx < ordered.length; idx++) {
  const { win, slot } = ordered[idx];
  // A window the plan itself never matched is not rendered; moving it would invent a clip.
  if (win.matched === false) { kept += 1; continue; }
  const line = String(win.line || '');
  const rawHint = Number(win.raw_start_sec ?? win.start_sec);
  // A window with no coordinates at all still has neighbours: search only between them.
  const prev = Number(ordered[idx - 1]?.orig?.s);
  const next = Number(ordered[idx + 1]?.orig?.s);
  const hint = Number.isFinite(rawHint) && rawHint > 0
    ? rawHint
    : (Number.isFinite(prev) && Number.isFinite(next) ? (prev + next) / 2 : NaN);
  // Neighbour bounds only help a window that has no coordinate of its own: a plan may legitimately
  // replay an earlier line out of order, and bounding those rejects their true match.
  const bounds = Number.isFinite(rawHint) && rawHint > 0
    ? {}
    : { lo: Number.isFinite(prev) ? prev : -Infinity, hi: Number.isFinite(next) ? next + 5 : Infinity };
  if (!Number.isFinite(hint)) { unmatched += 1; report.push(`  UNPLACEABLE ${slot} "${line.slice(0, 40)}"`); continue; }

  const audio = audioLocate ? audioLocate(line, hint, bounds) : null;
  const cue = cueLocate(line, hint, bounds);
  // Prefer the audio unless it is clearly the weaker match for this line.
  const hit = audio && (!cue || audio.score >= cue.score - 0.001) ? audio : cue;
  if (!hit) { unmatched += 1; report.push(`  UNMATCHED ${slot} "${line.slice(0, 40)}" @${Number.isFinite(rawHint) ? rawHint : '-'}`); continue; }
  if (hit === audio) fromAudio += 1;

  const ds = Math.abs(hit.s - rawHint);
  if (Number.isFinite(rawHint) && ds <= 0.25) { kept += 1; continue; }
  report.push(`  ${slot} ${Number.isFinite(rawHint) ? rawHint.toFixed(2) : '-'} → ${hit.s.toFixed(2)} (${hit.s - rawHint >= 0 ? '+' : ''}${(hit.s - rawHint).toFixed(2)}s, ${hit === audio ? 'audio' : 'cue'} ${hit.score.toFixed(2)}) "${line.slice(0, 40)}"`);
  moved += 1;
  if (apply) {
    const oldSpan = Number(win.end_sec) - Number(win.start_sec);
    win.raw_start_sec = +hit.s.toFixed(3);
    win.raw_end_sec = +hit.e.toFixed(3);
    win.start_sec = +hit.s.toFixed(3);
    win.end_sec = +Math.max(hit.e, hit.s + Math.min(Number.isFinite(oldSpan) ? oldSpan : 0, hit.e - hit.s)).toFixed(3);
  }
}

// Two lines of one exchange can locate onto the same words (auto-captions smear a line across its
// neighbour's cue), which lands both windows on one start and the gate rejects the pair. The plan's
// own order is the truth about who speaks first, so revert whichever move broke it.
if (apply) {
  for (let i = 1; i < ordered.length; i++) {
    const prev = Number(ordered[i - 1].win.start_sec);
    const cur = Number(ordered[i].win.start_sec);
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || cur >= prev + 0.3) continue;
    const o = ordered[i].orig;
    Object.assign(ordered[i].win, { start_sec: o.s, end_sec: o.e, raw_start_sec: o.rs, raw_end_sec: o.re });
    reverted += 1;
    report.push(`  reverted (would jump ahead of its own previous line): "${String(ordered[i].win.line).slice(0, 34)}"`);
  }
}

// The cold-open teaser reserves a source range of its own. A window re-timed back to where the line
// is really spoken can land inside it, and the gate rejects that outright
// (cold_open_no_reserved_overlap) - so start after the teaser even though the words begin earlier.
if (apply) {
  const cs = plan.cold_open_selection || {};
  const teaserStart = Number(cs.teaser_visual_start_sec);
  const teaserEnd = Number(cs.teaser_visual_end_sec);
  if (Number.isFinite(teaserStart) && Number.isFinite(teaserEnd)) {
    for (const { win } of ordered) {
      const s = Number(win.start_sec);
      const e = Number(win.end_sec);
      if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
      // Clearing the teaser by a hair is not enough: each clip carries ~0.35s of pre-roll, which
      // pulls a window that starts just after the teaser back inside it and trips the gate.
      if (s >= teaserEnd + 0.45 || e <= teaserStart) continue;
      if (e <= teaserEnd + 0.9) continue; // wholly inside the teaser: leave it alone
      win.start_sec = +(teaserEnd + 0.45).toFixed(3);
      if (Number(win.raw_start_sec) < teaserEnd) win.raw_start_sec = win.start_sec;
      report.push(`  teaser guard: "${String(win.line).slice(0, 34)}" start ${s.toFixed(2)} → ${win.start_sec}`);
    }
  }
}

// A moved window can now collide with its neighbour, and the draft gate rejects overlapping source
// ranges outright (the run then silently falls back to an older plan). Keep 0.35s between clips -
// the same gap the floor guard leaves for pre/post-roll padding.
let separated = 0;
if (apply) {
  const all = ordered
    .map(({ win }) => win)
    .filter((w) => Number.isFinite(Number(w.start_sec)) && Number(w.end_sec) > Number(w.start_sec))
    .sort((a, b) => Number(a.start_sec) - Number(b.start_sec));
  for (let i = 0; i < all.length - 1; i++) {
    const cur = all[i];
    const limit = Number(all[i + 1].start_sec) - GAP;
    if (Number(cur.end_sec) <= limit) continue;
    if (limit < Number(cur.start_sec) + 0.4) {
      report.push(`  OVERLAP left as-is: "${String(cur.line).slice(0, 34)}" cannot fit before "${String(all[i + 1].line).slice(0, 24)}"`);
      continue;
    }
    cur.end_sec = +limit.toFixed(3);
    if (Number(cur.raw_end_sec) > limit) cur.raw_end_sec = +limit.toFixed(3);
    separated += 1;
  }
}

console.log(report.join('\n'));
console.log(`windows: moved ${moved} (audio ${fromAudio}), unchanged ${kept}, unmatched ${unmatched}, reverted ${reverted}, separated ${separated}`);
if (apply) {
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  console.log('edit_plan.json updated');
}

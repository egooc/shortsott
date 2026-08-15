// Re-time an APPROVED edit plan against a corrected transcript.
// The plan's line selection and the Korean script stay exactly as approved; only each dialogue
// window's coordinates move to where the line is actually spoken. Blast radius is one field pair
// per window, so the review gate sees an unchanged script.
const fs = require('fs');

const planPath = process.argv[2];
const transcriptPath = process.argv[3];
const apply = process.argv[4] === '--apply';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
const toks = (s) => norm(s).split(' ').filter(Boolean);

const cues = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

// The cue run that carries this line: start at the cue holding its first tokens, extend while the
// line's remaining tokens keep coming. Anchored near the window's current time so a line repeated
// elsewhere in the source cannot steal it.
function locate(line, hint) {
  const lt = toks(line);
  if (lt.length < 2) return null;
  let best = null;
  for (let i = 0; i < cues.length; i++) {
    const ct = toks(cues[i].text);
    if (!ct.length) continue;
    let hit = 0;
    const probe = lt.slice(0, Math.min(4, lt.length));
    for (let k = 0; k <= ct.length - 1; k++) {
      let run = 0;
      for (let p = 0; p < probe.length && k + p < ct.length; p++) if (ct[k + p] === probe[p]) run++;
      if (run > hit) hit = run;
    }
    const score = hit / Math.min(4, lt.length);
    if (score < 0.75) continue;
    // extend across following cues while the line still has tokens left to cover
    let covered = ct.length;
    let j = i;
    while (covered < lt.length && j + 1 < cues.length && j + 1 <= i + 5) {
      const nt = toks(cues[j + 1].text);
      const overlap = nt.filter((w) => lt.includes(w)).length / Math.max(1, nt.length);
      if (overlap < 0.5) break;
      j += 1;
      covered += nt.length;
    }
    const dist = Math.abs(Number(cues[i].start_sec) - hint);
    if (!best || score > best.score + 0.001 || (Math.abs(score - best.score) < 0.001 && dist < best.dist)) {
      best = { score, dist, s: Number(cues[i].start_sec), e: Number(cues[j].end_sec) };
    }
  }
  return best && best.dist <= 45 ? best : null;
}

let moved = 0;
let kept = 0;
let unmatched = 0;
let reverted = 0;
const report = [];
const ordered = []; // windows in plan order, with their pre-move coordinates
for (const item of plan.timeline || []) {
  for (const win of item.dialogue_line_windows || []) {
    ordered.push({ win, orig: { s: win.start_sec, e: win.end_sec, rs: win.raw_start_sec, re: win.raw_end_sec } });
  }
}
for (const item of plan.timeline || []) {
  for (const win of item.dialogue_line_windows || []) {
    const line = String(win.line || '');
    const hint = Number(win.raw_start_sec ?? win.start_sec ?? 0);
    const hit = locate(line, hint);
    if (!hit) { unmatched += 1; report.push(`  UNMATCHED ${item.slot_id} "${line.slice(0, 40)}" @${hint}`); continue; }
    const ds = Math.abs(hit.s - hint);
    if (ds <= 0.25) { kept += 1; continue; }
    report.push(`  ${item.slot_id} ${hint.toFixed(2)} → ${hit.s.toFixed(2)} (${(hit.s - hint >= 0 ? '+' : '')}${(hit.s - hint).toFixed(2)}s) "${line.slice(0, 42)}"`);
    moved += 1;
    if (apply) {
      const oldSpan = Number(win.end_sec) - Number(win.start_sec);
      win.raw_start_sec = +hit.s.toFixed(3);
      win.raw_end_sec = +hit.e.toFixed(3);
      win.start_sec = +hit.s.toFixed(3);
      // keep at least the span the approved plan gave the line, bounded by the cue run
      win.end_sec = +Math.max(hit.e, hit.s + Math.min(oldSpan, hit.e - hit.s)).toFixed(3);
    }
  }
}

// Two lines of one exchange can locate onto the SAME cue (auto-captions smear a line across its
// neighbour's cue), which lands both windows on one start and the gate rejects the pair. The plan's
// own order is the truth about who speaks first, so revert whichever move broke it.
if (apply) {
  for (let i = 1; i < ordered.length; i++) {
    const prev = Number(ordered[i - 1].win.start_sec);
    const cur = Number(ordered[i].win.start_sec);
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) continue;
    if (cur >= prev + 0.3) continue;
    const o = ordered[i].orig;
    ordered[i].win.start_sec = o.s;
    ordered[i].win.end_sec = o.e;
    ordered[i].win.raw_start_sec = o.rs;
    ordered[i].win.raw_end_sec = o.re;
    reverted += 1;
    report.push(`  reverted (would jump ahead of its own previous line): "${String(ordered[i].win.line).slice(0, 34)}"`);
  }
}

// The cold-open teaser reserves a source range of its own. A window re-timed back to where the
// line is really spoken can land inside it, and the gate rejects that outright
// (cold_open_no_reserved_overlap) - so start after the teaser even though the words begin earlier.
if (apply) {
  const cs = plan.cold_open_selection || {};
  const teaserEnd = Number(cs.teaser_visual_end_sec);
  const teaserStart = Number(cs.teaser_visual_start_sec);
  if (Number.isFinite(teaserEnd) && Number.isFinite(teaserStart)) {
    for (const item of plan.timeline || []) {
      for (const win of item.dialogue_line_windows || []) {
        const s = Number(win.start_sec);
        const e = Number(win.end_sec);
        if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
        if (s >= teaserEnd || e <= teaserStart) continue;
        if (e <= teaserEnd + 0.45) continue; // wholly inside the teaser: leave it alone
        win.start_sec = +(teaserEnd + 0.05).toFixed(3);
        if (Number(win.raw_start_sec) < teaserEnd) win.raw_start_sec = win.start_sec;
        report.push(`  teaser guard: "${String(win.line).slice(0, 34)}" start ${s.toFixed(2)} → ${win.start_sec}`);
      }
    }
  }
}

// A moved window can now collide with its neighbour, and the draft gate rejects overlapping
// source ranges outright (the run then silently falls back to an older plan). Keep 0.35s between
// clips - the same gap the floor guard leaves for pre/post-roll padding.
let separated = 0;
if (apply) {
  const all = [];
  for (const item of plan.timeline || []) {
    for (const win of item.dialogue_line_windows || []) {
      const s = Number(win.start_sec);
      const e = Number(win.end_sec);
      if (Number.isFinite(s) && Number.isFinite(e) && e > s) all.push(win);
    }
  }
  all.sort((a, b) => Number(a.start_sec) - Number(b.start_sec));
  for (let i = 0; i < all.length - 1; i++) {
    const cur = all[i];
    const next = all[i + 1];
    const limit = Number(next.start_sec) - 0.35;
    if (Number(cur.end_sec) <= limit) continue;
    const floorEnd = Number(cur.start_sec) + 0.4;
    if (limit < floorEnd) { report.push(`  OVERLAP left as-is: "${String(cur.line).slice(0, 34)}" cannot fit before "${String(next.line).slice(0, 24)}"`); continue; }
    cur.end_sec = +limit.toFixed(3);
    if (Number(cur.raw_end_sec) > limit) cur.raw_end_sec = +limit.toFixed(3);
    separated += 1;
  }
}

console.log(report.join('\n'));
console.log(`windows: moved ${moved}, unchanged ${kept}, unmatched ${unmatched}, reverted ${reverted}, separated ${separated}`);
if (apply) {
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  console.log('edit_plan.json updated');
}

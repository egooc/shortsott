// Did any shipped clip reach into the source's promo tail?
//
//   node scripts/check-promo-tail.js <draft folder> [--json]
//   node scripts/check-promo-tail.js --all
//
// The pipeline computes usable_end_sec (where the channel outro / end-card begins) and tells the
// planner "nothing may be cut from after Xs". That was the whole enforcement: a sentence in a
// prompt. dropWindowsPastUsableEnd clamped windows whose START was past the limit, so a window
// starting at 392.8 and ending at 398.6 against a limit of 394.5 survived intact and put a frame
// of the film's end credits on screen at 1:56 (Draft Day, found by the owner 2026-09-03).
//
// The clamp is fixed, but a prompt-plus-clamp is still two layers that both live upstream. This
// measures the SHIPPED artifact: the manifest's own clip list against the run's usable_end.
//
// Timecodes in edit_manifest are MIXED - most clips are "HH:MM:SS.mmm" while slot_closing writes
// "MM:SS.mmm". Reading both as HH:MM:SS turns 06:01.674 into 21700 seconds, which is how this
// investigation first chased a phantom. parseTimecode handles both.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DRAFTS_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
const TEST_RUNS = path.join(ROOT, 'midform', 'test_runs');

// Clips land a hair past the boundary from rounding; only a real overrun is a finding.
const OVERRUN_TOLERANCE_SEC = 0.4;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function parseTimecode(value) {
  const text = String(value || '').trim();
  if (!text) return NaN;
  if (/^[\d.]+s$/.test(text)) return Number(text.replace(/s$/, ''));
  const parts = text.split(':');
  if (parts.some((p) => p === '' || Number.isNaN(Number(p)))) return NaN;
  if (parts.length === 3) return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
  if (parts.length === 1) return Number(parts[0]);
  return NaN;
}

const normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 60);

// usable_end lives on the compress run, which the draft only points at indirectly through the
// pipeline run's source title.
function usableEndFor(draftDir) {
  const manifest = readJson(path.join(draftDir, 'edit_manifest.json'), null);
  if (!manifest) return { error: 'edit_manifest.json 없음' };
  const runDir = path.dirname(String(manifest.source_video_path || ''));
  const info = readJson(path.join(runDir, 'source_info.json'), null);
  if (!info) return { manifest, error: 'source_info 없음' };
  const wanted = normTitle(info.title);
  let best = null;
  for (const name of fs.readdirSync(TEST_RUNS)) {
    if (!name.startsWith('compress_')) continue;
    const dir = path.join(TEST_RUNS, name);
    const caseFile = path.join(dir, 'source_case.json');
    if (!fs.existsSync(caseFile)) continue;
    const other = readJson(path.join(dir, 'source_info.json'), null);
    if (!other || normTitle(other.title) !== wanted) continue;
    if (!best || fs.statSync(dir).mtimeMs > fs.statSync(best).mtimeMs) best = dir;
  }
  if (!best) return { manifest, error: 'compress run 못 찾음' };
  const sourceCase = readJson(path.join(best, 'source_case.json'), {});
  return { manifest, sourceCase, compressRun: path.basename(best) };
}

function analyze(draftDir) {
  const name = path.basename(draftDir);
  const { manifest, sourceCase, error } = usableEndFor(draftDir);
  if (error) return { draft: name, error };
  const limit = Number(sourceCase.usable_end_sec || 0);
  if (!(limit > 0)) return { draft: name, verdict: 'PASS', note: 'promo tail 없음 (usable_end 미설정)', findings: [] };

  // The declared boundary can land early - measured on Draft Day, the detector said 394.5 while
  // the frames show film until ~397.5 and the line is still being spoken at 396.2. An end card
  // carries no dialogue, so footage that covers speech is film regardless of the boundary. The
  // pipeline trims to max(usable_end, utterance end); this gate has to judge by the same rule or
  // it condemns the very clips the fix produces. Speech comes from the source transcript.
  const runDir = path.dirname(String(manifest.source_video_path || ''));
  const transcript = readJson(path.join(runDir, 'source_transcript.json'), null);
  const cues = (transcript && (transcript.cues || transcript.segments || transcript.utterances)) || [];
  // Only speech that was ALREADY UNDERWAY at the boundary can extend it. Letting any cue inside
  // the clip window count made the window justify itself: the defective cut running to 398.6
  // contained a cue past the boundary, which raised the limit to cover its own overrun and the
  // gate passed the very frame it exists to catch.
  // Caption cues run LONG. The line straddling the boundary here is cued 392.76-398.63 while
  // the VAD-measured voice stops at 396.2 - and the frames show the card from ~397.5, so the
  // cue's tail is card, not speech. The pipeline trims to the VAD end; this gate only has cues,
  // so it allows a bounded grace past the boundary rather than the whole cue. Calibrated on the
  // two measured cuts: the good one sits 1.7s past, the defective one 4.13s.
  const SPEECH_GRACE_SEC = 2.5;
  const speechEndAcrossLimit = cues.reduce((latest, cue) => {
    const cueStart = Number(cue.start || 0);
    const cueEnd = Number(cue.end || cue.start || 0);
    return (cueStart <= limit && cueEnd > limit)
      ? Math.max(latest, Math.min(cueEnd, limit + SPEECH_GRACE_SEC))
      : latest;
  }, 0);
  const speechEndWithin = () => speechEndAcrossLimit;

  const findings = [];
  for (const clip of manifest.video_cut_placements || []) {
    const end = parseTimecode(clip.source_end);
    const start = parseTimecode(clip.source_start);
    if (!Number.isFinite(end)) continue;   // afterglow_freeze 등 시각이 아닌 항목
    const effectiveLimit = Number.isFinite(start)
      ? Math.max(limit, speechEndWithin(start, end))
      : limit;
    if (end > effectiveLimit + OVERRUN_TOLERANCE_SEC) {
      findings.push({
        segment: clip.segment_id,
        timelineSec: Number(clip.timeline_start_sec || 0),
        sourceStart: Number.isFinite(start) ? Number(start.toFixed(2)) : null,
        sourceEnd: Number(end.toFixed(2)),
        effectiveLimit: Number(effectiveLimit.toFixed(2)),
        overrunSec: Number((end - effectiveLimit).toFixed(2))
      });
    }
  }
  return {
    draft: name,
    usable_end_sec: limit,
    promo_tail_sec: Number(sourceCase.promo_tail_sec || 0),
    clips: (manifest.video_cut_placements || []).length,
    findings,
    verdict: findings.length ? 'FAIL' : 'PASS'
  };
}

function main() {
  const args = process.argv.slice(2);
  const targets = args.includes('--all')
    ? fs.readdirSync(DRAFTS_DIR).filter((n) => /^\d{8}[a-z]?-.+-(ko|ja)$/.test(n)).map((n) => path.join(DRAFTS_DIR, n))
    : [path.resolve(args.find((a) => !a.startsWith('--')) || '')];
  const results = targets.map(analyze);
  if (args.includes('--json')) { console.log(JSON.stringify(results, null, 2)); return; }
  for (const r of results) {
    if (r.error) { if (!args.includes('--all')) console.log(`${r.draft}: ${r.error}`); continue; }
    if (args.includes('--all') && r.verdict === 'PASS') continue;
    console.log(`[${r.verdict}] ${r.draft} — usable_end ${r.usable_end_sec}s (프로모 꼬리 ${r.promo_tail_sec}s) | 클립 ${r.clips}`);
    for (const f of r.findings) {
      console.log(`   ${f.timelineSec.toFixed(1)}s ${f.segment} ← 원본 ${f.sourceStart}~${f.sourceEnd}s (${f.overrunSec}s 초과)`);
    }
  }
  if (args.includes('--all')) {
    const fail = results.filter((r) => r.verdict === 'FAIL').length;
    console.log(`\n판정 ${results.filter((r) => !r.error).length}편 | FAIL ${fail}`);
  }
  if (results.some((r) => r.verdict === 'FAIL')) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { analyze, parseTimecode };

// Does the cut end on its ending, or does it fall back into the opening?
//
//   node scripts/check-tail-regression.js <draft folder> [--json]
//   node scripts/check-tail-regression.js --all
//
// Found on Blood Smoothie (2026-09-02): the cut resolves - Bella drinks, her pulse strengthens,
// "It's working" from source 182s - and then the LAST line is Alice's "Maybe I can figure out
// what it wants" from source 20s. A line from the opening, pasted after the ending, 162 seconds
// backwards. It reads as a non-sequitur, and no existing gate saw it: the dialogue-pair gate
// only looks at question/answer, the seam gate only at new speakers, and the arc judge noticed
// the regression but waved it through as merely "awkward".
//
// Reordering at the FRONT is deliberate - the cold open replays a later line first, and the
// casebook allows it as expression. What is not allowed is the tail: once the cut has reached
// its resolution, going back to earlier material undoes the ending it just landed.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DRAFTS_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');

// The opening is allowed to reach anywhere in the source; that is what a teaser is.
const COLD_OPEN_FRACTION = 0.2;
// Only the closing stretch is judged - a mid-cut flashback can be intentional.
const TAIL_FRACTION = 0.3;
// How far back counts as falling out of the ending rather than a normal beat-to-beat step.
const REGRESSION_MIN_SEC = 45;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function analyze(draftDir) {
  const name = path.basename(draftDir);
  const manifest = readJson(path.join(draftDir, 'edit_manifest.json'), null);
  if (!manifest) return { draft: name, error: 'edit_manifest.json 없음' };
  const runDir = path.dirname(String(manifest.source_video_path || ''));
  const transcript = readJson(path.join(runDir, 'source_transcript.json'), null);
  const cues = (transcript && (transcript.cues || transcript.segments || transcript.utterances)) || [];
  if (!cues.length) return { draft: name, error: 'source_transcript 없음 — 판정 불가' };
  const cueStart = new Map();
  for (const cue of cues) if (cue.utt_id) cueStart.set(String(cue.utt_id), Number(cue.start || 0));

  const seen = new Set();
  const lines = [];
  for (const segment of manifest.segments || []) {
    const key = `${segment.segment_id}|${segment.caption_id || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = String(segment.narration || '').trim();
    if (!text) continue;
    if (/recap|narration/i.test(String(segment.segment_type || ''))) continue;
    const uttId = segment.source_utterance_id ? String(segment.source_utterance_id) : '';
    if (!uttId || !cueStart.has(uttId)) continue;
    lines.push({ text, atSec: Number(segment.timeline_start_sec || 0), sourceSec: cueStart.get(uttId) });
  }
  if (lines.length < 4) return { draft: name, error: '대사 슬롯이 부족해 판정 불가' };

  lines.sort((a, b) => a.atSec - b.atSec);
  const totalSec = lines[lines.length - 1].atSec;
  const coldOpenEnd = totalSec * COLD_OPEN_FRACTION;
  const tailStart = totalSec * (1 - TAIL_FRACTION);

  // The furthest the cut has travelled into the source by the time the tail begins. Anything
  // in the tail that sits far behind this is the ending being walked back.
  let peakSource = 0;
  for (const line of lines) {
    if (line.atSec >= tailStart) break;
    if (line.atSec > coldOpenEnd) peakSource = Math.max(peakSource, line.sourceSec);
  }

  const findings = [];
  for (const line of lines) {
    if (line.atSec < tailStart) continue;
    const regression = peakSource - line.sourceSec;
    if (regression >= REGRESSION_MIN_SEC) {
      findings.push({
        atSec: Number(line.atSec.toFixed(1)),
        sourceSec: Number(line.sourceSec.toFixed(1)),
        peakSourceSec: Number(peakSource.toFixed(1)),
        regressionSec: Number(regression.toFixed(1)),
        line: line.text.slice(0, 40)
      });
    }
  }
  return {
    draft: name,
    dialogue_lines: lines.length,
    tail_from_sec: Number(tailStart.toFixed(1)),
    peak_source_sec: Number(peakSource.toFixed(1)),
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
    console.log(`[${r.verdict}] ${r.draft} — 대사 ${r.dialogue_lines}줄 | 꼬리 ${r.tail_from_sec}s~ | 도달 원본 ${r.peak_source_sec}s`);
    for (const f of r.findings) {
      console.log(`   ${f.atSec}s "${f.line}" ← 원본 ${f.sourceSec}s (${f.regressionSec}s 역행)`);
    }
  }
  if (args.includes('--all')) {
    const fail = results.filter((r) => r.verdict === 'FAIL').length;
    console.log(`\n판정 ${results.filter((r) => !r.error).length}편 | FAIL ${fail}`);
  }
  if (results.some((r) => r.verdict === 'FAIL')) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { analyze, REGRESSION_MIN_SEC };

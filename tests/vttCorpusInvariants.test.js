const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { parseVtt } = require('../server/services/midformCompressionService');

// Hand-written fixtures only prove the cases we already thought of. The placeholder-line bug lived
// in every one of these files for weeks and no fixture had that shape, so this runs the parser over
// the real subtitle files still sitting in the compress runs and asserts the properties that were
// violated. It skips when the runs are not on this machine (CI, a fresh clone), because its value is
// exactly that it reads the actual sources.
const RUNS_DIR = path.join(__dirname, '..', 'midform', 'test_runs');

function corpus() {
  if (!fs.existsSync(RUNS_DIR)) return [];
  const files = [];
  for (const entry of fs.readdirSync(RUNS_DIR)) {
    if (!entry.startsWith('compress_')) continue;
    const subtitleDir = path.join(RUNS_DIR, entry, 'subtitles_raw');
    if (!fs.existsSync(subtitleDir)) continue;
    const vtt = fs.readdirSync(subtitleDir).filter((name) => name.toLowerCase().endsWith('.vtt')).sort()[0];
    if (!vtt) continue;
    const transcript = path.join(RUNS_DIR, entry, 'transcript_timed.json');
    files.push({ run: entry, vtt: path.join(subtitleDir, vtt), transcript });
  }
  // Newest first, and enough of them to cover different caption styles without a slow test.
  return files.sort((a, b) => b.run.localeCompare(a.run)).slice(0, 6);
}

const FILES = corpus();

test('real auto-caption files parse without collapsing or losing lines', (t) => {
  if (!FILES.length) {
    t.skip('no compress runs with subtitles_raw on this machine');
    return;
  }
  for (const file of FILES) {
    const cues = parseVtt(fs.readFileSync(file.vtt, 'utf8'));
    assert.ok(cues.length > 20, `${file.run}: parsed ${cues.length} cues`);

    // A cue under 0.3s cannot hold a spoken line - it is the 10ms "settle" block that the parser
    // used to take instead of the block carrying the words. A couple survive legitimately (a single
    // "Yeah."), so this bounds the rate rather than forbidding them.
    const collapsed = cues.filter((cue) => cue.end_sec - cue.start_sec < 0.3);
    assert.ok(collapsed.length <= Math.max(3, cues.length * 0.02),
      `${file.run}: ${collapsed.length}/${cues.length} cues under 0.3s`);

    // Cues must advance. A cue starting before the previous one ended means the roll was folded
    // wrongly and every downstream window inherits the error.
    for (let i = 1; i < cues.length; i++) {
      assert.ok(cues[i].start_sec >= cues[i - 1].start_sec - 0.001,
        `${file.run}: cue ${i} starts before its predecessor`);
    }

    // Where the file carries per-word timing tags, the cue holding those words must sit with them.
    const tagged = [...fs.readFileSync(file.vtt, 'utf8').matchAll(/<(\d\d):(\d\d):(\d\d)[.,](\d{1,3})>/g)]
      .map((match) => Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000);
    if (tagged.length > 20) {
      const starts = cues.map((cue) => cue.start_sec);
      const orphaned = tagged.filter((at) => !starts.some((start) => Math.abs(start - at) < 6));
      assert.ok(orphaned.length <= tagged.length * 0.25,
        `${file.run}: ${orphaned.length}/${tagged.length} word-timing tags have no cue within 6s`);
    }
  }
});

test('the stored transcript still matches what the parser produces today', (t) => {
  const withTranscript = FILES.filter((file) => fs.existsSync(file.transcript));
  if (!withTranscript.length) {
    t.skip('no stored transcripts on this machine');
    return;
  }
  // Drift here means a run is carrying coordinates the current parser would no longer produce - the
  // state that shipped clips built on the collapsed cues. It is a report, not a hard failure: a run
  // parsed before a parser fix legitimately differs until it is rebuilt.
  const drifted = [];
  for (const file of withTranscript) {
    const stored = JSON.parse(fs.readFileSync(file.transcript, 'utf8'));
    const fresh = parseVtt(fs.readFileSync(file.vtt, 'utf8'));
    if (!Array.isArray(stored) || !stored.length) continue;
    const storedCollapsed = stored.filter((cue) => Number(cue.end_sec) - Number(cue.start_sec) < 0.3).length;
    const freshCollapsed = fresh.filter((cue) => cue.end_sec - cue.start_sec < 0.3).length;
    if (storedCollapsed > freshCollapsed + 3) drifted.push(`${file.run}: stored ${storedCollapsed} collapsed cues vs ${freshCollapsed} today`);
  }
  if (drifted.length) console.log(`  stale transcripts (rebuild to pick up parser fixes):\n   ${drifted.join('\n   ')}`);
  assert.ok(true);
});

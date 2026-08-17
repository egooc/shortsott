// Full vs highlight, per channel, across the buffer and what has shipped.
//
// The plan is a balanced mix - Full carries the audio-language signal, highlights
// carry volume - but a Full needs one whole source each while a longform source
// yields several highlights, so the highlight side drifts ahead unless someone
// counts (user, 2026-08-18).
//
//   node scripts/ops/variant-mix.js [--json]
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DRAFTS = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
const EXP = path.join(DRAFTS, '_automation factory');
const base = (n) => String(n).replace(/\.mp4$/i, '').replace(/\s*\(\d+\)$/, '');
const isKorean = (n) => /[가-힣]/.test(n);
const isFull = (n) => /-F-/.test(n);

const state = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'data', 'hourly_upload_state.json'), 'utf8')); } catch { return {}; }
})();
const uploadedNames = new Set((state.history || []).map((h) => base(h.file)));

const tally = () => ({ jp_full: 0, jp_hl: 0, kr_full: 0, kr_hl: 0 });
const add = (t, name) => {
  const key = `${isKorean(name) ? 'kr' : 'jp'}_${isFull(name) ? 'full' : 'hl'}`;
  t[key] += 1;
};

const buffer = tally();
const waiting = tally();
if (fs.existsSync(EXP)) {
  for (const f of fs.readdirSync(EXP)) {
    if (!f.toLowerCase().endsWith('.mp4')) continue;
    add(buffer, f);
    if (!uploadedNames.has(base(f))) add(waiting, f);
  }
}

const shipped = tally();
for (const h of state.history || []) add(shipped, base(h.file));

// Drafts that exist but have no mp4 yet - what the mix will look like next.
const pending = tally();
if (fs.existsSync(DRAFTS)) {
  const done = new Set();
  for (const dir of [EXP, path.join(EXP, 'uploaded'), path.join(EXP, 'held')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.toLowerCase().endsWith('.mp4')) done.add(base(f));
  }
  for (const e of fs.readdirSync(DRAFTS, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === '_automation factory') continue;
    if (done.has(e.name)) continue;
    if (!fs.existsSync(path.join(DRAFTS, e.name, 'edit_manifest.json'))) continue;
    add(pending, e.name);
  }
}

const line = (label, t) => {
  const jp = t.jp_full + t.jp_hl;
  const kr = t.kr_full + t.kr_hl;
  return `${label.padEnd(12)} JP ${String(jp).padStart(3)} (full ${t.jp_full}, hl ${t.jp_hl})   KR ${String(kr).padStart(3)} (full ${t.kr_full}, hl ${t.kr_hl})`;
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ shipped, waiting, buffer, pending }, null, 2));
} else {
  console.log(line('공개됨', shipped));
  console.log(line('업로드대기', waiting));
  console.log(line('미내보내기', pending));
}

// Does each exported mp4 actually contain the draft it is named after?
//
// The export drives CapCut through its GUI: it searches the Projects grid for a
// draft name and double-clicks the first row. If the grid has not filtered yet,
// that row is a DIFFERENT project - and the finished file is then renamed to the
// requested draft's name, so nothing downstream can tell. On 2026-08-17 a video
// of silk weaving went to YouTube titled "漆塗りの全工程を凝縮！" because
// 20260816-F-075400's mp4 held 20260816-F-073649's footage.
//
// The draft's timeline length is recorded in its manifest, so comparing that
// with the file's real duration catches a swapped export without watching it.
//
//   node scripts/ops/export-integrity.js [--all] [--tolerance 1.5]
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DRAFTS = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
const EXP = path.join(DRAFTS, '_automation factory');
const base = (n) => String(n).replace(/\.mp4$/i, '').replace(/\s*\(\d+\)$/, '');

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
};
const tolerance = argOf('--tolerance', 1.5);
const dirs = process.argv.includes('--all')
  ? [EXP, path.join(EXP, 'uploaded'), path.join(EXP, 'held')]
  : [EXP];

function probeDuration(file) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', file
    ], { encoding: 'utf8', timeout: 30000 });
    return Number(String(out).trim());
  } catch {
    return NaN;
  }
}

let checked = 0;
let bad = 0;
let noManifest = 0;

for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir)) {
    if (!file.toLowerCase().endsWith('.mp4')) continue;
    const name = base(file);
    const manifestPath = path.join(DRAFTS, name, 'edit_manifest.json');
    if (!fs.existsSync(manifestPath)) { noManifest += 1; continue; }
    let expected = 0;
    try {
      expected = Number(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).actual_timeline_duration_sec || 0);
    } catch { continue; }
    if (!expected) continue;

    const actual = probeDuration(path.join(dir, file));
    checked += 1;
    if (!Number.isFinite(actual)) { console.log(`?    ${file.slice(0, 52)} (ffprobe 실패)`); continue; }
    const diff = Math.abs(actual - expected);
    if (diff > tolerance) {
      bad += 1;
      console.log(`불일치 ${path.basename(dir)}/${file.slice(0, 46)}`);
      console.log(`       manifest ${expected.toFixed(1)}초 vs 파일 ${actual.toFixed(1)}초 (차이 ${diff.toFixed(1)})`);
    }
  }
}

console.log(`검사 ${checked}편 | 불일치 ${bad}편 | manifest 없음 ${noManifest}편 (허용오차 ${tolerance}초)`);
process.exitCode = bad ? 1 : 0;

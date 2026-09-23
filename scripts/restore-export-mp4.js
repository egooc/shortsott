// 내보내기 폴더에서 빠진 mp4 를 워크디렉토리에서 되찾는다.
//
//   node scripts/restore-export-mp4.js [--dry-run]
//
// 왜 (2026-09-23)
//   유튜브 업로드가 끝나면 내보내기 폴더의 mp4 가 소비된다. 그런데 소셜 팬아웃(블로타토)은
//   그 파일을 다시 올려야 한다 — 없으면 조용히 건너뛴다. 실측: 여덟 편이 그래서 막혀 있었다.
//
// 어느 파일이 «그 편»인가 — 이름으로 추측하지 않는다
//   드래프트의 `edit_manifest.json` 에 `source_video_path` 가 있고 그 폴더가 워크디렉토리다.
//   거기 있는 mp4 중 **매니페스트 길이와 맞는 것**을 고른다. 후킹본은 길이가 다르므로
//   길이가 곧 «어느 판인가»를 가른다(사례 99 에서 얻은 것이다).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DRAFTS = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
const EXPORT = path.join(DRAFTS, '_automation factory');
const DRY = process.argv.includes('--dry-run');
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const dur = (f) => {
  try {
    return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());
  } catch { return NaN; }
};

let restored = 0;
let missing = 0;
for (const name of fs.readdirSync(DRAFTS)) {
  if (!/^\d{8}[a-z]?-.+-(ko|ja)$/.test(name) || name.slice(0, 8) < '20260918') continue;
  const dst = path.join(EXPORT, `${name}.mp4`);
  if (fs.existsSync(dst)) continue;                       // 이미 있으면 그만
  if (fs.existsSync(path.join(EXPORT, 'held', `${name}.mp4`))) continue;   // 보류함은 따로 푼다

  const man = readJson(path.join(DRAFTS, name, 'edit_manifest.json'), null);
  if (!man) continue;
  // ★옛 매니페스트는 상대 경로를 적었다('koh\\volcano_src.mp4'). 그런 건 볼케이노 런 폴더에 붙인다.
  const RUNS = path.join(os.homedir(), 'volcano-runs');
  const rawPath = String(man.source_video_path || '').split('\\').join('/');
  const wd = path.isAbsolute(rawPath) ? path.dirname(rawPath)
    : path.join(RUNS, path.dirname(rawPath));
  const want = Number(man.actual_timeline_duration_sec) || 0;
  if (!wd || !want || !fs.existsSync(wd)) { missing += 1; console.log(`  [워크디렉토리 없음] ${name}`); continue; }

  const cands = fs.readdirSync(wd).filter((f) => /\.mp4$/.test(f) && !/^volcano_src|^raw|^v\.mp4$/.test(f))
    .map((f) => path.join(wd, f));
  const hit = cands.find((f) => Math.abs(dur(f) - want) < 0.25);
  if (!hit) { missing += 1; console.log(`  [길이 맞는 mp4 없음] ${name} (찾던 길이 ${want}s)`); continue; }

  console.log(`  ${DRY ? '[검토]' : '[되찾음]'} ${name} ← ${path.basename(hit)} (${want}s)`);
  if (!DRY) { fs.copyFileSync(hit, dst); fs.utimesSync(dst, new Date(), new Date()); }
  restored += 1;
}
console.log(`\n되찾음 ${restored}편 · 못 찾음 ${missing}편`);

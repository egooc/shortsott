// 이미 유튜브에 올라간 편의 mp4 를 내보내기 폴더에서 치운다.
//
//   node scripts/clean-export-published.js [--dry-run]
//
// 왜 (2026-09-25)
//   내보내기 폴더는 두 가지로 동시에 읽힌다 — 문지기에게는 «재고», 발행기에게는 «올릴 것».
//   소셜 백필 때 이미 발행된 mp4 를 되돌려 놨더니(2026-09-23, 사례 103) 그 폴더가 부풀어
//   **재고 14 → 39편**이 됐고, 문지기가 «목표 충족»으로 판단해 **생산이 27시간 멈췄다.**
//   되돌리는 것 자체는 맞았다 — 소셜이 그 파일을 올려야 했다. 치우지 않은 것이 잘못이다.
//
// ★안전선: 유튜브에 «url 이 찍힌» 편만 치운다. 예약만 잡힌 것은 아직 올라가는 중일 수 있다.
//   그리고 드래프트 폴더는 건드리지 않는다 — 매니페스트·패키지는 증거라 남긴다.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXPORT = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts', '_automation factory');
const ARCHIVE = path.join(EXPORT, 'uploaded');
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

const dry = process.argv.includes('--dry-run');
const st = readJson(path.join(ROOT, 'server', 'data', 'auto_publish_state.json'), { history: [] });
const uploaded = new Set((st.history || []).filter((h) => h.url).map((h) => h.draft));

let moved = 0;
let kept = 0;
for (const f of fs.readdirSync(EXPORT)) {
  if (!/\.mp4$/.test(f)) continue;
  const draft = f.replace(/\.mp4$/, '');
  if (!uploaded.has(draft)) { kept += 1; continue; }
  console.log(`  ${dry ? '[검토]' : '[치움]'} ${draft}`);
  if (!dry) {
    // 지우지 않고 옮긴다 — 소셜 백필이 다시 필요할 수 있고, 지우면 되돌릴 길이 없다.
    fs.mkdirSync(ARCHIVE, { recursive: true });
    fs.renameSync(path.join(EXPORT, f), path.join(ARCHIVE, f));
  }
  moved += 1;
}
console.log(`\n치운 것 ${moved}편 → _automation factory\\uploaded · 남은 재고 ${kept}편`);

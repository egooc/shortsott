// 최종 길이가 규격 안에 있는지 본다. 61~70초다.
//
//   node scripts/check-length.js <최종.mp4>       한 편
//   node scripts/check-length.js --pending        아직 안 올라간 것 전부
//
// 왜 (2026-09-25 소유주: "무조건 60초는 넘어야 되고, 60초만 넘으면 미드폼이야.")
//   · **아래 선 61초** — 60초 이하는 미드폼이 아니다. 소유주 규정이다.
//   · **위 선 70초** — 실측(사례 111): 같은 완성본을 104초로 올리면 전세계 차단,
//     70초로 자르면 통과. 두 영화에서 복제됐다. 오늘 막힌 편들의 실제 길이는 88.7·87.8초라
//     선은 70~88초 사이에 있다. 상한을 70초로 잡는다.
//
// ★후킹 하이라이트가 2~4초 붙으므로 **엔진 완성본은 62~66초**여야 최종이 규격에 든다.
//   이 검사는 «붙인 뒤»의 파일을 본다 — 발행 패키지에 들어가는 그 파일이다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXPORT = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts', '_automation factory');
const MIN = 61;
const MAX = 70;
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const dur = (f) => Number(execFileSync('ffprobe',
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());

function judge(sec) {
  if (sec < MIN) return { ok: false, why: `${sec.toFixed(1)}초 — 61초 미만이라 미드폼이 아니다` };
  if (sec > MAX) return { ok: false, why: `${sec.toFixed(1)}초 — 70초 초과라 차단 위험 구간이다(사례 111)` };
  return { ok: true, why: `${sec.toFixed(1)}초 — 규격 안` };
}

const args = process.argv.slice(2);
if (args.includes('--pending')) {
  const st = readJson(path.join(ROOT, 'server', 'data', 'auto_publish_state.json'), { history: [] });
  const done = new Set((st.history || []).filter((h) => h.url).map((h) => h.draft));
  let bad = 0;
  let n = 0;
  for (const f of fs.readdirSync(EXPORT)) {
    if (!/\.mp4$/.test(f)) continue;
    const draft = f.replace(/\.mp4$/, '');
    if (done.has(draft)) continue;
    const v = judge(dur(path.join(EXPORT, f)));
    n += 1;
    if (!v.ok) bad += 1;
    console.log(`  ${v.ok ? '통과' : '★벗어남'}  ${draft.padEnd(34)} ${v.why}`);
  }
  console.log(`\n검사 ${n}편 · 규격 밖 ${bad}편 (규격 ${MIN}~${MAX}초)`);
  // ★막지 않는다. 이미 만든 것을 여기서 세우면 되돌릴 방법이 없다 — 보고만 한다.
  process.exit(0);
}

const f = args[0];
if (!f || !fs.existsSync(f)) { console.error(`사용법: check-length.js <최종.mp4> | --pending`); process.exit(2); }
const v = judge(dur(f));
console.log(`${v.ok ? '통과' : '★벗어남'}  ${path.basename(f)}  ${v.why}`);
process.exit(v.ok ? 0 : 1);

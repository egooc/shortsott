// 최종 길이가 규격 안에 있는지 본다. 61~180초다.
//
//   node scripts/check-length.js <최종.mp4>       한 편
//   node scripts/check-length.js --pending        아직 안 올라간 것 전부
//
// 왜 (2026-09-25 소유주: "무조건 60초는 넘어야 되고, 60초만 넘으면 미드폼이야.")
//   · **아래 선 61초** — 60초 이하는 미드폼이 아니다. 소유주 규정이다. 이건 안 바뀐다.
//   · **위 선 180초** — 유튜브 숏츠 한도다. «차단 때문»이 아니다.
//
// ★2026-09-26 정정 — 한때 상한을 70초로 잡았다가 풀었다(소유주 결정).
//   근거였던 통제 실험(사례 111)은 «같은 파일을 104초로 올리면 차단, 70초면 통과»였고 그 자체는 맞다.
//   그러나 **보편 규칙이 아니었다.** 반례가 셋이다:
//     · 눈물한가득  중앙 150초 · 82편 **차단 0** · 121~180초 구간 평균 595만 조회
//     · 대한숏      중앙 130초 · 143편 차단 0
//     · 우리 실적    91~120초 차단 50% / 121초+ 21% — 길수록 나쁘다는 기울기가 **없다**
//   앞뒤가 맞는 설명: **그들은 애초에 매칭이 안 된다.** Content ID 가 잡은 «뒤에야» 길이 문턱이
//   작동하므로, 안 잡히면 150초든 180초든 상관없다. 우리는 잡히고 그다음 길이가 갈랐을 뿐이다.
//   그러니 진짜 질문은 여전히 «왜 우리만 매칭되는가»이고, 길이는 그 답이 아니다.
//
// ★후킹 하이라이트가 2~4초 붙는다. 최종 길이는 그것까지 더한 값이다.
//   이 검사는 «붙인 뒤»의 파일을 본다 — 발행 패키지에 들어가는 그 파일이다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXPORT = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts', '_automation factory');
const MIN = 61;
const MAX = 180;   // 숏츠 한도. 차단 기준이 아니다(위 정정 참고)
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const dur = (f) => Number(execFileSync('ffprobe',
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());

function judge(sec) {
  if (sec < MIN) return { ok: false, why: `${sec.toFixed(1)}초 — 61초 미만이라 미드폼이 아니다` };
  if (sec > MAX) return { ok: false, why: `${sec.toFixed(1)}초 — 180초(숏츠 한도) 초과다` };
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

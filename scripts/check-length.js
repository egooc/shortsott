// 최종 길이를 잰다. **막지 않는다 — 재는 자다.**
//
//   node scripts/check-length.js <최종.mp4>       한 편
//   node scripts/check-length.js --pending        아직 안 올라간 것 전부
//
// 왜 (2026-09-25 소유주: "무조건 60초는 넘어야 되고, 60초만 넘으면 미드폼이야.")
//   · **아래 선 61초** — 60초 이하는 미드폼이 아니다. 소유주 규정이다. 이건 안 바뀐다.
//   · **실무 상한 70초** — 측정된 차단선 아래다(아래 참고).
//   · **하드 한도 180초** — 유튜브 숏츠 한도다. 넘으면 아예 못 올린다.
//
// ★2026-09-28 ②정정 — 61~70초 «규격»은 풀었다 (소유주: "명화관은 지금 그대로 유지").
//   이유는 측정이 틀려서가 아니라 **엔진이 그 길이를 못 내기 때문이다**:
//     볼케이노 서버가 85초 미만을 duration_repair 로 반려한다(사례 172·178).
//     거기에 후킹 하이라이트 3~4초가 필수(4.5항)라 **최단 최종본이 약 89초**다.
//   그래서 61~70초를 규격으로 걸면 모든 회차가 자동으로 «벗어남»이 되어 신호가 아니라 잡음이 된다.
//   → 명화관은 지금 길이(90~100초)를 그대로 두고, 짧은 쪽은 **린박스 계열로 따로 올려
//     조회수를 비교한다**(소유주 방침 2026-09-28). 길이는 여기서 «기록»만 한다.
//
// ★★2026-09-28 ③정정 — «짧게 만들면 덜 막힌다»는 **실전에서 반증됐다.** 이제 길이로 경고하지 않는다.
//   재커팅해서 61~70초로 올린 첫 3편: **2편 차단** (루시퍼 65.4초 차단 · 브레이브하트 66.8초 차단 /
//   67.2초 통과). 사례 111·147 의 통제 실험(70초 CLEAR ×2 · 59초 CLEAR ×3)과 정면으로 어긋난다.
//   소유주 판단으로 61~70초 노선을 접었다. 이유가 셋이고 각각 독립이다:
//     ① 엔진이 85초 밑을 못 낸다(서버 duration_repair) — 애초에 만들 수가 없다
//     ② 이미 만든 것을 잘라 맞추면 가운데가 빠져 완성도가 떨어진다
//     ③ 그렇게 만든 3편 중 2편이 막혔다 — 효과 자체가 확인되지 않는다
//   → **명화관은 원래 길이(90~100초)로 만든다.** 이 검사는 숫자만 적는다.
//
// ★아래 측정 기록은 남긴다. 통제 실험 자체는 사실이고, 언젠가 다시 볼 값이다.
//   근거는 **같은 소스·같은 채널·같은 도구**로 친 통제 비교 둘이다.
//     사례 111 (2026-09-25)   트랜스포머 완성본 104초 → 전세계 차단 +10분
//                             같은 파일 앞 70초       → CLEAR ×2
//                             같은 파일 앞 59초       → CLEAR
//                             우주전쟁 완성본 앞 59초  → CLEAR ×2
//     오늘    (2026-09-28)   같은 트랜스포머 소스를 41.8초로 새로 편집 → **CLEAR-30min**
//                             대조군을 잡은 창(10분)의 세 배를 견뎠다
//     실제로 막힌 우리 편들의 길이 88.7 · 87.8초
//   → **선은 70초와 88초 사이에 있다.** 우리는 줄곧 그 위에서 만들어 왔다(91~110초).
//
//   ★2026-09-26 에 이 규칙을 한 번 폐기했던 이유와 그게 왜 틀렸는지.
//     당시 반례는 «눈물한가득 171초 무차단 · 대한숏 중앙 130초 무차단»이었다. 그건 사실이다.
//     그러나 그 채널들은 **애초에 매칭이 안 된다.** 길이 문턱은 매칭된 «뒤에» 작동하므로,
//     안 잡히는 쪽에는 길이가 아무 의미가 없다. **우리는 잡힌다.** 그러니 그들의 무차단은
//     우리에게 반례가 아니었다 — 다른 집단의 이야기를 우리 규칙의 반증으로 쓴 것이 오류였다.
//
// ★대가: 짧을수록 조회수 상한이 내려간다. 눈물한가득 실측으로 61~90초 평균 114만,
//   121~180초 평균 595만이다. 소유주가 알고 택했다 — 차단 45% 를 줄이는 쪽이 남는 장사다.
//
// ★후킹 하이라이트가 2~4초 붙는다. 최종 길이는 그것까지 더한 값이다.
//   이 검사는 «붙인 뒤»의 파일을 본다 — 발행 패키지에 들어가는 그 파일이다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXPORT = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts', '_automation factory');
const MIN = 61;    // 소유주 규정. 안 바뀐다
const BAND = 70;   // (옛 실무 상한. 2026-09-28 에 접었다 — 위 ③정정 참고)
const MAX = 180;   // 숏츠 하드 한도
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const dur = (f) => Number(execFileSync('ffprobe',
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());

function judge(sec) {
  if (sec < MIN) return { ok: false, why: `${sec.toFixed(1)}초 — 61초 미만이라 미드폼이 아니다` };
  if (sec > MAX) return { ok: false, why: `${sec.toFixed(1)}초 — 180초(숏츠 한도) 초과다` };
  // 70 초를 넘으면 «규격 밖»이 아니라 «측정된 위험 구간»이다. 통과시키되 눈에 띄게 적는다 —
  // 이미 만든 것을 여기서 세우면 되돌릴 방법이 없다.
  // ★길이로 경고하지 않는다. 짧게 만드는 것이 답이 아니라는 결론이 났다(아래 ③정정).
  return { ok: true, why: `${sec.toFixed(1)}초` };
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
    const mark = v.ok ? (v.warn ? '주의' : '통과') : '★벗어남';
    console.log(`  ${mark}  ${draft.padEnd(34)} ${v.why}`);
  }
  console.log(`\n검사 ${n}편 · 규격 밖 ${bad}편 (실무 규격 ${MIN}~${BAND}초 · 하드 한도 ${MAX}초)`);
  // ★막지 않는다. 이미 만든 것을 여기서 세우면 되돌릴 방법이 없다 — 보고만 한다.
  process.exit(0);
}

const f = args[0];
if (!f || !fs.existsSync(f)) { console.error(`사용법: check-length.js <최종.mp4> | --pending`); process.exit(2); }
const v = judge(dur(f));
console.log(`${v.ok ? (v.warn ? '주의' : '통과') : '★벗어남'}  ${path.basename(f)}  ${v.why}`);
process.exit(v.ok ? 0 : 1);

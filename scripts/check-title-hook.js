// 제목이 «후킹 틀»을 쓰고 있는지 본다. 밋밋한 서술형 제목을 생산 단계에서 걸러 낸다.
//
//   node scripts/check-title-hook.js                     발행 대기 드래프트 전부 채점
//   node scripts/check-title-hook.js "제목 문장"          한 줄만 채점
//   node scripts/check-title-hook.js --published         이미 올라간 편들을 채점(대조용)
//
// 왜 (2026-09-22 소유주 지시: "제목을 조금 더 후킹성 있게 잡는 건 어때?")
//   레퍼런스 실측(사례 71): 상위 20편 중 10편이 틀을 쓰고 하위 15편은 2편뿐이다.
//   우리 편 18개를 같은 틀로 채점하니 틀을 쓴 11편의 평균이 1,466회, 안 쓴 7편이 1,039회였다
//   (10배 이상치 1편 제외). **약한 양의 상관**이고 무작위 배정이 아니므로 증명은 아니다 —
//   그래도 공짜로 얻는 이득이라 규칙으로 쓴다.
//
// ★막지는 않는다. 경고만 한다. 표본이 18개뿐인 신호로 생산을 세우면 손해가 더 크다.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DRAFTS_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
const EXPORT_DIR = path.join(DRAFTS_DIR, '_automation factory');
const STATE = path.join(ROOT, 'server', 'data', 'auto_publish_state.json');
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

// 여섯 틀 — 한국어와 일본어를 같이 본다. 레퍼런스 실측(사례 71) + 우리 편 채점에서 나온 것.
const FRAMES = [
  ['반전형', /인 줄 알았|했지만|그런데|뒤집|알고 보니|だと思って|のに|はずが/],
  ['대조형', /를 걸었지만|을 걸었지만|대신|바꿔|よりも/],
  ['숫자대비', /\d+\s*[만억원달러]|\d+\s*(분|초|년|명|번)|\d+\s*(円|年|分|人)/],
  ['이유약속', /이유|왜 |理由|なぜ/],
  ['질문형', /\?|까요|을까|ますか|のか/],
  ['극단부정', /절대|못 |없는|않았|안 하|なかった|られない|できない/],
  ['결과예고', /그의 모습|된 순간|마지막|사라진|終わった|最後/],
];

function framesOf(title) {
  return FRAMES.filter(([, re]) => re.test(title)).map(([name]) => name);
}

function verdict(title) {
  const hits = framesOf(title);
  if (hits.length) return { ok: true, hits };
  return {
    ok: false,
    hits,
    // 무엇을 고치라고 말해 준다. "밋밋하다"만 적으면 다음 사람이 같은 걸 또 쓴다.
    hint: '서술형이다. 아래 중 하나를 얹어라 — '
      + '반전("~인 줄 알았던") · 대조("A를 걸었지만 B") · 숫자("40분 뒤") · '
      + '이유 약속("~한 이유") · 질문("~까") · 극단 부정("절대 ~없는")',
  };
}

function scoreOne(title) {
  const v = verdict(title);
  console.log(`${v.ok ? '통과' : '밋밋'}  ${title}`);
  if (v.ok) console.log(`      틀: ${v.hits.join(', ')}`);
  else console.log(`      ${v.hint}`);
  return v.ok;
}

function draftTitles() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(EXPORT_DIR).filter((f) => /\.mp4$/.test(f)).map((f) => f.replace(/\.mp4$/, '')); }
  catch { /* 폴더가 없으면 빈 목록 */ }
  const shipped = new Set((readJson(STATE, { history: [] }).history || []).map((h) => h.draft));
  for (const name of names) {
    if (shipped.has(name)) continue;
    const meta = readJson(path.join(DRAFTS_DIR, name, 'upload_meta.json'), null);
    if (meta && meta.title) out.push([name, meta.title]);
  }
  return out;
}

function publishedTitles() {
  const st = readJson(STATE, { history: [] });
  const out = [];
  for (const h of st.history || []) {
    const meta = readJson(path.join(DRAFTS_DIR, h.draft || '', 'upload_meta.json'), null);
    if (meta && meta.title) out.push([h.draft, meta.title]);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const free = args.filter((a) => !a.startsWith('--'));
  if (free.length) { process.exitCode = scoreOne(free.join(' ')) ? 0 : 1; return; }

  const rows = args.includes('--published') ? publishedTitles() : draftTitles();
  if (!rows.length) { console.log('채점할 제목이 없다.'); return; }
  let flat = 0;
  for (const [name, title] of rows) {
    const v = verdict(title);
    if (!v.ok) flat += 1;
    console.log(`${v.ok ? '통과' : '밋밋'}  ${String(name).slice(0, 30).padEnd(32)} ${title.slice(0, 40)}`);
    if (!v.ok) console.log(`      ${v.hint}`);
    else console.log(`      틀: ${v.hits.join(', ')}`);
  }
  console.log(`\n${rows.length}편 중 ${rows.length - flat}편이 틀을 쓴다 · 밋밋 ${flat}편`);
  // ★경고만 한다. 종료코드는 0 — 생산을 세우지 않는다.
}

main();

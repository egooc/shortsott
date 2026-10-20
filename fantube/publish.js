// 최애모먼트 발행 한 번에 — 업로드(예약) → 태그 게이트 → 업로드 기록 → 제작 장부.
//   node fantube/publish.js <epNN> <upload.json> <publishAt ISO>
// --check-only: 가이드 점검만 하고 올리지 않는다.
// 댓글 장치·기획 게이트(17~20항): expected_comment·vicarious·hook·title_pattern·첫 TTS 인사 — 하나라도 없으면 exit 5(업로드 금지).
// 태그 게이트(10/16 관리자): 태그를 넣고 다시 읽어 0개면 예약을 풀어 비공개로 두고 멈춘다(exit 2, 관리자 보고).
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const [ep, meta, at] = process.argv.slice(2);
if (!ep || !meta || !at) throw new Error('usage: node fantube/publish.js <epNN> <upload.json> <publishAt ISO>');
const ROOT = path.join(__dirname, '..');
const LOG = 'D:/volcano-runs/fantube/_upload/upload_log.jsonl';

const M = JSON.parse(fs.readFileSync(meta, 'utf8'));
// 댓글 장치 게이트(10/20 소유주 질책 «댓글 반응을 노리는 원고가 반영 안 됐다», RULES_PDF 20항):
// ①②③ 은 공용 scripts/comment_hook.py(도구개발 a4856bc) — expected_comment·장치 문장이 본문에·끝 3문장 장치. 0 말고는 전부 업로드 금지(4 FAIL·5 검사 불가).
// 팬튜브만 더 본다: at_sec 이 그 문장(자막·TTS) 표시 구간 안인지.
{
  const specPath = path.join('D:/volcano-runs/fantube', ep, 'spec.json');
  const ch = spawnSync('python', [path.join(ROOT, 'scripts', 'comment_hook.py'), specPath, '--lane', 'fantube'], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  process.stdout.write(ch.stdout || ''); process.stderr.write(ch.stderr || '');
  let why = ch.status !== 0 ? `comment_hook exit ${ch.status}${ch.status === 5 ? '(검사 불가)' : ''}` : '';
  if (!why) {
    const S = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const ec = S.expected_comment;
    const norm = (x) => String(x || '').replace(/\s+/g, '');
    const spans = [...(S.caps || []).map((c) => [c.text, c.t0, c.t1]), ...(S.voice || []).flatMap((v) => [[v.text, v.t0, v.t0 + 6], [v.show || '', v.t0, v.t0 + 6]])];
    if (!spans.some(([tx, a, b]) => norm(tx).includes(norm(ec.line)) && ec.at_sec >= a - 0.05 && ec.at_sec <= b)) why = `«${ec.line}» 이 ${ec.at_sec}초 자막·TTS 구간에 없음`;
  }
  if (why) {
    console.error(`[publish] ★FAIL 댓글 장치 — ${why}. spec.expected_comment={type,line,at_sec} 를 원고 본문에 넣은 뒤 다시. 업로드 안 함.`);
    process.exit(5);
  }
  console.log('✓ 댓글 장치 통과(comment_hook + at_sec)');
}
// 기획 게이트(10/20 관리자 실측 «17~19항이 ack 만 있고 코드가 없었다») — 넷 중 하나라도 없으면 업로드 금지(exit 5).
// ① spec.vicarious: 지금의 대리만족 한 문장(20자+) ② spec.hook {visual,audio,text} 3칸(0~3초 안에 있는 것) ③ spec.title_pattern {pattern: 10패턴 이름, key: 멤버/상황 낱말}
//    + 업로드 제목: 해시태그 없이 15자±3, key 가 앞 10자 안 ④ 첫 TTS 문장에 «안녕하세요·오늘은» 금지.
{
  const S = JSON.parse(fs.readFileSync(path.join('D:/volcano-runs/fantube', ep, 'spec.json'), 'utf8'));
  const PAT = ['결과 숨김', '이유·비밀', '팬 저격', '숫자', '금지·주의', '말하다 만다', '실화·썰', 'ㅋㅋ·ㄷㄷ', '대사 그대로', '최상급·한정'];
  const bad = [];
  if (String(S.vicarious || '').replace(/\s/g, '').length < 20) bad.push(`① vicarious «${S.vicarious || ''}» 20자 미만`);
  const h = S.hook || {};
  for (const k of ['visual', 'audio', 'text']) if (String(h[k] || '').trim().length < 4) bad.push(`② hook.${k} 비었음`);
  const v0 = [...(S.voice || [])].sort((a, b) => a.t0 - b.t0)[0];
  if (!/효과음/.test(h.audio || '') && !(v0 && v0.t0 < 3)) bad.push('② 청각 훅: 첫 TTS 가 3초 안에 없음(효과음이면 hook.audio 에 «효과음»)');
  const tp = S.title_pattern || {};
  const title = String(M.title || '');
  const len = [...title.replace(/\s/g, '')].length;
  if (!PAT.includes(tp.pattern)) bad.push(`③ title_pattern.pattern «${tp.pattern || ''}» — ${PAT.join('/')} 중 하나`);
  if (!tp.key || !title.slice(0, 10).includes(tp.key)) bad.push(`③ 핵심 낱말 «${tp.key || ''}» 이 제목 앞 10자에 없음`);
  if (/#/.test(title)) bad.push('③ 제목에 해시태그(제목 늘리기 금지 — 설명란으로)');
  if (len < 12 || len > 18) bad.push(`③ 제목 ${len}자(공백 빼고) — 15자±3`);
  if (v0 && /안녕|오늘은/.test(v0.text)) bad.push(`④ 첫 TTS «${v0.text}» 인사·«오늘은» 금지`);
  if (bad.length) {
    console.error(`\x07[publish] ★FAIL 기획 게이트 — ${bad.join(' / ')}. 업로드 안 함.`);
    process.exit(5);
  }
  console.log(`✓ 기획 게이트 통과 — 대리만족 «${S.vicarious}» · 훅 ${h.visual} / ${h.audio} / ${h.text} · 제목 ${tp.pattern}·«${tp.key}» ${len}자`);
}
// 제목 점검(10/20 관리자, 공용 scripts/title_check.py 055f18a) — 경고도 FAIL(--fail-on-warn), 4·5 업로드 금지.
{
  const tc = spawnSync('python', [path.join(ROOT, 'scripts', 'title_check.py'), meta, '--lane', 'fantube', '--fail-on-warn'], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  process.stdout.write(tc.stdout || ''); process.stderr.write(tc.stderr || '');
  if (tc.status !== 0) {
    console.error(`[publish] ★FAIL 제목 점검 — title_check exit ${tc.status}${tc.status === 5 ? '(검사 불가)' : ''}. 업로드 안 함.`);
    process.exit(5);
  }
}
// 태그 관문(10/20 관리자, 공용 scripts/tag_gate.py — 14항 «안 나오는 인물 태그 금지» 자동판): 제목·설명 첫 두 줄·태그 공통 낱말 ≥2,
// 태그의 원고 등장 ≥50%. 원고 = 화면에 나오는 글 전부(위 판·TTS·자막·베댓) → <ep>/script.txt 로 써서 넘긴다. 4·5 업로드 금지.
{
  const S = JSON.parse(fs.readFileSync(path.join('D:/volcano-runs/fantube', ep, 'spec.json'), 'utf8'));
  const body = [S.top?.tag, S.top?.l1, S.top?.l2, S.top?.credit, ...(S.voice || []).map((v) => v.text), ...(S.caps || []).map((c) => c.text), ...(S.comments || []).map((c) => c.text)].filter(Boolean);
  const scriptPath = path.join('D:/volcano-runs/fantube', ep, 'script.txt');
  fs.writeFileSync(scriptPath, body.join('\n') + '\n', 'utf8');
  const tg = spawnSync('python', [path.join(ROOT, 'scripts', 'tag_gate.py'), meta, '--script', scriptPath, '--lane', 'fantube', '--fail-on-warn'], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  process.stdout.write(tg.stdout || ''); process.stderr.write(tg.stderr || '');
  if (tg.status !== 0) {
    console.error(`[publish] ★FAIL 태그 관문 — tag_gate exit ${tg.status}${tg.status === 5 ? '(검사 불가)' : ''}. 업로드 안 함.`);
    process.exit(5);
  }
}
// 가이드라인 사전 점검(10/18 소유주: 피드를 못 받으면 위반으로 본다) — 롱투숏 guide_check.py 를 그대로 쓰고, 걸리면 업로드 전에 멈춘다.
// 팬튜브 특유: 멤버 미성년 시기·«어린» 강조는 «어린아이 대상» 범주로 본다.
const tagLine = (M.tags || []).join(' ');
const gc = spawnSync('python', ['D:/volcano-runs/ls_tools/guide_check.py', meta, tagLine], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
process.stdout.write(gc.stdout); process.stderr.write(gc.stderr);
const MINOR = /어린|미성년|아기|꼬마|애기|초딩|중딩|고딩|초등|중학생|고등학생|중학교|고등학교|학창|교복|데뷔\s*전|연습생\s*시절|\d{1,2}살|10대/;
const minor = [M.title, M.description, tagLine].join(' ').match(MINOR);
if (gc.status !== 0 || minor) {
  console.error(`[publish] 가이드 점검 걸림(${gc.status !== 0 ? 'guide_check ' + gc.status : ''}${minor ? ' 미성년 낱말 «' + minor[0] + '»' : ''}) — 업로드 중단, 문구 고친 뒤 다시`);
  process.exit(4);
}
// 이미지 중복도(10/19 관리자, 경고만): 롱투숏 frame_dup.py — 첫 컷 3장을 같은 소재 검색 8편과 dHash 대조, ≤10 이면 4.
// 검색어는 upload.json 의 dup_queries, 없으면 태그 앞 낱말로 두 개(멤버·무대명). 경고여도 발행은 그대로, 기록만 남긴다.
const tg = M.tags || [];
const dq = M.dup_queries || [`${tg[0] || '엔믹스'} ${tg[2] || ''}`.trim(), `${tg[0] || '엔믹스'} ${tg[5] || tg[3] || ''}`.trim()];
const fd = spawnSync('python', ['D:/volcano-runs/ls_tools/frame_dup.py', M.file, ...dq.flatMap((q) => ['--query', q]), '--work', 'D:/volcano-runs/fantube/_dup'],
  { encoding: 'utf8', timeout: 600000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });   // 경고용이라 10분 넘으면 접고 발행(ep17 15분+)
process.stdout.write(fd.stdout || ''); process.stderr.write(fd.stderr);
fs.appendFileSync('D:/volcano-runs/fantube/_upload/frame_dup.jsonl', JSON.stringify({ at: new Date().toISOString(), ep, file: M.file, queries: dq, status: fd.status, summary: (fd.stdout || '').trim().split('\n').pop() }) + '\n', 'utf8');
if (fd.status === 4) console.error(`[publish] 이미지 중복 경고(${ep}) — 발행은 계속, 관리자에게 한 줄 보고`);
if (process.argv.includes('--check-only')) process.exit(0);

const out = execFileSync('node', [path.join(ROOT, 'scripts', 'yt-upload.js'), meta, '--purpose', 'idol_fantube_ko', '--publish-at', at],
  { cwd: ROOT, encoding: 'utf8' });
process.stdout.write(out);
const last = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop());
fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), meta: path.basename(meta), videoId: last.videoId, publishAt: last.publishAt }) + '\n', 'utf8');

const g = spawnSync('node', [path.join(__dirname, 'yt_tags.js'), last.videoId, meta, '--gate'], { cwd: ROOT, encoding: 'utf8' });
process.stdout.write(g.stdout); process.stderr.write(g.stderr);
if (g.status !== 0) { console.error(`[publish] 태그 게이트 실패(${g.status}) — 공개 금지, 관리자 보고`); process.exit(2); }

const l = spawnSync('node', [path.join(__dirname, 'ledger.js'), ep, '--youtube-id', last.videoId, '--publish-at', at], { cwd: ROOT, encoding: 'utf8' });
process.stdout.write(l.stdout); process.stderr.write(l.stderr);
console.log(`[publish] ${ep} → ${last.videoId} · ${at} · 태그 확인 끝`);

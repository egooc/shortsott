// 최애모먼트 발행 한 번에 — 업로드(예약) → 태그 게이트 → 업로드 기록 → 제작 장부.
//   node fantube/publish.js <epNN> <upload.json> <publishAt ISO>
// --check-only: 가이드 점검만 하고 올리지 않는다.
// 댓글 장치 게이트: spec.expected_comment 없으면 exit 5(업로드 금지).
// 태그 게이트(10/16 관리자): 태그를 넣고 다시 읽어 0개면 예약을 풀어 비공개로 두고 멈춘다(exit 2, 관리자 보고).
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const [ep, meta, at] = process.argv.slice(2);
if (!ep || !meta || !at) throw new Error('usage: node fantube/publish.js <epNN> <upload.json> <publishAt ISO>');
const ROOT = path.join(__dirname, '..');
const LOG = 'D:/volcano-runs/fantube/_upload/upload_log.jsonl';

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
// 가이드라인 사전 점검(10/18 소유주: 피드를 못 받으면 위반으로 본다) — 롱투숏 guide_check.py 를 그대로 쓰고, 걸리면 업로드 전에 멈춘다.
// 팬튜브 특유: 멤버 미성년 시기·«어린» 강조는 «어린아이 대상» 범주로 본다.
const M = JSON.parse(fs.readFileSync(meta, 'utf8'));
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

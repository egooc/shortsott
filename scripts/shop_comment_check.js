// 쇼핑 «댓글 장치» 관문 — 메타에 expected_comment 가 없거나 원고와 안 맞으면 FAIL(종료 코드 4).
// 10/20 소유주 질책(관리자 전달): «시청자 댓글 반응을 노리는 원고를 쓰기로 했는데 반영이 안 됐다».
// ffref17·19·20 원고의 «~냐고요?»는 다음 문장에서 바로 답해 버려 댓글이 할 말을 닫았다 — 그래서 문장·유형·시각을 메타에 박고 업로드 전에 기계로 본다.
// 쓰임: node scripts/shop_comment_check.js <메타.json>  (shop_schedule fill 도 같은 함수로 업로드를 막는다)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TYPES = ['정정', '경험담', '훈수', '공감', '논쟁'];

// 공용 관문 scripts/comment_hook.py(도구개발 a4856bc — ①메타 ②plan.json 원고 ③끝 3문장 장치)를 부르고, 쇼핑 고유 규칙(comment_question 물음표)만 여기서 더 본다.
// 종료 코드 4=FAIL, 5=검사 불가 — 둘 다 통과 아님.
function check(metaPath) {
  const errs = [];
  const r = spawnSync('python', [path.join(__dirname, 'comment_hook.py'), metaPath, '--lane', 'shopping'],
    { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (r.status !== 0) {
    const lines = `${r.stdout || ''}${r.stderr || ''}`.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('-')).map((l) => l.slice(1).trim());
    errs.push(...(lines.length ? lines : [`comment_hook.py 종료 코드 ${r.status}${r.error ? ` (${r.error.message})` : ''}`]));
  }
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) { errs.push(`메타를 못 읽음: ${e.message}`); }
  const q = String(meta.comment_question || '').trim();
  if (!q) errs.push('comment_question 없음 — 고정 댓글 첫 줄에 붙일 질문 한 줄 필수');
  else if (!/[?？]/.test(q)) errs.push(`comment_question 은 물음표로 묻는 문장이어야 함: «${q}»`);
  return errs;
}

module.exports = { check, TYPES };

if (require.main === module) {
  const f = process.argv[2];
  if (!f) { console.error('쓰임: node scripts/shop_comment_check.js <메타.json>'); process.exit(2); }
  const errs = check(f);
  if (errs.length) {
    console.error(`\x07✗✗✗ 댓글 장치 FAIL — ${path.basename(f)} 업로드 금지`);
    for (const e of errs) console.error(`  - ${e}`);
    process.exit(4);
  }
  console.log(`✓ 댓글 장치 통과 — ${path.basename(f)}`);
}

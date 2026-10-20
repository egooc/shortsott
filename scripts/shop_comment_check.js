// 쇼핑 «댓글 장치» 관문 — 메타에 expected_comment 가 없거나 원고와 안 맞으면 FAIL(종료 코드 4).
// 10/20 소유주 질책(관리자 전달): «시청자 댓글 반응을 노리는 원고를 쓰기로 했는데 반영이 안 됐다».
// ffref17·19·20 원고의 «~냐고요?»는 다음 문장에서 바로 답해 버려 댓글이 할 말을 닫았다 — 그래서 문장·유형·시각을 메타에 박고 업로드 전에 기계로 본다.
// 쓰임: node scripts/shop_comment_check.js <메타.json>  (shop_schedule fill 도 같은 함수로 업로드를 막는다)
const fs = require('fs');
const path = require('path');

const TYPES = ['정정', '경험담', '훈수', '공감', '논쟁'];
const norm = (s) => String(s || '').replace(/[\s/?!.,~…'"«»]/g, '');

function check(metaPath) {
  const errs = [];
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) { return [`메타를 못 읽음: ${e.message}`]; }
  const ec = meta.expected_comment;
  if (!ec || typeof ec !== 'object') errs.push('expected_comment 없음 — {type,line,at_sec} 필수');
  else {
    if (!TYPES.includes(ec.type)) errs.push(`expected_comment.type «${ec.type}» — ${TYPES.join('·')} 중 하나`);
    if (!norm(ec.line)) errs.push('expected_comment.line 비었음');
    if (typeof ec.at_sec !== 'number' || !(ec.at_sec >= 0 && ec.at_sec <= 60)) errs.push(`expected_comment.at_sec «${ec.at_sec}» — 0~60 숫자`);
    // 원고에 그 문장이 실제로 있어야 한다(메타 file 옆 plan.json)
    const plan = meta.file && path.join(path.dirname(meta.file), 'plan.json');
    if (plan && fs.existsSync(plan) && norm(ec.line)) {
      const text = norm(JSON.parse(fs.readFileSync(plan, 'utf8')).segments.map((s) => s.text).join(''));
      if (!text.includes(norm(ec.line))) errs.push(`expected_comment.line 이 plan.json 원고에 없음: «${ec.line}»`);
    }
  }
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

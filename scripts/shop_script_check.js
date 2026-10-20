// 쇼핑 원고 검사 — 결충전·썰형 6단·리듬·열린 결말·반박 선제·사회적 증거·첫 문장을 기계로 본다. FAIL 이면 종료 코드 4.
// 10/20 관리자 실측(docs/materials-audit-20261020.md #3): 이 규칙들이 프롬프트에만 있고 검사 코드가 0 — 밤 보고의 «결충전 통과»는 자기 평가였다.
// 원고 쪽이 메타에 표시를 박고(script_map), 여기서는 그 문장이 plan.json 원고에 실제로 있는지·순서·위치·모양을 본다.
//   meta.script_map = {
//     six: ["①제목 읊기 문장", "②배경", "③문제", "④해결 사건", "⑤반박 선제", "⑥사회적 증거+손맛"],   // 원고 문장 그대로(앞부분만 적어도 됨)
//     gyeol: "결 문장", chung: "충 문장", jeon: "전 문장",
//     rebut: "반박 선제 질문 문장", social_proof: { line: "사회적 증거 문장", source: "https://… (쿠팡 페이지 등 확인한 곳)" }
//   }
// 쓰임: node scripts/shop_script_check.js <메타.json>   — 항목별 ✓/✗ 줄을 찍는다(밤 보고서에 그대로 붙인다)
// 10/20 12:00 KST 전에 시작한 편(<작업폴더>/started_at.txt)은 «구 원고 면제»로 통과시킨다(이미 만든 재고를 막지 않는다).
const fs = require('fs');
const path = require('path');

const SINCE = Date.parse('2026-10-20T12:00:00+09:00');
const squash = (s) => String(s || '').replace(/[\s/?？!！.,~…'"«»·:;()]/g, '');
const GREETING = /^(안녕하세요|안녕|여러분|오늘은)/;
const OPEN_END = /(지도 몰라요|대요|래요|을까요|ㄹ까요|일까요|아닐까요|않을까요|것 같아요|걸요|모르죠|일 듯|던데요|거래요)\s*[?？.…]*$/;
const CLOSED_END = /(입니다|습니다|끝!?|끝이에요|끝입니다)\s*[.!…]*$/;
const NARRATIVE = /(대요|래요|었대|했대|처음|원래|만든|만들|개발|발상|이유|그래서|덕분|비밀|탄생|시작)/;
const PROOF = /([0-9]|리뷰|평점|후기|판매|품절|만 개|만개|명이|누적|별점|재구매)/;
const MIN_CV = 0.30;     // 문장 길이 변동계수 하한 — 10/20 실측 ffref15 0.22·16 0.24(고른 편)·17 0.31·19 0.27·20 0.27
const MAX_SHORTEST = 10; // 짧게 «툭» 끊는 문장이 하나는 있어야 한다(글자 수, 공백 제외)

function check(metaPath) {
  const out = [];   // {ok, item, msg}
  const add = (ok, item, msg) => out.push({ ok, item, msg });
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) { return { code: 5, out: [{ ok: false, item: '입력', msg: `메타를 못 읽음: ${e.message}` }] }; }
  const wd = meta.file && path.dirname(meta.file);
  const planPath = wd && path.join(wd, 'plan.json');
  if (!planPath || !fs.existsSync(planPath)) return { code: 5, out: [{ ok: false, item: '입력', msg: `plan.json 없음: ${planPath}` }] };
  const startedFile = path.join(wd, 'started_at.txt');
  const started = fs.existsSync(startedFile) ? Date.parse(fs.readFileSync(startedFile, 'utf8').trim()) : NaN;
  if (started < SINCE) return { code: 0, exempt: true, out: [{ ok: true, item: '면제', msg: `구 원고(시작 ${fs.readFileSync(startedFile, 'utf8').trim()} < 10/20 12:00)` }] };

  const segs = JSON.parse(fs.readFileSync(planPath, 'utf8')).segments.map((s) => String(s.text || '').replace(/\s*\/\s*/g, ' ').trim());
  const sq = segs.map(squash);
  const find = (line) => { const l = squash(line); if (!l) return -1; return sq.findIndex((s) => s.includes(l) || (l.length >= 6 && l.includes(s) && s.length >= 6)); };
  const m = meta.script_map;
  if (!m || typeof m !== 'object') add(false, 'script_map', '메타에 script_map 없음 — 결/충/전·6단·반박·사회적 증거 문장을 적어야 한다');
  const M = m || {};

  // ⑦ 첫 문장 인사 금지
  add(!GREETING.test(segs[0] || ''), '⑦ 첫 문장', `«${segs[0]}»${GREETING.test(segs[0] || '') ? ' — 인사·«오늘은» 시작 금지' : ''}`);

  // ② 6단 순서
  const six = Array.isArray(M.six) ? M.six : [];
  const idx6 = six.map(find);
  if (six.length !== 6) add(false, '② 6단', `six 는 6문장이어야 함(지금 ${six.length})`);
  else {
    const missing = idx6.map((x, i) => (x < 0 ? `${'①②③④⑤⑥'[i]}«${six[i]}»` : null)).filter(Boolean);
    const ordered = idx6.every((x, i) => i === 0 || x > idx6[i - 1]);
    const title = squash(String(meta.title || '').replace(/#\S+/g, ''));
    const head = title.slice(0, 6);
    const firstOk = idx6[0] === 0 && head && sq[0].includes(head);
    add(!missing.length && ordered && firstOk, '② 6단',
      missing.length ? `원고에 없는 단: ${missing.join(' ')}`
        : !ordered ? `순서 어긋남(문장 번호 ${idx6.map((x) => x + 1).join('→')})`
          : !firstOk ? `① 이 첫 문장이 아니거나 제목 앞부분 «${head}» 를 안 읊음` : `문장 번호 ${idx6.map((x) => x + 1).join('→')}`);
  }

  // ① 결·충·전
  const iG = find(M.gyeol), iC = find(M.chung), iJ = find(M.jeon);
  const n = segs.length;
  const gErr = iG < 0 ? '결 문장이 원고에 없음' : iG > Math.floor(n * 0.4) ? `결이 앞 40% 밖(${iG + 1}/${n})` : '';
  const cErr = iC < 0 ? '충 문장이 원고에 없음' : !NARRATIVE.test(segs[iC]) ? `충이 서사 문장이 아님(«${segs[iC]}» — 일화·발상·이유 표지 없음)` : iC <= iG ? '충이 결보다 앞' : '';
  const jErr = iJ < 0 ? '전 문장이 원고에 없음' : iJ < Math.floor(n * 0.6) ? `전이 뒤 40% 밖(${iJ + 1}/${n})` : iJ <= iC ? '전이 충보다 앞' : '';
  add(!gErr && !cErr && !jErr, '① 결충전', [gErr, cErr, jErr].filter(Boolean).join(' · ') || `결 ${iG + 1} · 충 ${iC + 1} · 전 ${iJ + 1} / ${n}문장`);

  // ③ 문장 길이 편차
  const L = sq.map((s) => s.length);
  const mean = L.reduce((a, b) => a + b, 0) / L.length;
  const cv = Math.sqrt(L.reduce((a, b) => a + (b - mean) ** 2, 0) / L.length) / mean;
  const shortest = Math.min(...L), longest = Math.max(...L);
  add(cv >= MIN_CV && shortest <= MAX_SHORTEST, '③ 문장 길이',
    `변동계수 ${cv.toFixed(2)}(하한 ${MIN_CV}) · 최단 ${shortest}자(≤${MAX_SHORTEST}) · 최장 ${longest}자`);

  // ④ 열린 결말 — 마지막 «저장해 두고…» 저장 권유 문장 앞의 끝 문장
  let e = n - 1;
  while (e > 0 && /^(저장해|이 .*프로필 링크|.*링크에 있어요|.*댓글에 링크)/.test(segs[e])) e--;
  const endLine = segs[e] || '';
  add(OPEN_END.test(endLine) && !CLOSED_END.test(endLine), '④ 열린 결말', `«${endLine}»`);

  // ⑤ 반박 선제 — 의심을 묻는 질문 + 다음 문장에서 답
  const iR = find(M.rebut);
  const rErr = iR < 0 ? '반박 선제 문장이 원고에 없음' : !/[?？]|냐고요|나요|까요/.test(String(M.rebut) + segs[iR]) ? `질문이 아님(«${segs[iR]}»)` : iR >= n - 1 ? '답할 다음 문장이 없음' : '';
  add(!rErr, '⑤ 반박 선제', rErr || `«${segs[iR]}» → «${segs[iR + 1]}»`);

  // ⑥ 사회적 증거 — 확인한 곳 URL + 숫자·리뷰류 표지
  const sp = M.social_proof || {};
  const iS = find(sp.line);
  const sErr = iS < 0 ? '사회적 증거 문장이 원고에 없음' : !PROOF.test(segs[iS]) ? `숫자·리뷰·평점 표지 없음(«${segs[iS]}»)` : !/^https?:\/\//.test(String(sp.source || '')) ? 'source URL 없음(확인한 페이지)' : '';
  add(!sErr, '⑥ 사회적 증거', sErr || `«${segs[iS]}» · ${sp.source}`);

  return { code: out.every((x) => x.ok) ? 0 : 4, out };
}

module.exports = { check };

if (require.main === module) {
  const f = process.argv[2];
  if (!f) { console.error('쓰임: node scripts/shop_script_check.js <메타.json>'); process.exit(2); }
  const r = check(f);
  for (const x of r.out) console.log(`${x.ok ? '✓' : '✗'} ${x.item}: ${x.msg}`);
  if (r.code) console.error(`\x07✗✗✗ 원고 검사 ${r.code === 5 ? '검사 불가' : 'FAIL'} — ${path.basename(f)} 재고·업로드 금지`);
  else console.log(`✓ 원고 검사 통과 — ${path.basename(f)}${r.exempt ? '(구 원고 면제)' : ''}`);
  process.exit(r.code);
}

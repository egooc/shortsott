// 쇼핑 원고 검사 — 결충전·썰형 6단·리듬·열린 결말·반박 선제·사회적 증거·첫 문장·첫 질문 3초·끝 질문(답 없이 맨 끝)·devo V1·V2(FAIL)·V3·V14(△)를 기계로 본다. FAIL 이면 종료 코드 4.
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
// ⑧ 첫 질문 3초 — 공용 script_audit.py 쇼츠 «질문» 항목과 같은 규칙·같은 정규식(10/20 관리자: script_audit 은 이 검사로 동등 인정, 이 항목만 빠져 있었다)
const QUESTION = /[?？]\s*$|(까요?|나요|가요|습니까|죠)\s*[.。]?\s*$/;
const FIRST_Q_SEC = 3;
const V1_EXPLAIN = /^(이유는|왜냐하면|그 이유는|왜 그러냐면)|때문(이에요|입니다|이죠|이래요|이다)|에 대해/;
const V2_EMOTION = /(너무 좋|대박|놀라워|놀라웠|놀랍|감동|충격적|대단해|대단했|슬펐|최고예요|최고에요|짱이에요|짱이죠)/;
const V3_SUMMARY = /^(그래서|결국|이처럼|역시)|꼭 사세요|꼭 써 보세요|(정말|참|역시).*(였|이었)(습니다|어요)/;
const V14_COMPARE = /(배|보다|대신|만에|에서|전|후|하루|매일|한 번|%|→|vs)/;
const CPS = 7.0;   // 자막 시각이 없을 때 추정(script_audit 과 같은 ko 7자/초)

// 문장(segment) 시작 시각 — <작업폴더>/_ff/cap.ass 의 Cap 줄(plan 문장을 « / » 로 나눈 조각)에서 찾는다. 못 찾으면 글자 수로 추정.
function segStarts(wd, rawSegs) {
  const ass = path.join(wd, '_ff', 'cap.ass');
  let acc = 0;
  const est = rawSegs.map((t) => { const x = acc; acc += squash(t).length / CPS; return x; });
  if (fs.existsSync(ass)) {
    // 조각 수가 꼭 맞지는 않는다(ffref20: 조각 45·자막 44) — 문장마다 첫 조각 글자로 앞에서부터 찾는다
    const caps = fs.readFileSync(ass, 'utf8').split('\n').filter((l) => /^Dialogue:.*,Cap,/.test(l)).map((l) => {
      const m = l.match(/^Dialogue:\s*\d+,(\d+):(\d+):([\d.]+),/);
      return { t: m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : NaN, x: squash(l.split('}').pop().split(',').slice(l.includes('}') ? 0 : 9).join(',')) };
    });
    let k = 0;
    const at = rawSegs.map((t) => {
      const head = squash(String(t).split(/\s*\/\s*/)[0]);
      const j = caps.findIndex((c, i) => i >= k && c.x && (head.startsWith(c.x) || c.x.startsWith(head)));
      if (j < 0) return NaN;
      k = j + 1;
      return caps[j].t;
    });
    // 자막에서 못 찾은 문장(끝 CTA 등)만 글자 수 추정으로 채운다
    return { at: at.map((x, i) => (Number.isFinite(x) ? x : est[i])), how: at.map((x) => (Number.isFinite(x) ? '자막 시각' : '글자 수 추정')) };
  }
  return { at: est, how: est.map(() => '글자 수 추정') };
}

function check(metaPath) {
  const out = [];   // {ok, item, msg}
  const add = (ok, item, msg) => out.push({ ok, item, msg });
  const warn = (bad, item, msg) => out.push({ ok: true, warn: !!bad, item, msg });   // △ — 종료 코드에 안 들어간다
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) { return { code: 5, out: [{ ok: false, item: '입력', msg: `메타를 못 읽음: ${e.message}` }] }; }
  const wd = meta.file && path.dirname(meta.file);
  const planPath = wd && path.join(wd, 'plan.json');
  if (!planPath || !fs.existsSync(planPath)) return { code: 5, out: [{ ok: false, item: '입력', msg: `plan.json 없음: ${planPath}` }] };
  const startedFile = path.join(wd, 'started_at.txt');
  const started = fs.existsSync(startedFile) ? Date.parse(fs.readFileSync(startedFile, 'utf8').trim()) : NaN;
  if (started < SINCE) return { code: 0, exempt: true, out: [{ ok: true, item: '면제', msg: `구 원고(시작 ${fs.readFileSync(startedFile, 'utf8').trim()} < 10/20 12:00)` }] };

  const rawSegs = JSON.parse(fs.readFileSync(planPath, 'utf8')).segments.map((s) => String(s.text || ''));
  const segs = rawSegs.map((t) => t.replace(/\s*\/\s*/g, ' ').trim());
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

  // ④ 열린 결말 · ⑨ 끝 질문 — 10/20 관리자(공용 판정 변경): 바로 다음 문장에서 스스로 답하는 자문자답은 댓글 장치가 아니다.
  //   끝 3문장 중 마지막 질문은 답 없이 원고 맨 끝(링크 안내 줄만 뒤에 허용), 저장 권유는 그 앞으로.
  let e = n - 1;
  while (e > 0 && /^(이 .*프로필 링크|.*링크에 있어요|.*댓글에 링크)/.test(segs[e])) e--;
  const endLine = segs[e] || '';
  add((OPEN_END.test(endLine) || QUESTION.test(endLine)) && !CLOSED_END.test(endLine), '④ 열린 결말', `«${endLine}»`);
  const tail = segs.slice(Math.max(0, e - 2), e + 1);
  const lastQ = tail.map((x) => QUESTION.test(x)).lastIndexOf(true);
  add(lastQ === tail.length - 1, '⑨ 끝 질문',
    `${lastQ < 0 ? '끝 3문장에 질문 없음' : lastQ < tail.length - 1 ? `질문 뒤에 문장이 이어짐(자문자답·저장 권유는 질문 앞으로)` : '마지막 문장이 답 없는 질문'} — 끝 3문장: ${tail.map((x) => `«${x}»`).join(' / ')}`);

  // ⑤ 반박 선제 — 의심을 묻는 질문 + 다음 문장에서 답
  const iR = find(M.rebut);
  const rErr = iR < 0 ? '반박 선제 문장이 원고에 없음' : !/[?？]|냐고요|나요|까요/.test(String(M.rebut) + segs[iR]) ? `질문이 아님(«${segs[iR]}»)` : iR >= n - 1 ? '답할 다음 문장이 없음' : '';
  add(!rErr, '⑤ 반박 선제', rErr || `«${segs[iR]}» → «${segs[iR + 1]}»`);

  // ⑥ 사회적 증거 — 확인한 곳 URL + 숫자·리뷰류 표지
  const sp = M.social_proof || {};
  const iS = find(sp.line);
  const sErr = iS < 0 ? '사회적 증거 문장이 원고에 없음' : !PROOF.test(segs[iS]) ? `숫자·리뷰·평점 표지 없음(«${segs[iS]}»)` : !/^https?:\/\//.test(String(sp.source || '')) ? 'source URL 없음(확인한 페이지)' : '';
  add(!sErr, '⑥ 사회적 증거', sErr || `«${segs[iS]}» · ${sp.source}`);

  // ⑧ 첫 질문 3초
  const T = segStarts(wd, rawSegs);
  const iQ = segs.findIndex((x) => QUESTION.test(x));
  const tQ = iQ < 0 ? null : T.at[iQ];
  add(iQ >= 0 && tQ <= FIRST_Q_SEC, '⑧ 첫 질문',
    iQ < 0 ? `질문 문장 없음 — ${FIRST_Q_SEC}초 안에 묻는 문장 하나` : `«${segs[iQ]}» ${tQ.toFixed(1)}초(≤${FIRST_Q_SEC}, ${T.how[iQ]})`);

  // devo 칼럼(docs/devo-column-rules-20261020.md, 10/20 관리자) — 공용 script_audit --shorts 가 나오면 겹치는 항목은 그쪽으로 옮긴다
  // V1 ① 제목 읊기 뒤 둘째 문장 설명형 금지(FAIL) — 궁금증·의외성으로
  const s2 = segs[1] || '';
  add(!V1_EXPLAIN.test(s2), 'V1 둘째 문장', `«${s2}»${V1_EXPLAIN.test(s2) ? ' — 설명형(이유는·왜냐하면·~때문) 금지, 궁금증·의외성으로' : ''}`);
  // V2 감정 평가 어휘 금지(FAIL) — 행동·사실·숫자로
  const emo = segs.map((x) => (x.match(V2_EMOTION) || [])[0]).map((w, i) => (w ? `«${w}»(${i + 1}번 «${segs[i]}»)` : null)).filter(Boolean);
  add(!emo.length, 'V2 감정 평가 어휘', emo.length ? emo.join(' · ') : '없음');
  // V3 끝 질문 앞 문장이 요약·평가형이면 WARN
  let pe = e - 1;
  while (pe > 0 && /^저장해/.test(segs[pe])) pe--;   // 끝 질문 앞 «저장해 두고…» 권유는 건너뛰고 그 앞 문장을 본다
  const preEnd = segs[pe] || '';
  warn(V3_SUMMARY.test(preEnd), 'V3 끝 앞 문장', `«${preEnd}»${V3_SUMMARY.test(preEnd) ? ' — 요약·평가형(그래서·결국·꼭 사세요)' : ''}`);
  // V14 끝 어미 한 종류 60% 초과 WARN · 숫자에 비교 대상
  const ends = segs.map((x) => squash(x).slice(-1)).filter(Boolean);
  const freq = ends.reduce((m, c) => ({ ...m, [c]: (m[c] || 0) + 1 }), {});
  const [topEnd, topN] = Object.entries(freq).sort((a, b) => b[1] - a[1])[0] || ['', 0];
  const share = ends.length ? topN / ends.length : 0;
  const bareNum = segs.filter((x) => /[0-9]/.test(x) && !V14_COMPARE.test(x));
  warn(share > 0.6 || bareNum.length, 'V14 어미·숫자',
    `끝 글자 «~${topEnd}» ${Math.round(share * 100)}%(≤60%) · 어미 ${Object.entries(freq).map(([k, v]) => `${k}${v}`).join(' ')}${bareNum.length ? ` · 비교 없는 숫자 ${bareNum.map((x) => `«${x}»`).join(' ')}` : ''}`);

  return { code: out.every((x) => x.ok) ? 0 : 4, out };
}

module.exports = { check };

if (require.main === module) {
  const f = process.argv[2];
  if (!f) { console.error('쓰임: node scripts/shop_script_check.js <메타.json>'); process.exit(2); }
  const r = check(f);
  for (const x of r.out) console.log(`${!x.ok ? '✗' : x.warn ? '△' : '✓'} ${x.item}: ${x.msg}`);
  if (r.code) console.error(`\x07✗✗✗ 원고 검사 ${r.code === 5 ? '검사 불가' : 'FAIL'} — ${path.basename(f)} 재고·업로드 금지`);
  else console.log(`✓ 원고 검사 통과 — ${path.basename(f)}${r.exempt ? '(구 원고 면제)' : ''}`);
  process.exit(r.code);
}

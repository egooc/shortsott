// 쇼핑 원고 검사 — 결충전·썰형 6단·리듬·열린 결말·반박 선제·사회적 증거·첫 문장·첫 질문 3초·끝 질문(답 없이 맨 끝)·devo V1·V2(FAIL)·V3·V14(△)를 기계로 본다. FAIL 이면 종료 코드 4.
// 10/20 관리자 실측(docs/materials-audit-20261020.md #3): 이 규칙들이 프롬프트에만 있고 검사 코드가 0 — 밤 보고의 «결충전 통과»는 자기 평가였다.
// 원고 쪽이 메타에 표시를 박고(script_map), 여기서는 그 문장이 plan.json 원고에 실제로 있는지·순서·위치·모양을 본다.
//   meta.script_map = {
//     six: ["①제목 읊기 문장", "②배경", "③문제", "④해결 사건", "⑤반박 선제", "⑥사회적 증거+손맛"],   // 원고 문장 그대로(앞부분만 적어도 됨)
//     gyeol: "결 문장", chung: "충 문장", jeon: "전 문장",
//     rebut: "반박 선제 질문 문장", social_proof: { line: "사회적 증거 문장", source: "https://… (쿠팡 페이지 등 확인한 곳)" },
//     narrative_fact: { line: "충에 쓴 서사 팩트 문장", source: "https://… (그 사실을 확인한 곳)" },          // ⑬ G16
//     person4: { problem: "문제 발견", reaction: "반응", struggle: "삽질(실패·반복)", result: "결과" },   // ⑪ G20 인물형 4박자
//     story: { structure_id: "가족 불만형 등", beats: { situation, stake, attempt, turn, ending, emotion_tail },   // ⑭ 10-21 소유주 «숏폼도 스토리» — 문장 그대로
//              map: { "①": "stake", … "⑥": "ending" }, devices: { "문장 번호(0부터)": "장치 이름(12종 중)", … 5종 이상 },   // ⑭ 안의 공용 story_gate ⑥ 이 센다(10-21 소유주 «재밌게, 여러 장치», 목록 longshort-reset §9)
//              fiction: ["허구 장치 설명", …] }   // 6단 ①~⑥ 이 어느 beat 인지, 허구 장치(없으면 [])
//   }
//   meta.human_touch = { before, after, by, at }   // ⑫ 사람이 실제로 고쳤을 때만(선택). 없으면 기계 손질 패스 결과만 △ 로 기록(10-21 관리자)
// 10-21 관리자(docs/materials-gap-20261021.md G16·G20): ⑩ 대사·⑪ 4박자·⑬ 서사 팩트는 10-23 00:00 KST 부터 시작한 편에 FAIL, 그 전엔 △.
// 쓰임: node scripts/shop_script_check.js <메타.json>   — 항목별 ✓/✗ 줄을 찍는다(밤 보고서에 그대로 붙인다)
// 10/20 12:00 KST 전에 시작한 편(<작업폴더>/started_at.txt)은 «구 원고 면제»로 통과시킨다(이미 만든 재고를 막지 않는다).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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
const ENFORCE_1023 = Date.parse('2026-10-23T00:00:00+09:00');
const ENFORCE_SELLER = Date.parse('2026-10-25T12:00:00+09:00');   // 10-25 소유주: 경쟁 쇼핑 채널 레퍼런스 풀 + 쿠팡 리뷰 수 기록
const ENFORCE_HOOK = Date.parse('2026-10-28T00:00:00+09:00');
const GYEOL_FROM = Date.parse('2026-10-29T12:00:00+09:00');       // 10-29 소유주 «결분석 다 잡고 가자»: 이 시각 뒤 착수분만 결 표(⑱) — 이미 만든 재고는 막지 않는다     // 10-28 소유주: 첫 1초 상품·훅 돌려쓰기(⑰)
const HOOK_TYPES = ['정체', '사연', '결과먼저', '기묘', '손해', '경고'];
const WARN_HOOK = /마세요/;
const UPLOAD_DIR = 'D:/volcano-runs/_upload';
// ⑩ 대사 — 따옴표로 묶은 사람 말(설명 대신 대사로 장면을 넘긴다, 하늘 8)
const DIALOGUE = /["“”「」『』]/;
const MIN_DIALOGUE = 0.15;
// ⑪ 삽질 표지(실패·반복)와 고난 크기(횟수·시간·숫자)
const STRUGGLE = /(안 (돼|됐|되|빠|지워|떨어)|실패|소용(이)? ?없|그대로|또 |다시|몇 번|매번|포기|버렸|헛수고|못 (했|하|버))/;
const HARDSHIP = /([0-9]|(몇|두|세|네|열) 번|매번|며칠|몇 시간|한 시간|내내|매일|수십|수백|평생|한참)/;
// ⑫ 손질 패스 — 번역투 표지·문장 길이 상한
const TRANSLATIONESE = /(에 있어서|[을를] 통해|에 의해|에 의한|하는 것이 (가능|필요)|되어지|되어진|의 경우|함에 따라|하도록 하|것으로 보|를 가지고 있|을 가지고 있)/;
const MAX_LEN = 30;
// ⑭ 이야기(10-21 소유주 질책 «화면 해설이 아니라 허구라도 스토리를», 관리자 §7 규칙 5 · devo V1·V5 · 전자책 W10·W12)
//   공용 story_gate(도구개발)가 나오면 그쪽으로 옮긴다. 그때까지 script_map.story 표시 + 사람 표지로 본다.
// beat 이름은 공용 story_gate 와 같게(린박스 ac3ab2a plan.story_beats)
const BEATS = ['situation', 'stake', 'attempt', 'turn', 'ending', 'emotion_tail'];
const PERSON = /(엄마|아빠|남편|아내|언니|오빠|누나|형|동생|딸|아들|시어머니|할머니|할아버지|친구|룸메|이웃|사장님|저는|제가|저도|내가|나는|우리|다들|여러분|그 집|손님|아이|애들)/;
const MIN_PERSON = 0.4;
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

  const enforced = (Number.isFinite(started) ? started : Date.now()) >= ENFORCE_1023;
  const gate = (bad, item, msg) => (enforced ? add(!bad, item, msg) : warn(bad, item, `${msg}${bad ? ' (10-23부터 FAIL)' : ''}`));

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
  // G16 반려 유형: ① 충이 서사가 아닌 단순 호평 → 조회 0 · ② 결/전이 없이 역사·원리 나열만 → 조회는 나도 구매 0(큰제로 06-25·07-11)
  const reject = cErr ? '반려 유형 ① 단순 호평(→ 조회 0)' : (gErr || jErr) ? '반려 유형 ② 역사·원리 나열만(→ 구매 0)' : '';
  add(!gErr && !cErr && !jErr, '① 결충전', [gErr, cErr, jErr, reject].filter(Boolean).join(' · ') || `결 ${iG + 1} · 충 ${iC + 1} · 전 ${iJ + 1} / ${n}문장`);
  if (reject) out[out.length - 1].reject = reject;

  // ⑬ 서사 팩트 1개(출처 있음, G16) — 충이 지어낸 일화가 아니라 확인한 사실이어야 한다
  const nf = M.narrative_fact || {};
  const iN = find(nf.line);
  const nErr = !nf.line ? 'script_map.narrative_fact 없음' : iN < 0 ? '서사 팩트 문장이 원고에 없음' : !/^https?:\/\//.test(String(nf.source || '')) ? 'source URL 없음(그 사실을 확인한 곳)' : '';
  gate(!!nErr, '⑬ 서사 팩트', nErr || `«${segs[iN]}» · ${nf.source}`);

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

  // ⑩ 대사 비율(G20) — 따옴표 대사 1줄 이상(0이면 FAIL), 15% 미만 △
  const dl = segs.filter((x) => DIALOGUE.test(x));
  const dr = n ? dl.length / n : 0;
  if (!dl.length) gate(true, '⑩ 대사', `대사 0/${n}문장 — 설명 대신 «"…"» 사람 말로 장면을 넘긴다`);
  else warn(dr < MIN_DIALOGUE, '⑩ 대사', `${dl.length}/${n}문장 ${Math.round(dr * 100)}%(권장 ≥${MIN_DIALOGUE * 100}%) — ${dl.map((x) => `«${x}»`).join(' ')}`);

  // ⑪ 인물형 4박자(G20) — 문제 발견→반응→삽질→결과, 삽질에 실패 표지 필수·고난 크기(횟수·시간) △
  const p4 = M.person4 || {};
  const keys4 = ['problem', 'reaction', 'struggle', 'result'];
  const i4 = keys4.map((k) => find(p4[k]));
  const miss4 = keys4.filter((k, i) => i4[i] < 0);
  const p4Err = !M.person4 ? 'script_map.person4 없음' : miss4.length ? `원고에 없는 박자: ${miss4.join(',')}`
    : !i4.every((x, i) => i === 0 || x > i4[i - 1]) ? `순서 어긋남(${i4.map((x) => x + 1).join('→')})`
      : !STRUGGLE.test(segs[i4[2]]) ? `삽질이 실패·반복이 아님(«${segs[i4[2]]}»)` : '';
  gate(!!p4Err, '⑪ 4박자', p4Err || `문장 ${i4.map((x) => x + 1).join('→')} · 삽질 «${segs[i4[2]]}»`);
  if (!p4Err) warn(!HARDSHIP.test(segs[i4[2]]), '⑪ 고난 크기', HARDSHIP.test(segs[i4[2]]) ? '횟수·시간 있음' : '삽질에 횟수·시간(몇 번·며칠·숫자)이 없다 — 고난을 키운다');

  // ⑫ 손질 패스(G20, 10-21 관리자 답) — 밤 생산엔 사람이 없다: 사람 손질 대신 TTS 전 기계 두 번째 패스로 어색 문장을 본다. 결과만 기록(△)
  //   번역투 · 같은 어미(끝 두 글자) 3연속 · 30자(공백 제외) 초과. 사람이 실제로 고친 경우에만 meta.human_touch 를 함께 찍는다(지어내지 않는다)
  const awk = [];
  segs.forEach((x, i) => { const w = (x.match(TRANSLATIONESE) || [])[0]; if (w) awk.push(`번역투 «${w}»(${i + 1})`); });
  sq.forEach((x, i) => { if (i >= 2 && x.slice(-2) && x.slice(-2) === sq[i - 1].slice(-2) && x.slice(-2) === sq[i - 2].slice(-2)) awk.push(`어미 «~${x.slice(-2)}» 3연속(${i - 1}~${i + 1})`); });
  sq.forEach((x, i) => { if (x.length > MAX_LEN) awk.push(`${x.length}자(${i + 1})`); });
  warn(awk.length, '⑫ 손질 패스', awk.length ? awk.join(' · ') : `어색 문장 0(번역투·어미 3연속·${MAX_LEN}자 초과)`);
  const ht = meta.human_touch;
  if (ht && ht.by) {
    const iH = find(ht.after);
    warn(iH < 0 || squash(ht.before) === squash(ht.after), '⑫ 사람 손질', iH < 0 ? '고친 문장이 원고에 없음' : `${ht.by}: «${ht.before}» → «${ht.after}»`);
  }

  // ⑱ 결 표 — 공용 gyeol_gate.py(도구개발 18cd569) 그대로 부른다(사본 금지). <작업폴더>/gyeol_table.md|json: 레퍼런스 출처 · «초|결|우리 장면» 4줄+ · 반전·약속 줄.
  //    관문 자체가 2026-10-31 00:00 전에는 경고만 찍고 0 — 그 뒤 종료 4·5 면 FAIL. 10-29 12:00 전 착수분은 면제.
  if (Number.isFinite(started) && started < GYEOL_FROM) warn(false, '⑱ 결 표', '10-29 12:00 전 착수분 면제');
  else {
    const gg = spawnSync('python', ['-X', 'utf8', path.join(__dirname, 'gyeol_gate.py'), wd], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    const gmsg = `${gg.stdout || ''}${gg.stderr || ''}`.trim().split(String.fromCharCode(10)).map((x) => x.trim()).filter(Boolean).join(' / ').slice(0, 300);
    if (gg.status) add(false, '⑱ 결 표(gyeol_gate)', `종료 ${gg.status} · ${gmsg}`);
    else warn(/FAIL|유예/.test(gmsg), '⑱ 결 표(gyeol_gate)', gmsg || 'PASS');
  }
  // ⑭ 이야기 — 공용 story_gate.py(도구개발 2e986a7) 그대로 부른다(사본 금지). 시작 시각 기준 유예: 10-23 전 시작 편은 FAIL 도 △
  const st = M.story || {};
  const sgIn = path.join(os.tmpdir(), `shop_story_${path.basename(metaPath)}`);
  fs.writeFileSync(sgIn, JSON.stringify({ lane: 'shopping', segments: rawSegs.map((text) => ({ text })), story: M.story || null,
    facts: [M.narrative_fact, M.social_proof].filter((x) => x && x.source).map((x) => ({ line: x.line, source: x.source })) }, null, 2) + '\n', 'utf8');
  const sgr = spawnSync('python', [path.join(__dirname, 'story_gate.py'), sgIn, '--field', 'segments', '--json', ...(enforced ? ['--enforce-now'] : [])],
    { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  let sg;
  try { sg = JSON.parse(String(sgr.stdout).trim().split('\n').pop()); } catch { sg = { verdict: 'ERROR', error: `${sgr.stdout || ''}${sgr.stderr || ''}`.slice(0, 200), fails: [], warns: [] }; }
  if (sg.verdict === 'ERROR') add(false, '⑭ 이야기(story_gate)', `검사 불가 · ${sg.error}`);
  else if (sg.verdict === 'FAIL') gate(true, '⑭ 이야기(story_gate)', sg.fails.concat(sg.warns).join(' / '));
  else warn(sg.verdict === 'WARN', '⑭ 이야기(story_gate)', sg.warns.join(' / ') || `PASS · ${st.structure_id} · ${(sg.stats || {}).n}문장`);
  // ⑮ 사람의 이야기(쇼핑 레인 몫) — 상황·위기·시도 beat 문장에 화자·가족·대사, 사람·대사 문장 40% 미만 △
  const bt = st.beats || {};
  const iB = BEATS.slice(0, 3).map((k) => find(Array.isArray(bt[k]) ? bt[k][0] : bt[k]));
  const noHuman = iB.map((x, k) => (x >= 0 && !(PERSON.test(segs[x]) || DIALOGUE.test(segs[x])) ? `${BEATS[k]} «${segs[x]}»` : null)).filter(Boolean);
  if (M.story) gate(noHuman.length > 0, '⑮ 사람 beat', noHuman.length ? `사람 없는 beat: ${noHuman.join(' ')} — 화자·가족·대사로` : '상황·위기·시도 beat 에 사람·대사 있음');
  const pr = n ? segs.filter((x) => PERSON.test(x) || DIALOGUE.test(x)).length / n : 0;
  warn(pr < MIN_PERSON, '⑮ 사람 문장', `${Math.round(pr * 100)}%(권장 ≥${MIN_PERSON * 100}%) — 제품 화면만 말하는 문장 대신 화자·가족·대사`);

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

  // ⑯ 경쟁 쇼핑 채널 레퍼런스(10-25 소유주): plan.ref_seller(채널·영상 링크·조회·배수≥3·올린 날 90일 안) + 쿠팡 리뷰 수 기록
  {
    const planObj = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const sg = (bad, item, msg) => (started >= ENFORCE_SELLER ? add(!bad, item, msg) : warn(bad, item, `${msg}${bad ? ' (10-25 12시 이후 착수분부터 FAIL)' : ''}`));
    const rs = planObj.ref_seller || meta.ref_seller || null;
    const problems = [];
    if (!rs) problems.push('ref_seller 없음');
    else {
      if (!rs.channel) problems.push('channel');
      if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be|instagram\.com)\//.test(String(rs.url || ''))) problems.push('url(유튜브·인스타 영상 링크)');
      if (!(Number(rs.views) > 0)) problems.push('views');
      // 10-28 소유주 «시즌 상품은 해마다 비슷»: season:true 면 작년 같은 시즌(착수 300~430일 전)·조회 10만↑(server/data/shop_season_pool.json)
      const season = rs.season === true;
      if (season ? !(Number(rs.views) >= 100000) : !(Number(rs.mult) >= 3)) problems.push(season ? `views ${rs.views} (작년 시즌 ≥100000)` : `mult ${rs.mult} (≥3)`);
      const pd = Date.parse(String(rs.posted || ''));
      const base = Number.isFinite(started) ? started : Date.now();
      if (!Number.isFinite(pd)) problems.push('posted(YYYY-MM-DD)');
      else if (season ? (base - pd < 300 * 86400000 || base - pd > 430 * 86400000) : (base - pd > 90 * 86400000 || pd > base + 86400000)) problems.push(season ? `posted ${rs.posted} 가 작년 같은 시즌(300~430일 전)이 아님` : `posted ${rs.posted} 가 착수 90일 안이 아님`);
    }
    sg(problems.length > 0, '⑯ ref_seller', problems.length ? problems.join(' · ') : `${rs.season ? '작년 시즌 ' : ''}${rs.channel} ×${rs.mult ?? '-'} ${Number(rs.views).toLocaleString()}회 · ${rs.posted} · ${rs.url}`);
    const cr = planObj.coupang_reviews || meta.coupang_reviews || null;
    const cp = [];
    // 10-28 소유주 «그냥 api로»: 쿠팡 화면이 막혀 리뷰 수 대신 파트너스 API /products/search 순위(rank)로 고른다
    if (cr && cr.route === 'partners-api') {
      if (!cr.picked || !cr.top || !(Number(cr.picked.rank) >= 1) || !(Number(cr.top.rank) >= 1)) cp.push('coupang_reviews{route:"partners-api",query,picked:{id,rank},top:{id,rank},why?} — rank 숫자');
      else if (Number(cr.picked.rank) > Number(cr.top.rank) && !String(cr.why || '').trim()) cp.push(`고른 상품 순위 ${cr.picked.rank} > 같은 모양 최상위 ${cr.top.rank} — why(모양이 달라서 등) 필요`);
      sg(cp.length > 0, '⑯ 쿠팡 순위(API)', cp.length ? cp.join(' · ') : `«${cr.query || ''}» 고른 ${cr.picked.id} ${cr.picked.rank}위 · 같은 모양 최상위 ${cr.top.id} ${cr.top.rank}위${cr.why ? ` (${cr.why})` : ''}`);
    } else {
    if (!cr || !cr.picked || !cr.top) cp.push('coupang_reviews{picked:{id,reviews},top:{id,reviews},why?} 없음');
    else {
      if (!Number.isFinite(Number(cr.picked.reviews)) || !Number.isFinite(Number(cr.top.reviews))) cp.push('reviews 숫자');
      else if (Number(cr.picked.reviews) < Number(cr.top.reviews) && !String(cr.why || '').trim()) cp.push(`고른 상품 리뷰 ${cr.picked.reviews} < 같은 모양 최다 ${cr.top.reviews} — why(모양이 달라서 등) 필요`);
    }
    sg(cp.length > 0, '⑯ 쿠팡 리뷰 수', cp.length ? cp.join(' · ') : `고른 ${cr.picked.id} 리뷰 ${cr.picked.reviews} · 같은 모양 최다 ${cr.top.id} 리뷰 ${cr.top.reviews}${cr.why ? ` (${cr.why})` : ''}`);
    }
  }

  // ⑰ 첫 1초 후킹(10-28 소유주 «클릭과 구매전환», docs/shopping-hook-top2x12-20261028.md): 상위 2채널×12편은 0~0.5초에 상품이 화면에 있고
  //    정체·사연·결과로 멈추게 한다 — 우리 3편은 5.5초까지 상품이 없고 전부 «~없이 ~하지 마세요».
  //    meta.hook = { type: "정체|사연|결과먼저|기묘|손해|경고", product_at_s: 숫자(상품·사용 결과가 처음 또렷이 보이는 초), sheet: "<첫 6초 0.5초 간격 시트 경로>" }
  //    plan.segments[0].media[0].shows = "product|result" (첫 컷에 상품 또는 상품을 쓴 결과)
  {
    const planObj = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const hg = (bad, item, msg) => (started >= ENFORCE_HOOK ? add(!bad, item, msg) : warn(bad, item, `${msg}${bad ? ' (10-28부터 착수분 FAIL)' : ''}`));
    const h = meta.hook || {};
    const hp = [];
    if (!HOOK_TYPES.includes(h.type)) hp.push(`type «${h.type || ''}» (${HOOK_TYPES.join('|')})`);
    if (!(Number(h.product_at_s) >= 0) || Number(h.product_at_s) > 1) hp.push(`product_at_s ${h.product_at_s} (≤1초)`);
    if (!h.sheet || !fs.existsSync(h.sheet)) hp.push(`sheet(첫 6초 시트) 없음: ${h.sheet || ''}`);
    const first = ((planObj.segments[0] || {}).media || [])[0] || {};
    if (!['product', 'result'].includes(first.shows)) hp.push(`첫 컷 shows «${first.shows || ''}» (product|result)`);
    hg(hp.length > 0, '⑰ 첫 1초 상품', hp.length ? hp.join(' · ') : `${h.type} · 상품 ${h.product_at_s}초 · 첫 컷 ${first.shows}`);
    // 같은 훅 공식 반복 금지: 최근 3편과 같은 type 2편 이상이거나, «~마세요» 경고형이 최근 3편에 이미 있으면 FAIL
    const others = fs.readdirSync(UPLOAD_DIR).filter((f) => /^ffref\d+\.json$/.test(f) && path.join(UPLOAD_DIR, f) !== path.resolve(metaPath))
      .map((f) => path.join(UPLOAD_DIR, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(0, 3)
      .map((f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } });
    const isWarnHook = (mm, firstLine) => (mm.hook && mm.hook.type === '경고') || WARN_HOOK.test(firstLine || String(mm.title || ''));
    const sameType = others.filter((o) => o.hook && o.hook.type === h.type).length;
    const warnNow = isWarnHook(meta, segs[0]);
    const warnRecent = others.filter((o) => isWarnHook(o)).length;
    const rp = [];
    if (sameType >= 2) rp.push(`최근 3편 중 ${sameType}편이 같은 «${h.type}»`);
    if (warnNow && warnRecent) rp.push(`«~마세요» 경고형은 4편에 1편 이하(최근 3편에 ${warnRecent}편)`);
    hg(rp.length > 0, '⑰ 훅 돌려쓰기', rp.length ? rp.join(' · ') : `최근 3편 type ${others.map((o) => (o.hook && o.hook.type) || (isWarnHook(o) ? '경고(제목)' : '?')).join('·')}`);
  }

  return { code: out.every((x) => x.ok) ? 0 : 4, out };
}

module.exports = { check };

if (require.main === module) {
  const f = process.argv[2];
  if (!f) { console.error('쓰임: node scripts/shop_script_check.js <메타.json>'); process.exit(2); }
  const r = check(f);
  for (const x of r.out) console.log(`${!x.ok ? '✗' : x.warn ? '△' : '✓'} ${x.item}: ${x.msg}`);
  // G16 반려 유형은 _gate_log 에 쌓는다(나중에 자체 게이트·부검 재료)
  const rj = r.out.find((x) => x.reject);
  if (rj) fs.appendFileSync('D:/volcano-runs/_gate_log.jsonl', JSON.stringify({ at: new Date().toISOString(), wd: path.basename(f, '.json'), source: 'shop_script_check', kind: 'gyeol_reject', message: rj.reject, detail: rj.msg }) + '\n', 'utf8');
  if (r.code) console.error(`\x07✗✗✗ 원고 검사 ${r.code === 5 ? '검사 불가' : 'FAIL'} — ${path.basename(f)} 재고·업로드 금지`);
  else console.log(`✓ 원고 검사 통과 — ${path.basename(f)}${r.exempt ? '(구 원고 면제)' : ''}`);
  process.exit(r.code);
}

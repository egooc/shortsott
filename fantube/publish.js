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

// 자체 시험(10/28 관리자, G22 무검사 통과 사고 재발 방지): 시작할 때 G22 ⑥이 반드시 FAIL 해야 하는 가짜 편(share 0.1·viral_basis 없음)을
// 자기 자신(--selftest)으로 먼저 돌리고, 그 편이 종료 5 + «⑥ group_check.share_1m»·«⑥ viral_basis» 로 떨어지지 않으면 전체를 종료 5로 멈춘다.
const SELFTEST = process.argv.includes('--selftest');
const ST_DIR = 'D:/volcano-runs/fantube/_selftest';
if (!SELFTEST) {
  fs.mkdirSync(ST_DIR, { recursive: true });
  // 가짜 편은 결 틀이 아닌 기본형(B)으로 둔다 — 10/28 소유주 «예외로 올려 일단» 뒤 결 틀은 share 가 경고라 FAIL 시험이 안 된다.
  const fakeSpec = { skin: 'b', template: 'B', sources: {}, segs: [{ src: 'A', a: 0, b: 12, cw: 608, x: 0, y: 0 }],
    top: { l1: '자체 시험 전제', l2: '자체 시험 펀치' }, caps: [{ t0: 0, t1: 3, style: 'note', text: '[자체 시험]' }, { t0: 10, t1: 12, style: 'end', text: '자체 시험 끝 한마디' }],
    vicarious: '자체 시험용 대리만족 문장입니다 스무 자를 넘깁니다', hook: { visual: '자체 시험 시각 훅', audio: '원음 자체 시험', text: '자체 시험 텍스트 훅' },
    title_pattern: { pattern: '숫자', key: '자체' }, expected_comment: { type: '공감', line: '자체 시험 끝 한마디', at_sec: 10, form: '단정' },
    group_check: { share_1m: 0.1, latest_days: 10, cross: ['a', 'b'], ja_fandom: 'x' }, twist: '조금', reason: ['1개월', '유사', '댓글'], source_check: { views: 20000, found_by: '키워드' },
    story: { structure_id: '자체 시험', beats: { situation: 's', stake: 's', attempt: 'a', turn: '갑자기 t', ending: 'e', emotion_tail: 'x' }, map: { '자체 시험': 'situation', '끝 한마디': 'emotion_tail' }, devices: {} } };
  fs.writeFileSync(path.join(ST_DIR, 'spec.json'), JSON.stringify(fakeSpec, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(ST_DIR, 'meta.json'), JSON.stringify({ file: 'D:/volcano-runs/fantube/_selftest/none.mp4', title: '자체 시험 가짜 편 제목 열다섯', description: '자체 시험', tags: ['자체'] }, null, 2) + '\n', 'utf8');
  const st = spawnSync(process.execPath, [__filename, '_selftest', path.join(ST_DIR, 'meta.json'), at, '--check-only', '--selftest'], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const out = (st.stdout || '') + (st.stderr || '');
  if (st.status !== 5 || !/⑥ group_check\.share_1m/.test(out) || !/⑥ viral_basis/.test(out)) {
    console.error(`[publish] ★FAIL 발행기 자체 시험 — 가짜 편(share 0.1·viral_basis 없음)이 G22 ⑥에서 안 막혔다(exit ${st.status}). 관문이 빠져 있다 — 전체 중단. 출력: ${out.slice(-400)}`);
    process.exit(5);
  }
  console.log('✓ 발행기 자체 시험 — 가짜 편 G22 ⑥(share·viral_basis) FAIL 확인');
}
const M = JSON.parse(fs.readFileSync(meta, 'utf8'));
// 결 표 관문(도구개발 18cd569, 소유주 «결분석 다 잡고 가자» 10/29): 편 폴더에 gyeol_table.md|json(레퍼런스 출처·초|결|우리 장면 4줄+·반전·약속) 없으면 막는다.
// 공용 파일을 그대로 부른다(사본 금지). 2026-10-31 00:00 KST 전에는 경고만. 자체 시험 가짜 편은 건너뛴다(G22 시험이 목적).
if (!SELFTEST) {
  const gg = spawnSync('python', ['-X', 'utf8', 'D:/midform/scripts/gyeol_gate.py', `D:/volcano-runs/fantube/${ep}`], { stdio: 'inherit' });
  if (gg.status) { console.error(`[publish] ★FAIL 결 표 관문(gyeol_gate exit ${gg.status}) — D:/volcano-runs/fantube/${ep}/gyeol_table.json 을 채워라. 업로드 안 함.`); process.exit(4); }
}
// 댓글 장치 게이트(10/20 소유주 질책 «댓글 반응을 노리는 원고가 반영 안 됐다», RULES_PDF 20항):
// ①②③ 은 공용 scripts/comment_hook.py(도구개발 a4856bc) — expected_comment·장치 문장이 본문에·끝 3문장 장치. 0 말고는 전부 업로드 금지(4 FAIL·5 검사 불가).
// 팬튜브만 더 본다: at_sec 이 그 문장(자막·TTS) 표시 구간 안인지. (--selftest 는 이 블록을 건너뛰고 기획 게이트만 본다)
if (!SELFTEST) {
  const specPath = path.join('D:/volcano-runs/fantube', ep, 'spec.json');
  // 10/27 새 채널 «원본 자막형»(GUIDE_TOP2x12 §4: 자체 자막·TTS 0, 댓글 카드 4~6장이 해설 역할): voice·caps 가 없으면 댓글 카드 문장(시각순)을 본문으로 넘긴다.
  const S0 = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const cardMode = !(S0.voice || []).length && !(S0.caps || []).some((c) => c.style !== 'en');
  const hookArgs = [path.join(ROOT, 'scripts', 'comment_hook.py'), specPath, '--lane', 'fantube'];
  if (cardMode) {
    const sp = path.join('D:/volcano-runs/fantube', ep, '_hook_script.txt');
    fs.writeFileSync(sp, [...(S0.comments || [])].sort((a, b) => a.t0 - b.t0).map((c) => String(c.text || '').replace(/\n/g, ' ')).join('\n') + '\n', 'utf8');
    hookArgs.push('--script', sp);
  }
  const ch = spawnSync('python', hookArgs, { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  process.stdout.write(ch.stdout || ''); process.stderr.write(ch.stderr || '');
  let why = ch.status !== 0 ? `comment_hook exit ${ch.status}${ch.status === 5 ? '(검사 불가)' : ''}` : '';
  if (!why) {
    const S = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const ec = S.expected_comment;
    const norm = (x) => String(x || '').replace(/\s+/g, '');
    const spans = [...(S.caps || []).map((c) => [c.text, c.t0, c.t1]), ...(S.voice || []).flatMap((v) => [[v.text, v.t0, v.t0 + 6], [v.show || '', v.t0, v.t0 + 6]]),
      ...(cardMode ? (S.comments || []).map((c) => [c.text, c.t0, c.t1]) : [])];   // 원본 자막형: 댓글 카드 문장도 화면 글
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
//    + 업로드 제목: 해시태그 없이 15자±3, key 가 앞 10자 안 ④ 첫 TTS 문장에 «안녕하세요·오늘은» 금지 ⑤ devo V1·V2·V3·V5(21~24항).
{
  const S = JSON.parse(fs.readFileSync(path.join('D:/volcano-runs/fantube', ep, 'spec.json'), 'utf8'));
  const PAT = ['결과 숨김', '이유·비밀', '팬 저격', '숫자', '금지·주의', '말하다 만다', '실화·썰', 'ㅋㅋ·ㄷㄷ', '대사 그대로', '최상급·한정'];
  const bad = [];
  if (String(S.vicarious || '').replace(/\s/g, '').length < 20) bad.push(`① vicarious «${S.vicarious || ''}» 20자 미만`);
  const h = S.hook || {};
  for (const k of ['visual', 'audio', 'text']) if (String(h[k] || '').trim().length < 4) bad.push(`② hook.${k} 비었음`);
  const v0 = [...(S.voice || [])].sort((a, b) => a.t0 - b.t0)[0];
  if (!/효과음|원음/.test(h.audio || '') && !(v0 && v0.t0 < 3)) bad.push('② 청각 훅: 첫 TTS 가 3초 안에 없음(효과음이면 hook.audio 에 «효과음», 해설 없이 원음이 훅이면 «원음» — 10/22 소유주 «재미없다» 뒤 레퍼런스식 무해설 허용)');
  const tp = S.title_pattern || {};
  const title = String(M.title || '');
  const len = [...title.replace(/\s/g, '')].length;
  if (!PAT.includes(tp.pattern)) bad.push(`③ title_pattern.pattern «${tp.pattern || ''}» — ${PAT.join('/')} 중 하나`);
  if (!tp.key || !title.slice(0, 10).includes(tp.key)) bad.push(`③ 핵심 낱말 «${tp.key || ''}» 이 제목 앞 10자에 없음`);
  if (/#/.test(title)) bad.push('③ 제목에 해시태그(제목 늘리기 금지 — 설명란으로)');
  if (len < 12 || len > 18) bad.push(`③ 제목 ${len}자(공백 빼고) — 15자±3`);
  if (v0 && /안녕|오늘은/.test(v0.text)) bad.push(`④ 첫 TTS «${v0.text}» 인사·«오늘은» 금지`);
  // devo 칼럼 V1·V2·V3·V5(21~24항, 10/20 관리자 — 도구개발 script_audit --shorts 나오면 그쪽 import 로 교체).
  // 원음 인용(caps style 'say')·베댓 카드는 실제 말이라 V2·V3 검사에서 뺀다.
  if (v0 && /오늘은|이유는|왜냐하면|때문입니다|때문이에요|때문이죠/.test(v0.text)) bad.push(`⑤ V1 첫 TTS «${v0.text}» 설명형 — 행동 묘사·의외성·궁금증으로`);
  // 결 틀의 quote(따옴표 대사)·label(이름 라벨)·list 는 멤버 말·표지라 우리 문장이 아니다(say 와 같이 뺀다).
  const ours = [...(S.voice || []).map(x => ({ ...x, src: 'TTS' })), ...(S.caps || []).filter(x => !['say', 'quote', 'label', 'list'].includes(x.style)).map(x => ({ ...x, src: '자막' }))].sort((a, b) => a.t0 - b.t0);
  const EVAL = /너무\s?감동|감동적|감동이|놀라웠|놀랍|대단했|대단하|대단한|소름/;
  for (const x of ours.slice(v0 ? 1 : 0)) if (EVAL.test(x.text)) bad.push(`⑤ V2 ${x.src} @${x.t0}s «${x.text}» 감정 평가 어휘 — 행동·사실로`);
  const last = ours[ours.length - 1];
  if (last && /결국|정리하면|요약하면|한마디로|역시\s|레전드였|최고였|완벽했/.test(last.text)) bad.push(`⑤ V3 끝 문장 «${last.text}» 평가·요약 — 댓글 장치 질문 또는 감정 한 문장`);
  const top = `${(S.top || {}).l1 || ''} ${(S.top || {}).l2 || ''}`;
  if (!/\d|[한두세네다섯]\s?(번|명|개|시간|초|분|살|년)|번째|첫\s|째/.test(top)) {
    // 10/28 결 틀(style=claim, GUIDE_KYUL_JJYUK §2): 제목은 전제/펀치라 숫자가 없는 편이 많다(«퇴근 앞에서 / 찐텐 나오는 오해원») → 경고만. 다른 형식은 그대로 FAIL.
    if (S.style === 'claim') console.warn(`[publish] △ V5 상단 문구 «${top.trim()}» 숫자 없음 — 결 틀이라 경고만(10/28)`);
    else bad.push(`⑤ V5 상단 문구 «${top.trim()}» 에 숫자·시간 없음(«8시간째» 식 1개)`);
  }
  if (S.style === 'claim') {
    // 결 틀 구조 검사: l1·l2 둘 다, 끝 한마디(style=end) 1개가 마지막 1~2초에, 길이 9~20초, 댓글 카드 0.
    const capsC = [...(S.caps || [])].sort((a, b) => a.t0 - b.t0);
    const dur = (S.segs || []).reduce((t, g) => t + (g.b - g.a), 0);
    if (!(S.top || {}).l1 || !(S.top || {}).l2) bad.push('⑨ 결 틀: top.l1(전제)·l2(펀치) 둘 다 필요');
    const ends = capsC.filter(c => c.style === 'end');
    if (ends.length !== 1) bad.push(`⑨ 결 틀: 끝 한마디(style=end) ${ends.length}개 — 정확히 1개`);
    else if (dur - ends[0].t1 > 0.3 || ends[0].t1 - ends[0].t0 < 1) bad.push(`⑨ 결 틀: 끝 한마디가 끝까지(${ends[0].t0}~${ends[0].t1}s, 전체 ${dur.toFixed(1)}s) 1초 이상 떠 있어야`);
    if (dur < 9 || dur > 20) bad.push(`⑨ 결 틀: 길이 ${dur.toFixed(1)}s — 9~20초(«모음» 편만 예외, spec.compilation=true)`.replace(/ — .*$/, S.compilation ? ' — 모음 편 허용' : ' — 9~20초'));
    // 10/29 소유주 «번역 카드(추천대로)»(관리자 전달): 결 틀 카드는 실제 영어 댓글의 번역 카드 1장만 — orig 는 영어 원문(한글 0), text 는 뜻만 옮긴 번역, translated=true, 원문은 spec.comment_source(info.json) 의 댓글에 실제로 있어야 한다.
    const cards = S.comments || [];
    if (cards.length > 1) bad.push(`⑨ 결 틀: 카드 ${cards.length}장 — 번역 카드 1장까지, 나머지는 끝 한마디로`);
    for (const c of cards) {
      if (!c.translated || !c.orig) { bad.push('⑨ 결 틀: 댓글 카드 금지 — 번역 카드(orig 영어 원문·translated=true)만 1장'); continue; }
      if (/[가-힣]/.test(c.orig) || !/[A-Za-z]{3,}/.test(c.orig)) bad.push(`⑨ 번역 카드: orig 가 영어 원문이 아님 «${c.orig.slice(0, 40)}»`);
      if (!/[가-힣]/.test(c.text || '')) bad.push('⑨ 번역 카드: text 는 한국어 번역이어야 한다');
      if (!(c.likes >= 1)) bad.push('⑨ 번역 카드: likes(원문 ♥ 수) 필요');
      const srcInfo = S.comment_source;
      if (!srcInfo || !fs.existsSync(srcInfo)) bad.push('⑨ 번역 카드: spec.comment_source(원본 info.json 경로) 없음 — 원문이 실제 댓글인지 확인 불가');
      else {
        try {
          const info = JSON.parse(fs.readFileSync(srcInfo, 'utf8'));
          const norm = t => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const want = norm(c.orig.replace(/\n/g, ' '));
          const hit = (info.comments || []).find(k => norm(k.text).includes(want));
          if (!hit) bad.push(`⑨ 번역 카드: 원문이 ${path.basename(srcInfo)} 댓글에 없음 «${c.orig.slice(0, 40)}»`);
          else if (Number(hit.like_count || 0) < Number(c.likes) * 0.8) bad.push(`⑨ 번역 카드: likes ${c.likes} 가 실제 ♥ ${hit.like_count} 보다 부풀려짐`);
          else console.log(`✓ 번역 카드 원문 실재 — ♥${hit.like_count} «${String(hit.text).slice(0, 50)}»`);
        } catch (e) { bad.push(`⑨ 번역 카드: comment_source 읽기 실패 ${e.message}`); }
      }
    }
    if (!capsC.some(c => ['paren', 'note'].includes(c.style))) bad.push('⑨ 결 틀: 팬 화자 자막(paren 괄호 반응 또는 note 대괄호 상황) 0개');
    // 10/29 소유주: 박힌 자막은 다 보여야 한다(검수 #21·레퍼런스 예능셔틀 정사각 창). 정사각 창(spec.window=square)이 기본이고, 그래도 자막·얼굴이 한 창에 못 들어오는 컷만 spec.fit_ok 사유와 함께 fit 허용.
    if ((S.segs || []).some(g => g.fit) && !S.fit_ok) bad.push('⑨ 결 틀: 가로 통짜(segs[].fit)는 spec.window="square"(정사각 창) 로 먼저 풀고, 그래도 안 되는 컷만 spec.fit_ok 에 사유를 적어라(소유주 10/29)');
    else if ((S.segs || []).some(g => g.fit)) console.error(`[publish] △ 가로 통짜 컷 ${(S.segs || []).filter(g => g.fit).length}개 — fit_ok: ${S.fit_ok}`);
  }
  // 10/30 소유주 «엔믹스에 카르멘이 누군데? 멤버가 아니잖아»(n05 카르멘=하츠투하츠 사고) — 레인은 그룹 하나. 설윤이또(idol3sec_ko)=엔믹스, 제임스 과몰입(cortis_fan_ko)=코르티스. 다른 그룹 편은 FAIL.
  const LANE_GROUP = { idol3sec_ko: ['엔믹스', 'NMIXX'], cortis_fan_ko: ['코르티스', 'CORTIS'] };
  const lg = LANE_GROUP[M.purpose || 'idol3sec_ko'] || [];
  const lgGot = String((S.group_check || {}).group || '');
  if (lg.length && !lg.includes(lgGot)) bad.push(`⑩ 레인 그룹 불일치 — 이 채널은 ${lg[0]} 전용인데 spec.group_check.group=«${lgGot || '없음'}» (소유주 10/30)`);
  // 꽉갈이 누락분 G22(10/21 관리자, RULES_PDF 25~29항) — 10/23 부터 막고 그 전엔 경고만.
  const g22 = [];
  const gc = S.group_check || {};
  if (!(gc.share_1m >= 0.5)) {
    // 10/27 소유주 결정 (b)(관리자 전달): 원본 자막형(spec.style==='orig_caption')에 한해 share_1m 은 FAIL 대신 경고 — 출력·기록에 남긴다. 다른 형식은 그대로 FAIL.
    // 10/28 09:50 관리자: 결 틀(style=claim)로 넓힌 예외는 되돌림 — 소유주 (b)는 원본 자막형 한정, claim 은 소유주 답 전까지 FAIL 유지.
    // 10/28 11:30 소유주 «예외로 올려 일단» (결정 1·2에 대한 답): 결 틀(style=claim)도 경고로. 다른 형식은 그대로 FAIL. 공개 7일 뒤 비교 기록(g22_share_warn.jsonl).
    if (S.style === 'orig_caption' || S.style === 'claim') {
      console.warn(`[publish] △ G22 ⑥ share_1m ${gc.share_1m ?? '없음'} < 0.5 — ${S.style === 'claim' ? '결 틀이라 경고로만(소유주 «예외로 올려 일단» 10/28)' : '원본 자막형이라 경고로만(소유주 결정 (b) 10/27)'}. 공개 7일 뒤 비교 기록 대상`);
      if (!process.argv.includes('--check-only')) try { fs.appendFileSync('D:/volcano-runs/fantube/_upload/g22_share_warn.jsonl', JSON.stringify({ at: new Date().toISOString(), ep, style: S.style, share_1m: gc.share_1m ?? null, group: gc.group || null }) + '\n', 'utf8'); } catch (e) { console.warn(`[publish] 경고 기록 실패: ${e.message}`); }
    } else g22.push(`⑥ group_check.share_1m ${gc.share_1m ?? '없음'} — #그룹 쇼츠탭 100만+ 절반 이상`);
  }
  if (!(gc.latest_days <= 30)) g22.push(`⑥ group_check.latest_days ${gc.latest_days ?? '없음'} — 100만+ 최신이 1달 이내`);
  if (!Array.isArray(gc.cross) || gc.cross.length < 2) g22.push('⑥ group_check.cross — 유튜브 차트·브랜드평판·구글트렌드 중 2개+');
  if (!gc.ja_fandom) g22.push('⑥ group_check.ja_fandom — 일본 팬덤 근거 한 줄');
  // 10/27 소유주 «기존에 터진 소재는 재해석, 갓 터진 건 빠르게» + RULES_PDF 1항(이미 터진 것만, 근거 ID·조회수) 강제:
  // spec.viral_basis = {kind:'100만+'|'상승', id, views, hours?, per_hour?, checked_at}. 100만+ 는 views>=1,000,000, 상승은 공개 72시간 안 시간당 1,000회 이상. 없으면 업로드 금지.
  const vb = S.viral_basis || {};
  const vbOk = (vb.kind === '100만+' && Number(vb.views) >= 1000000 && vb.id)
    || (vb.kind === '상승' && Number(vb.hours) <= 72 && Number(vb.per_hour) >= 1000 && vb.id);
  // 10/28 소유주 «예외로 올려 일단»: 편 단위 예외만 — spec.viral_basis.owner_exception = {by:'소유주', at, quote, scope}. 그 편만 경고+기록(g22_viral_exception.jsonl), 다른 편은 그대로 FAIL.
  const vbEx = vb.owner_exception;
  if (!vbOk && vbEx && vbEx.by === '소유주' && vbEx.quote && vbEx.at) {
    console.warn(`[publish] △ G22 ⑥ viral_basis 미충족 — 소유주 예외(${vbEx.at} «${vbEx.quote}», ${vbEx.scope || '이 편'}). 공개 7일 뒤 비교 기록 대상`);
    if (!process.argv.includes('--check-only')) try { fs.appendFileSync('D:/volcano-runs/fantube/_upload/g22_viral_exception.jsonl', JSON.stringify({ at: new Date().toISOString(), ep, viral_basis: vb }) + '\n', 'utf8'); } catch (e) { console.warn(`[publish] 경고 기록 실패: ${e.message}`); }
  } else if (!vbOk) g22.push(`⑥ viral_basis 없음/미달 — ${JSON.stringify(vb)} (100만+ 쇼츠 ID·조회수, 또는 72h 안 시간당 1,000회↑ 상승 근거 필수, 소유주 10/27)`);
  else console.log(`✓ 터진 근거 ${vb.kind} ${vb.id} ${vb.kind === '100만+' ? Number(vb.views).toLocaleString() + '회' : vb.per_hour + '회/h·' + vb.hours + 'h'}`);
  const rs = Array.isArray(S.reason) ? S.reason : [];
  if (rs.length < 3 || !/년|개월|달/.test(rs[0] || '') || !/렌즈|유사/.test(rs[1] || '') || !/댓글|베댓/.test(rs[2] || '')) g22.push('⑥ reason 3줄 [원본 시기, 구글렌즈 유사 적음, 댓글 포인트]');
  const so = S.source_check || {};
  if (!(so.views >= 10000)) g22.push(`⑥ source_check.views ${so.views ?? '없음'} — 원본 조회 1만+`);
  if (!/렌즈|AI|키워드|공식/.test(so.found_by || '')) g22.push('⑥ source_check.found_by — 원본 찾은 방법(구글렌즈·AI 시간대·영어 키워드), AI 답은 직접 확인');
  if (!['조금', '+@'].includes(S.twist)) g22.push(`⑥ twist «${S.twist || ''}» — «조금»(180도 금지) 또는 «+@»`);
  // claim_* = 결 틀(GUIDE_KYUL_JJYUK §8, 10/28) — 주제×템플릿 A/B 는 11/06 비교에 «결 전환 전/후» 열. (10/28 10:40 한 줄 주석이 g22.push 를 삼켜 G22 전체가 꺼졌던 사고 수정)
  if (!['B', '랭킹형', '인스타형', '음악형', '미녀형', 'claim_yoon', 'claim_james'].includes(S.template)) g22.push(`⑥ template «${S.template || ''}» — 주제×템플릿 짝 A/B 기록`);
  if (g22.length) {
    if (new Date() >= new Date('2026-10-23T00:00:00+09:00')) bad.push(...g22);
    else console.warn(`[publish] △ 꽉갈이 G22(10/23부터 FAIL) — ${g22.join(' / ')}`);
  }
  // 이야기 원고(10/21 소유주 질책 «화면 해설 말고 허구라도 스토리», RULES_PDF 30항) — 공용 scripts/story_gate.py(도구개발 2e986a7) 그대로.
  // 원고 문장 = 우리 문장(TTS + 원음 인용 아닌 자막, 시각순) → <ep>/_story_input.json 의 narration. spec.story.map 은 {문장: beat} 로 적고 여기서 순번으로 바꾼다.
  // 종료 4(FAIL) → 업로드 금지(10/23 전엔 story_gate 가 [유예]·0), 5(검사 불가) → 금지. 결과 줄은 편 보고에 그대로.
  {
    const sy = S.story || {};
    // 원본 자막형(voice·caps 0)은 댓글 카드가 해설 자리이므로 카드 문장을 이야기 원고로 본다(GUIDE_TOP2x12 §4 5·6항).
    const nar = ours.length ? ours.map(x => x.text) : [...(S.comments || [])].sort((a, b) => a.t0 - b.t0).map(c => String(c.text || '').replace(/\n/g, ' '));
    if (!ours.length) {
      if ((S.comments || []).length < 4) bad.push(`⑧ 원본 자막형: 댓글 카드 ${(S.comments || []).length}장 — 4~6장 필요(GUIDE §4)`);
      if (!/원음/.test((S.hook || {}).audio || '')) bad.push('⑧ 원본 자막형: hook.audio 에 «원음»');
    } else if ((S.caps || []).some(c => ['say', 'pop'].includes(c.style))) console.warn('[publish] △ GUIDE §4 8항: 자체 자막 say/pop 은 새 채널에서 0개');
    const smap = sy.map && !Array.isArray(sy.map) && isNaN(Object.keys(sy.map)[0])
      ? nar.map(t => { const k = Object.keys(sy.map).find(k => t.replace(/\s/g, '').includes(k.replace(/\s/g, '')) || k.replace(/\s/g, '').includes(t.replace(/\s/g, ''))); return k ? sy.map[k] : null; })
      : sy.map;
    const inp = path.join('D:/volcano-runs/fantube', ep, '_story_input.json');
    const idx = k => nar.findIndex(t => t.replace(/\s/g, '').includes(k.replace(/\s/g, '')) || k.replace(/\s/g, '').includes(t.replace(/\s/g, '')));
    const sdev = sy.devices && Object.keys(sy.devices).some(k => isNaN(k))       // story.devices {문장: 장치} → story_gate 가 받는 {문장 번호: 장치}
      ? Object.fromEntries(Object.entries(sy.devices).map(([k, v]) => [idx(k), v]).filter(([i]) => i >= 0))
      : sy.devices;
    fs.writeFileSync(inp, JSON.stringify({ narration: nar, story: S.story ? { ...sy, map: smap, devices: sdev } : undefined, fiction: sy.fiction }, null, 2) + '\n', 'utf8');
    const sg = spawnSync('python', [path.join(ROOT, 'scripts', 'story_gate.py'), inp, '--field', 'narration', '--lane', 'fantube'], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    process.stdout.write(sg.stdout || ''); process.stderr.write(sg.stderr || '');
    if (sg.status !== 0) bad.push(`⑦ story_gate exit ${sg.status}${sg.status === 5 ? '(검사 불가)' : ''}`);
  }
  if (!(S.caps || []).some(x => x.style === 'en')) console.warn('[publish] △ 영어 자막 1줄 없음(G22 ⑥, 템플릿 지원 뒤 FAIL)');
  if (bad.length) {
    console.error(`\x07[publish] ★FAIL 기획 게이트 — ${bad.join(' / ')}. 업로드 안 함.`);
    process.exit(5);
  }
  console.log(`✓ 기획 게이트 통과 — 대리만족 «${S.vicarious}» · 훅 ${h.visual} / ${h.audio} / ${h.text} · 제목 ${tp.pattern}·«${tp.key}» ${len}자`);
}
// 원고 점검(10/21 관리자 검수 «팬튜브 script_audit 미연결»): 공용 scripts/script_audit.py --kind shorts 를 spec 그대로.
// 경고형은 통과, 0이 아니면(검사 불가 5 포함) 업로드 금지. 옛 A틀 spec(ep03~15, segments/captions)은 못 읽는다 — B틀(voice·caps)만 대상.
{
  // 10/27 원본 자막형 입력 어댑터(관리자 승인 조건 ①②): spec.style === 'orig_caption' 이라고 명시된 편만, 댓글 카드 문장(시각순)을 .txt 원고로 넘긴다.
  // 형식을 추측해서 켜지 않는다. 카드 문장이 0개면 지금처럼 종료 5(검사 불가)로 끝낸다. 기준(V1~V4)은 그대로 script_audit 이 판정한다.
  const specP = path.join('D:/volcano-runs/fantube', ep, 'spec.json');
  const SA = JSON.parse(fs.readFileSync(specP, 'utf8'));
  let auditTarget = specP;
  if (SA.style === 'orig_caption') {
    const cards = [...(SA.comments || [])].sort((a, b) => a.t0 - b.t0).map((c) => String(c.text || '').replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
    if (!cards.length) {
      console.error('[publish] ★FAIL 원고 점검 — 원본 자막형(style=orig_caption)인데 댓글 카드 문장이 0개(검사 불가). 업로드 안 함.');
      process.exit(5);
    }
    auditTarget = path.join('D:/volcano-runs/fantube', ep, '_audit_script.txt');
    fs.writeFileSync(auditTarget, cards.join('\n') + '\n', 'utf8');
    console.log(`[publish] 원고 점검 입력: 원본 자막형 — 댓글 카드 ${cards.length}문장 → ${path.basename(auditTarget)}`);
  }
  const sa = spawnSync('python', [path.join(ROOT, 'scripts', 'script_audit.py'), auditTarget, '--lane', 'fantube', '--kind', 'shorts'], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  process.stdout.write(sa.stdout || ''); process.stderr.write(sa.stderr || '');
  if (sa.status !== 0) {
    console.error(`[publish] ★FAIL 원고 점검 — script_audit exit ${sa.status}${sa.status === 5 ? '(검사 불가)' : ''}. 업로드 안 함.`);
    process.exit(5);
  }
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
// 미성년 멤버 보호 관문(10/27 관리자, 코르티스 레인): 외모·몸 평가 ①, 연애 엮기 ②, 썸네일 미성년 단독 클로즈업 ③ — 낱말 검사와 별개. 4·5 업로드 금지.
{
  const mg = spawnSync('python', [path.join(__dirname, 'minor_gate.py'), ep, meta], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  process.stdout.write(mg.stdout || ''); process.stderr.write(mg.stderr || '');
  if (mg.status !== 0) { console.error(`[publish] ★FAIL 미성년 보호 관문 — minor_gate exit ${mg.status}${mg.status === 5 ? '(검사 불가: spec.thumb.members)' : ''}. 업로드 안 함.`); process.exit(4); }
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

// 레인별 채널: upload.json 의 purpose(없으면 «아이돌 3초» idol3sec_ko). 10/27 소유주 «레인2 코르티스 증설».
const PURPOSE = M.purpose || 'idol3sec_ko';
const out = execFileSync('node', [path.join(ROOT, 'scripts', 'yt-upload.js'), meta, '--purpose', PURPOSE, '--publish-at', at],
  { cwd: ROOT, encoding: 'utf8' });
process.stdout.write(out);
const last = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop());
fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), meta: path.basename(meta), videoId: last.videoId, publishAt: last.publishAt }) + '\n', 'utf8');

const g = spawnSync('node', [path.join(__dirname, 'yt_tags.js'), last.videoId, meta, '--gate'], { cwd: ROOT, encoding: 'utf8' });
process.stdout.write(g.stdout); process.stderr.write(g.stderr);
if (g.status !== 0) { console.error(`[publish] 태그 게이트 실패(${g.status}) — 공개 금지, 관리자 보고`); process.exit(2); }

// 장부(publish_at 포함) — 오피스 대시보드가 재고·다음 공개를 여기서 읽는다(10/29)
const l = spawnSync('node', [path.join(__dirname, 'ledger.js'), ep, '--youtube-id', last.videoId, '--publish-at', at, '--purpose', PURPOSE, '--file', path.basename(M.file || 'out.mp4')], { cwd: ROOT, encoding: 'utf8' });
if (l.status) console.error(`[publish] △ 장부 기록 실패(ledger exit ${l.status}) — 수동으로 node fantube/ledger.js ${ep} --youtube-id ${last.videoId} --publish-at ${at}`);
process.stdout.write(l.stdout); process.stderr.write(l.stderr);
console.log(`[publish] ${ep} → ${last.videoId} · ${at} · 태그 확인 끝`);

// 린박스 전용 발행 경로 — 완성본 mp4 하나를 받아 유튜브에 예약 업로드한다.
//
//   node scripts/rinbox-publish.js <완성본.mp4> [--dry-run] [--publish-at 18:00|<ISO>]
//   node scripts/rinbox-publish.js --approve <완성본.mp4>
//   node scripts/rinbox-publish.js --list
//   node scripts/rinbox-publish.js --revoke <완성본.mp4>
//
// 소유주 지시 2026-09-28:
//   · 캡컷 «드래프트»를 만들지 않는다. mp4 를 그대로 받는다.
//   · movie_catalog(극장 영화 153편)를 쓰지 않는다 — 린박스 전용 rinbox_catalog 를 쓴다.
//   · 명화관 규칙(61초 길이 규정 등)을 가져오지 않는다.
//   · 동기화 감사는 Groq 이 아니라 Speechmatics 로 한다.
//   auto-publish.js 와 **공유하는 것은 업로드 루트뿐**이다
//   (youtubeUploadService + uploadLoudnessService + 08/12/18 슬롯).
//
// 메타는 mp4 옆에 «곁딸린 파일»로 둔다: <완성본>.rinbox.json
//   { "work": "doctors-sbs-2016", "locale": "ko", "title": "...",
//     "description": "...", "tags": ["..."], "workdir": "D:/volcano-runs/rinbox04" }
//   workdir 는 볼케이노 작업 폴더다. 동기화 감사와 완주 판정이 여기를 읽는다.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const {
  listYouTubeUploadProfiles,
  createUploadJob,
  startUploadJob,
  listUploadJobs,
  loadJob
} = require('../server/services/youtubeUploadService');
const { normalizeUploadLoudness } = require('../server/services/uploadLoudnessService');
const { riskOf, withNote, describeHits } = require('./lib/feedSafety');

const CATALOG_PATH = path.join(ROOT, 'midform', 'config', 'rinbox_catalog.json');
const APPROVALS_PATH = path.join(ROOT, 'server', 'data', 'rinbox_approvals.json');
const STATE_PATH = path.join(ROOT, 'server', 'data', 'rinbox_publish_state.json');
const REPORTS_DIR = path.join(ROOT, 'server', 'output', 'rinbox-publish-reports');

// 슬롯 — 08:00 · 12:00 · 18:00 KST (소유주 확인 2026-10-01: 원래 정해진 시간으로 되돌림).
//
// 왜 한때 30분 뒤였나: 2026-09-28 당시 같은 채널에 명화관이 08:00·12:00·18:00 으로 나가고 있어서,
// 같은 시각에 두 편이 공개되면 서로 잡아먹기에 린박스를 30분 밀어 두었다. 2026-09-30 소유주가
// **명화관 업로드를 중지**했고 `midform-auto-publish*` 가 전부 Disabled 라, 비켜 줄 상대가 없어졌다.
// 미뤄 둘 이유가 사라졌으니 원래 시각으로 돌아온다. 명화관을 다시 켜면 이 값을 함께 봐야 한다.
// (린박스끼리의 중복은 여전히 막아야 해서 takenSlots 는 양쪽 기록을 다 본다.)
const SLOT_TIMES_UTC9 = [[8, 0], [12, 0], [18, 0]];
const SLOT_LEAD_MIN = 45;

// 채널 용도 ↔ 카드 포맷. 어긋나면 createUploadJob 이 배치 전체를 던진다(2026-09-25 38시간 정지).
const VARIANT = { ko: 'ko_highlight', ja: 'highlight' };
const PURPOSE = { ko: 'ko_highlight', ja: 'jp_highlight' };

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function ffprobeDurationSec(videoPath) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nk=1:nw=1', videoPath], { encoding: 'utf8' });
  return Number.parseFloat(String(out).trim());
}

function resolvePublishAt(value) {
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  let ms;
  if (hhmm) {
    const now9 = new Date(Date.now() + 9 * 3600 * 1000);
    const base = Date.UTC(now9.getUTCFullYear(), now9.getUTCMonth(), now9.getUTCDate());
    ms = base + Number(hhmm[1]) * 3600 * 1000 + Number(hhmm[2]) * 60 * 1000 - 9 * 3600 * 1000;
  } else {
    ms = Date.parse(value);
  }
  if (!Number.isFinite(ms)) throw new Error(`--publish-at: "${value}" 를 읽을 수 없다`);
  const leadMin = Math.round((ms - Date.now()) / 60000);
  if (leadMin < SLOT_LEAD_MIN) {
    throw new Error(`--publish-at 이 ${leadMin}분 뒤다 — 클레임 확인 창에 ${SLOT_LEAD_MIN}분이 필요하다`);
  }
  return new Date(ms).toISOString();
}

// 이 채널에 이미 잡힌 슬롯은 명화관 기록과 린박스 기록 **양쪽**에서 모은다.
// 채널을 공유하므로 한쪽만 보면 같은 시각에 두 편이 공개된다.
function takenSlots() {
  const taken = new Set();
  for (const p of [path.join(ROOT, 'server', 'data', 'auto_publish_state.json'), STATE_PATH]) {
    for (const entry of (readJson(p, {}).history || [])) {
      // ★retracted 가 붙은 편은 슬롯을 잡고 있지 않다. 유튜브에서 예약을 풀고 비공개로 세운 편이라
      //   그 자리는 비어 있다 — 안 거르면 다음 편이 하루 뒤로 밀린다(2026-10-03 실제로 밀렸다).
      if (entry.retracted) continue;
      if (entry.publishAt && entry.locale) taken.add(`${entry.locale}:${entry.publishAt}`);
    }
  }
  return taken;
}

function nextFreeSlot(locale, fromMs, taken) {
  const dayMs = 24 * 60 * 60 * 1000;
  const shifted = new Date(fromMs + 9 * 3600 * 1000);
  const base = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  for (let day = 0; day < 14; day += 1) {
    for (const [hour, minute] of SLOT_TIMES_UTC9) {
      const slotMs = base + day * dayMs + hour * 3600 * 1000 + minute * 60 * 1000 - 9 * 3600 * 1000;
      if (slotMs < fromMs + SLOT_LEAD_MIN * 60 * 1000) continue;
      const iso = new Date(slotMs).toISOString();
      const key = `${locale}:${iso}`;
      if (taken.has(key)) continue;
      taken.add(key);
      return iso;
    }
  }
  throw new Error(`${locale} 채널에 14일 안에 빈 슬롯이 없다`);
}

function profileByPurpose(purpose) {
  const raw = listYouTubeUploadProfiles();
  const list = Array.isArray(raw) ? raw : (raw.profiles || []);
  return list.find((p) => String(p.purpose || '') === purpose
    && (p.hasRefreshToken || p.maskedRefreshToken)) || null;
}

// ── 문지기 3: 동기화 감사 (Speechmatics) ────────────────────────────────────
// 린박스 자막은 편집표를 쓸 때 이미 Speechmatics 낱말 시각(source-timing.json)에 묶었다.
// 그래서 새로 전사할 필요가 없다 — **그 낱말 시각이 실제로 완성본 자막 시각과 맞는지**
// 대조하면 된다. Groq 로 다시 받아 적는 것은 같은 값을 더 나쁜 정확도로 재측정하는 짓이다.
// (일본어판은 한국어 음성 위에 일본어 자막이라 STT 로 글자를 맞대면 반드시 어긋난다.
//  시각만 대조하는 이 방식은 두 판 모두에 성립한다.)
// ★mp4 가 정말 그 작업 폴더에서 나왔는지 먼저 묶는다.
//   이게 없으면 «통과하는 폴더»를 가리켜 놓고 감사 안 받은 mp4 를 올릴 수 있다(2026-09-28 실측:
//   한국어판 메타의 workdir 를 일본어판 폴더로 바꿔도 그대로 통과했다).
//   볼케이노 완성본 이름은 final-<render_id 앞 16자>.mp4 다.
function bindMp4ToWorkdir(mp4, workdir) {
  const payload = readJson(path.join(workdir, 'next_payload.json'), {});
  const renderId = ((payload.rinbox_review || {}).render_id) || '';
  if (!renderId) return { ok: false, why: 'next_payload.json 에 rinbox_review.render_id 가 없다' };
  const want = `final-${renderId.slice(0, 16)}.mp4`;
  const got = path.basename(mp4);
  if (got !== want) return { ok: false, why: `mp4 가 이 작업 폴더의 것이 아니다 — 기대 ${want}, 실제 ${got}` };
  return { ok: true, renderId };
}

function auditSync(workdir) {
  const timingPath = path.join(workdir, 'source-timing.json');
  const timing = readJson(timingPath, null);
  if (!timing) return { ok: false, why: `source-timing.json 없음: ${timingPath}` };
  if ((timing.provenance || {}).provider !== 'speechmatics') {
    return { ok: false, why: `전사 제공자가 speechmatics 가 아니다: ${(timing.provenance || {}).provider}` };
  }
  const byId = new Map((timing.words || []).map((w) => [w.id, w]));

  const editsDir = path.join(workdir, 'edits');
  if (!fs.existsSync(editsDir)) return { ok: false, why: `edits 폴더 없음: ${editsDir}` };
  const payload = readJson(path.join(workdir, 'next_payload.json'), {});
  const edit = payload.rinbox_edit;
  if (!edit) return { ok: false, why: 'next_payload.json 에 rinbox_edit 이 없다' };

  // ★자막은 두 모양으로 온다. **둘 다** 봐야 한다.
  //   ① word_bound {word_ids, text} — 일본어판처럼 문구가 원문과 다를 때
  //   ② 문자열 "의사양반 의사양반" — 한국어판처럼 원문 그대로일 때
  //   ②를 건너뛰면 한국어판은 «낱말 0개»로 통과한다. 즉 빈 문지기다(2026-09-28 실측).
  //   ②는 문구의 어절을 시간표에서 **연속으로** 찾아 컷 안에 있는지 본다.
  const words = timing.words || [];
  const norm = (s) => String(s).replace(/\s+/g, '');
  // ★문구를 공백으로 쪼개 «전사 낱말 하나»씩 맞대면 일본어는 절대 못 맞춘다(2026-10-01 실측).
  //   일본어는 띄어쓰기가 없어서 자막 한 줄이 토큰 하나인데, 전사표에는
  //   「たかが/小娘/一/人/の/命/を」처럼 일곱 개로 쪼개져 있다. 그래서 첫 비교부터 어긋나고,
  //   ja 평문 자막은 **구조적으로 통과 불가**였다(그래서 지금까지 ja 는 word_bound 만 썼다).
  //   고친 방식: 공백을 지운 뒤 **이어 붙여** 맞댄다. 한국어(「의사양반 의사양반」)도 그대로 맞는다.
  function findPhrase(phrase, lo, hi) {
    const want = norm(String(phrase).trim());
    if (!want) return null;
    for (let i = 0; i < words.length; i += 1) {
      if (words[i].start < lo - 1e-6 || words[i].start > hi + 1e-6) continue;
      let acc = '';
      for (let k = i; k < words.length; k += 1) {
        acc += norm(words[k].text);
        if (acc === want) return { start: words[i].start, end: words[k].end };
        if (acc.length >= want.length || !want.startsWith(acc)) break;
      }
    }
    return null;
  }

  let checked = 0;
  const bad = [];
  for (const item of edit.sequence || []) {
    if (!item.captions) continue;
    const lo = item.source_in;
    const hi = item.source_out;
    for (const cap of item.captions) {
      if (cap && Array.isArray(cap.word_ids)) {
        for (const id of cap.word_ids) {
          const w = byId.get(id);
          checked += 1;
          if (!w) { bad.push(`낱말 id 없음 ${id}`); continue; }
          if (w.start < lo - 1e-6 || w.end > hi + 1e-6) {
            bad.push(`${id} (${w.text}) ${w.start.toFixed(2)}~${w.end.toFixed(2)} 가 컷 ${lo.toFixed(2)}~${hi.toFixed(2)} 밖`);
          }
        }
      } else if (typeof cap === 'string') {
        checked += 1;
        const hit = findPhrase(cap, lo, hi);
        if (!hit) bad.push(`문구를 컷 ${lo.toFixed(2)}~${hi.toFixed(2)} 안에서 못 찾음: "${cap}"`);
        else if (hit.end > hi + 1e-6) bad.push(`"${cap}" 이 컷 끝 ${hi.toFixed(2)} 를 넘음(${hit.end.toFixed(2)})`);
      } else if (Array.isArray(cap) && cap.length === 3) {
        checked += 1;   // existing_cue [start, end, text]
        if (cap[0] < lo - 1e-6 || cap[1] > hi + 1e-6) {
          bad.push(`기존 cue ${cap[0]}~${cap[1]} 가 컷 ${lo.toFixed(2)}~${hi.toFixed(2)} 밖`);
        }
      }
    }
  }
  if (!checked) return { ok: false, why: '대조한 자막이 0개다 — 감사가 비어 있다(형식을 못 알아봤다)' };
  return { ok: bad.length === 0, checked, bad: bad.slice(0, 8), provider: 'speechmatics' };
}

function loadTarget(mp4Arg) {
  const mp4 = path.resolve(mp4Arg);
  if (!fs.existsSync(mp4)) throw new Error(`mp4 가 없다: ${mp4}`);
  const metaPath = `${mp4}.rinbox.json`;
  const meta = readJson(metaPath, null);
  if (!meta) throw new Error(`곁딸린 메타가 없다: ${metaPath}`);
  for (const k of ['work', 'locale', 'title', 'description']) {
    if (!meta[k]) throw new Error(`메타에 ${k} 가 없다: ${metaPath}`);
  }
  if (!VARIANT[meta.locale]) throw new Error(`locale 은 ko 또는 ja 여야 한다: ${meta.locale}`);
  return { mp4, metaPath, meta };
}

// 가이드라인 관문(2026-10-18 소유주: «제재 없이도 피드를 못 받으면 커뮤니티 가이드 위반 — 위험한 거·칼·마약·총기·살인·피·어린아이 대상»).
// 제목·설명·태그·화면 제목(plan title)에 걸리면 승인·발행을 멈춘다. 롱투숏 guide_check.py 를 그대로 부른다(복사 금지).
// 낱말 정본은 D:/midform/config/guide_words.json(도구개발 소유) — 추가·제외는 도구개발에 보고. ja 는 --lang ja --lane jp_highlight.
// 時代劇은 칼·피가 소재라 행위 낱말을 빼고 «정체·반전» 틀로 다시 쓴다. 우회(GUIDE_OK=1)는 소유주 말이 있을 때만.
const GUIDE_PY = 'D:/volcano-runs/ls_tools/guide_check.py';
function guideGate(mp4, meta) {
  if (process.env.GUIDE_OK === '1') return [];
  if (!fs.existsSync(GUIDE_PY)) return [`가이드 점검기가 없다: ${GUIDE_PY}`];
  const plan = [path.join(path.dirname(mp4), '..', 'plan_local.json'), path.join(path.dirname(mp4), 'plan_local.json')].find((p) => fs.existsSync(p));
  const shown = plan ? [].concat(readJson(plan, {}).title || []).join('') : '';
  const lang = meta.locale === 'ja' ? ['--lang', 'ja', '--lane', 'jp_highlight'] : ['--lang', 'ko'];
  try {
    execFileSync('python', ['-I', '-X', 'utf8', GUIDE_PY, `${mp4}.rinbox.json`, ...(shown ? [shown] : []), ...lang],
      { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    return [];
  } catch (e) {
    if (e.status === 4) return String(e.stdout || '').split(/\r?\n/).filter((l) => /^\s+\S/.test(l) && !/대체 제목/.test(l)).map((l) => l.trim());
    return [`가이드 점검기 실행 실패(${e.status}) — ${String(e.stderr || e.message).trim().split(/\r?\n/).pop()}`];
  }
}

// 댓글 장치 관문(2026-10-20 소유주 질책 «댓글 반응을 노리는 원고를 쓰기로 했는데 반영이 안 됐다»).
// 10-19 에 plan.expected_comment 를 «예상 댓글 유형» 메모로만 적고 원고엔 장치 문장이 없었다(133ja).
// 공용 관문 scripts/comment_hook.py(도구개발 a4856bc)를 부른다 — 복사 금지. 0 통과 · 4 FAIL · 5 검사 불가(통과 아님).
// expected_comment = {type, line, at_sec}, line 이 해설 칸·대사 자막에 실재, 끝 3문장 장치. 해설은 음성 전용(cap.ass 엔 대사뿐).
function commentGate(mp4) {
  const plan = [path.join(path.dirname(mp4), '..', 'plan_local.json'), path.join(path.dirname(mp4), 'plan_local.json')].find((p) => fs.existsSync(p));
  if (!plan) return ['plan_local.json 이 없다 — 댓글 장치를 확인할 수 없다'];
  try {
    execFileSync('python', ['-I', '-X', 'utf8', path.join(__dirname, 'comment_hook.py'), plan, '--lane', 'rinbox'],
      { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    return [];
  } catch (e) {
    const out = String(e.stdout || '').split(/\r?\n/).filter((l) => /^\s+-\s/.test(l)).map((l) => l.trim().replace(/^-\s*/, ''));
    if (e.status === 4 && out.length) return out;
    return [`댓글 장치 검사 불가(종료 ${e.status}) — 통과 아님: ${out[0] || String(e.stderr || e.stdout || e.message).trim().split(/\r?\n/).pop()}`];
  }
}

// 대리만족 관문(2026-10-20 관리자 실측 — 10-19 큰제로 Z3 «터진 편 대리만족 문장 → 같은 감정의 다른 장면» 이 plan 에 없었다).
// plan.vicarious = {ja, ko, from} — from 은 문장을 뽑은 터진 편(rinboxNNja, 폴더가 있어야 한다). 해설 첫 줄 인사(皆さん·今日は…) 금지.
// 해부 정본: docs/rinbox-ja-vicarious-20261019.md.
const GREETING = /^(皆さん|みなさん|今日は|こんにちは|こんばんは|どうも|はい[、 ]|さて)/;
function vicariousGate(mp4) {
  const planPath = [path.join(path.dirname(mp4), '..', 'plan_local.json'), path.join(path.dirname(mp4), 'plan_local.json')].find((p) => fs.existsSync(p));
  if (!planPath) return ['plan_local.json 이 없다 — 대리만족 문장을 확인할 수 없다'];
  const p = readJson(planPath, {});
  const v = p.vicarious;
  const bad = [];
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad.push('plan.vicarious 가 {ja, ko, from} 객체가 아니다(문자열 메모는 안 된다)');
  else {
    if (!/[\u3040-\u30ff\u4e00-\u9fff]/.test(String(v.ja || ''))) bad.push('vicarious.ja 가 비었거나 일본어가 아니다');
    if (!/[\uac00-\ud7a3]/.test(String(v.ko || ''))) bad.push('vicarious.ko(한국어 뜻)가 비었다');
    if (!/^rinbox\d+ja$/.test(String(v.from || ''))) bad.push(`vicarious.from «${v.from}» — 문장을 뽑은 터진 편 id(rinboxNNja)`);
    else if (!fs.existsSync(path.join('D:/volcano-runs', v.from))) bad.push(`vicarious.from «${v.from}» 폴더가 없다`);
  }
  const first = String((((p.narration || [])[0] || {}).cards || [])[0] || '').trim();
  if (GREETING.test(first)) bad.push(`해설 첫 줄이 인사로 시작한다 «${first}» — 첫 줄은 장면으로`);
  return bad;
}

// 해설 문장 관문(2026-10-20 관리자 · devo 칼럼 docs/devo-column-rules-20261020.md) — script_audit --shorts 나오기 전 plan 검사.
// V1 첫 해설 설명형 시작 금지 · V3 마지막 해설 평가·요약 금지 · V5 해설에 숫자·시간 1개(nar4). V6 3~4초 컷은 §5 60 대기라 안 본다.
const EXPLAIN_OPEN = /^(今日は|理由は|なぜなら|実は|というのも|この(作品|ドラマ|話)は)/;
const VERDICT_END = /(やはり|やっぱり|結局|つまり|要するに)|でした[。！]?$/;
const NUM_TIME = /[0-9０-９]|[一二三四五六七八九十百千万半]+\s*(人|間|里|両|日|年|時|刻|度|本|回|つ|文|貫|歩|枚|月|分|夜|晩)/;
function narrationGate(mp4) {
  const planPath = [path.join(path.dirname(mp4), '..', 'plan_local.json'), path.join(path.dirname(mp4), 'plan_local.json')].find((p) => fs.existsSync(p));
  if (!planPath) return ['plan_local.json 이 없다 — 해설 문장을 확인할 수 없다'];
  const p = readJson(planPath, {});
  const blocks = (p.narration || []).map((n) => (n.cards || []).map((c) => String(c).trim()));
  if (!blocks.length) return ['plan.narration 이 비었다'];
  const bad = [];
  const first = blocks[0].join('');
  if (EXPLAIN_OPEN.test(first)) bad.push(`V1 첫 해설이 설명형으로 시작한다 «${first}» — 행동·의외성·궁금증으로`);
  const last = blocks[blocks.length - 1];
  for (const c of last) if (VERDICT_END.test(c)) bad.push(`V3 마지막 해설이 평가·요약형 «${c}» — 질문이나 행동으로 닫아라`);
  if (p.style === 'nar4' && !blocks.some((b) => b.some((c) => NUM_TIME.test(c)))) bad.push('V5 해설 어디에도 숫자·시간이 없다 — «三十間先»·«八時間» 식 1개');
  return bad;
}

// 이야기 beat 관문(10-20 소유주 «화면 해설이 아니라 스토리를 입혀야 된다. 창작 글쓰기» · 관리자 §7 규칙 5).
// plan.story_beats = {situation, stake, attempt, turn, ending, emotion_tail} — 공용 story_gate 이름. 값은 그 beat 의 한 줄(일본어).
// 린박스 엔진은 plan.arc(situation·conflict·turn·close)를 쓰니 arc 는 그대로 두고 이 칸을 따로 적는다.
// 공용 story_gate 가 나오면 이 검사를 그 호출로 바꾼다. 10-23(KST) 전엔 경고만, 그 뒤엔 ✗.
const STORY_BEATS = ['situation', 'stake', 'attempt', 'turn', 'ending', 'emotion_tail'];
const STORY_STRICT_FROM = Date.parse('2026-10-23T00:00:00+09:00');
function storyGate(mp4, meta) {
  const planPath = [path.join(path.dirname(mp4), '..', 'plan_local.json'), path.join(path.dirname(mp4), 'plan_local.json')].find((p) => fs.existsSync(p));
  const p = planPath ? readJson(planPath, {}) : {};
  const sb = p.story_beats && typeof p.story_beats === 'object' ? p.story_beats : {};
  const miss = STORY_BEATS.filter((k) => !String(sb[k] || '').trim());
  const out = { fail: [], warn: [] };
  const sink = Date.now() >= STORY_STRICT_FROM ? out.fail : out.warn;
  if (miss.length) sink.push(`plan.story_beats 빈 칸: ${miss.join(', ')}`);
  // 터진 29편 공통: 제목 12자 이하·한마디 결말형(장면 서술 아님). 길이만 기계로 본다 — 장면 서술인지는 사람 눈.
  const title = String((meta || {}).title || '').replace(/\s+/g, '');
  if ([...title].length > 12) out.warn.push(`제목 ${[...title].length}자 — 터진 편은 12자 이하`);
  return out;
}

// 롱투숏(work longshort-*) — 위 관문들은 린박스 plan_local.json 형식이라 롱투숏 plan.json 에선 구조상 못 돈다.
// 롱투숏 관문은 publish_ko.sh(plan_gate·title_check·tag_gate·comment_hook·comment_gate·guide·P1)가 먼저 돌린다.
// 건너뛰기가 아니라 «그쪽 관문 통과 증거 확인»(10-20 관리자): mp4 옆 gates_ok.json(publish_ko.sh 가 쓴다)
//   {at, gates:{plan,title,tag,comment,guide,p1: 'ok'}, exit:0, mp4:<전체 경로>, sha256, override:{GUIDE_OK,P1_OK}}
// 6칸 전부 'ok' · exit 0 · sha256 이 지금 mp4 와 같아야 통과(다시 렌더하면 무효). override 는 소유주 말로 켠 것이라 막지 않고 알린다.
const LONGSHORT_GATES = ['plan', 'title', 'tag', 'comment', 'guide', 'p1'];
function longshortEvidence(mp4) {
  const f = path.join(path.dirname(mp4), 'gates_ok.json');
  if (!fs.existsSync(f)) return [`롱투숏 관문 통과 기록 ${f} 이 없다 — publish_ko.sh 관문을 먼저 돌려라`];
  const g = readJson(f, {});
  const bad = [];
  if (path.resolve(String(g.mp4 || '')) !== path.resolve(mp4)) bad.push(`gates_ok.json 의 mp4 «${g.mp4}» ≠ ${mp4}`);
  if (g.sha256 !== sha256File(mp4)) bad.push('gates_ok.json 의 sha256 이 지금 mp4 와 다르다 — 다시 렌더했으면 관문을 다시 돌려라');
  if (g.exit !== 0) bad.push(`gates_ok.json exit ${g.exit}`);
  const gates = g.gates && typeof g.gates === 'object' ? g.gates : {};
  for (const k of LONGSHORT_GATES) if (gates[k] !== 'ok') bad.push(`롱투숏 관문 ${k} = ${gates[k] === undefined ? '기록 없음' : gates[k]}`);
  const ov = Object.entries(g.override || {}).filter(([, v]) => v);
  if (!bad.length && ov.length) console.log(`  ! 롱투숏 관문 소유주 예외 켜짐: ${ov.map(([k]) => k).join(', ')}`);
  return bad;
}
const isLongshort = (meta) => /^longshort-/.test(String((meta || {}).work || ''));

// 제목 관문(2026-10-20 관리자 지시 · 공용 title_check.py 055f18a, 하늘구름땅바람 10패턴) — nar4(rinbox134ja)부터.
// plan.title_pattern(10패턴 이름) 필수, 사이드카 제목을 --fail-on-warn 으로 검사. 4(경고)·5(검사 불가) 모두 승인·발행 ✗.
function titleGate(mp4, meta) {
  const planPath = [path.join(path.dirname(mp4), '..', 'plan_local.json'), path.join(path.dirname(mp4), 'plan_local.json')].find((p) => fs.existsSync(p));
  if (!planPath) return ['plan_local.json 이 없다 — 제목 패턴을 확인할 수 없다'];
  if (!String(readJson(planPath, {}).title_pattern || '').trim()) return ['plan.title_pattern(10패턴 이름)이 없다'];
  try {
    execFileSync('python', ['-I', '-X', 'utf8', path.join(__dirname, 'title_check.py'), `${mp4}.rinbox.json`, '--lane', 'rinbox',
      '--lang', meta.locale === 'ja' ? 'ja' : 'ko', '--fail-on-warn'], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    return [];
  } catch (e) {
    const out = String(e.stdout || '').split(/\r?\n/).filter((l) => /^\s+△/.test(l)).map((l) => l.trim());
    if (e.status === 4 && out.length) return out;
    return [`제목 검사 불가(종료 ${e.status}) — 통과 아님: ${out[0] || String(e.stderr || e.stdout || e.message).trim().split(/\r?\n/).pop()}`];
  }
}

// 태그 관문(2026-10-20 관리자 adoption_check · 공용 tag_gate.py 35d6266, 카이안 K6) — 제목·설명 두 줄·태그 공통 낱말 ≥2,
// 태그의 원고 일치 ≥50%. --fail-on-warn 이라 4·5 모두 승인·발행 ✗.
// 첫 3초 훅(같은 날 지시) — plan.hook={visual(0~3초 센 컷), audio(첫 소리: 원음 한마디·효과음), text(상단 문구)} 셋 다 있어야 한다.
function tagHookGate(mp4) {
  const bad = [];
  const planPath = [path.join(path.dirname(mp4), '..', 'plan_local.json'), path.join(path.dirname(mp4), 'plan_local.json')].find((p) => fs.existsSync(p));
  const hook = planPath ? readJson(planPath, {}).hook : null;
  if (!hook || typeof hook !== 'object') bad.push('plan.hook={visual, audio, text} 가 없다');
  else for (const k of ['visual', 'audio', 'text']) if (!String(hook[k] || '').trim()) bad.push(`plan.hook.${k} 가 비었다`);
  // ★10-20 관리자 판단: 린박스 설명 머리 두 줄이 고정 문구라 공통 낱말이 구조상 0 — 도구개발 rinbox 어댑터가 나올 때까지
  //   태그는 경고형(승인을 막지 않되 크게 찍는다). 어댑터 반영되면 TAG_STRICT=true 로 되돌린다. hook 세 칸은 계속 FAIL.
  const TAG_STRICT = true;   // 10-20 도구개발 어댑터 734c534 + 134ja 포장 보강으로 공통 ≥2 확인 → 다시 FAIL
  try {
    execFileSync('python', ['-I', '-X', 'utf8', path.join(__dirname, 'tag_gate.py'), `${mp4}.rinbox.json`, '--fail-on-warn'],
      { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  } catch (e) {
    const out = String(e.stdout || '').split(/\r?\n/).filter((l) => /^\s+△/.test(l)).map((l) => `태그: ${l.trim()}`);
    const lines = e.status === 4 && out.length ? out
      : [`태그 검사 불가(종료 ${e.status}): ${out[0] || String(e.stderr || e.stdout || e.message).trim().split(/\r?\n/).pop()}`];
    if (TAG_STRICT) bad.push(...lines);
    else console.log(lines.map((l) => `  ⚠ (경고형·어댑터 대기) ${l}`).join('\n'));
  }
  return bad;
}

function cmdApprove(mp4Arg, revoke) {
  const { mp4, meta } = loadTarget(mp4Arg);
  const hash = sha256File(mp4);
  const approvals = readJson(APPROVALS_PATH, {});
  const key = path.basename(mp4);
  if (revoke) {
    delete approvals[key];
    writeJson(APPROVALS_PATH, approvals);
    console.log(`승인 취소: ${key}`);
    return;
  }
  // 이름 관문(2026-10-09) — 자체 렌더 편은 plan 이 곁에 있다. 설명문까지 배역표와 대조하고, 틀리면 승인하지 않는다.
  const plan = [path.join(path.dirname(mp4), '..', 'plan_local.json'), path.join(path.dirname(mp4), 'plan_local.json')]
    .find((p) => fs.existsSync(p));
  if (plan) {
    const py = path.join(os.homedir(), '.volcano', 'venv', 'Scripts', 'python.exe');
    try {
      const out = execFileSync(py, [path.join(__dirname, 'rinbox_names.py'), plan, `${mp4}.rinbox.json`],
        { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      process.stdout.write(out);
    } catch (e) {
      process.stdout.write(String(e.stdout || ''));
      throw new Error('이름 관문에서 막혔다 — 설명·원고의 이름을 배역표와 맞춘 뒤 다시 승인');
    }
  }
  const gw = guideGate(mp4, meta);
  if (gw.length) { console.log(gw.map((l) => `  ✗ ${l}`).join('\n')); throw new Error('가이드라인 관문에서 막혔다 — 행위 낱말을 빼고 «정체·반전» 틀로 다시 쓴 뒤 승인'); }
  if (isLongshort(meta)) {
    const lw = longshortEvidence(mp4);
    if (lw.length) { console.log(lw.map((l) => `  ✗ ${l}`).join('\n')); throw new Error('롱투숏 관문 통과 기록이 없다 — publish_ko.sh 관문부터'); }
    console.log('롱투숏 관문 기록(gates_ok.json) · 통과 — 린박스 plan 관문 5개는 롱투숏에 해당 없음');
  } else {
  const cw = commentGate(mp4);
  if (cw.length) { console.log(cw.map((l) => `  ✗ 댓글 장치: ${l}`).join('\n')); throw new Error('댓글 장치 관문에서 막혔다 — 원고 끝 한 줄에 장치 문장을 넣고 plan.expected_comment={type,line,at_sec}'); }
  console.log('댓글 장치 관문 · 통과');
  const vw = vicariousGate(mp4);
  if (vw.length) { console.log(vw.map((l) => `  ✗ 대리만족: ${l}`).join('\n')); throw new Error('대리만족 관문에서 막혔다 — plan.vicarious={ja,ko,from} 를 적고 해설 첫 줄 인사를 빼라'); }
  console.log('대리만족 관문 · 통과');
  const nw = narrationGate(mp4);
  if (nw.length) { console.log(nw.map((l) => `  ✗ 해설: ${l}`).join('\n')); throw new Error('해설 문장 관문에서 막혔다 — 첫 해설은 행동으로·끝 해설은 평가 없이·nar4 는 숫자 1개'); }
  console.log('해설 문장 관문 · 통과');
  const sg = storyGate(mp4, meta);
  if (sg.warn.length) console.log(sg.warn.map((l) => `  ! 이야기: ${l}`).join('\n'));
  if (sg.fail.length) { console.log(sg.fail.map((l) => `  ✗ 이야기: ${l}`).join('\n')); throw new Error('이야기 beat 관문에서 막혔다 — plan.story_beats 여섯 칸'); }
  console.log('이야기 beat 관문 · ' + (sg.warn.length ? '경고' : '통과'));
  const tw = titleGate(mp4, meta);
  if (tw.length) { console.log(tw.map((l) => `  ✗ 제목: ${l}`).join('\n')); throw new Error('제목 관문에서 막혔다 — 10패턴 중 하나로 고치고 plan.title_pattern 을 적어라'); }
  console.log('제목 관문 · 통과');
  const hw = tagHookGate(mp4);
  if (hw.length) { console.log(hw.map((l) => `  ✗ ${l}`).join('\n')); throw new Error('태그·훅 관문에서 막혔다 — 제목·설명·태그 공통 낱말 2개·plan.hook 세 칸'); }
  console.log('태그·훅 관문 · 통과');
  }
  // 화면 검사(2026-10-09) — 렌더러가 남긴 screen.txt 가 FAIL 이면 승인하지 않는다(덧칠 글자·깜빡이는 샷 조각).
  const screen = path.join(path.dirname(mp4), 'screen.txt');
  if (plan && fs.existsSync(screen)) {
    const txt = fs.readFileSync(screen, 'utf8');
    if (/FAIL\s*$/.test(txt) && !process.argv.includes('--screen-ok')) {
      process.stdout.write(txt);
      throw new Error('화면 검사에서 막혔다 — 고쳐서 다시 렌더하거나, 눈으로 보고 괜찮으면 --screen-ok');
    }
  }
  approvals[key] = {
    approved_at: new Date().toISOString(),
    mp4_sha256: hash,                 // ★캡컷 매니페스트가 아니라 **완성본 바이트**에 묶는다
    locale: meta.locale,
    work: meta.work,
    title: meta.title
  };
  writeJson(APPROVALS_PATH, approvals);
  ledgerAppend(mp4, meta, { finished_at: approvals[key].approved_at });
  console.log(`승인: ${key}\n  mp4 sha256 ${hash}\n  ★이 파일을 다시 렌더하면 승인은 자동 무효가 된다`);
  if (!process.argv.includes('--no-frame-dup')) frameDup(mp4, meta);
}

// 화면 중복도(2026-10-19 관리자 지시, 롱투숏 frame_dup.py 를 그대로 부른다 — 복사·수정 금지).
// 첫 컷 3장을 같은 작품 검색어 2개로 모은 영상과 dHash 비교. ★경고만 — 승인·발행은 막지 않고 _gate_log 에 남긴다.
const FRAME_DUP_PY = 'D:/volcano-runs/ls_tools/frame_dup.py';
const GATE_LOG = 'D:/volcano-runs/_gate_log.jsonl';
function frameDup(mp4, meta) {
  if (!fs.existsSync(FRAME_DUP_PY)) { console.log(`  [frame_dup] 도구 없음: ${FRAME_DUP_PY}`); return; }
  const cat = readJson(path.join(ROOT, 'midform', 'config', 'rinbox_catalog.json'), { works: {} });
  const name = cat.works?.[meta.work]?.title_ja || meta.work;
  const queries = meta.locale === 'ja' ? [name, `${name} 名場面`] : [name, `${name} 명장면`];
  // ★완성본 그대로 넣으면 위아래 검은 판·제목 글자가 dHash(9x8)를 지배해 무관한 영상과 10/64가 나온다(131ja 실측 —
  //   다큐 상처 컷과 일치). 그래서 첫 15초의 그림 창(rinbox_render PIC_Y0~Y1 = 450~1470)만 잘라 넘긴다.
  const pic = mp4.replace(/\.mp4$/i, '.dup_pic.mp4');
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-t', '15', '-vf', 'crop=1080:1020:0:450', '-an', pic]);
  } catch (e) { console.log('  [frame_dup] 그림 창 자르기 실패 — 건너뜀'); return; }
  const args = ['-I', '-X', 'utf8', FRAME_DUP_PY, pic, ...queries.flatMap((q) => ['--query', q]),
    '--work', 'D:/volcano-runs/_frame_dup_vids'];
  let status = 0, out = '';
  try {
    out = execFileSync('python', args, { encoding: 'utf8', timeout: 900000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  } catch (e) { status = e.status; out = String(e.stdout || ''); if (status !== 4) { console.log(`  [frame_dup] 실행 실패(${status}) — 건너뜀`); return; } }
  console.log(`  [frame_dup] ${out.trim().split(/\r?\n/).pop()}`);
  if (status !== 4) return;
  // 우리가 자른 원본 본편(카탈로그 available_episodes)과 맞는 건 당연하다 — 경고에서 뺀다.
  const own = new Set((cat.works?.[meta.work]?.available_episodes || []).map((e) => e.videoId).filter(Boolean));
  const res = readJson(pic.replace(/\.mp4$/i, '.frame_dup.json'), { rows: [] });
  const hits = (res.rows || []).filter((r) => r.min_dist != null && r.min_dist <= (res.warn || 10) && !own.has(r.id));
  if (!hits.length) { console.log('  [frame_dup] 일치는 원본 본편뿐 — 경고 없음'); return; }
  fs.appendFileSync(GATE_LOG, `${JSON.stringify({ at: new Date().toISOString(), wd: path.basename(mp4, '.mp4'), source: 'C 린박스',
    kind: 'frame_dup', message: '첫 컷이 같은 작품 영상과 화면 지문 일치(경고만, 발행 그대로)',
    detail: { queries, hits: hits.map((r) => ({ id: r.id, min_dist: r.min_dist, our_cut: r.our_cut, their_sec: r.their_sec })) } })}\n`, 'utf8');
  console.log(`  ⚠ [frame_dup] 경고 ${hits.length}건 — ${hits.map((r) => `${r.id} ${r.min_dist}/64`).join(', ')} → _gate_log 기록, 관리자에게 한 줄`);
}

// 제작 장부(2026-10-15 소유주 지시, 관리자 매일 07:40 성과 보고) — 승인·업로드 때 한 줄씩 덧붙인다. 규격 docs/production-ledger.md.
//   lane: 사이드카 work 가 longshort-* 면 ko_longshort(A 롱투숏), 그 외는 locale(C 린박스). 마지막 줄이 이긴다.
//   started_at = 편집표(plan_local.json) 처음 만든 시각, render_secs 는 모른다(생략). --gpt N 으로 gpt-ask 횟수를 적는다.
const LEDGER_PATH = path.join(__dirname, '..', 'server', 'data', 'production_ledger.jsonl');
function ledgerAppend(mp4, meta, extra) {
  try {
    const dir = path.dirname(mp4);
    const run = path.basename(path.basename(dir) === '_render' ? path.dirname(dir) : dir);
    const isLs = /^longshort-/.test(String(meta.work || ''));
    // 롱투숏 폴더엔 plan_local.json 이 없다 — make_plan.py 를 처음 쓴 때가 그 편의 시작(A 세션 기준, 2026-10-15)
    const plan = ['plan_local.json', 'make_plan.py'].flatMap((f) => [path.join(dir, '..', f), path.join(dir, f)])
      .find((p) => fs.existsSync(p));
    const st = plan ? fs.statSync(plan) : null;
    const started = st ? new Date(Math.min(st.birthtimeMs || st.mtimeMs, st.mtimeMs)) : null;
    // 소스 준비(받기·crop·전사) 시작 표시 — 소스를 받은 폴더(첫 편)에만 있다 (관리자 장부 규격 prep_started_at, 2026-10-15)
    const prepFile = [path.join(dir, '..', 'prep_started_at.txt'), path.join(dir, 'prep_started_at.txt')].find((p) => fs.existsSync(p));
    const prep = prepFile ? new Date(fs.readFileSync(prepFile, 'utf8').trim()) : null;
    const gi = process.argv.indexOf('--gpt');
    const rec = {
      at: new Date().toISOString(),
      session: isLs ? 'A 롱투숏' : 'C 린박스',
      lane: isLs ? 'ko_longshort' : (meta.locale || ''),
      id: run.replace(/^rinbox/, ''),
      title: meta.title || '',
      ...(started ? { started_at: started.toISOString() } : {}),
      ...(prep && Number.isFinite(prep.getTime()) ? { prep_started_at: prep.toISOString() } : {}),
      gpt_calls: gi >= 0 ? Number(process.argv[gi + 1]) || 0 : 0,
      rejected: 0,
      note: String(meta.work || ''),
      ...extra
    };
    fs.appendFileSync(LEDGER_PATH, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {
    console.log(`  (장부 기록 실패: ${e.message})`);
  }
}

function cmdList() {
  const approvals = readJson(APPROVALS_PATH, {});
  const entries = Object.entries(approvals);
  if (!entries.length) { console.log('승인 대기/이력 없음'); return; }
  for (const [k, v] of entries) {
    console.log(`  ${k}  [${v.locale}] ${v.title || ''}  승인 ${v.approved_at}  ${String(v.mp4_sha256).slice(0, 12)}…`);
  }
}

// 태그 게이트(2026-10-16, 관리자 공지 — 쟁점브리핑 태그 0개 사고). 올린 직후 API 로 다시 읽어
// 0개면 사이드카 태그를 넣고 또 읽는다. 그래도 0개면 예약을 풀어 비공개로 남긴다(공개 금지).
async function tagGate(masked, videoId, tags) {
  // ★profileByPurpose 는 가린 목록(비밀값 없음)을 준다 — 그대로 쓰면 토큰을 영영 못 받는다(10-20 118 v2·134 실측).
  //   저장 파일에서 같은 id 의 원본을 읽는다(값은 찍지 않는다).
  const all = readJson(path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json'), {});
  const profile = (Array.isArray(all) ? all : (all.profiles || [])).find((p) => p.id === masked.id) || masked;
  const b = new URLSearchParams({ client_id: profile.oauthClientId, client_secret: profile.oauthClientSecret, refresh_token: profile.refreshToken, grant_type: 'refresh_token' });
  const tok = (await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: b })).json()).access_token;
  if (!tok) throw new Error('토큰을 못 받았다');
  const H = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
  const get = async () => (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${videoId}`, { headers: H })).json()).items?.[0];
  // ★갓 올린 영상은 30초 넘게 0개로 읽히거나 수정이 403 을 받는다(팬튜브 실측) — 20초 간격, 3분까지 본 뒤에만 판정한다.
  const WAIT = 20000, TRIES = 9;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let item, n = 0;
  for (let i = 0; i < TRIES; i += 1) {
    item = (await get()) || item;
    n = (item?.snippet.tags || []).length;
    if (n > 0) return { count: n, inserted: false, blocked: false };
    if (i < TRIES - 1) await sleep(WAIT);
  }
  if (!item) throw new Error(`영상이 안 읽힌다 ${videoId}`);
  if (tags.length) {
    for (let i = 0; i < TRIES; i += 1) {
      const sn = item.snippet;
      const snippet = { title: sn.title, description: sn.description, tags, categoryId: sn.categoryId, defaultLanguage: sn.defaultLanguage, defaultAudioLanguage: sn.defaultAudioLanguage };
      await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet', { method: 'PUT', headers: H, body: JSON.stringify({ id: videoId, snippet }) });
      await sleep(WAIT);
      item = (await get()) || item;
      n = (item.snippet.tags || []).length;
      if (n > 0) return { count: n, inserted: true, blocked: false };
    }
  }
  const st = { ...item.status, privacyStatus: 'private' };
  delete st.publishAt; delete st.uploadStatus; delete st.failureReason; delete st.rejectionReason;
  await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', { method: 'PUT', headers: H, body: JSON.stringify({ id: videoId, status: st }) });
  return { count: 0, inserted: Boolean(tags.length), blocked: true };
}

async function cmdPublish(mp4Arg, args) {
  const { mp4, meta } = loadTarget(mp4Arg);
  const lines = [`# rinbox-publish ${new Date().toISOString()}`, `- 파일: ${mp4}`];
  const locale = meta.locale;

  // 1. 권리 판정 — 카탈로그를 **지금** 다시 읽는다(메타에 박제된 값은 낡을 수 있다)
  const catalog = readJson(CATALOG_PATH, null);
  if (!catalog) throw new Error(`카탈로그를 못 읽었다: ${CATALOG_PATH}`);
  const work = (catalog.works || {})[meta.work];
  if (!work) throw new Error(`rinbox_catalog 에 '${meta.work}' 가 없다 — 먼저 등록해라`);
  const banned = (catalog.banned_broadcasters || []).includes(work.broadcaster);
  if (banned || work.rights_tier === 'banned') {
    throw new Error(`발행 금지: ${meta.work} (방송사 ${work.broadcaster}, tier ${work.rights_tier})`);
  }
  // ★로케일별 차단 — 권리는 나라마다 다르다. 같은 작품이 ko 에서는 멀쩡하고 ja 에서만 죽는다.
  //   2026-09-29 실측: 「닥터스」 같은 편을 ko/ja 에 같이 올렸는데 ja 만 licensedContent 매칭으로
  //   조회 4회에서 멈췄다(ko 2,847회). 그때는 이 게이트가 없어서 그대로 나갔다.
  const localeBlock = (work.locale_block || {})[meta.locale];
  if (localeBlock) {
    throw new Error(`발행 금지(${meta.locale}): ${meta.work} — ${localeBlock}`);
  }
  lines.push(`- 작품: ${work.title_ko || work.title_ja} (${work.broadcaster}, ${work.year}) tier=${work.rights_tier}`);

  // 2. 길이 — 소유주 지시로 **기록만** 한다(명화관 61초 규정은 린박스에 적용하지 않는다)
  const dur = ffprobeDurationSec(mp4);
  lines.push(`- 길이 ${dur.toFixed(2)}초 (기록만 · 린박스 서버 상한 50초)`);
  if (dur > 180) throw new Error(`숏츠 하드 한도 180초 초과: ${dur.toFixed(2)}초`);

  // 3. 동기화 감사 (Speechmatics 낱말 시각 대조)
  // ★자체 렌더 편(rinbox_render.py)은 볼케이노 완주 상태가 없다 — workdir 가 있어도 볼케이노 감사를 건너뛴다.
  //   대신 렌더러가 게이트·소리·화면·이름·재사용 관문을 이미 돌렸다(2026-10-09: workdir 를 넣었다가 발행이 막혔다).
  const selfRendered = String(meta.renderer || '').startsWith('rinbox_render.py');
  if (meta.workdir && selfRendered) {
    lines.push('- 볼케이노 동기화 감사 해당 없음 (자체 렌더 — 렌더러 관문 통과본)');
  } else if (meta.workdir) {
    const drive = readJson(path.join(meta.workdir, '.volcano_drive_state.json'), {});
    const done = drive.status === 'done' && (drive.args || {}).step === 'rinbox_finish';
    if (!done) throw new Error(`작업 폴더가 완주 상태가 아니다 (status=${drive.status}, step=${(drive.args || {}).step})`);
    const bind = bindMp4ToWorkdir(mp4, meta.workdir);
    if (!bind.ok) throw new Error(`작업 폴더 결속 실패 — ${bind.why}`);
    lines.push(`- 작업 폴더 결속 확인 (render ${bind.renderId.slice(0, 16)}…)`);
    const audit = auditSync(meta.workdir);
    if (!audit.ok) {
      lines.push(`- 동기화 감사 실패: ${audit.why || audit.bad.join(' / ')}`);
      throw new Error(`동기화 감사 실패 — ${audit.why || audit.bad.join(' / ')}`);
    }
    lines.push(`- 동기화 감사 통과 (speechmatics 낱말 ${audit.checked}개 전수 대조)`);
  } else {
    lines.push('- 동기화 감사 건너뜀 (메타에 workdir 없음)');
  }

  // 4. 검수 승인 — 완성본 바이트에 묶인다
  const approvals = readJson(APPROVALS_PATH, {});
  const approval = approvals[path.basename(mp4)];
  if (!approval) throw new Error(`검수 승인이 없다 — node scripts/rinbox-publish.js --approve "${mp4}"`);
  const hash = sha256File(mp4);
  if (approval.mp4_sha256 !== hash) {
    delete approvals[path.basename(mp4)];
    writeJson(APPROVALS_PATH, approvals);
    throw new Error('mp4 가 승인 이후 바뀌었다 — 승인을 무효화했다. 다시 보고 다시 승인해라');
  }
  lines.push(`- 검수 승인 확인 (${approval.approved_at})`);

  // 노출 안전(2026-10-12, 소유주 전자책 1장) — 막지 않는다. 위험 단어는 알리고, 폭력계 장면엔 픽션 안내문을 붙인다.
  const hits = riskOf(meta.title, meta.description);
  if (hits.length) lines.push(`- 위험 단어: ${describeHits(hits)}`);
  const description = withNote(meta.description, locale, meta.title);
  if (description !== meta.description) lines.push('- 설명란에 픽션 안내문을 붙였다');

  const gwp = guideGate(mp4, meta);
  if (gwp.length) throw new Error(`가이드라인 관문: ${gwp.join(' / ')} — 발행 중단`);
  lines.push('- 가이드라인 관문 통과');
  if (isLongshort(meta)) {
    const lwp = longshortEvidence(mp4);
    if (lwp.length) throw new Error(`롱투숏 관문 기록: ${lwp.join(' / ')} — 발행 중단`);
    lines.push('- 롱투숏 관문 기록(gates_ok.json) 통과');
  } else {
  const cwp = commentGate(mp4);
  if (cwp.length) throw new Error(`댓글 장치 관문: ${cwp.join(' / ')} — 발행 중단`);
  lines.push('- 댓글 장치 관문 통과');
  const vwp = vicariousGate(mp4);
  if (vwp.length) throw new Error(`대리만족 관문: ${vwp.join(' / ')} — 발행 중단`);
  lines.push('- 대리만족 관문 통과');
  const nwp = narrationGate(mp4);
  if (nwp.length) throw new Error(`해설 문장 관문: ${nwp.join(' / ')} — 발행 중단`);
  lines.push('- 해설 문장 관문 통과');
  const sgp = storyGate(mp4, meta);
  if (sgp.fail.length) throw new Error(`이야기 beat 관문: ${sgp.fail.join(' / ')} — 발행 중단`);
  lines.push(sgp.warn.length ? `- 이야기 beat 관문 경고: ${sgp.warn.join(' / ')}` : '- 이야기 beat 관문 통과');
  const twp = titleGate(mp4, meta);
  if (twp.length) throw new Error(`제목 관문: ${twp.join(' / ')} — 발행 중단`);
  lines.push('- 제목 관문 통과');
  const hwp = tagHookGate(mp4);
  if (hwp.length) throw new Error(`태그·훅 관문: ${hwp.join(' / ')} — 발행 중단`);
  lines.push('- 태그·훅 관문 통과');
  }
  if (!(meta.tags || []).length) throw new Error('사이드카에 tags 가 없다 — 태그 0개로는 올리지 않는다');
  const profile = profileByPurpose(PURPOSE[locale]);
  if (!profile) throw new Error(`${locale} 업로드 프로필(${PURPOSE[locale]})이 연결돼 있지 않다`);

  if (args.dryRun) {
    lines.push('- dry-run: 여기까지만');
    console.log(lines.join('\n'));
    return;
  }

  // 5. 라우드니스 — 실패해도 막지 않는다(fail-open)
  let uploadPath = mp4;
  try {
    const norm = await normalizeUploadLoudness(mp4, (m) => console.log(`  [loudness] ${m}`));
    if (norm.applied && norm.path) uploadPath = norm.path;
  } catch (e) { console.log(`  [loudness] 건너뜀: ${e.message}`); }

  // 6. 슬롯 — 명화관 기록과 합쳐서 같은 채널에 겹치지 않게 잡는다
  const publishAt = args.publishAt ? resolvePublishAt(args.publishAt)
    : nextFreeSlot(locale, Date.now(), takenSlots());

  const item = {
    filePath: uploadPath,
    originalName: path.basename(mp4),
    title: meta.title,
    description,
    tags: meta.tags || [],
    variant: VARIANT[locale],
    uploadProfileId: profile.id,
    privacyStatus: 'private',
    publishAt
  };
  const job = createUploadJob([item]);
  startUploadJob(job.jobId);
  console.log(`upload job: ${job.jobId} -> ${publishAt} [${locale}]`);
  lines.push(`- 예약 ${publishAt} [${locale}] job=${job.jobId}`);

  for (let poll = 0; poll < 240; poll += 1) {
    await new Promise((r) => setTimeout(r, 15000));
    const cur = (listUploadJobs() || []).find((e) => e.jobId === job.jobId);
    if (!cur || ['queued', 'running', 'cancelling'].includes(cur.status)) continue;
    const full = loadJob(job.jobId);
    const up = (full.items || [])[0] || {};
    let ok = up.status === 'completed' || Boolean(up.youtubeUrl);
    const vidNow = (String(up.youtubeUrl || '').match(/v=([\w-]{6,})/) || [])[1];
    if (ok && !vidNow) lines.push(`- ⚠ 태그 게이트 건너뜀: 영상 ID를 못 읽었다(${up.youtubeUrl || ''}) — 손으로 확인`);
    if (ok && vidNow) {
      try {
        const g = await tagGate(profile, vidNow, meta.tags || []);
        if (g.blocked) { ok = false; lines.push(`- ✗ 태그 게이트: 0개 — 예약을 풀고 비공개로 남겼다(${vidNow}). 관리자에게 보고`); }
        else lines.push(`- 태그 게이트: ${g.count}개${g.inserted ? ' (0개라서 넣었다)' : ''}`);
      } catch (e) { lines.push(`- ⚠ 태그 게이트 확인 실패: ${e.message} — node scripts/rinbox-publish.js 재확인 필요`); }
    }
    console.log(`RESULT ${cur.status}: ${up.youtubeUrl || up.error || up.status || ''}`);
    lines.push(`- 결과: ${ok ? 'OK' : 'FAIL'} ${up.youtubeUrl || up.error || up.status || ''}`);
    if (ok) {
      const state = readJson(STATE_PATH, {});
      state.history = [...(state.history || []), {
        at: new Date().toISOString(),
        file: path.basename(mp4),
        work: meta.work,
        locale,
        publishAt,
        url: up.youtubeUrl || ''
      }].slice(-500);
      writeJson(STATE_PATH, state);
      const ap = readJson(APPROVALS_PATH, {})[path.basename(mp4)] || {};
      const vid = (String(up.youtubeUrl || '').match(/v=([\w-]{6,})/) || [])[1];
      ledgerAppend(mp4, meta, { ...(ap.approved_at ? { finished_at: ap.approved_at } : {}), ...(vid ? { youtube_id: vid } : {}), publish_at: publishAt });
    }
    break;
  }

  lines.push('', '## 다음에 할 것 — Content ID 3층',
    `- node scripts/claim-probe.js "${mp4}" --locale ${locale} --start 0 --len ${Math.round(dur)} --wait-min 30`,
    '- node scripts/check-claims.js --all --unschedule   (공개 시각 전에)');
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const rp = path.join(REPORTS_DIR, `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-rinbox-publish.md`);
  fs.appendFileSync(rp, `${lines.join('\n')}\n\n`, 'utf8');
  console.log(`report: ${rp}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const args = { dryRun: argv.includes('--dry-run') };
  const pAt = argv.indexOf('--publish-at');
  if (pAt >= 0) args.publishAt = argv[pAt + 1];

  if (argv.includes('--list')) return cmdList();
  const ap = argv.indexOf('--approve');
  if (ap >= 0) return cmdApprove(argv[ap + 1], false);
  const rv = argv.indexOf('--revoke');
  if (rv >= 0) return cmdApprove(argv[rv + 1], true);

  const target = argv.find((a) => !a.startsWith('--') && /\.mp4$/i.test(a));
  if (!target) {
    console.log('사용법: node scripts/rinbox-publish.js <완성본.mp4> [--dry-run] [--publish-at 18:00]');
    console.log('        node scripts/rinbox-publish.js --approve <완성본.mp4>');
    console.log('        node scripts/rinbox-publish.js --list | --revoke <완성본.mp4>');
    process.exitCode = 2;
    return;
  }
  await cmdPublish(target, args);
}

main().catch((e) => { console.error('rinbox-publish:', e.message || e); process.exitCode = 1; });

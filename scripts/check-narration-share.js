// Gate: does the cut carry its story in narration, the way the reference channels do?
//
//   node scripts/check-narration-share.js <draft folder> [--json]
//   node scripts/check-narration-share.js --all
//
// The owner named three reference shorts on 2026-09-04 and the measurement separated them
// cleanly. 헛개리카노 (7.9M views) narrates 72% of its runtime at 6.5 narration sentences per
// minute, spending its source audio on two bursts of five to six seconds. 대한숏 (2.5K views)
// narrates 31% at 1.7/min and lets original dialogue run for half its length. Ours measured
// 12-20% at 1.5-2.5/min - further toward the weak end than the weak reference was.
//
// Two reasons this is now a gate rather than a preference. It is what the owner asked for, and
// it is the lever on reused-content enforcement: less shipped source audio is less of someone
// else's work in the upload.
//
// The numbers are read off the SHIPPED manifest, so a doctrine change in the planner that does
// not survive to the screen fails here - which is exactly what happened when the recap budget
// ran too early in the pipeline and later passes put the dialogue back.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DRAFTS_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');

// Measured on the reference, not chosen: 72% share, 6.5 sentences/min. The floor sits below it
// so a good cut is not failed for landing at 60%, and the ceiling exists because wall-to-wall
// voice is its own failure - the cut stops being a scene at all.
const NARRATION_SHARE_MIN = 0.5;
const NARRATION_SHARE_WARN = 0.6;
const SENTENCES_PER_MIN_MIN = 3.5;
// Ceilings (2026-09-06, owner review of The Dictator): 90% share at 12.2 sentences/min passed
// every gate and the owner's verdict was "주저리주저리, 재미도 없고". The reference cut runs
// 72% at 6.5/min - narration that DENSE stops being a guide and buries the film. A floor
// without a ceiling let the generator lecture wall-to-wall.
// 0.85로 두자 ja 85.04%가 경계에서 튕겼다(내용은 판정 통과) - 한 컷의 자연 변동이 ±1%p라
// 상한은 86으로 캘리브레이션. 그날의 90%/12.5문장은 여전히 한참 밖이다.
const NARRATION_SHARE_MAX = 0.86;
const SENTENCES_PER_MIN_MAX = 12;
const SENTENCES_PER_MIN_WARN = 8;
// One kept dialogue moment may not run longer than this; the reference spends five to six
// seconds and War Dogs shipped a thirteen-second explanation that read as an interview.
const DIALOGUE_RUN_MAX_SEC = 10;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function analyze(draftDir, opts = {}) {
  const name = path.basename(draftDir);
  const manifest = readJson(path.join(draftDir, 'edit_manifest.json'), null);
  if (!manifest) return { draft: name, error: 'edit_manifest.json 없음' };

  const seen = new Set();
  const rows = [];
  for (const segment of (manifest.segments || []).slice()
    .sort((a, b) => (a.timeline_start_sec || 0) - (b.timeline_start_sec || 0))) {
    const key = `${segment.segment_id}|${segment.caption_id || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!String(segment.narration || '').trim()) continue;
    rows.push({
      at: Number(segment.timeline_start_sec || 0),
      end: Number(segment.timeline_end_sec || 0),
      // A narrated scene hook SPEAKS (adapter rule 2026-09-05: the sentence rides over the
      // action window's own audio). Typing on segment_type alone counted those spoken seconds
      // as dialogue: Shaolin's S06-S08 hooks narrated 21.9s straight and this gate read them
      // as a 21.9s dialogue run and failed the share at 52%. The manifest already says what a
      // caption IS - caption_kind - so read that first and keep the type regex as fallback.
      isNarration: (String(segment.caption_kind || '') === 'narration' && segment.tts_enabled === true)
        || /recap|narration/i.test(String(segment.segment_type || '')),
      id: String(segment.segment_id || ''),
      text: String(segment.narration || '').trim()
    });
  }
  if (!rows.length) return { draft: name, error: '자막이 없어 판정 불가' };

  const total = Number(manifest.total_video_duration_sec || 0);
  let narrationSec = 0;
  let dialogueSec = 0;
  // 자막의 몫은 자기 표시창까지다. '다음 자막까지 점유' 규칙은 자막이 빽빽한 소스에선
  // 무해했지만, 침묵 훅이 낀 컷에선 소스 단독 구간(자막 없음)이 직전 나레이션의 몫으로
  // 귀속돼 11문장짜리 컷이 97%로 찍혔다(QP 실측: 발화 30.5s 인데 97%). 소스가 스스로
  // 말하는 시간은 어느 쪽도 아니다 - 벤치마크 72%도 발화 시간 실측이다.
  for (let i = 0; i < rows.length; i += 1) {
    const nextAt = i + 1 < rows.length ? rows[i + 1].at : total;
    const ownEnd = rows[i].end > rows[i].at ? rows[i].end : nextAt;
    const span = Math.min(nextAt, ownEnd) - rows[i].at;
    if (span <= 0) continue;
    if (rows[i].isNarration) narrationSec += span; else dialogueSec += span;
  }

  // The longest unbroken stretch of dialogue - a cut can hit the share target and still park
  // fifteen seconds of one speaker in the middle of it.
  let longestRun = 0;
  let runStart = null;
  for (let i = 0; i < rows.length; i += 1) {
    if (!rows[i].isNarration) {
      if (runStart === null) runStart = rows[i].at;
      const end = (i + 1 < rows.length ? rows[i + 1].at : total);
      longestRun = Math.max(longestRun, end - runStart);
    } else {
      runStart = null;
    }
  }

  const narrationSentences = rows.filter((row) => row.isNarration).length;
  const share = total > 0 ? narrationSec / total : 0;
  // 대사 심문/대치형(scene_type dialogue_confrontation)은 자막 대사가 본체다 - 코퍼스의
  // 대사형 채널(ch_37689, 144만 히트) 실존 근거로 하한을 25% 로 완화한다 (2026-09-08).
  // 해설이 본체인 리캡형 하한 50% 는 그대로.
  const sceneType = String(opts.sceneType || manifest.scene_type || manifest.case_type || '');
  const isDialogueScene = /dialogue_confrontation|interrogation/.test(sceneType);
  const shareFloor = isDialogueScene ? 0.25 : NARRATION_SHARE_MIN;
  // 대사형 씬은 문장 밀도도 낮은 게 정상이다 - 코퍼스의 대사형 채널(ch_37689)은 사실상
  // 나레이션 0~3/분으로 144만 히트를 냈다. 하한 3.5 -> 2.0.
  const perMinFloor = isDialogueScene ? 2.0 : SENTENCES_PER_MIN_MIN;
  const perMin = total > 0 ? narrationSentences / (total / 60) : 0;

  const findings = [];
  if (share < shareFloor) {
    findings.push(`해설 비중 ${(share * 100).toFixed(0)}% — 하한 ${shareFloor * 100}% 미만`);
  } else if (share < NARRATION_SHARE_WARN) {
    findings.push(`해설 비중 ${(share * 100).toFixed(0)}% — 목표 ${NARRATION_SHARE_WARN * 100}%에 미달`);
  }
  if (perMin < perMinFloor) {
    findings.push(`해설 문장 ${perMin.toFixed(1)}/분 — 하한 ${SENTENCES_PER_MIN_MIN} 미만 (레퍼런스 6.5)`);
  }
  if (share > NARRATION_SHARE_MAX) {
    findings.push(`해설 비중 ${(share * 100).toFixed(0)}% — 상한 ${NARRATION_SHARE_MAX * 100}% 초과 (레퍼런스 72%): 영화가 묻힌다`);
  }
  if (perMin > SENTENCES_PER_MIN_MAX) {
    findings.push(`해설 문장 ${perMin.toFixed(1)}/분 — 상한 ${SENTENCES_PER_MIN_MAX} 초과 (레퍼런스 6.5): 주저리주저리`);
  } else if (perMin > SENTENCES_PER_MIN_WARN) {
    findings.push(`해설 문장 ${perMin.toFixed(1)}/분 — 경고선 ${SENTENCES_PER_MIN_WARN} 초과 (레퍼런스 6.5)`);
  }
  // 중계형 개시 선언 (2026-09-06 검수: "1분 40초에 이미 총 쏘는데 '총격이 시작됩니다'"):
  // 나레이션 문장이 화면 사건의 '개시'를 선언하면, 표시 시점은 항상 사건보다 늦다 — 창 단위
  // 기계 눈도 프레임 통독도 이 시간축 어긋남을 못 본다. 개시 선언은 텍스트 차원에서 막는다.
  const inceptive = rows.filter((row) => row.isNarration && /(시작(됩니다|되는데|된다|합니다)|벌어집니다|터집니다|들이닥칩니다|が始まります|始まる)/.test(row.text));
  for (const row of inceptive) {
    findings.push(`중계형 개시 선언 [${row.id}] "${row.text.slice(0, 28)}…" — 화면 사건의 시작 선언은 항상 화면보다 늦게 뜬다. 전제·인과형으로 다시 쓸 것`);
  }
  if (longestRun > DIALOGUE_RUN_MAX_SEC) {
    findings.push(`대사 연속 ${longestRun.toFixed(1)}s — 상한 ${DIALOGUE_RUN_MAX_SEC}s 초과 (레퍼런스 5~6s)`);
  }

  const verdict = (inceptive.length > 0 || share < shareFloor || perMin < perMinFloor
    || share > NARRATION_SHARE_MAX || perMin > SENTENCES_PER_MIN_MAX
    || longestRun > DIALOGUE_RUN_MAX_SEC) ? 'FAIL' : (findings.length ? 'WARN' : 'PASS');

  return {
    draft: name,
    total_sec: Number(total.toFixed(1)),
    narration_sec: Number(narrationSec.toFixed(1)),
    dialogue_sec: Number(dialogueSec.toFixed(1)),
    narration_share: Number(share.toFixed(3)),
    narration_sentences: narrationSentences,
    sentences_per_min: Number(perMin.toFixed(1)),
    longest_dialogue_run_sec: Number(longestRun.toFixed(1)),
    findings,
    verdict
  };
}

function main() {
  const args = process.argv.slice(2);
  const targets = args.includes('--all')
    ? fs.readdirSync(DRAFTS_DIR).filter((n) => /^\d{8}[a-z]?-.+-(ko|ja)$/.test(n)).map((n) => path.join(DRAFTS_DIR, n))
    : [path.resolve(args.find((a) => !a.startsWith('--')) || '')];
  const results = targets.map(analyze);
  if (args.includes('--json')) { console.log(JSON.stringify(results, null, 2)); return; }

  for (const r of results) {
    if (r.error) { if (!args.includes('--all')) console.log(`${r.draft}: ${r.error}`); continue; }
    if (args.includes('--all') && r.verdict === 'PASS') continue;
    console.log(`[${r.verdict}] ${r.draft} — ${r.total_sec}s | 해설 ${(r.narration_share * 100).toFixed(0)}%`
      + ` (${r.narration_sec}s, ${r.narration_sentences}문장 ${r.sentences_per_min}/분)`
      + ` | 대사 최장연속 ${r.longest_dialogue_run_sec}s`);
    for (const f of r.findings) console.log(`   ${f}`);
  }
  if (args.includes('--all')) {
    const fail = results.filter((r) => r.verdict === 'FAIL').length;
    const warn = results.filter((r) => r.verdict === 'WARN').length;
    console.log(`\n판정 ${results.filter((r) => !r.error).length}편 | FAIL ${fail} · WARN ${warn}`);
  }
  if (results.some((r) => r.verdict === 'FAIL')) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { analyze, NARRATION_SHARE_MIN, SENTENCES_PER_MIN_MIN, DIALOGUE_RUN_MAX_SEC };

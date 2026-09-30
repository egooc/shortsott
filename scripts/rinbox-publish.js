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

const CATALOG_PATH = path.join(ROOT, 'midform', 'config', 'rinbox_catalog.json');
const APPROVALS_PATH = path.join(ROOT, 'server', 'data', 'rinbox_approvals.json');
const STATE_PATH = path.join(ROOT, 'server', 'data', 'rinbox_publish_state.json');
const REPORTS_DIR = path.join(ROOT, 'server', 'output', 'rinbox-publish-reports');

// 슬롯 — 소유주 지시 2026-09-28: 명화관 08:00·12:00·18:00 의 **30분 뒤**에 린박스를 올린다.
// 채널을 공유하므로 같은 시각에 두 편이 공개되면 서로 잡아먹는다. 30분을 띄워 둔 이유가 그것이다.
// (그래서 명화관 슬롯과는 애초에 겹치지 않지만, 린박스끼리의 중복은 여전히 막아야 해서
//  takenSlots 는 양쪽 기록을 다 본다.)
const SLOT_TIMES_UTC9 = [[8, 30], [12, 30], [18, 30]];
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
  approvals[key] = {
    approved_at: new Date().toISOString(),
    mp4_sha256: hash,                 // ★캡컷 매니페스트가 아니라 **완성본 바이트**에 묶는다
    locale: meta.locale,
    work: meta.work,
    title: meta.title
  };
  writeJson(APPROVALS_PATH, approvals);
  console.log(`승인: ${key}\n  mp4 sha256 ${hash}\n  ★이 파일을 다시 렌더하면 승인은 자동 무효가 된다`);
}

function cmdList() {
  const approvals = readJson(APPROVALS_PATH, {});
  const entries = Object.entries(approvals);
  if (!entries.length) { console.log('승인 대기/이력 없음'); return; }
  for (const [k, v] of entries) {
    console.log(`  ${k}  [${v.locale}] ${v.title || ''}  승인 ${v.approved_at}  ${String(v.mp4_sha256).slice(0, 12)}…`);
  }
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
  if (meta.workdir) {
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
    description: meta.description,
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
    const ok = up.status === 'completed' || Boolean(up.youtubeUrl);
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

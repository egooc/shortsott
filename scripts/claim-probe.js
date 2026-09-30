// Content ID preflight, layer 0 — BEFORE any editing/TTS/ASR is spent on a source.
//
//   node scripts/claim-probe.js --recheck                       (re-read every probe still on file)
//   node scripts/claim-probe.js <source.mp4 | volcano workdir> --locale ja|ko [--movie-key <catalog key>]
//                               [--start <sec>] [--len 150] [--wait-min 30] [--poll-sec 120] [--keep] [--middle]
//
//   ★**--plan <edit_ko.json>** 이 가장 좋은 자리다 — 서버에 제출하기 «전»이라 TTS 를 안 태운다.
//     제출한 뒤라면 워크디렉토리만 줘도 timeline.json 을 읽어 올릴 그림 그대로를 검사한다(그때는
//     TTS 가 이미 나갔다). --middle 은 옛 방식(소스 한가운데 한 덩어리)으로 되돌리는 탈출구다.
//
// There is no API that asks Content ID "will this be claimed?". What does exist: a private upload is
// scanned within minutes, and a claim whose policy blocks shows up in videos.list as
// contentDetails.regionRestriction.blocked (worldwide = every country listed). Measured 2026-09-01 (New Moon),
// 2026-09-18 (No Country ja: blocked 18 min after upload; Sherlock ko+ja: blocked, published unnoticed).
//
// So: cut a ~150s slice of the source (same length class as a finished 명화관 cut, because the owner's
// block rule is "matched length exceeds the limit they set"), upload it PRIVATE with no publishAt, poll
// until a block appears or the wait runs out, then report and record. The probe is left private (deleting
// needs youtube.force-ssl; run scripts/yt-reauth.js once and pass --delete later) unless the token allows it.
//
// Verdict: BLOCKED (do not produce from this source) / CLEAR-<n>min (no block within the window — not a
// guarantee, claims can land later, so check-claims still runs after the real upload and before publish).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const scheduleProbe = process.argv.includes('--schedule');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const LEDGER = path.join(ROOT, 'server', 'data', 'claim_probes.json');
const CATALOG = path.join(ROOT, 'midform', 'config', 'movie_catalog.json');

function arg(name, fallback) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }

async function accessToken(profile) {
  const body = new URLSearchParams({ client_id: profile.oauthClientId, client_secret: profile.oauthClientSecret,
    refresh_token: profile.refreshToken, grant_type: 'refresh_token' });
  const data = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body })).json();
  if (!data.access_token) throw new Error(`token refresh failed: ${JSON.stringify(data).slice(0, 140)}`);
  return data.access_token;
}

function probeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number(r.stdout.trim()) || 0;
}

// 편집표가 고른 «실제로 화면에 나올 구간»을 그대로 잘라 붙인다.
//
// ★2026-09-22: 프로브 대장 14건을 열어 보니 CLEAR 13건 중 5건이 나중에 차단됐다(38%).
//   우리 차단율 37% 와 같다 — 즉 **동전 던지기와 성능이 같았다.**
//   원인: 프로브는 소스 «한가운데 150초 한 덩어리»를 검사하는데, 완성본은 영화 여기저기서
//   고른 세 장면을 이어 붙인 것이다. **검사한 필름과 올린 필름이 달랐다.**
//   그래서 timeline.json 의 picture_in/out 을 읽어 올릴 그림 그대로를 검사한다.
//
// 언제 도느냐도 같이 바뀐다: 제작 «전»이 아니라 **편집표가 확정된 직후**다.
//   실측(헐크): timeline.json 12:55:01 → master.wav(TTS) 13:00:38. 5분 반의 창이 있다.
//   여기서 막히면 ASR 은 이미 썼지만 **TTS 크레딧과 렌더 시간은 안 날린다.**
function editSegments(workdir) {
  const payload = readJson(path.join(workdir, 'next_payload.json'), null);
  if (!payload) return null;
  const rinbox = payload.rinbox || {};
  const timelinePath = rinbox.timeline_path;
  if (!timelinePath || !fs.existsSync(timelinePath)) return null;
  const clips = (readJson(timelinePath, {}) || {}).clips || [];
  if (!clips.length) return null;

  // picture_in/out 이 «화면에 실제로 나오는» 구간이다. 내레이션 컷(kind N)은
  // source_in 이 다음 컷 머리를 가리키므로 picture 쪽을 봐야 맞다.
  const raw = [];
  for (const c of clips) {
    let a = Number(c.picture_in);
    let b = Number(c.picture_out);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) {
      a = Number(c.source_in);
      b = a + Number(c.duration);
    }
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) raw.push([a, b]);
  }
  if (!raw.length) return null;

  // 붙어 있는 구간은 합친다 — 컷 경계마다 자르면 이음새만 늘고 지문은 그대로다.
  raw.sort((x, y) => x[0] - y[0]);
  const merged = [raw[0].slice()];
  for (const [a, b] of raw.slice(1)) {
    const last = merged[merged.length - 1];
    if (a - last[1] <= 0.25) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const source = rinbox.source && fs.existsSync(rinbox.source) ? rinbox.source : null;
  return source ? { source, segments: merged } : null;
}

// 워크디렉토리의 소스 파일을 찾는다. 예전 런은 volcano_src.mp4 를 폴더 안에 복사해 두지만,
// local_video 로 시작한 런(우주전쟁 2026-09-23)은 원본을 그 자리에서 쓴다 — 그때는 상태 파일이
// 유일한 단서다. 여기서 안 찾으면 프로브가 통째로 안 돌아 3.7 이 건너뛰어진다.
function workdirSource(dir) {
  const copied = ['volcano_src.orig.mp4', 'volcano_src.mp4']
    .map((n) => path.join(dir, n)).find((f) => fs.existsSync(f));
  if (copied) return copied;
  const state = readJson(path.join(dir, '.volcano_drive_state.json'), null);
  const payload = state && state.args && state.args.payload;
  for (const cand of [payload && payload.source, payload && payload.rinbox && payload.rinbox.source,
                      payload && payload.source_request && payload.source_request.path]) {
    if (typeof cand === 'string' && fs.existsSync(cand)) return cand;
  }
  return null;
}

// 우리가 «직접 쓴» 편집안에서 구간을 읽는다 — 서버에 제출하기 «전»이다.
//
// ★2026-09-23 정정. 어제 나는 "편집표(timeline.json) 확정 뒤 TTS 전에 5분 반의 창이 있다"고
//   적었는데 **틀렸다.** 편집 폴더의 master.wav(렌더 중 만들어지는 믹스)를 보고 판단했다.
//   실제 «유료» 산출물은 paid/<해시>/narration.wav 이고, 실측하면 편집표보다 **앞선다**:
//       koh   narration.wav 15:58:12 → timeline.json 15:58:27   (15초 앞)
//       hulk  narration.wav 03:38:00 → timeline.json 03:55:01   (17분 앞)
//   서버는 편집안을 받는 그 호출에서 내레이션 TTS 를 돌린다. **제출하면 이미 샀다.**
//
//   그래서 진짜 창은 한 칸 앞이다 — **우리가 edit_*.json 을 쓰고 아직 제출하지 않은 동안**.
//   그 파일에 컷별 source_in/source_out 이 다 들어 있다(실측: koh 24컷).
//   여기서 프로브를 돌리고 CLEAR 를 받은 뒤에 제출하면 **TTS 를 안 태우고 거를 수 있다.**
//   (ASR 은 그전에 이미 샀다 — 단어가 있어야 컷을 짤 수 있으니 그건 어쩔 수 없다.)
function planSegments(planPath, workdir) {
  const plan = readJson(planPath, null);
  if (!plan) return null;
  const seq = plan.sequence || plan.cuts || [];
  const raw = [];
  for (const c of seq) {
    const a = Number(c.source_in);
    const b = Number(c.source_out);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) raw.push([a, b]);
  }
  if (!raw.length) return null;
  raw.sort((x, y) => x[0] - y[0]);
  const merged = [raw[0].slice()];
  for (const [a, b] of raw.slice(1)) {
    const last = merged[merged.length - 1];
    if (a - last[1] <= 0.25) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const base = workdir || path.dirname(planPath);
  const source = workdirSource(base);
  return source ? { source, segments: merged } : null;
}

function cutFromEdit(source, segments, out) {
  const dir = path.dirname(out);
  // ★조각 이름은 실행마다 달라야 한다 — ko/ja 프로브를 나란히 돌리면 같은 %TEMP% 에서
  //   probe-part-0.mp4 를 서로 덮어써 둘 다 concat 에서 죽는다(2026-09-23 우주전쟁에서 실측).
  const tag = `${process.pid}-${Date.now().toString(36)}`;
  const parts = [];
  segments.forEach(([a, b], i) => {
    const piece = path.join(dir, `probe-part-${tag}-${i}.mp4`);
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-ss', a.toFixed(6), '-i', source, '-t', (b - a).toFixed(6),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', piece], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg segment failed: ${r.stderr.slice(0, 300)}`);
    parts.push(piece);
  });
  const listfile = path.join(dir, `probe-parts-${tag}.txt`);
  fs.writeFileSync(listfile, parts.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
  // ★반드시 재인코딩 — -c copy 는 타임스탬프가 어긋난다(사례 67)
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listfile,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', out], { encoding: 'utf8' });
  for (const f of [...parts, listfile]) { try { fs.unlinkSync(f); } catch { /* 남아도 그만 */ } }
  if (r.status !== 0) throw new Error(`ffmpeg concat failed: ${r.stderr.slice(0, 300)}`);
}

function cutSlice(src, start, len, out) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-i', src, '-t', String(len),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg slice failed: ${r.stderr.slice(0, 300)}`);
}

async function upload(token, file, title) {
  const size = fs.statSync(file).size;
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/mp4' },
    body: JSON.stringify({ snippet: { title, description: 'content id probe — private, not for publication', categoryId: '1' },
      // ★--schedule 을 주면 «공개 예약»을 걸어 올린다 (2026-09-23 실험).
      //   프로브는 publishAt 없이 비공개로 올리는데 실제 업로드는 예약이 걸려 있다.
      //   그 차이가 프로브의 46% 오판을 설명하는지 보려고 둔 손잡이다.
      //   예약 시각은 사흘 뒤 — 어차피 판정만 보고 지운다.
      status: scheduleProbe
        ? { privacyStatus: 'private', selfDeclaredMadeForKids: false,
          publishAt: new Date(Date.now() + 3 * 864e5).toISOString() }
        : { privacyStatus: 'private', selfDeclaredMadeForKids: false } })
  });
  if (!init.ok) throw new Error(`upload session ${init.status}: ${(await init.text()).slice(0, 200)}`);
  const put = await fetch(init.headers.get('location'), { method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Length': String(size), 'Content-Type': 'video/mp4' }, body: fs.readFileSync(file) });
  const data = await put.json();
  if (!put.ok || !data.id) throw new Error(`upload failed ${put.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data.id;
}

async function blockState(token, id) {
  const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status,contentDetails&id=${id}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await r.json();
  const item = (data.items || [])[0] || {};
  const blocked = ((item.contentDetails || {}).regionRestriction || {}).blocked || [];
  // ★regionRestriction 하나만 보면 놓친다 (2026-09-29 실측).
  //   같은 날 같은 소스로 올린 ko/ja 한 쌍에서 ja 만 licensedContent=true 로 잡혔고 조회수가 4 에서
  //   멈췄다(ko 는 licensedContent=false · 2,847회). regionRestriction 은 **양쪽 다 비어 있었다**.
  //   소유권이 매칭됐다는 뜻이므로, 차단 국가가 안 적혀도 그 소재는 쓰면 안 된다.
  const licensed = ((item.contentDetails || {}).licensedContent === true);
  return { blocked: blocked.length > 0, licensed,
           countries: blocked.length, worldwide: blocked.length >= 200,
           // ★어느 나라가 막혔는지 남긴다 — 일본이 포함되면 ja 채널에서는 죽은 소재다.
           //   갯수만 세면 「2개국 차단」이 우리에게 치명적인지 무해한지 알 수 없다.
           blockedList: blocked.slice(0, 40),
           uploadStatus: (item.status || {}).uploadStatus || '' };
}

async function tryDelete(token, id) {
  const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  return r.status === 204;
}

async function recheck() {
  // Re-read every probe still on file (they stay private). A CLEAR verdict is only "not yet"; Sherlock's raw
  // slice was still clear 30 min in while its two published cuts were already blocked worldwide (2026-09-18).
  const ledger = readJson(LEDGER, { probes: [] }); const store = readJson(PROFILES, { profiles: [] });
  for (const p of ledger.probes) {
    if (p.deleted) continue;
    const profile = (store.profiles || []).find((x) => x.purpose === (p.locale === 'ko' ? 'ko_highlight' : 'jp_highlight'));
    const st = await blockState(await accessToken(profile), p.videoId);
    const age = Math.round((Date.now() - Date.parse(p.at)) / 60000);
    const verdict = st.blocked ? (st.worldwide ? 'BLOCKED-WORLDWIDE' : `BLOCKED-${st.countries}`)
      : st.licensed ? 'MATCHED-licensedContent' : `CLEAR-${age}min`;
    const changed = verdict.startsWith('BLOCKED') !== String(p.verdict).startsWith('BLOCKED');
    p.verdict = verdict; p.recheckedAt = new Date().toISOString();
    console.log(`[recheck] ${p.movieKey || p.source} [${p.locale}] ${p.videoId} +${age}min -> ${verdict}${changed ? '  ** CHANGED' : ''}`);
    if ((st.blocked || st.licensed) && p.movieKey) {
      const cat = readJson(CATALOG, null);
      if (cat && cat.movies[p.movieKey]) { const m = cat.movies[p.movieKey]; m.distributor_tier = 'banned'; m.claim_probe = `${new Date().toISOString().slice(0, 10)} ${p.locale} ${verdict} (+${age}min)`; fs.writeFileSync(CATALOG, JSON.stringify(cat, null, 2)); }
    }
  }
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
}

async function main() {
  if (process.argv[2] === '--recheck') return recheck();
  const target = process.argv[2];
  if (!target) throw new Error('usage: node scripts/claim-probe.js <source.mp4|workdir> --locale ja|ko [--movie-key k] [--start s] [--len 150] [--wait-min 30]');
  const locale = arg('--locale', 'ja'); const movieKey = arg('--movie-key', '');
  // ★기다리는 창을 30분 → 150분으로 늘렸다 (2026-09-23 실측).
  //   업로드 → 차단까지 걸린 시간을 15편에서 재니 **20분 안에 잡힌 것은 4편뿐**이고
  //   중앙값이 116분이었다(헐크는 1.9시간). 30분 창으로는 구조적으로 못 잡는다 —
  //   프로브가 46% 를 놓친 진짜 이유가 이것이다. 소스도 publishAt 도 장면도 아니었다.
  //   ★그래도 «놓칠 수 있다»는 전제는 그대로다. 3층(업로드 뒤 check-claims)이 여전히
  //   유일하게 믿을 수 있는 층이다(사례 91·100).
  const len = Number(arg('--len', '150')); const waitMin = Number(arg('--wait-min', '150')); const pollSec = Number(arg('--poll-sec', '120'));
  let src = target;
  if (fs.statSync(target).isDirectory()) {
    src = workdirSource(target);
    if (!src) throw new Error(`no source for ${target} — volcano_src.mp4 도 상태파일의 source 도 없다`);
  }
  // 편집표가 있으면 그것으로 자른다. --middle 을 주면 옛 방식(한가운데 한 덩어리)으로 돌아간다.
  let plan = null;
  const planPath = arg('--plan', '');
  if (planPath) {
    // ★제출 전 편집안. 여기서 걸러야 TTS 를 안 태운다.
    plan = planSegments(planPath, fs.statSync(target).isDirectory() ? target : path.dirname(target));
    if (!plan) console.log(`[probe] ${planPath} 에서 구간을 못 읽었다`);
  }
  if (!plan && !process.argv.includes('--middle') && fs.statSync(target).isDirectory()) {
    plan = editSegments(target);
    if (!plan) console.log('[probe] 편집표를 못 읽었다 — 한가운데 구간으로 내려간다');
  }
  const dur = probeDuration(src);
  const start = Number(arg('--start', String(Math.max(0, Math.round((dur - len) / 2)))));
  const store = readJson(PROFILES, { profiles: [] });
  const profile = (store.profiles || []).find((p) => p.purpose === (locale === 'ko' ? 'ko_highlight' : 'jp_highlight'));
  if (!profile) throw new Error(`no upload profile for ${locale}`);

  const tmp = path.join(require('os').tmpdir(), `claim-probe-${process.pid}-${Date.now()}.mp4`);
  let mode = 'middle';
  let span = `${start}s+${len}s`;
  if (plan) {
    cutFromEdit(plan.source, plan.segments, tmp);
    mode = planPath ? 'plan' : 'edit';
    const total = plan.segments.reduce((a, [x, y]) => a + (y - x), 0);
    span = `${plan.segments.length}구간 ${total.toFixed(0)}s`;
    console.log(`[probe] 편집표 구간으로 검사한다 — ${span} (올릴 그림 그대로)`);
  } else {
    cutSlice(src, start, Math.min(len, dur - start), tmp);
  }
  // 올리기 전에 «무엇을 검사하는지» 눈으로 볼 수 있어야 한다. 업로드는 되돌릴 수 없다.
  if (process.argv.includes('--dry')) {
    const out = arg('--dry-out', path.join(process.cwd(), 'probe-preview.mp4'));
    fs.copyFileSync(tmp, out);
    fs.unlinkSync(tmp);
    console.log(`[probe] --dry: 올리지 않았다. 검사할 필름 ${span} (${mode}) -> ${out}`);
    return;
  }
  const token = await accessToken(profile);
  const label = movieKey || path.basename(path.dirname(src) === '.' ? src : path.dirname(src));
  const title = `probe ${label} ${new Date().toISOString().slice(0, 16)}`;
  const id = await upload(token, tmp, title);
  fs.unlinkSync(tmp);
  console.log(`[probe] ${label} [${locale}] ${span} (${mode}) -> https://www.youtube.com/watch?v=${id} (private) — polling ${waitMin} min`);

  // ★장부는 «업로드 직후»에 적는다 (2026-09-24).
  //   전에는 폴링 루프가 끝난 뒤에 한 번만 적었다. 창을 30분 → 150분 으로 늘린 뒤로(사례 106)
  //   그 사이에 프로세스가 죽으면 비공개 업로드는 남는데 장부에 흔적이 없어 --recheck 로도 못 찾았다.
  //   «오래 기다릴수록 잃기 쉬운» 모양이었다 — 창을 늘린 변경과 정확히 반대 방향이다.
  //   이제 PENDING 으로 먼저 박고 매 바퀴 갱신하므로, 어디서 끊겨도 다음 회차가 이어받는다.
  const uploadedAt = new Date().toISOString();
  const saveLedger = (verdict, minutes, deleted) => {
    const ledger = readJson(LEDGER, { probes: [] });
    const row = ledger.probes.find((p) => p.videoId === id);
    const next = { at: uploadedAt, locale, movieKey, source: src, start, len, mode, span, videoId: id, verdict, minutes, deleted };
    if (row) Object.assign(row, next); else ledger.probes.push(next);
    fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
  };
  saveLedger('PENDING', 0, false);

  // ★판정은 두 신호를 본다 — blocked 하나만 보면 놓친다(2026-09-29 실측, 메모리 참조).
  //   같은 소스로 올린 ko/ja 한 쌍에서 ja 만 licensedContent=true 였고 조회수가 4 에서 멈췄는데
  //   regionRestriction 은 양쪽 다 비어 있었다. 소유권 매칭도 그 소재를 쓰면 안 된다는 뜻이다.
  const bad = (st) => st.blocked || st.licensed;
  const t0 = Date.now(); let state = { blocked: false, licensed: false }; let minutes = 0;
  while (Date.now() - t0 < waitMin * 60 * 1000) {
    await new Promise((r) => setTimeout(r, pollSec * 1000));
    state = await blockState(await accessToken(profile), id);
    minutes = Math.round((Date.now() - t0) / 60000);
    console.log(`[probe] +${minutes}min upload=${state.uploadStatus} blocked=${state.blocked} licensed=${state.licensed}${state.blocked ? ` (${state.countries}개국${state.worldwide ? ' 전세계' : ''}: ${(state.blockedList || []).join(',')})` : ''}`);
    saveLedger(bad(state) ? 'PENDING-BAD' : `PENDING-${minutes}min`, minutes, false);
    if (bad(state)) break;
  }
  const verdict = state.blocked ? (state.worldwide ? 'BLOCKED-WORLDWIDE' : `BLOCKED-${state.countries}`)
    : state.licensed ? `MATCHED-licensedContent-${minutes}min` : `CLEAR-${minutes}min`;
  let deleted = false;
  if (!process.argv.includes('--keep')) deleted = await tryDelete(await accessToken(profile), id).catch(() => false);

  saveLedger(verdict, minutes, deleted);
  if (movieKey) {
    const cat = readJson(CATALOG, null);
    if (cat && cat.movies && cat.movies[movieKey]) {
      const m = cat.movies[movieKey];
      m.claim_probe = `${new Date().toISOString().slice(0, 10)} ${locale} ${span} (${mode}) ${verdict}`;
      if (state.blocked || state.licensed) { m.distributor_tier = 'banned'; m.note = `${m.note ? m.note + ' | ' : ''}claim-probe ${verdict} ${new Date().toISOString().slice(0, 10)}`; }
      fs.writeFileSync(CATALOG, JSON.stringify(cat, null, 2));
    }
  }
  console.log(`[probe] VERDICT ${verdict} | probe video ${deleted ? 'deleted' : 'left private (delete needs youtube.force-ssl)'}${movieKey ? ` | catalog ${movieKey} updated` : ''}`);
  process.exit((state.blocked || state.licensed) ? 2 : 0);
}

main().catch((e) => { console.error(`[probe] ${e.message}`); process.exit(1); });

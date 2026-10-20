// 공개 뒤 조회 사후 점검(관리자·소유주 10-17): 공개 +3h·+6h 조회가 전날 편 같은 시점의 절반 미만이면 제목·태그·썸네일부터 다시 쓴다(재업로드 금지).
//
//   node politics-hour/views_check.js <videoId> <시간 3|6>                 지금 조회를 기록하고 직전 편 같은 시점과 비교
//   node politics-hour/views_check.js <videoId> --schedule <publishAt ISO> [--short]   (쇼츠는 +6h 한 번, 조회 0이면 비공개)
//   node politics-hour/views_check.js <videoId> --schedule <publishAt ISO>   +3h·+6h·+24h 에 위 점검이 돌게 Windows 작업 스케줄러에 1회성 작업 3개 등록
//
// ★Data API 는 «지금» 조회만 준다 — 전날 같은 시점 값은 이 스크립트가 날마다 남긴 기록(server/data/politics_views.jsonl)에서 찾는다.
// 미달이면 server/data/politics_alerts.jsonl 에 한 줄 남기고 exit 4 — 관리자 보고는 이 줄을 보고 한다(스케줄 작업은 세션에 말을 못 건다).
//
// ★자동 포장 교체(10-18 소유주 «성과가 아예 없으면 썸네일·키워드를 자동으로 바꿔 줘야»): 롱폼이 미달이면
//   에피소드 폴더의 packages.json 에서 아직 안 쓴 다음 포장(제목+썸네일)을 그 자리에서 API 로 갈아 끼운다(재업로드 아님).
//   미달 = 바닥값(FLOOR) 미만 또는 직전 편 같은 시점의 절반 미만. 포장이 다 떨어지면 알림만. --no-repack 이면 교체 안 함.
//   packages.json: {"video_id": "...", "packages": [{"title", "thumbnail", "style"}, ...], "applied": [{"idx", "at", "h", "views"}]}
//   포장마다 선택 칸(관리자 10-18 «제목·키워드·해시태그도 함께»): "tags": [...](통째 교체), "desc_head": ["줄1","줄2"](설명 첫 두 줄), "hashtags": ["#…"](해시태그 줄 교체). 없으면 지금 값 유지.
//   1주(+168h) 뒤에도 끝내지 않는다: `<id> auto` 가 매일 07:00 돌고(공개 뒤 날수×24h, 바닥은 168h 값), 교체는 주 1회. 다 돌면 «새 포장 후보 필요» 알림.
//   packages[0] 은 업로드 때 포장(기록용) — 교체는 1번부터. 키워드(keywords.json 1~2위)는 대체 제목에도 남긴다.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { OAuth2Client } = require(path.join(__dirname, '..', 'node_modules', 'google-auth-library'));

const DATA = path.join(__dirname, '..', 'server', 'data');
const LOG = path.join(DATA, 'politics_views.jsonl');
const ALERT = path.join(DATA, 'politics_alerts.jsonl');
const append = (f, o) => fs.appendFileSync(f, JSON.stringify(o) + '\n', 'utf8');
const HOURS = [4, 8, 12, 24, 48, 72, 96, 120, 144, 168];   // 첫날 4시간마다(새 영상 노출이 몰리는 때), 그 뒤 하루 한 번 1주 — 안 나오면 계속 돌린다(10-18 소유주)
const FLOOR_SCALE = { politics_ja: 0.5 };   // 채널별 바닥 배율 — JA 는 ko 의 절반(관리자 10-18, JA 사본 값)
// 공개 뒤 조회 0인 롱폼: 교체 보류 채널(지금은 없음). 관리자 10-18 통일 — 롱폼은 «키워드·태그가 문제»(10/18 교체 70분 만에 0→72)라 0이어도 교체 + alerts 에 가이드 의심 경고. 피드 0 = 가이드 비공개는 쇼츠(+6h)만.
const ZERO_HOLD = new Set([]);
const FLOOR = { 3: 20, 6: 40, 4: 25, 8: 50, 12: 70, 24: 100, 48: 200, 72: 300, 96: 350, 120: 400, 144: 450, 168: 500 };   // 롱폼 «아예 안 받는» 선 — 10/15 2,663회·10/17 +6h 19회 실측 기준, 데이터 쌓이면 조정

async function auth(purpose = 'politics') {   // 채널 = packages.json 의 purpose(다른 롱폼 레인, 도구개발 10-18)
  const store = JSON.parse(fs.readFileSync(path.join(DATA, 'youtube_upload_profiles.json'), 'utf8'));
  const p = store.profiles.find((x) => x.purpose === purpose);
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  return { Authorization: `Bearer ${(await c.getAccessToken()).token}` };
}

const ROOTS = [path.join(__dirname, 'episodes'), ...['ja-nenkin', 'ko-truecrime', 'biz-rise-fall', 'politics-hour-ja/episodes'].map((d) => path.join(__dirname, '..', d))];   // 각 레인 <레인>/<ep>/packages.json
function packagesPath(videoId) {
  return ROOTS.filter((r) => fs.existsSync(r)).flatMap((r) => fs.readdirSync(r).map((d) => path.join(r, d, 'packages.json')))
    .find((f) => fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')).video_id === videoId);
}
const findPackages = (videoId) => { const f = packagesPath(videoId); return f ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };

// 점검 때 그 편 키워드가 아직 오르는지(관리자 10-19 «공개 시점 상승 지속 여부») — 같은 폴더 keywords.json 낱말별 rising_keywords 최신 점수
const RISING_LANE = { politics: 'politics_ko', politics_ja: 'politics_ja' };
function risingNow(videoId, purpose) {
  try {
    const f = packagesPath(videoId), lane = RISING_LANE[purpose];
    const kf = f && path.join(path.dirname(f), 'keywords.json');
    if (!lane || !kf || !fs.existsSync(kf)) return null;
    const { keywordScore } = require(path.join(__dirname, '..', 'scripts', 'rising_keywords.js'));
    const k = JSON.parse(fs.readFileSync(kf, 'utf8'));
    return Object.fromEntries((k.keywords || []).map((w) => [w, keywordScore(lane, w)]));
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// 포장의 설명 첫 두 줄(desc_head: [줄1, 줄2])·해시태그(hashtags: ['#…'])를 설명에 갈아 끼운다(관리자 10-18 «제목·키워드·해시태그도 함께»)
function swapDesc(description, pkg) {
  let lines = description.split('\n');
  if (pkg.desc_head) lines = [...pkg.desc_head, ...lines.slice(pkg.desc_head.length)];
  if (pkg.hashtags) lines = [...lines.filter((l) => !/^(#\S+\s*)+$/.test(l.trim())), pkg.hashtags.join(' ')];
  return lines.join('\n');
}

// 다음 포장으로 교체 — 성공하면 {idx, title, style}, 쓸 포장이 없으면 null
// --purpose <값>: packages.json 없이 채널을 고른다(쇼츠 점검 — 정치JA 10-19). 없으면 packages.json 의 purpose
const PURPOSE_ARG = process.argv.includes('--purpose') ? process.argv[process.argv.indexOf('--purpose') + 1] : null;
const purposeOf = (videoId) => PURPOSE_ARG || findPackages(videoId)?.purpose;
const PURPOSE_FLAG = PURPOSE_ARG ? ` --purpose ${PURPOSE_ARG}` : '';

// 썸네일 업로드 하루 한도(관리자 10-20: 10/20 11:00 교체가 429 «too many thumbnails» 로 썸네일만 실패 → 제목·썸네일 불일치).
// 채널(purpose)별 KST 하루 THUMB_CAP 회까지만 자동 교체한다. 장부 server/data/thumb_uploads.jsonl — 이 도구가 올린 것만 센다(yt-upload.js 업로드 썸네일은 안 셈).
const THUMB_CAP = 3;
const THUMB_LOG = path.join(__dirname, '..', 'server', 'data', 'thumb_uploads.jsonl');
const kstDay = (t) => new Date(new Date(t).getTime() + 9 * 3600e3).toISOString().slice(0, 10);
function thumbsToday(purpose) {
  if (!fs.existsSync(THUMB_LOG)) return 0;
  const today = kstDay(Date.now());
  return fs.readFileSync(THUMB_LOG, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } })
    .filter((r) => r.purpose === purpose && r.ok !== false && kstDay(r.at) === today).length;   // 실패(429)는 안 셈
}

async function repack(videoId, h, views, H) {
  const pf = packagesPath(videoId);
  if (!pf) return null;
  const pk = JSON.parse(fs.readFileSync(pf, 'utf8'));
  pk.applied = pk.applied || [];
  // 10-18 소유주 «안 나오는 건 계속 바꿔 줘, 언제 터질지 모른다»: 대체 포장이 떨어지면 1번부터 다시 돈다
  const n = pk.packages.length - 1;
  if (n < 1) return null;
  const lastA = pk.applied[pk.applied.length - 1];
  // 바꾼 지 3시간이 안 됐으면 새 포장이 노출을 받을 시간을 준다(자동 점검만 — 소유주 즉시 교체는 막지 않음)
  // 1주(+168h) 뒤에는 매일 점검·주 1회 교체(소유주 10-18 «썸네일은 성과에 따라 계속 수정»)
  const hold = h !== 'now' && h > 168 ? 7 * 24 : 3;
  if (lastA && h !== 'now' && Date.now() - new Date(lastA.at) < hold * 3600e3) {
    return { idx: lastA.idx, title: pk.packages[lastA.idx].title, style: `직전 교체 ${hold === 3 ? '3시간' : '1주'} 안 — 유지`, kept: true, hold };
  }
  const last = lastA ? lastA.idx : 0;
  const idx = (last % n) + 1;
  const next = pk.packages[idx];
  const purpose = purposeOf(videoId) || 'politics';
  if (next.thumbnail && thumbsToday(purpose) >= THUMB_CAP) {
    return { idx: last, title: pk.packages[last]?.title, style: `썸네일 하루 한도 ${THUMB_CAP}회 — 오늘 교체 안 함`, kept: true, capped: true };
  }
  const v = (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${videoId}`, { headers: H })).json()).items[0];
  const { title, description, tags, categoryId, defaultLanguage } = v.snippet;
  views = views ?? Number(v.statistics.viewCount || 0);   // 교체 순간 조회 — 다음 점검이 «새 포장이 받는 중인가»를 이 값에서 잰다
  // 썸네일을 먼저 올린다 — 실패하면 제목도 안 바꿔서 제목 머리·썸네일 큰 낱말이 어긋나지 않게(10/20 11:00 사고)
  if (next.thumbnail) {
    const img = fs.readFileSync(path.join(__dirname, '..', next.thumbnail));
    const tr = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, {
      method: 'POST', headers: { ...H, 'Content-Type': next.thumbnail.endsWith('.png') ? 'image/png' : 'image/jpeg' }, body: img,
    });
    fs.appendFileSync(THUMB_LOG, JSON.stringify({ at: new Date().toISOString(), purpose, videoId, idx, ok: tr.ok, status: tr.status }) + '\n', 'utf8');
    if (!tr.ok) throw new Error(`썸네일 교체 실패 ${tr.status} — 제목은 안 바꿨다: ${(await tr.text()).slice(0, 200)}`);
  }
  const up = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet', {
    method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: videoId, snippet: { title: next.title || title, description: swapDesc(description, next), tags: next.tags || tags, categoryId, defaultLanguage } }),
  });
  if (!up.ok) throw new Error(`제목 교체 실패 ${up.status}: ${(await up.text()).slice(0, 200)}`);
  pk.applied.push({ idx, at: new Date().toISOString(), h, views, from: title });
  fs.writeFileSync(pf, JSON.stringify(pk, null, 2) + '\n', 'utf8');
  // 마지막 대체 포장을 걸었으면 «소진» 표시 — 다음 점검 전에 세션이 새 포장(롱폼 속 다른 발언·게이트 통과)을 붙인다(관리자 10-18). 없으면 순환은 최후 수단
  return { idx, title: next.title || title, style: next.style, exhausted: idx === n, wrapped: last === n };
}

// 피드 회복 루프(소유주 10-20 «저거 계속 수정해, 피드 받을 때까지», 관리자 전달) — packages.json "loop" 묶음만 쓴다(옛 포장은 군사·전복 낱말이 있어 안 씀).
//   node politics-hour/views_check.js <id> --loop      schtasks politics_views_<id>_loop 매시간
// 매시간: 걸어 둔 포장의 썸네일이 아직 안 올라갔으면(429·하루 한도) 다시 올린다.
// 마지막 교체 뒤 LOOP_EVERY 시간이 지났으면 판정: 교체 뒤 조회 증가 ≥ LOOP_FEED 면 피드 신호(연속 2회면 그 포장 고정·보고),
// 아니면 아직 안 쓴 다음 묶음으로 교체(같은 포장 재사용 금지). 남은 묶음이 없으면 «소진» 경보 → 세션이 새 후보 3개를 붙인다.
// 썸네일이 다른 묶음은 썸네일이 먼저 올라가야 글자를 바꾼다(제목 머리·썸네일 큰 낱말 불일치 방지).
const LOOP_EVERY = 4, LOOP_FEED = 50;
async function loop(videoId) {
  const pf = packagesPath(videoId);
  const pk = JSON.parse(fs.readFileSync(pf, 'utf8'));
  const L = pk.loop;
  if (!L || !L.packages?.length) throw new Error('packages.json 에 loop 묶음 없음');
  L.applied = L.applied || [];
  const purpose = pk.purpose || 'politics';
  const H = await auth(purpose);
  const save = () => fs.writeFileSync(pf, JSON.stringify(pk, null, 2) + '\n', 'utf8');
  const v = (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${videoId}`, { headers: H })).json()).items[0];
  const views = Number(v.statistics.viewCount || 0);
  const putThumb = async (pkg) => {
    if (thumbsToday(purpose) >= THUMB_CAP) return `하루 한도 ${THUMB_CAP}회`;
    const tr = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, {
      method: 'POST', headers: { ...H, 'Content-Type': pkg.thumbnail.endsWith('.png') ? 'image/png' : 'image/jpeg' }, body: fs.readFileSync(path.join(__dirname, '..', pkg.thumbnail)),
    });
    fs.appendFileSync(THUMB_LOG, JSON.stringify({ at: new Date().toISOString(), purpose, videoId, idx: `loop${pkg._i}`, ok: tr.ok, status: tr.status }) + '\n', 'utf8');
    if (tr.ok) { L.thumb_now = pkg.thumbnail; return null; }
    return `썸네일 ${tr.status}`;
  };
  const putText = async (pkg) => {
    const s = v.snippet;
    const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet', {
      method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: videoId, snippet: { title: pkg.title, description: swapDesc(s.description, pkg), tags: pkg.tags, categoryId: s.categoryId, defaultLanguage: s.defaultLanguage } }),
    });
    if (!r.ok) throw new Error(`제목 교체 실패 ${r.status}: ${(await r.text()).slice(0, 200)}`);
    if (L.comment_id && pkg.comment) {
      const cr = await fetch('https://www.googleapis.com/youtube/v3/comments?part=snippet', { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: L.comment_id, snippet: { textOriginal: pkg.comment } }) });
      if (!cr.ok) console.log(`[loop] 고정 댓글 수정 실패 ${cr.status}`);
    }
  };
  L.packages.forEach((p, i) => { p._i = i; });
  const last = L.applied[L.applied.length - 1];
  const cur = last && L.packages[last.idx];
  const row = { at: new Date().toISOString(), id: videoId, purpose, h: 'loop', long: true, views, title: v.snippet.title, loop: last ? { idx: last.idx, since: last.views } : null };
  // 1) 걸어 둔 포장의 썸네일이 아직이면 다시
  if (cur && cur.thumbnail && L.thumb_now !== cur.thumbnail) {
    const err = await putThumb(cur);
    console.log(`[loop] ${videoId} 포장 ${last.idx}번 썸네일 ${err ? `보류(${err})` : '올림'}`);
    if (!err) append(ALERT, { ...row, alert: `루프 포장 ${last.idx}번 썸네일 올림(밀린 것), 관리자 보고` });
  }
  if (L.fixed != null) { append(LOG, { ...row, fixed: L.fixed }); save(); return; }
  const hrs = last ? (Date.now() - new Date(last.at)) / 3600e3 : Infinity;
  if (last && hrs < LOOP_EVERY - 0.25) { append(LOG, row); save(); console.log(`[loop] ${videoId} 조회 ${views} · 포장 ${last.idx}번 ${hrs.toFixed(1)}h째 — 판정 전`); return; }
  const gain = last ? views - last.views : 0;
  if (last && gain >= LOOP_FEED) {
    L.streak = (L.streak || 0) + 1;
    last.checks = [...(last.checks || []), { at: row.at, views }];
    if (L.streak >= 2) L.fixed = last.idx;
    const msg = L.fixed != null ? `피드 회복 — 포장 ${last.idx}번 고정 «${cur.title}» (교체 뒤 +${gain})` : `피드 신호 1회 — 포장 ${last.idx}번 유지(교체 뒤 +${gain}), 다음 점검도 오르면 고정`;
    if (L.fixed == null) last.views = views;   // 다음 판정은 이 시점부터 다시 잰다
    console.log(`[loop] ${videoId} ${msg}`);
    append(LOG, { ...row, kept: { idx: last.idx, gain } });
    append(ALERT, { ...row, alert: `${msg}, 관리자 보고` });
    save(); return;
  }
  L.streak = 0;
  const used = new Set(L.applied.map((a) => a.idx));
  const next = L.packages.find((p, i) => !used.has(i));
  if (!next) {
    console.log(`[loop] ${videoId} 묶음 소진 — 새 후보 3개 필요`);
    append(ALERT, { ...row, alert: `루프 묶음 소진(조회 ${views}, 직전 포장 뒤 +${gain}) — 새 후보 3개(인물 이름+«말맛 한마디»+상대 인물) 필요, 관리자 보고` });
    save(); process.exit(4);
  }
  if (next.thumbnail && L.thumb_now !== next.thumbnail) {
    const err = await putThumb(next);
    if (err) {
      console.log(`[loop] ${videoId} 포장 ${next._i}번 썸네일 보류(${err}) — 글자도 안 바꿈, 다음 회차`);
      append(LOG, { ...row, wait_thumb: next._i, err });
      save(); return;
    }
  }
  await putText(next);
  L.applied.push({ idx: next._i, at: new Date().toISOString(), views, from: v.snippet.title });
  const msg = `루프 교체 → 포장 ${next._i}번 «${next.title}» · 썸네일 ${next.big?.join('·') || ''} · 직전 포장 뒤 +${gain}(${last ? `${hrs.toFixed(1)}h` : '첫 회'})`;
  console.log(`[loop] ${videoId} ${msg}`);
  append(LOG, { ...row, repack: next._i });
  append(ALERT, { ...row, alert: `${msg}, 관리자 보고` });
  save();
}

(async () => {
  const [videoId, a2, a3] = process.argv.slice(2);
  if (!videoId || !a2) throw new Error('usage: node politics-hour/views_check.js <videoId> <3|6|24> [--no-repack] [--purpose <p>] | --schedule <publishAt> [--short] [--purpose <p>]');
  if (a2 === '--repack') {   // 지금 바로 다음 포장으로(소유주 지시 때) — 조회 기록은 남기지 않는다
    const sw = await repack(videoId, 'now', null, await auth(purposeOf(videoId)));
    console.log(sw ? `[views] ${videoId} 포장 ${sw.idx}번(${sw.style || ''})으로 교체 «${sw.title}»` : `[views] ${videoId} packages.json 없음`);
    append(ALERT, { at: new Date().toISOString(), id: videoId, alert: `소유주 지시 즉시 교체 — ${sw ? `포장 ${sw.idx}번 «${sw.title}»` : '포장 없음'}`, repack: sw });
    return;
  }
  if (a2 === '--loop') { await loop(videoId); return; }
  if (a2 === '--schedule') {
    const pub = new Date(a3);
    if (isNaN(pub)) throw new Error('publishAt 이 날짜가 아니다');
    const done = await require('./yt_processed')(videoId, await auth(purposeOf(videoId)));   // 처리 거절된 영상엔 점검을 등록하지 않는다(관리자 §7 10-18)
    if (done !== true) {
      console.log(`[views] ${videoId} 처리 완료 아님 — ${done} · 점검 등록 안 함`);
      append(ALERT, { at: new Date().toISOString(), id: videoId, alert: `업로드 처리 완료 아님(${done}) — 점검 등록 안 함, 관리자 보고` });
      process.exit(5);
    }
    for (const h of process.argv.includes('--short') ? [6] : HOURS) {   // 쇼츠는 +6h 한 번(조회 0이면 비공개)
      const t = new Date(pub.getTime() + h * 3600e3);
      if (t < Date.now()) continue;   // 이미 지난 점검은 건너뛴다(오래된 편에 늦게 걸 때)
      const pad = (n) => String(n).padStart(2, '0');
      const day = `${t.getFullYear()}/${pad(t.getMonth() + 1)}/${pad(t.getDate())}`;   // 로컬 시각(KST)
      const hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
      const cmd = `cmd /c cd /d ${path.join(__dirname, '..')} && node politics-hour\\views_check.js ${videoId} ${h}${PURPOSE_FLAG} >> server\\data\\politics_views_task_${videoId}.log 2>&1`;
      execFileSync('schtasks', ['/Create', '/F', '/SC', 'ONCE', '/TN', `politics_views_${videoId}_${h}h`, '/SD', day, '/ST', hm, '/TR', cmd], { stdio: 'inherit' });
      console.log(`[views] 등록 ${videoId} +${h}h → ${day} ${hm}`);
    }
    if (!process.argv.includes('--short')) {   // 1주 뒤에도 끝내지 않는다: 매일 07:00 점검(교체는 주 1회) — 소유주 10-18
      const t = new Date(pub.getTime() + 192 * 3600e3), pad = (n) => String(n).padStart(2, '0');
      const cmd = `cmd /c cd /d ${path.join(__dirname, '..')} && node politics-hour\\views_check.js ${videoId} auto${PURPOSE_FLAG} >> server\\data\\politics_views_task_${videoId}.log 2>&1`;
      execFileSync('schtasks', ['/Create', '/F', '/SC', 'DAILY', '/TN', `politics_views_${videoId}_daily`, '/SD', `${t.getFullYear()}/${pad(t.getMonth() + 1)}/${pad(t.getDate())}`, '/ST', '07:00', '/TR', cmd], { stdio: 'inherit' });
      console.log(`[views] 등록 ${videoId} 매일 07:00 (+192h부터, 교체는 주 1회)`);
    }
    // 꺼져 있던 시각(재부팅 등)의 점검은 켜진 뒤 바로 돈다 — schtasks /Create 로는 못 거는 설정(10-20 07:00 재부팅)
    execFileSync('powershell', ['-NoProfile', '-Command', `Get-ScheduledTask -TaskName 'politics_views_${videoId}_*' | ForEach-Object { $s = $_.Settings; $s.StartWhenAvailable = $true; Set-ScheduledTask -TaskName $_.TaskName -Settings $s | Out-Null }`], { stdio: 'inherit' });
    return;
  }
  const H = await auth(purposeOf(videoId));
  const v = (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet,contentDetails,status&id=${videoId}`, { headers: H })).json()).items?.[0];
  if (!v) throw new Error(`영상 없음 ${videoId}`);
  const h = a2 === 'auto' ? Math.round((Date.now() - new Date(v.snippet.publishedAt)) / 86400e3) * 24 : Number(a2);   // 매일 점검은 공개 뒤 날수×24
  const views = Number(v.statistics.viewCount || 0);
  const long = !/^PT(\d+S|[0-2]M)/.test(v.contentDetails.duration);   // 3분 미만은 쇼츠 — 롱폼끼리만 비교
  const rows = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const purpose = purposeOf(videoId) || 'politics';   // 직전 편 비교는 같은 채널끼리
  const prev = rows.filter((r) => r.h === h && r.long === long && r.id !== videoId && (r.purpose || 'politics') === purpose).pop();
  const row = { at: new Date().toISOString(), id: videoId, purpose, h, long, views, title: v.snippet.title, prev: prev ? { id: prev.id, views: prev.views } : null, rising: risingNow(videoId, purpose) };
  append(LOG, row);
  // 쇼츠 공개 6시간 조회 0 = 피드를 못 받는 것 → 커뮤니티 가이드 위반으로 보고 즉시 비공개(소유주 10-18, 제재 표시 없어도)
  if (!long && h >= 6 && views === 0 && v.status?.privacyStatus === 'public') {
    const st = (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status&id=${videoId}`, { headers: H })).json()).items[0].status;
    const { publishAt, ...rest } = st;
    const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', {
      method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: videoId, status: { ...rest, privacyStatus: 'private' } }),
    });
    const msg = r.ok ? '쇼츠 공개 +6h 조회 0 — 피드 못 받음(가이드 위반 추정), 비공개로 내림' : `비공개 전환 실패 ${r.status}`;
    console.log(`[views] ${msg}`);
    append(ALERT, { ...row, alert: `${msg}, 관리자 보고` });
    process.exit(4);
  }
  const floor = long ? (FLOOR[h] || (h > 168 ? FLOOR[168] : 0)) * (FLOOR_SCALE[purpose] ?? 1) : 0;
  const why = [views < floor ? `바닥 ${floor} 미만` : '', prev && views < prev.views / 2 ? `직전 편 ${prev.views}의 절반 미만` : ''].filter(Boolean).join(' · ');
  console.log(`[views] ${videoId} +${h}h 조회 ${views} · 직전 편 ${prev ? `${prev.id} ${prev.views}` : '기록 없음(첫 기준)'} · ${why ? `미달(${why})` : '통과'}`);
  // 새 포장이 조회를 받는 중이면 누적이 바닥 아래여도 그대로 둔다(10-18 소유주 «조회 나오는데» — 10/18 교체 70분 만에 0→72):
  // 교체 뒤 시간당 증가가 바닥값의 시간당 몫(FLOOR[h]/h) 이상이면 통과.
  const pk = long && why ? findPackages(videoId) : null;
  const lastA = pk?.applied?.[pk.applied.length - 1];
  if (lastA && lastA.views != null) {
    const hrs = Math.max((Date.now() - new Date(lastA.at)) / 3600e3, 0.25), rate = (views - lastA.views) / hrs, need = floor / h;
    if (rate >= need) {
      console.log(`[views] 포장 ${lastA.idx}번이 받는 중 — 교체 뒤 시간당 ${rate.toFixed(1)}회(기준 ${need.toFixed(1)}) · 유지`);
      append(LOG, { ...row, kept: { idx: lastA.idx, rate: +rate.toFixed(1), need: +need.toFixed(1) } });
      return;
    }
  }
  const zero = long && views === 0 && h >= 4;
  if (why && zero && ZERO_HOLD.has(purpose)) {
    console.log('[views] 조회 0 = 가이드 의심, 교체 아님 — 범주 낱말·프레임 점검');
    append(ALERT, { ...row, alert: `공개 +${h}h 조회 0 = 가이드 의심, 교체 아님 — 범주 낱말·프레임 점검, 관리자 보고` });
    process.exit(4);
  }
  if (why) {
    const sw = long && !process.argv.includes('--no-repack') ? await repack(videoId, h, views, H) : null;
    const msg = sw?.kept ? `포장 ${sw.idx}번 유지(${sw.style})` : sw ? `포장 ${sw.idx}번(${sw.style || ''})으로 자동 교체 «${sw.title}»${sw.exhausted || sw.wrapped ? ' · 포장 소진 — 새 포장 후보 필요(관리자)' : ''}` : '교체할 포장 없음 — 제목·태그·썸네일부터 다시(재업로드 금지)';
    console.log(`[views] ${msg}`);
    append(ALERT, { ...row, alert: `공개 +${h}h 조회 ${views} 미달(${why}) — ${msg}${zero ? ' · 조회 0 = 가이드 의심(범주 낱말·프레임도 점검)' : ''}, 관리자 보고`, repack: sw });
    process.exit(4);
  }
})().catch((e) => { console.error('[views]', e.message); process.exit(1); });

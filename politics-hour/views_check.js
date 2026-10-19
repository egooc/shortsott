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
  const v = (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${videoId}`, { headers: H })).json()).items[0];
  const { title, description, tags, categoryId, defaultLanguage } = v.snippet;
  views = views ?? Number(v.statistics.viewCount || 0);   // 교체 순간 조회 — 다음 점검이 «새 포장이 받는 중인가»를 이 값에서 잰다
  const up = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet', {
    method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: videoId, snippet: { title: next.title || title, description: swapDesc(description, next), tags: next.tags || tags, categoryId, defaultLanguage } }),
  });
  if (!up.ok) throw new Error(`제목 교체 실패 ${up.status}: ${(await up.text()).slice(0, 200)}`);
  if (next.thumbnail) {
    const img = fs.readFileSync(path.join(__dirname, '..', next.thumbnail));
    const tr = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, {
      method: 'POST', headers: { ...H, 'Content-Type': next.thumbnail.endsWith('.png') ? 'image/png' : 'image/jpeg' }, body: img,
    });
    if (!tr.ok) throw new Error(`썸네일 교체 실패 ${tr.status}: ${(await tr.text()).slice(0, 200)}`);
  }
  pk.applied.push({ idx, at: new Date().toISOString(), h, views, from: title });
  fs.writeFileSync(pf, JSON.stringify(pk, null, 2) + '\n', 'utf8');
  // 마지막 대체 포장을 걸었으면 «소진» 표시 — 다음 점검 전에 세션이 새 포장(롱폼 속 다른 발언·게이트 통과)을 붙인다(관리자 10-18). 없으면 순환은 최후 수단
  return { idx, title: next.title || title, style: next.style, exhausted: idx === n, wrapped: last === n };
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

// 공개 뒤 조회 사후 점검(관리자·소유주 10-17): 공개 +3h·+6h 조회가 전날 편 같은 시점의 절반 미만이면 제목·태그·썸네일부터 다시 쓴다(재업로드 금지).
//
//   node politics-hour/views_check.js <videoId> <시간 3|6>                 지금 조회를 기록하고 직전 편 같은 시점과 비교
//   node politics-hour/views_check.js <videoId> --schedule <publishAt ISO>   +3h·+6h·+24h 에 위 점검이 돌게 Windows 작업 스케줄러에 1회성 작업 3개 등록
//
// ★Data API 는 «지금» 조회만 준다 — 전날 같은 시점 값은 이 스크립트가 날마다 남긴 기록(server/data/politics_views.jsonl)에서 찾는다.
// 미달이면 server/data/politics_alerts.jsonl 에 한 줄 남기고 exit 4 — 관리자 보고는 이 줄을 보고 한다(스케줄 작업은 세션에 말을 못 건다).
//
// ★자동 포장 교체(10-18 소유주 «성과가 아예 없으면 썸네일·키워드를 자동으로 바꿔 줘야»): 롱폼이 미달이면
//   에피소드 폴더의 packages.json 에서 아직 안 쓴 다음 포장(제목+썸네일)을 그 자리에서 API 로 갈아 끼운다(재업로드 아님).
//   미달 = 바닥값(FLOOR) 미만 또는 직전 편 같은 시점의 절반 미만. 포장이 다 떨어지면 알림만. --no-repack 이면 교체 안 함.
//   packages.json: {"video_id": "...", "packages": [{"title", "thumbnail", "style"}, ...], "applied": [{"idx", "at", "h", "views"}]}
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
const FLOOR = { 3: 20, 6: 40, 4: 25, 8: 50, 12: 70, 24: 100, 48: 200, 72: 300, 96: 350, 120: 400, 144: 450, 168: 500 };   // 롱폼 «아예 안 받는» 선 — 10/15 2,663회·10/17 +6h 19회 실측 기준, 데이터 쌓이면 조정

async function auth() {
  const store = JSON.parse(fs.readFileSync(path.join(DATA, 'youtube_upload_profiles.json'), 'utf8'));
  const p = store.profiles.find((x) => x.purpose === 'politics');
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  return { Authorization: `Bearer ${(await c.getAccessToken()).token}` };
}

// 다음 포장으로 교체 — 성공하면 {idx, title, style}, 쓸 포장이 없으면 null
async function repack(videoId, h, views, H) {
  const eps = path.join(__dirname, 'episodes');
  const pf = fs.readdirSync(eps).map((d) => path.join(eps, d, 'packages.json'))
    .find((f) => fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')).video_id === videoId);
  if (!pf) return null;
  const pk = JSON.parse(fs.readFileSync(pf, 'utf8'));
  pk.applied = pk.applied || [];
  // 10-18 소유주 «안 나오는 건 계속 바꿔 줘, 언제 터질지 모른다»: 대체 포장이 떨어지면 1번부터 다시 돈다
  const n = pk.packages.length - 1;
  if (n < 1) return null;
  const lastA = pk.applied[pk.applied.length - 1];
  // 바꾼 지 3시간이 안 됐으면 새 포장이 노출을 받을 시간을 준다(자동 점검만 — 소유주 즉시 교체는 막지 않음)
  if (lastA && h !== 'now' && Date.now() - new Date(lastA.at) < 3 * 3600e3) {
    return { idx: lastA.idx, title: pk.packages[lastA.idx].title, style: '직전 교체 3시간 안 — 유지', kept: true };
  }
  const last = lastA ? lastA.idx : 0;
  const idx = (last % n) + 1;
  const next = pk.packages[idx];
  const v = (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}`, { headers: H })).json()).items[0];
  const { title, description, tags, categoryId, defaultLanguage } = v.snippet;
  const up = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet', {
    method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: videoId, snippet: { title: next.title || title, description, tags, categoryId, defaultLanguage } }),
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
  return { idx, title: next.title || title, style: next.style };
}

(async () => {
  const [videoId, a2, a3] = process.argv.slice(2);
  if (!videoId || !a2) throw new Error('usage: node politics-hour/views_check.js <videoId> <3|6|24> [--no-repack] | --schedule <publishAt>');
  if (a2 === '--repack') {   // 지금 바로 다음 포장으로(소유주 지시 때) — 조회 기록은 남기지 않는다
    const sw = await repack(videoId, 'now', null, await auth());
    console.log(sw ? `[views] ${videoId} 포장 ${sw.idx}번(${sw.style || ''})으로 교체 «${sw.title}»` : `[views] ${videoId} packages.json 없음`);
    append(ALERT, { at: new Date().toISOString(), id: videoId, alert: `소유주 지시 즉시 교체 — ${sw ? `포장 ${sw.idx}번 «${sw.title}»` : '포장 없음'}`, repack: sw });
    return;
  }
  if (a2 === '--schedule') {
    const pub = new Date(a3);
    if (isNaN(pub)) throw new Error('publishAt 이 날짜가 아니다');
    for (const h of HOURS) {
      const t = new Date(pub.getTime() + h * 3600e3);
      if (t < Date.now()) continue;   // 이미 지난 점검은 건너뛴다(오래된 편에 늦게 걸 때)
      const pad = (n) => String(n).padStart(2, '0');
      const day = `${t.getFullYear()}/${pad(t.getMonth() + 1)}/${pad(t.getDate())}`;   // 로컬 시각(KST)
      const hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
      const cmd = `cmd /c cd /d ${path.join(__dirname, '..')} && node politics-hour\\views_check.js ${videoId} ${h} >> server\\data\\politics_views_task.log 2>&1`;
      execFileSync('schtasks', ['/Create', '/F', '/SC', 'ONCE', '/TN', `politics_views_${videoId}_${h}h`, '/SD', day, '/ST', hm, '/TR', cmd], { stdio: 'inherit' });
      console.log(`[views] 등록 ${videoId} +${h}h → ${day} ${hm}`);
    }
    return;
  }
  const h = Number(a2);
  const H = await auth();
  const v = (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet,contentDetails&id=${videoId}`, { headers: H })).json()).items?.[0];
  if (!v) throw new Error(`영상 없음 ${videoId}`);
  const views = Number(v.statistics.viewCount || 0);
  const long = !/^PT(\d+S|[0-2]M)/.test(v.contentDetails.duration);   // 3분 미만은 쇼츠 — 롱폼끼리만 비교
  const rows = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const prev = rows.filter((r) => r.h === h && r.long === long && r.id !== videoId).pop();
  const row = { at: new Date().toISOString(), id: videoId, h, long, views, title: v.snippet.title, prev: prev ? { id: prev.id, views: prev.views } : null };
  append(LOG, row);
  const floor = long ? FLOOR[h] || 0 : 0;
  const why = [views < floor ? `바닥 ${floor} 미만` : '', prev && views < prev.views / 2 ? `직전 편 ${prev.views}의 절반 미만` : ''].filter(Boolean).join(' · ');
  console.log(`[views] ${videoId} +${h}h 조회 ${views} · 직전 편 ${prev ? `${prev.id} ${prev.views}` : '기록 없음(첫 기준)'} · ${why ? `미달(${why})` : '통과'}`);
  if (why) {
    const sw = long && !process.argv.includes('--no-repack') ? await repack(videoId, h, views, H) : null;
    const msg = sw?.kept ? `포장 ${sw.idx}번 유지(직전 교체 3시간 안)` : sw ? `포장 ${sw.idx}번(${sw.style || ''})으로 자동 교체 «${sw.title}»` : '교체할 포장 없음 — 제목·태그·썸네일부터 다시(재업로드 금지)';
    console.log(`[views] ${msg}`);
    append(ALERT, { ...row, alert: `공개 +${h}h 조회 ${views} 미달(${why}) — ${msg}, 관리자 보고`, repack: sw });
    process.exit(4);
  }
})().catch((e) => { console.error('[views]', e.message); process.exit(1); });

// 공개 뒤 조회 사후 점검(관리자·소유주 10-17): 공개 +3h·+6h 조회가 전날 편 같은 시점의 절반 미만이면 제목·태그·썸네일부터 다시 쓴다(재업로드 금지).
//
//   node politics-hour/views_check.js <videoId> <시간 3|6>                 지금 조회를 기록하고 직전 편 같은 시점과 비교
//   node politics-hour/views_check.js <videoId> --schedule <publishAt ISO>   +3h·+6h 에 위 점검이 돌게 Windows 작업 스케줄러에 1회성 작업 2개 등록
//
// ★Data API 는 «지금» 조회만 준다 — 전날 같은 시점 값은 이 스크립트가 날마다 남긴 기록(server/data/politics_views.jsonl)에서 찾는다.
// 미달이면 server/data/politics_alerts.jsonl 에 한 줄 남기고 exit 4 — 관리자 보고는 이 줄을 보고 한다(스케줄 작업은 세션에 말을 못 건다).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { OAuth2Client } = require(path.join(__dirname, '..', 'node_modules', 'google-auth-library'));

const DATA = path.join(__dirname, '..', 'server', 'data');
const LOG = path.join(DATA, 'politics_views.jsonl');
const ALERT = path.join(DATA, 'politics_alerts.jsonl');
const append = (f, o) => fs.appendFileSync(f, JSON.stringify(o) + '\n', 'utf8');

(async () => {
  const [videoId, a2, a3] = process.argv.slice(2);
  if (!videoId || !a2) throw new Error('usage: node politics-hour/views_check.js <videoId> <3|6> | --schedule <publishAt>');
  if (a2 === '--schedule') {
    const pub = new Date(a3);
    if (isNaN(pub)) throw new Error('publishAt 이 날짜가 아니다');
    for (const h of [3, 6]) {
      const t = new Date(pub.getTime() + h * 3600e3);
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
  const store = JSON.parse(fs.readFileSync(path.join(DATA, 'youtube_upload_profiles.json'), 'utf8'));
  const p = store.profiles.find((x) => x.purpose === 'politics');
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  const H = { Authorization: `Bearer ${(await c.getAccessToken()).token}` };
  const v = (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet,contentDetails&id=${videoId}`, { headers: H })).json()).items?.[0];
  if (!v) throw new Error(`영상 없음 ${videoId}`);
  const views = Number(v.statistics.viewCount || 0);
  const long = !/^PT(\d+S|[0-2]M)/.test(v.contentDetails.duration);   // 3분 미만은 쇼츠 — 롱폼끼리만 비교
  const rows = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const prev = rows.filter((r) => r.h === h && r.long === long && r.id !== videoId).pop();
  const row = { at: new Date().toISOString(), id: videoId, h, long, views, title: v.snippet.title, prev: prev ? { id: prev.id, views: prev.views } : null };
  append(LOG, row);
  const low = prev && views < prev.views / 2;
  console.log(`[views] ${videoId} +${h}h 조회 ${views} · 직전 편 ${prev ? `${prev.id} ${prev.views}` : '기록 없음(첫 기준)'} · ${low ? '미달 — 제목·태그·썸네일 다시' : '통과'}`);
  if (low) {
    append(ALERT, { ...row, alert: `공개 +${h}h 조회 ${views} < 직전 편 ${prev.views}의 절반 — 제목·태그·썸네일부터 다시(재업로드 금지), 관리자 보고` });
    process.exit(4);
  }
})().catch((e) => { console.error('[views]', e.message); process.exit(1); });

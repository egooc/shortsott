// 공개된 영상에 upload.json 의 pinned_comment 를 단다(예약 중인 영상에는 403 이라 yt-upload.js 가 못 단다).
// 고정(pin)은 Data API 에 없다 — 스튜디오에서 눌러야 한다(yt-upload.js 와 같음). 이미 같은 글이 있으면 다시 안 단다.
//
//   node politics-hour/yt_comment.js <videoId> <upload.json>
//   node politics-hour/yt_comment.js <videoId> <upload.json> --wait   공개될 때까지 1분마다 확인(최대 30분)
//   --purpose <이름>   채널 프로필(기본 politics)
const fs = require('fs');
const path = require('path');
const { OAuth2Client } = require(path.join(__dirname, '..', 'node_modules', 'google-auth-library'));

(async () => {
  const [videoId, metaPath] = process.argv.slice(2);
  if (!videoId || !metaPath) throw new Error('usage: node politics-hour/yt_comment.js <videoId> <upload.json> [--wait]');
  const text = JSON.parse(fs.readFileSync(metaPath, 'utf8')).pinned_comment;
  if (!text) throw new Error('upload.json 에 pinned_comment 가 없다');
  const store = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'data', 'youtube_upload_profiles.json'), 'utf8'));
  const pi = process.argv.indexOf('--purpose');
  const purpose = pi > 0 ? process.argv[pi + 1] : 'politics';
  const p = store.profiles.find((x) => x.purpose === purpose);
  if (!p) throw new Error(`프로필 없음: ${purpose}`);
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  const H = { Authorization: `Bearer ${(await c.getAccessToken()).token}`, 'Content-Type': 'application/json' };
  const status = async () => (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status&id=${videoId}`, { headers: H })).json()).items?.[0]?.status;
  let st = await status();
  for (let i = 0; process.argv.includes('--wait') && st?.privacyStatus !== 'public' && i < 30; i++) {
    await new Promise((res) => setTimeout(res, 60000));
    st = await status();
  }
  if (st?.privacyStatus !== 'public') { console.log(`[comment] ${videoId} 아직 공개 아님(${st?.privacyStatus}) — 안 달았다`); process.exit(2); }
  const mine = await (await fetch(`https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&maxResults=50`, { headers: H })).json();
  if ((mine.items || []).some((t) => t.snippet.topLevelComment.snippet.textOriginal === text)) { console.log(`[comment] ${videoId} 이미 있음`); return; }
  const r = await fetch('https://www.googleapis.com/youtube/v3/commentThreads?part=snippet', {
    method: 'POST', headers: H,
    body: JSON.stringify({ snippet: { videoId, topLevelComment: { snippet: { textOriginal: text } } } }),
  });
  const j = await r.json();
  console.log(r.ok ? `[comment] ${videoId} 댓글 ${j.id} — 스튜디오에서 «고정» 눌러 주세요` : `[comment] 실패 ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  if (!r.ok) process.exit(1);
})().catch((e) => { console.error(e.message); process.exit(1); });

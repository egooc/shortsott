// 공개된 최애모먼트 영상에 댓글 한 줄 — 예약(비공개) 영상은 403 이라 공개 뒤에 단다. 고정은 API 가 없어 스튜디오에서 손으로.
//   node fantube/post_comment.js <videoId> "<text>"
const fs = require('fs');
const path = require('path');
const { OAuth2Client } = require(path.join(__dirname, '..', 'node_modules', 'google-auth-library'));

(async () => {
  const [videoId, text] = process.argv.slice(2);
  if (!videoId || !text) throw new Error('usage: node fantube/post_comment.js <videoId> "<text>" [--purpose <purpose>]');
  const pi = process.argv.indexOf('--purpose');
  const purpose = pi > 0 ? process.argv[pi + 1] : 'idol3sec_ko';   // 레인별 채널(10/27 코르티스 레인 증설)
  const store = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'data', 'youtube_upload_profiles.json'), 'utf8'));
  const p = store.profiles.find((x) => x.purpose === purpose);
  if (!p) throw new Error(`채널 프로필 없음: purpose=${purpose}`);
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  const H = { Authorization: `Bearer ${(await c.getAccessToken()).token}`, 'Content-Type': 'application/json' };
  const r = await fetch('https://www.googleapis.com/youtube/v3/commentThreads?part=snippet', {
    method: 'POST', headers: H,
    body: JSON.stringify({ snippet: { videoId, topLevelComment: { snippet: { textOriginal: text } } } }),
  });
  const j = await r.json();
  console.log(r.ok ? `[comment] ${videoId} 댓글 ${j.id} — 스튜디오에서 «고정» 눌러야 함` : `[comment] 실패 ${r.status}: ${JSON.stringify(j.error || j).slice(0, 200)}`);
  if (!r.ok) process.exit(1);
})();

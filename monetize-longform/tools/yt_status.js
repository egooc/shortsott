// 수창 롱폼: 영상 처리 상태 확인 — uploadStatus·failureReason·rejectionReason·privacy·publishAt (videos.list part=status,processingDetails).
//   node monetize-longform/tools/yt_status.js <videoId> --purpose <p>
// 종료 코드: 0 processed · 2 아직 처리 중(uploaded) · 4 rejected/failed · 1 오류
const fs = require('fs');
const path = require('path');
const { OAuth2Client } = require(path.join('D:/midform', 'node_modules', 'google-auth-library'));

(async () => {
  const a = process.argv.slice(2);
  const videoId = a[0];
  const purpose = a[a.indexOf('--purpose') + 1];
  if (!videoId || !a.includes('--purpose') || !purpose) throw new Error('usage: yt_status.js <videoId> --purpose <p>');
  const store = JSON.parse(fs.readFileSync('D:/midform/server/data/youtube_upload_profiles.json', 'utf8'));
  const p = store.profiles.find((x) => x.purpose === purpose);
  if (!p) throw new Error(`업로드 프로필 없음: ${purpose}`);
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  const H = { Authorization: `Bearer ${(await c.getAccessToken()).token}` };
  const r = await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails,snippet&id=${videoId}`, { headers: H })).json();
  const it = r.items?.[0];
  if (!it) { console.log(`[status] 영상 없음 ${videoId}`); process.exit(1); }
  const s = it.status, pd = it.processingDetails || {};
  console.log(JSON.stringify({ videoId, channel: it.snippet?.channelTitle, uploadStatus: s.uploadStatus, failureReason: s.failureReason, rejectionReason: s.rejectionReason,
    privacy: s.privacyStatus, publishAt: s.publishAt, processing: pd.processingStatus, progress: pd.processingProgress?.partsProcessed !== undefined ? `${pd.processingProgress.partsProcessed}/${pd.processingProgress.partsTotal}` : undefined }));
  if (s.uploadStatus === 'rejected' || s.uploadStatus === 'failed') process.exit(4);
  if (s.uploadStatus !== 'processed') process.exit(2);
})().catch((e) => { console.error(e.message || e); process.exit(1); });

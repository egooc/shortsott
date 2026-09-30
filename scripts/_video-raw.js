// 영상 한 건의 YouTube API 원본 응답을 그대로 찍는다.
//
//   node scripts/_video-raw.js <purpose> <videoId>
//
// 왜: check-claims.js 는 contentDetails.regionRestriction.blocked 하나만 본다.
// 그 필드가 비어 있는데도 스튜디오에는 제한이 뜨는 경우가 있어, 무엇이 실제로 오는지 눈으로 봐야 한다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');

async function accessToken(profile) {
  const body = new URLSearchParams({
    client_id: profile.oauthClientId,
    client_secret: profile.oauthClientSecret,
    refresh_token: profile.refreshToken,
    grant_type: 'refresh_token'
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }
  });
  const json = await res.json();
  if (!json.access_token) throw new Error('토큰 갱신 실패: ' + JSON.stringify(json).slice(0, 200));
  return json.access_token;
}

(async () => {
  const [purpose, id] = process.argv.slice(2);
  if (!purpose || !id) { console.error('사용법: node scripts/_video-raw.js <purpose> <videoId>'); process.exit(2); }
  const list = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  const profiles = Array.isArray(list) ? list : (list.profiles || []);
  const profile = profiles.find((p) => p.purpose === purpose);
  if (!profile) { console.error('프로필 없음: ' + purpose); process.exit(2); }
  const token = await accessToken(profile);
  const parts = 'snippet,status,contentDetails,statistics,processingDetails,suggestions';
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=${parts}&id=${id}`,
    { headers: { authorization: 'Bearer ' + token } });
  const json = await res.json();
  const v = (json.items || [])[0];
  if (!v) { console.error('조회 실패: ' + JSON.stringify(json).slice(0, 400)); process.exit(1); }
  console.log(JSON.stringify({
    id: v.id,
    title: v.snippet.title,
    status: v.status,
    contentDetails: v.contentDetails,
    statistics: v.statistics,
    processingDetails: v.processingDetails,
    suggestions: v.suggestions
  }, null, 1));
})().catch((e) => { console.error('[raw]', e.message); process.exit(1); });

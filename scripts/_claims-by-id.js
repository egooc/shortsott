// 영상 ID 를 직접 주고 Content ID 차단 여부만 본다.
//
//   node scripts/_claims-by-id.js <purpose> <videoId> [<videoId> ...]
//     purpose: ko_highlight | jp_highlight  (업로드에 쓴 프로필의 purpose)
//
// 왜 필요한가 (2026-09-29)
//   check-claims.js 는 state.history 를 훑어 명화관 잡만 본다. 린박스 발행 건은
//   그 목록에 안 잡혀서 공개 직전 확인이 빠진다. ID 를 아는 경우를 위한 최소 도구다.
//   판정 근거는 check-claims.js 와 같다 — 정책이 차단인 클레임은 videos.list 의
//   contentDetails.regionRestriction.blocked 로 드러난다(전세계 차단이면 모든 나라가 실린다).
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
    method: 'POST', body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  });
  const json = await res.json();
  if (!json.access_token) throw new Error('토큰 갱신 실패: ' + JSON.stringify(json).slice(0, 200));
  return json.access_token;
}

(async () => {
  const [purpose, ...ids] = process.argv.slice(2);
  if (!purpose || !ids.length) {
    console.error('사용법: node scripts/_claims-by-id.js <ko_highlight|jp_highlight> <videoId> ...');
    process.exit(2);
  }
  const profiles = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  const list = Array.isArray(profiles) ? profiles : (profiles.profiles || []);
  const profile = list.find((p) => p.purpose === purpose);
  if (!profile) {
    console.error('purpose 에 맞는 프로필이 없다: ' + purpose
      + ' (있는 것: ' + list.map((p) => p.purpose).join(', ') + ')');
    process.exit(2);
  }
  const token = await accessToken(profile);
  const url = 'https://www.googleapis.com/youtube/v3/videos?part=snippet,status,contentDetails,statistics&id='
    + ids.join(',');
  const res = await fetch(url, { headers: { authorization: 'Bearer ' + token } });
  const json = await res.json();
  if (!json.items) {
    console.error('조회 실패: ' + JSON.stringify(json).slice(0, 300));
    process.exit(1);
  }
  const found = new Set();
  for (const v of json.items) {
    found.add(v.id);
    const blocked = ((v.contentDetails || {}).regionRestriction || {}).blocked || null;
    // ★licensedContent 도 본다 — regionRestriction 이 비어 있어도 소유권이 매칭되면 도달이 죽는다
    //   (2026-09-29: 같은 소스 ko/ja 한 쌍에서 ja 만 true, 조회 4회 vs 2,847회).
    const licensed = (v.contentDetails || {}).licensedContent === true;
    const mark = blocked
      ? (blocked.length >= 200 ? '**전세계 차단**' : '일부 지역 차단 ' + blocked.length + '개국')
      : licensed ? '**소유권 매칭(licensedContent)**' : '클레임 없음';
    console.log('- %s %s  %s  공개예정 %s  조회 %s  %s',
      mark, v.id, v.status.privacyStatus,
      v.status.publishAt || '(없음)', (v.statistics || {}).viewCount || '?',
      v.snippet.title.slice(0, 44));
  }
  for (const id of ids) if (!found.has(id)) console.log('- 조회 안 됨 %s (이 계정 영상이 아닐 수 있다)', id);
})().catch((e) => { console.error('[claims]', e.message); process.exit(1); });

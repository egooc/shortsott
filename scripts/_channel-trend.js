// 채널의 최근 업로드 조회수 추이를 뽑는다 — "요즘 조회수가 안 나온다"를 숫자로 확인하려고.
//
//   node scripts/_channel-trend.js <purpose> [개수]
//     purpose: ko_highlight | jp_highlight
//
// 왜: 감으로 "노출이 줄었다"고 판단하면 대응이 엉뚱해진다. 업로드 날짜별 조회수를 늘어놓으면
// ① 전반적 하락인지 ② 특정 편만 죽은 것인지 ③ 클레임·소유권 매칭 때문인지 갈라진다.
// ★조회수는 «공개 후 경과 시간»에 비례하므로 날짜와 같이 봐야 한다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');

async function accessToken(p) {
  const body = new URLSearchParams({
    client_id: p.oauthClientId, client_secret: p.oauthClientSecret,
    refresh_token: p.refreshToken, grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('토큰 갱신 실패: ' + JSON.stringify(j).slice(0, 160));
  return j.access_token;
}

async function api(token, url) {
  const r = await fetch(url, { headers: { authorization: 'Bearer ' + token } });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
  return j;
}

(async () => {
  const purpose = process.argv[2];
  const want = Number(process.argv[3] || 25);
  const store = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  const list = Array.isArray(store) ? store : (store.profiles || []);
  const profile = list.find((p) => p.purpose === purpose);
  if (!profile) { console.error('프로필 없음: ' + purpose); process.exit(2); }
  const token = await accessToken(profile);

  // 업로드 재생목록 → 최근 영상 id
  const ch = await api(token, 'https://www.googleapis.com/youtube/v3/channels?part=contentDetails,statistics&mine=true');
  const me = (ch.items || [])[0];
  const uploads = me.contentDetails.relatedPlaylists.uploads;
  console.log('채널 구독자 %s · 총 조회 %s · 영상 %s',
    me.statistics.subscriberCount, me.statistics.viewCount, me.statistics.videoCount);

  const ids = [];
  let pageToken = '';
  while (ids.length < want) {
    const pl = await api(token, `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}${pageToken ? '&pageToken=' + pageToken : ''}`);
    for (const it of pl.items || []) ids.push(it.contentDetails.videoId);
    if (!pl.nextPageToken) break;
    pageToken = pl.nextPageToken;
  }
  const pick = ids.slice(0, want);

  const rows = [];
  for (let i = 0; i < pick.length; i += 50) {
    const batch = pick.slice(i, i + 50).join(',');
    const v = await api(token, `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails,status&id=${batch}`);
    for (const item of v.items || []) {
      const iso = (item.contentDetails.duration || '').match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
      rows.push({
        id: item.id,
        at: item.snippet.publishedAt,
        views: Number(item.statistics.viewCount || 0),
        likes: Number(item.statistics.likeCount || 0),
        sec: iso ? Number(iso[1] || 0) * 60 + Number(iso[2] || 0) : 0,
        licensed: item.contentDetails.licensedContent === true,
        privacy: item.status.privacyStatus,
        title: item.snippet.title
      });
    }
  }
  rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const now = Date.now();
  console.log('\n%-10s %-5s %-7s %-6s %-4s %s', '공개일', '길이', '조회', '좋아요', '매칭', '제목');
  for (const r of rows) {
    const days = ((now - Date.parse(r.at)) / 86400000).toFixed(1);
    console.log([ (r.at.slice(5,10)+'('+days+'d)').padEnd(13), (r.sec+'s').padStart(5), String(r.views).padStart(7), String(r.likes).padStart(5), (r.licensed?'★매칭':'    '), (r.privacy==='public'?'':'['+r.privacy+']')+r.title.slice(0,40) ].join(' ')); if(false) console.log('',
      r.at.slice(5, 10) + '(' + days + 'd)', r.sec, r.views, r.likes,
      r.licensed ? '★' : '', r.privacy === 'public' ? '' : '[' + r.privacy + ']',
      r.title.slice(0, 40));
  }
  const pub = rows.filter((r) => r.privacy === 'public');
  const half = Math.floor(pub.length / 2);
  const avg = (a) => (a.length ? Math.round(a.reduce((s, r) => s + r.views, 0) / a.length) : 0);
  console.log('\n최근 %d편 평균 %s회 · 그 이전 %d편 평균 %s회',
    half, avg(pub.slice(0, half)), pub.length - half, avg(pub.slice(half)));
  console.log('소유권 매칭된 편: %d / %d', pub.filter((r) => r.licensed).length, pub.length);
})().catch((e) => { console.error('[trend]', e.message); process.exit(1); });

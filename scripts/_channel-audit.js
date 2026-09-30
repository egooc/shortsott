// 채널의 업로드를 전수 조사해 «소유권 매칭이 언제부터 시작됐는지» 찾는다.
//
//   node scripts/_channel-audit.js <purpose> [최대개수]
//
// 왜: 매칭이 특정 시점부터 «전부» 시작됐다면 소재가 아니라 채널 문제다.
// 소재 문제라면 작품·시기별로 섞여 나온다. 그 둘을 가르려고 만든다.
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
  if (!j.access_token) throw new Error('토큰 갱신 실패');
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
  const cap = Number(process.argv[3] || 400);
  const store = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  const list = Array.isArray(store) ? store : (store.profiles || []);
  const profile = list.find((p) => p.purpose === purpose);
  if (!profile) { console.error('프로필 없음: ' + purpose); process.exit(2); }
  const token = await accessToken(profile);

  const ch = await api(token, 'https://www.googleapis.com/youtube/v3/channels?part=contentDetails,statistics,status&mine=true');
  const me = (ch.items || [])[0];
  console.log('구독 %s · 총조회 %s · 영상 %s',
    me.statistics.subscriberCount, me.statistics.viewCount, me.statistics.videoCount);
  console.log('채널 status: %s', JSON.stringify(me.status));

  const uploads = me.contentDetails.relatedPlaylists.uploads;
  const ids = [];
  let pageToken = '';
  while (ids.length < cap) {
    const pl = await api(token, `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}${pageToken ? '&pageToken=' + pageToken : ''}`);
    for (const it of pl.items || []) ids.push(it.contentDetails.videoId);
    if (!pl.nextPageToken) break;
    pageToken = pl.nextPageToken;
  }
  console.log('업로드 %d건 조회', ids.length);

  const rows = [];
  for (let i = 0; i < ids.length; i += 50) {
    const v = await api(token, `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails,status&id=${ids.slice(i, i + 50).join(',')}`);
    for (const it of v.items || []) {
      const blocked = ((it.contentDetails || {}).regionRestriction || {}).blocked || [];
      rows.push({
        id: it.id,
        at: it.snippet.publishedAt,
        views: Number(it.statistics.viewCount || 0),
        licensed: it.contentDetails.licensedContent === true,
        blocked: blocked.length,
        privacy: it.status.privacyStatus,
        title: it.snippet.title
      });
    }
  }
  rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));   // 오래된 것부터

  // 월별 집계 — 전환점이 있으면 여기서 드러난다
  const by = new Map();
  for (const r of rows) {
    const k = r.at.slice(0, 7);
    const g = by.get(k) || { n: 0, lic: 0, blk: 0, views: 0, pub: 0 };
    g.n += 1;
    if (r.licensed) g.lic += 1;
    if (r.blocked) g.blk += 1;
    if (r.privacy === 'public') { g.pub += 1; g.views += r.views; }
    by.set(k, g);
  }
  console.log('\n월       편수  매칭  차단  공개  공개분평균조회');
  for (const [k, g] of [...by.entries()].sort()) {
    console.log([k, String(g.n).padStart(5), String(g.lic).padStart(5),
      String(g.blk).padStart(5), String(g.pub).padStart(5),
      String(g.pub ? Math.round(g.views / g.pub) : '-').padStart(9),
      String(g.pub ? g.views : '-').padStart(9)].join(' '));
  }

  const firstLic = rows.find((r) => r.licensed);
  const lastClean = [...rows].reverse().find((r) => !r.licensed);
  console.log('\n첫 매칭: %s', firstLic ? `${firstLic.at.slice(0, 10)} ${firstLic.id} ${firstLic.title.slice(0, 36)}` : '없음');
  console.log('마지막 비매칭: %s', lastClean ? `${lastClean.at.slice(0, 10)} ${lastClean.id} ${lastClean.title.slice(0, 36)}` : '없음');
  const lic = rows.filter((r) => r.licensed).length;
  console.log('전체 ' + rows.length + '건 중 매칭 ' + lic + '건 ('
    + (100 * lic / Math.max(1, rows.length)).toFixed(0) + '%)');
})().catch((e) => { console.error('[audit]', e.message); process.exit(1); });

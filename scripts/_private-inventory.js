// 비공개로 묶여 있는 업로드를 «풀어도 되는 것»과 «풀면 안 되는 것»으로 가른다.
//
//   node scripts/_private-inventory.js <purpose> [--json]
//
// 왜: 차단(regionRestriction)된 편은 공개해도 조회가 0이다 — 채널에 죽은 영상만 쌓인다.
// 소유권 매칭(licensedContent)은 사정이 다르다: 2026-06 에 매칭 100% 인 채로 편당 8,288회가 나왔다.
// 그러니 매칭은 공개를 막을 사유가 아니고, 차단만 막을 사유다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');

async function token(p) {
  const body = new URLSearchParams({
    client_id: p.oauthClientId, client_secret: p.oauthClientSecret,
    refresh_token: p.refreshToken, grant_type: 'refresh_token'
  });
  const j = await (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }
  })).json();
  if (!j.access_token) throw new Error('토큰 갱신 실패');
  return j.access_token;
}

async function api(tk, url) {
  const j = await (await fetch(url, { headers: { authorization: 'Bearer ' + tk } })).json();
  if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 180));
  return j;
}

(async () => {
  const purpose = process.argv[2];
  const asJson = process.argv.includes('--json');
  const store = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  const list = Array.isArray(store) ? store : (store.profiles || []);
  const p = list.find((x) => x.purpose === purpose);
  if (!p) { console.error('프로필 없음'); process.exit(2); }
  const tk = await token(p);
  const ch = await api(tk, 'https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true');
  const up = ch.items[0].contentDetails.relatedPlaylists.uploads;

  const ids = [];
  let pt = '';
  while (ids.length < 500) {
    const pl = await api(tk, `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${up}${pt ? '&pageToken=' + pt : ''}`);
    for (const it of pl.items || []) ids.push(it.contentDetails.videoId);
    if (!pl.nextPageToken) break;
    pt = pl.nextPageToken;
  }
  const rows = [];
  for (let i = 0; i < ids.length; i += 50) {
    const v = await api(tk, `https://www.googleapis.com/youtube/v3/videos?part=snippet,status,statistics,contentDetails&id=${ids.slice(i, i + 50).join(',')}`);
    for (const it of v.items || []) {
      const blocked = ((it.contentDetails || {}).regionRestriction || {}).blocked || [];
      rows.push({
        id: it.id, at: it.snippet.publishedAt, title: it.snippet.title,
        privacy: it.status.privacyStatus, publishAt: it.status.publishAt || '',
        views: Number(it.statistics.viewCount || 0),
        blocked: blocked.length, worldwide: blocked.length >= 200,
        licensed: it.contentDetails.licensedContent === true,
        duration: it.contentDetails.duration
      });
    }
  }
  const priv = rows.filter((r) => r.privacy !== 'public');
  const safe = priv.filter((r) => !r.blocked);
  const dead = priv.filter((r) => r.blocked);
  if (asJson) { console.log(JSON.stringify({ safe, dead }, null, 1)); return; }

  console.log('%s — 전체 %d · 공개 %d · 비공개 %d', purpose, rows.length,
    rows.length - priv.length, priv.length);
  console.log('  풀어도 되는 것(차단 없음) : %d', safe.length);
  console.log('  풀면 안 되는 것(지역 차단): %d  ← 공개해도 조회 0', dead.length);
  console.log('  (비공개 중 소유권 매칭 %d — 매칭은 공개를 막을 사유가 아니다)',
    priv.filter((r) => r.licensed).length);
  console.log('\n-- 풀어도 되는 것 (최근 15) --');
  for (const r of safe.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 15)) {
    console.log('  %s %s 조회%s %s%s', r.at.slice(0, 10), r.id,
      String(r.views).padStart(6), r.licensed ? '매칭 ' : '     ', r.title.slice(0, 34));
  }
  console.log('\n-- 차단돼서 두는 것 (최근 10) --');
  for (const r of dead.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 10)) {
    console.log('  %s %s %s개국%s %s', r.at.slice(0, 10), r.id,
      String(r.blocked).padStart(3), r.worldwide ? '(전세계)' : '      ', r.title.slice(0, 32));
  }
})().catch((e) => { console.error('[inv]', e.message); process.exit(1); });

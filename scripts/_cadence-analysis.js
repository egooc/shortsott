// 「편수를 올려서 조회가 떨어졌나」를 가른다.
//
//   node scripts/_cadence-analysis.js <purpose> [최대개수]
//
// 왜 평균으로는 안 되나: 월평균 조회수는 «죽은 편»이 섞이면 편수와 무관하게 내려간다.
// ja 는 차단·소유권매칭 편이 많아서 평균이 그쪽에 끌려간다. 그래서 세 가지를 따로 본다 —
//   1) 중앙값 (죽은 편에 덜 끌린다)
//   2) 상위 1편·상위 20% (알고리즘이 집어 올린 편이 있었는지)
//   3) 깨끗한 편(차단X·매칭X)만의 성적 (편수 효과를 소재 효과와 분리)
// 「알고리즘 받을 때 몰아친다」가 성립하려면 상위편이 나온 달의 **다음 달**이 좋아야 한다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');

async function accessToken(p) {
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
  if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
  return j;
}
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

(async () => {
  const purpose = process.argv[2];
  const cap = Number(process.argv[3] || 400);
  const store = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  const list = Array.isArray(store) ? store : (store.profiles || []);
  const profile = list.find((p) => p.purpose === purpose);
  if (!profile) { console.error('프로필 없음: ' + purpose); process.exit(2); }
  const tk = await accessToken(profile);

  const ch = await api(tk, 'https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet,statistics&mine=true');
  const me = ch.items[0];
  console.log('%s (%s) — 구독 %s', me.snippet.title, purpose, me.statistics.subscriberCount);

  const uploads = me.contentDetails.relatedPlaylists.uploads;
  const ids = [];
  let pt = '';
  while (ids.length < cap) {
    const pl = await api(tk, `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}${pt ? '&pageToken=' + pt : ''}`);
    for (const it of pl.items || []) ids.push(it.contentDetails.videoId);
    if (!pl.nextPageToken) break;
    pt = pl.nextPageToken;
  }
  const rows = [];
  for (let i = 0; i < ids.length; i += 50) {
    const v = await api(tk, `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails,status&id=${ids.slice(i, i + 50).join(',')}`);
    for (const it of v.items || []) {
      const blocked = ((it.contentDetails || {}).regionRestriction || {}).blocked || [];
      rows.push({
        id: it.id, at: it.snippet.publishedAt, title: it.snippet.title,
        views: Number(it.statistics.viewCount || 0),
        likes: Number(it.statistics.likeCount || 0),
        licensed: it.contentDetails.licensedContent === true,
        blocked: blocked.length, privacy: it.status.privacyStatus
      });
    }
  }
  // 공개된 편만 성적을 재는 대상이다 — 비공개는 노출 기회가 없었다
  const pub = rows.filter((r) => r.privacy === 'public');

  const by = new Map();
  for (const r of pub) {
    const k = r.at.slice(0, 7);
    const g = by.get(k) || { all: [], clean: [], lic: 0, blk: 0 };
    g.all.push(r.views);
    if (!r.licensed && !r.blocked) g.clean.push(r.views);
    if (r.licensed) g.lic += 1;
    if (r.blocked) g.blk += 1;
    by.set(k, g);
  }
  const months = [...by.entries()].sort();

  console.log('\n월       공개  매칭  평균     중앙값   최고      상위20%평균  깨끗한편  깨끗한편중앙값');
  for (const [k, g] of months) {
    const top = [...g.all].sort((a, b) => b - a).slice(0, Math.max(1, Math.ceil(g.all.length * 0.2)));
    console.log([
      k,
      String(g.all.length).padStart(5),
      String(g.lic).padStart(5),
      String(Math.round(g.all.reduce((s, v) => s + v, 0) / g.all.length)).padStart(8),
      String(median(g.all)).padStart(8),
      String(Math.max(...g.all)).padStart(9),
      String(Math.round(top.reduce((s, v) => s + v, 0) / top.length)).padStart(12),
      String(g.clean.length).padStart(9),
      String(median(g.clean)).padStart(15)
    ].join(' '));
  }

  // 「몰아치기」검증: 상위편이 나온 달 다음 달이 실제로 좋았나
  console.log('\n-- 몰아치기 검증: 최고 조회 편이 나온 달과 그 다음 달 --');
  for (let i = 0; i < months.length - 1; i++) {
    const [k, g] = months[i];
    const [k2, g2] = months[i + 1];
    const peak = Math.max(...g.all);
    if (peak < 5000) continue;   // 알고리즘이 집어 올렸다고 볼 만한 편이 있었던 달만
    console.log('  %s 최고 %s회(%d편) → %s 중앙값 %s회(%d편) %s',
      k, peak.toLocaleString(), g.all.length, k2, median(g2.all).toLocaleString(), g2.all.length,
      median(g2.all) > median(g.all) ? '올랐다' : '내렸다');
  }

  // 편수 대 중앙값의 관계 (상관)
  const xs = months.map(([, g]) => g.all.length);
  const ys = months.map(([, g]) => median(g.all));
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
  const r = num / Math.sqrt(dx * dy || 1);
  console.log('\n월 편수 ↔ 월 중앙값 상관 r = %s (%d개월)', r.toFixed(2), months.length);
  console.log('  ★상관은 인과가 아니다. 편수를 올린 달에 소재·언어도 같이 바뀌었으면 이 값은 둘을 섞는다.');

  // 최근 편들이 아직 자라는 중인지 — 최근 7일 편은 성적 확정이 아니다
  const now = Date.now();
  const fresh = pub.filter((x) => now - Date.parse(x.at) < 7 * 864e5);
  console.log('\n최근 7일 공개 %d편 — 아직 자라는 중이라 위 집계에서 성적 미확정', fresh.length);
  for (const x of fresh.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 12)) {
    console.log('  %s %s %s회 %s%s', x.at.slice(0, 10), x.id,
      String(x.views).padStart(6), x.licensed ? '매칭 ' : '     ', x.title.slice(0, 34));
  }
})().catch((e) => { console.error('[cadence]', e.message); process.exit(1); });

// Recent view counts per channel, straight from YouTube.
//
// "no views" needs a number before it can be diagnosed: a channel that averages
// 40 is a different problem from one that averages 800, and the two channels here
// are only comparable once both are measured the same way.
//
//   node scripts/ops/channel-views.js [jp|kr|both] [--limit 25]
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { OAuth2Client } = require(path.join(ROOT, 'node_modules', 'google-auth-library'));

const which = (process.argv[2] || 'both').toLowerCase();
const limitIdx = process.argv.indexOf('--limit');
const limit = limitIdx > -1 ? Number(process.argv[limitIdx + 1]) : 25;

function profileFor(prefix) {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json'), 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.profiles || []);
  return list.find((p) => String(p.purpose || '').startsWith(prefix) && p.refreshToken) || null;
}

async function report(label, prefix) {
  const profile = profileFor(prefix);
  if (!profile) { console.log(`${label}: 프로필 없음`); return; }
  const client = new OAuth2Client(profile.oauthClientId, profile.oauthClientSecret, profile.oauthRedirectUri);
  client.setCredentials({ refresh_token: profile.refreshToken });
  const tok = await client.getAccessToken();
  const headers = { Authorization: `Bearer ${typeof tok === 'string' ? tok : tok?.token}` };

  const ch = await (await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true', { headers })).json();
  const info = ch.items?.[0];
  if (!info) { console.log(`${label}: 채널 조회 실패`); return; }
  const stats = info.statistics || {};
  console.log(`\n=== ${label}: ${info.snippet?.title} (${profile.name || ''}) ===`);
  console.log(`구독자 ${stats.subscriberCount} | 총 영상 ${stats.videoCount} | 총 조회 ${stats.viewCount}`);

  const uploads = info.contentDetails?.relatedPlaylists?.uploads;
  const pl = await (await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=${Math.min(50, limit)}&playlistId=${uploads}`, { headers })).json();
  const ids = (pl.items || []).map((i) => i.contentDetails.videoId);
  if (!ids.length) { console.log('최근 영상 없음'); return; }

  const vids = await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${ids.join(',')}`, { headers })).json();
  const rows = (vids.items || []).map((v) => ({
    at: v.snippet.publishedAt,
    title: v.snippet.title,
    views: Number(v.statistics?.viewCount || 0),
    likes: Number(v.statistics?.likeCount || 0)
  })).sort((a, b) => String(b.at).localeCompare(String(a.at)));

  rows.forEach((r) => console.log(`  ${String(r.at).slice(5, 16)} ${String(r.views).padStart(6)}회 ♥${String(r.likes).padStart(3)} | ${r.title.slice(0, 44)}`));
  const views = rows.map((r) => r.views).sort((a, b) => a - b);
  const total = views.reduce((s, v) => s + v, 0);
  const median = views[Math.floor(views.length / 2)];
  console.log(`  -- ${rows.length}편 | 평균 ${Math.round(total / rows.length)} | 중앙값 ${median} | 최대 ${views[views.length - 1]} | 최소 ${views[0]}`);
}

(async () => {
  if (which === 'jp' || which === 'both') await report('JP', 'jp');
  if (which === 'kr' || which === 'both') await report('KR', 'ko');
})().catch((e) => console.error('FAILED', String(e.message || e).slice(0, 200)));

// 정치 채널 배너·소개 갱신: node yt_branding.js [--banner banner.png] [--desc desc.txt] [--dry-run]
// 채널 이름·핸들·프로필 사진은 API 로 못 바꾼다(스튜디오에서 사람이).
const fs = require('fs');
const { OAuth2Client } = require('D:/midform/node_modules/google-auth-library');
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
(async () => {
  const p = JSON.parse(fs.readFileSync('D:/midform/server/data/youtube_upload_profiles.json', 'utf8')).profiles.find((x) => x.purpose === 'politics');
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  const H = { Authorization: `Bearer ${(await c.getAccessToken()).token}` };
  const ch = (await (await fetch('https://www.googleapis.com/youtube/v3/channels?part=brandingSettings&mine=true', { headers: H })).json()).items[0];
  if (ch.id !== p.channelId) throw new Error('채널 불일치');
  const bs = ch.brandingSettings;
  console.log('[now] desc:', (bs.channel.description || '').slice(0, 300));
  if (process.argv.includes('--dry-run')) return;
  if (arg('--banner')) {
    const r = await fetch('https://www.googleapis.com/upload/youtube/v3/channelBanners/insert', { method: 'POST', headers: { ...H, 'Content-Type': 'image/png' }, body: fs.readFileSync(arg('--banner')) });
    const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 300));
    bs.image = { bannerExternalUrl: j.url };
  }
  if (arg('--desc')) bs.channel.description = fs.readFileSync(arg('--desc'), 'utf8').trim();
  const u = await fetch('https://www.googleapis.com/youtube/v3/channels?part=brandingSettings', { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: ch.id, brandingSettings: { channel: bs.channel, image: bs.image } }) });
  console.log(u.ok ? '[ok] 갱신' : `[fail] ${u.status} ${(await u.text()).slice(0, 300)}`);
})().catch((e) => { console.error(e.message); process.exit(1); });

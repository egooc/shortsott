// 15분 넘는 영상은 채널 longUploadsStatus 가 «allowed» 일 때만 올린다(10-24 1편 28WKU7aG9N0 사고: «eligible» 을 인증 끝으로 오독 →
// 25.9분 업로드가 곧바로 «Deleted video». eligible = 켤 수 있음·아직 안 켜짐, allowed = 전화 인증 끝). 토큰 값은 찍지 않는다.
//
//   node ja-nenkin/render/long_upload_check.js <purpose> <영상 파일>      통과 0 · 막힘 4
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const { OAuth2Client } = require(path.join(ROOT, 'node_modules', 'google-auth-library'));

(async () => {
  const [purpose, file] = process.argv.slice(2);
  if (!purpose || !file) throw new Error('usage: node ja-nenkin/render/long_upload_check.js <purpose> <file>');
  const sec = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }));
  const store = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json'), 'utf8'));
  const p = store.profiles.find((x) => x.purpose === purpose);
  if (!p) throw new Error(`업로드 프로필 없음: ${purpose}`);
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  const H = { Authorization: `Bearer ${(await c.getAccessToken()).token}` };
  const ch = (await (await fetch('https://www.googleapis.com/youtube/v3/channels?part=status&mine=true', { headers: H })).json()).items[0];
  const st = ch.status.longUploadsStatus;
  const ok = sec <= 15 * 60 || st === 'allowed';
  console.log(`긴 영상 ${(sec / 60).toFixed(1)}분 · longUploadsStatus ${st} → ${ok ? '통과' : '막힘(15분 넘는데 allowed 아님 — 전화 인증 youtube.com/verify 뒤에)'}`);
  process.exit(ok ? 0 : 4);
})().catch((e) => { console.error('ERR', e.message); process.exit(4); });

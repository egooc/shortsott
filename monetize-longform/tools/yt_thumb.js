// 수창 롱폼: 올라간 영상에 썸네일만 다시 올린다 — 어느 업로드 프로필이든 --purpose 로.
// (10-24 00:3x: 야생일지·로보토리 채널이 전화 인증 전이라 업로드 때 thumbnails/set 이 403 — 인증 뒤 이 도구로 다시 설정.)
//
//   node monetize-longform/tools/yt_thumb.js <videoId> <upload.json> --purpose <p> [--file <png|jpg>]
// 종료 코드: 0 설정됨 · 1 오류(403 = 채널 맞춤 썸네일 권한 없음 → 소유주 전화 인증 필요). upload.json 옆 upload_log.jsonl 에 한 줄.
const fs = require('fs');
const path = require('path');
const { OAuth2Client } = require(path.join('D:/midform', 'node_modules', 'google-auth-library'));

(async () => {
  const a = process.argv.slice(2);
  const [videoId, metaPath] = a;
  const purpose = a[a.indexOf('--purpose') + 1];
  if (!videoId || !metaPath || !a.includes('--purpose') || !purpose) throw new Error('usage: yt_thumb.js <videoId> <upload.json> --purpose <p> [--file <img>]');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const file = a.includes('--file') ? a[a.indexOf('--file') + 1] : meta.thumbnail;
  if (!file || !fs.existsSync(file)) throw new Error(`썸네일 파일 없음: ${file}`);
  const store = JSON.parse(fs.readFileSync('D:/midform/server/data/youtube_upload_profiles.json', 'utf8'));
  const p = store.profiles.find((x) => x.purpose === purpose);
  if (!p) throw new Error(`업로드 프로필 없음: ${purpose}`);
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  const token = (await c.getAccessToken()).token;
  const img = fs.readFileSync(file);
  const r = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg' }, body: img,
  });
  const text = await r.text();
  const line = { at: new Date().toISOString(), action: 'thumbnail', videoId, file, ok: r.ok, status: r.status };
  fs.appendFileSync(path.join(path.dirname(metaPath), 'upload_log.jsonl'), JSON.stringify(line) + '\n');
  if (!r.ok) { console.log(`[thumb] 실패 ${r.status}: ${text.slice(0, 200)}`); process.exit(1); }
  console.log(`[thumb] 설정됨 ${videoId} ← ${path.basename(file)}`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });

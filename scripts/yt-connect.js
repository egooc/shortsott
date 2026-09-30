// 새 유튜브 채널을 업로드 프로필로 연결한다(기존 프로필은 건드리지 않는다).
//
//   node scripts/yt-connect.js <purpose> [--chrome-profile "Profile 6"] [--timeout-min 10]
//   node scripts/yt-connect.js <purpose> --url-only
//   node scripts/yt-connect.js <purpose> --code "<콜백 주소 또는 code>"
//
// 같은 구글 OAuth 앱(기존 프로필의 client id/secret, redirect 3001)을 쓰고, 로그인한 계정의 채널을 새 프로필로
// youtube_upload_profiles.json 에 추가한다. 이미 있는 채널 id 면 저장하지 않는다(채널을 잘못 고른 경우를 막는다).
// 한 구글 계정에 채널이 여러 개면 동의 화면의 "채널 선택"에서 어랍숏 채널을 고를 것.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { OAuth2Client } = require('google-auth-library');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly'
];
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };

async function save(store, base, purpose, client, code) {
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new Error('refresh_token 이 오지 않았다 — 구글 계정에서 앱 접근 권한을 해제하고 다시');
  const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  });
  const ch = ((await r.json()).items || [])[0];
  if (!ch) throw new Error('이 계정에 유튜브 채널이 없다');
  const dup = store.profiles.find((p) => p.channelId === ch.id);
  if (dup) throw new Error(`이미 연결된 채널이다: ${ch.snippet.title} (${ch.id}) = 프로필 ${dup.id}. 저장하지 않음 — 다른 채널을 골라라`);
  const now = new Date().toISOString();
  store.profiles.push({
    id: `channel_${ch.id.slice(-8).toLowerCase()}`, name: ch.snippet.title, purpose,
    refreshToken: tokens.refresh_token, channelTitle: ch.snippet.title, channelId: ch.id,
    createdAt: now, updatedAt: now, oauthClientId: base.oauthClientId, oauthClientSecret: base.oauthClientSecret,
    oauthRedirectUri: base.oauthRedirectUri, scopes: SCOPES,
  });
  fs.copyFileSync(PROFILES, `${PROFILES}.bak-${Date.now()}`);
  fs.writeFileSync(PROFILES, JSON.stringify(store, null, 2));
  return { title: ch.snippet.title, id: ch.id, subs: (ch.statistics || {}).subscriberCount, videos: (ch.statistics || {}).videoCount };
}

async function main() {
  const purpose = process.argv[2];
  if (!purpose || purpose.startsWith('--')) throw new Error('usage: node scripts/yt-connect.js <purpose>');
  const store = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  if (store.profiles.some((p) => p.purpose === purpose)) throw new Error(`purpose ${purpose} 프로필이 이미 있다 — 토큰 갱신은 yt-reauth.js`);
  const base = store.profiles[0];
  const redirect = new URL(base.oauthRedirectUri);
  const client = new OAuth2Client(base.oauthClientId, base.oauthClientSecret, redirect.toString());
  const authUrl = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent select_account', scope: SCOPES });
  const pasted = arg('--code', '');
  if (pasted) {
    let code = pasted.includes('code=') ? new URL(pasted).searchParams.get('code') : pasted;
    const r = await save(store, base, purpose, client, decodeURIComponent(code));
    return console.log(`[connect] 저장: ${purpose} → ${r.title} (${r.id}) · 구독 ${r.subs} · 영상 ${r.videos}`);
  }
  if (process.argv.includes('--url-only')) return console.log(authUrl);
  const timeoutMin = Number(arg('--timeout-min', '10'));
  const r = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, redirect.origin);
      if (url.pathname !== redirect.pathname) { res.statusCode = 404; return res.end('not the callback path'); }
      const code = url.searchParams.get('code');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (!code) { res.statusCode = 400; res.end(`코드 없음: ${url.searchParams.get('error') || ''}`); return; }
      try {
        const out = await save(store, base, purpose, client, code);
        res.end(`<h2>연결 완료: ${out.title}</h2><p>이 창은 닫아도 됩니다.</p>`);
        resolve(out);
      } catch (e) { res.statusCode = 500; res.end(`실패: ${e.message}`); reject(e); }
      finally { setTimeout(() => server.close(), 500); }
    });
    server.on('error', reject);
    server.listen(Number(redirect.port || 80), () => {
      console.log(`[connect] ${redirect} 에서 대기 (${timeoutMin}분)\n${authUrl}\n`);
      const prof = arg('--chrome-profile', null);
      try { spawn(CHROME, [...(prof ? [`--profile-directory=${prof}`] : []), authUrl], { detached: true, stdio: 'ignore' }).unref(); }
      catch (e) { console.log(`크롬을 못 열었다(${e.message}) — 위 주소를 직접 열어라`); }
    });
    setTimeout(() => { server.close(); reject(new Error(`${timeoutMin}분 안에 콜백이 없었다`)); }, timeoutMin * 60 * 1000);
  });
  console.log(`[connect] 저장: ${purpose} → ${r.title} (${r.id}) · 구독 ${r.subs} · 영상 ${r.videos}`);
}

main().catch((e) => { console.error(`[connect] ${e.message}`); process.exit(1); });

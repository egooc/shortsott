// Re-issue a YouTube upload profile's refresh token with a wider scope set.
//
//   node scripts/yt-reauth.js <jp_highlight|ko_highlight> [--chrome-profile "Profile 9"] [--timeout-min 10]
//   node scripts/yt-reauth.js <purpose> --url-only            (print the consent URL; open it anywhere)
//   node scripts/yt-reauth.js <purpose> --code "<pasted callback URL or code>"
//
// Why: the stored tokens carry youtube.upload + youtube.readonly only, so videos.update (needed to pull a
// scheduled publish off a Content-ID-blocked video, check-claims.js --unschedule) answers 403. This script
// asks for youtube.force-ssl as well, keeps the same profile id/purpose/channel, and only overwrites the
// refresh token after the returned channelId matches the stored one (never swap channels by accident).
// Redirect URI must stay the one registered in the Google console (port 3001 path below).
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

function arg(name, fallback) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; }

// Paste-the-code path: when the browser cannot reach this machine's localhost callback (remote/phone), the
// consent still ends at a "site can't be reached" page whose ADDRESS BAR carries ?code=... — paste that whole
// URL (or just the code) here and the exchange happens locally. 2026-09-18: added because RustDesk was down.
async function exchangePastedCode(profile, store, raw) {
  const redirect = new URL(profile.oauthRedirectUri || 'http://localhost:3001/api/youtube-upload/oauth/callback');
  const client = new OAuth2Client(profile.oauthClientId, profile.oauthClientSecret, redirect.toString());
  let code = String(raw).trim();
  if (code.includes('code=')) { try { code = new URL(code).searchParams.get('code'); } catch { code = (code.split('code=')[1] || '').split('&')[0]; } }
  code = decodeURIComponent(code);
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new Error('Google returned no refresh_token — revoke the app in the Google account, then redo consent');
  const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  const ch = ((await r.json()).items || [])[0] || {};
  if (profile.channelId && ch.id !== profile.channelId) throw new Error(`signed-in channel ${ch.id} (${(ch.snippet || {}).title}) != stored ${profile.channelId}; token NOT saved`);
  profile.refreshToken = tokens.refresh_token; profile.scopes = SCOPES;
  profile.channelTitle = (ch.snippet || {}).title || profile.channelTitle; profile.updatedAt = new Date().toISOString();
  fs.copyFileSync(PROFILES, `${PROFILES}.bak-${Date.now()}`);
  fs.writeFileSync(PROFILES, JSON.stringify(store, null, 2));
  console.log(`[reauth] saved: ${profile.purpose} -> ${profile.channelTitle} (${ch.id}) with force-ssl`);
}

async function main() {
  const purpose = process.argv[2];
  if (!purpose) throw new Error('usage: node scripts/yt-reauth.js <jp_highlight|ko_highlight> [--chrome-profile "Profile 9"]');
  const chromeProfile = arg('--chrome-profile', purpose === 'jp_highlight' ? 'Profile 9' : 'Profile 6');
  const timeoutMin = Number(arg('--timeout-min', '10'));
  const store = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  const profile = (store.profiles || []).find((p) => p.purpose === purpose);
  if (!profile) throw new Error(`no profile with purpose ${purpose}`);
  const redirect = new URL(profile.oauthRedirectUri || 'http://localhost:3001/api/youtube-upload/oauth/callback');
  const client = new OAuth2Client(profile.oauthClientId, profile.oauthClientSecret, redirect.toString());
  const authUrl = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent select_account', scope: SCOPES });

  const pasted = arg('--code', '');
  if (pasted) return exchangePastedCode(profile, store, pasted);
  if (process.argv.includes('--url-only')) { console.log(authUrl); return; }

  const result = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, redirect.origin);
      if (url.pathname !== redirect.pathname) { res.statusCode = 404; res.end('not the callback path'); return; }
      const code = url.searchParams.get('code');
      if (!code) { res.statusCode = 400; res.end(`no code: ${url.searchParams.get('error') || ''}`); return; }
      try {
        const { tokens } = await client.getToken(code);
        if (!tokens.refresh_token) throw new Error('Google returned no refresh_token (revoke app access in the Google account and retry)');
        client.setCredentials(tokens);
        const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
          headers: { Authorization: `Bearer ${tokens.access_token}` }
        });
        const data = await r.json();
        const ch = (data.items || [])[0] || {};
        if (profile.channelId && ch.id !== profile.channelId) {
          throw new Error(`signed-in channel ${ch.id} (${(ch.snippet || {}).title}) != stored ${profile.channelId}; token NOT saved — log in with the right account`);
        }
        profile.refreshToken = tokens.refresh_token;
        profile.scopes = SCOPES;
        profile.channelTitle = (ch.snippet || {}).title || profile.channelTitle;
        profile.updatedAt = new Date().toISOString();
        fs.copyFileSync(PROFILES, `${PROFILES}.bak-${Date.now()}`);
        fs.writeFileSync(PROFILES, JSON.stringify(store, null, 2));
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<h2>연결 완료: ${profile.channelTitle}</h2><p>force-ssl 스코프로 토큰을 갱신했습니다. 이 창은 닫아도 됩니다.</p>`);
        resolve({ channel: profile.channelTitle, id: ch.id });
      } catch (e) {
        res.statusCode = 500; res.end(`실패: ${e.message}`); reject(e);
      } finally { setTimeout(() => server.close(), 500); }
    });
    server.on('error', reject);
    server.listen(Number(redirect.port || 80), () => {
      console.log(`[reauth] waiting on ${redirect.toString()} (${timeoutMin} min)`);
      console.log(`[reauth] auth url:\n${authUrl}\n`);
      try { spawn(CHROME, [`--profile-directory=${chromeProfile}`, authUrl], { detached: true, stdio: 'ignore' }).unref(); }
      catch (e) { console.log(`[reauth] could not launch Chrome (${e.message}); open the URL above by hand`); }
    });
    setTimeout(() => { server.close(); reject(new Error(`timed out after ${timeoutMin} min without a callback`)); }, timeoutMin * 60 * 1000);
  });
  console.log(`[reauth] saved: ${purpose} -> ${result.channel} (${result.id}) with force-ssl`);
}

main().catch((e) => { console.error(`[reauth] ${e.message}`); process.exit(1); });

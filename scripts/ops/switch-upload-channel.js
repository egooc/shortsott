// Move a channel's uploads to a different YouTube channel.
//
// Three steps, and the middle one is yours: this prints a consent URL, you
// approve it in a browser, and the callback stores the new channel's refresh
// token as its own profile. The old profile is kept - never overwritten - and
// marked retired so the hourly uploader stops choosing it.
//
//   node scripts/ops/switch-upload-channel.js kr --url        # get the consent link
//   node scripts/ops/switch-upload-channel.js kr --status      # what is connected now
//   node scripts/ops/switch-upload-channel.js kr --retire <profileId>
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') });

const svc = require('../../server/services/youtubeUploadService');

const channel = (process.argv[2] || '').toLowerCase();
if (!['kr', 'jp'].includes(channel)) {
  console.log('사용법: node scripts/ops/switch-upload-channel.js <kr|jp> [--status|--url|--retire <profileId>]');
  process.exitCode = 1;
  return;
}
const prefix = channel === 'kr' ? 'ko' : 'jp';

function profiles() {
  const raw = svc.listYouTubeUploadProfiles();
  const list = Array.isArray(raw) ? raw : (raw.profiles || []);
  return list.filter((p) => String(p.purpose || '').startsWith(prefix));
}

function showStatus() {
  const list = profiles();
  console.log(`${channel.toUpperCase()} 프로필 ${list.length}개`);
  for (const p of list) {
    const flags = [
      p.hasRefreshToken ? '연결됨' : '미연결',
      p.retired ? '은퇴' : '사용중'
    ].join(' / ');
    console.log(`  ${p.id} | ${flags} | ${p.channelTitle || '(제목 없음)'} | name: ${p.name || '-'} | updated ${p.updatedAt || p.createdAt || '-'}`);
  }
  const active = list.filter((p) => p.hasRefreshToken && p.retired !== true);
  console.log(`\n업로더가 쓸 프로필: ${active.length ? (active[0].channelTitle || active[0].id) : '없음'}`);
  if (active.length > 1) console.log('연결된 프로필이 둘 이상입니다 - 최신 것이 쓰이고, 나머지는 --retire 로 정리하세요.');
}

if (process.argv.includes('--status')) { showStatus(); return; }

if (process.argv.includes('--retire')) {
  const id = process.argv[process.argv.indexOf('--retire') + 1];
  if (!id) { console.log('--retire <profileId> 가 필요합니다.'); process.exitCode = 1; return; }
  svc.updateYouTubeUploadProfile(id, { retired: true });
  console.log(`${id} 을 은퇴 처리했습니다.`);
  showStatus();
  return;
}

// The consent redirect goes to localhost, which only resolves on the machine
// running the server - approving on a phone gives ERR_CONNECTION_REFUSED even
// though the flow succeeded (2026-08-18). The authorization code is in the URL
// the browser failed to load, so paste that URL here and the exchange happens
// server-side.
if (process.argv.includes('--code')) {
  const raw = process.argv[process.argv.indexOf('--code') + 1] || '';
  if (!raw) { console.log('--code <붙여넣은 주소 또는 code 값> 이 필요합니다.'); process.exitCode = 1; return; }
  let code = raw;
  let state = '';
  if (raw.includes('code=')) {
    try {
      const u = new URL(raw.startsWith('http') ? raw : `http://localhost:3001/${raw.replace(/^\/+/, '')}`);
      code = u.searchParams.get('code') || '';
      state = u.searchParams.get('state') || '';
    } catch {
      const m = raw.match(/[?&]code=([^&\s]+)/);
      const s = raw.match(/[?&]state=([^&\s]+)/);
      code = m ? decodeURIComponent(m[1]) : raw;
      state = s ? decodeURIComponent(s[1]) : '';
    }
  }
  if (!code) { console.log('주소에서 code 를 찾지 못했습니다.'); process.exitCode = 1; return; }
  console.log(`code ${code.slice(0, 12)}... / state ${state ? '있음' : '없음'} 로 교환합니다.`);
  svc.exchangeOAuthCode(code, state)
    .then((result) => {
      console.log('연결 완료:', JSON.stringify(result).slice(0, 200));
      showStatus();
    })
    .catch((e) => {
      console.log('교환 실패:', String(e.message || e).slice(0, 240));
      console.log('code 는 한 번만 쓸 수 있고 몇 분 뒤 만료됩니다 - 실패하면 --url 로 새 링크를 받아 다시 승인하세요.');
      process.exitCode = 1;
    });
  return;
}

if (process.argv.includes('--url')) {
  // Reuse an existing profile's OAuth client: the consent flow needs a client id
  // and secret, and the same app can authorize a different channel. Which
  // channel the token ends up for is decided by the account picked on the consent
  // screen, not here.
  const source = profiles().find((p) => p.oauthClientConfigured) || profiles()[0];
  if (!source) { console.log(`${channel.toUpperCase()} 프로필이 없어 OAuth 클라이언트를 재사용할 수 없습니다.`); process.exitCode = 1; return; }
  const r = svc.getAuthorizationUrl({ profileId: source.id, profileName: `${channel.toUpperCase()} 신규 채널` });
  console.log(`OAuth 클라이언트: ${source.channelTitle || source.id} 의 것을 재사용합니다.`);
  console.log('\n아래 링크를 브라우저에서 열고, 바꿀 채널의 계정으로 승인하세요:\n');
  console.log(r.authUrl);
  console.log(`\n요청 권한: ${(r.scopes || []).join(' ')}`);
  console.log('\n주의: 승인 화면에서 반드시 새 채널을 선택하세요. 기존 채널로 승인하면 같은 프로필이 갱신될 뿐 전환되지 않습니다.');
  console.log('승인 후: node scripts/ops/switch-upload-channel.js ' + channel + ' --status');
  return;
}

showStatus();

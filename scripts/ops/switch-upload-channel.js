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

// 유튜브 OAuth 토큰이 살아 있는지, 어떤 권한을 갖고 있는지 확인한다.
//
//   node scripts/_token-check.js
//
// 왜: 발행이 막히면 «토큰 만료» 인지 «스코프 부족» 인지 «다른 이유» 인지부터 갈라야 한다.
// 삭제(videos.delete)는 youtube.force-ssl 이 있어야 한다 — 그게 없으면 삭제 요청이 403 이 난다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');

async function check(p) {
  const out = { purpose: p.purpose, name: p.name || '', channel: p.channelTitle || '' };
  const body = new URLSearchParams({
    client_id: p.oauthClientId, client_secret: p.oauthClientSecret,
    refresh_token: p.refreshToken, grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }
  });
  const j = await r.json();
  if (!j.access_token) {
    out.alive = false;
    out.error = (j.error || '') + ' ' + (j.error_description || '');
    return out;
  }
  out.alive = true;
  out.expires_in = j.expires_in;
  // tokeninfo 로 실제 부여된 스코프를 읽는다 (저장된 scopes 값은 낡을 수 있다)
  const ti = await (await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + j.access_token)).json();
  out.scopes = (ti.scope || '').split(/\s+/).filter(Boolean).map((s) => s.replace('https://www.googleapis.com/auth/', ''));
  // 실제로 채널을 읽어 본다 — 토큰이 살아도 채널 접근이 막힐 수 있다
  const ch = await (await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,status&mine=true',
    { headers: { authorization: 'Bearer ' + j.access_token } })).json();
  if (ch.error) { out.channelError = JSON.stringify(ch.error).slice(0, 160); return out; }
  const me = (ch.items || [])[0] || {};
  out.channelTitle = (me.snippet || {}).title;
  out.subs = (me.statistics || {}).subscriberCount;
  out.videos = (me.statistics || {}).videoCount;
  out.monetized = (me.status || {}).isChannelMonetizationEnabled;
  return out;
}

(async () => {
  const store = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  const list = Array.isArray(store) ? store : (store.profiles || []);
  console.log('프로필 %d개\n', list.length);
  for (const p of list) {
    const r = await check(p);
    console.log('■ %s  (%s)', r.purpose, r.name || r.channel);
    if (!r.alive) { console.log('   ✗ 토큰 죽음: %s', r.error); continue; }
    console.log('   ✓ 살아 있음 · 액세스 토큰 %d초 유효', r.expires_in);
    if (r.channelError) console.log('   ✗ 채널 조회 실패: %s', r.channelError);
    else console.log('   채널 %s · 구독 %s · 영상 %s · 수익화 %s',
      r.channelTitle, r.subs, r.videos, r.monetized);
    console.log('   스코프: %s', r.scopes.join(', ') || '(없음)');
    const canDelete = r.scopes.includes('youtube.force-ssl');
    const canUpload = r.scopes.includes('youtube.upload') || r.scopes.includes('youtube') || canDelete;
    console.log('   업로드 %s · 삭제/수정 %s',
      canUpload ? '가능' : '★불가', canDelete ? '가능' : '★불가(youtube.force-ssl 없음)');
    console.log('');
  }
})().catch((e) => { console.error('[token]', e.message); process.exit(1); });

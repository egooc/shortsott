// 채널 정리 — 소유주 지시(2026-09-30)
//   · 차단(regionRestriction)된 편은 **삭제**한다. 공개해도 조회가 0이라 남길 이유가 없다.
//   · 차단 안 된 비공개 편은 **공개**한다. 소유권 매칭(licensedContent)은 공개를 막을 사유가 아니다
//     — 2026-06 에 매칭 100% 인 채로 편당 8,288회가 나왔다.
//   · 테스트용 probe 업로드는 내용물이 아니므로 **삭제**한다.
//
//   node scripts/_channel-cleanup.js <purpose>                         대상만 보여준다(기본 안전)
//   node scripts/_channel-cleanup.js <purpose> --apply --delete        차단·probe 삭제만
//   node scripts/_channel-cleanup.js <purpose> --apply --publish       비공개 해제만
//   node scripts/_channel-cleanup.js <purpose> --apply --delete --publish  둘 다
//
// 왜 갈라 놨나: ja 의 비공개 중 차단 안 된 22편은 드라마가 아니라 «채널 이전 시대»
// 콘텐츠였다(영어 크리켓 뉴스·한국 공예 쇼츠). 삭제와 공개는 판단이 다르므로 따로 실행한다.
//
// ★삭제는 되돌릴 수 없다. --apply 는 소유주가 명시적으로 지시했을 때만 쓴다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const LOG = path.join(ROOT, 'server', 'output', 'channel-cleanup');
const PROBE = /^probe\s/i;

async function token(p) {
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
const api = async (tk, url, init) => {
  const r = await fetch(url, { ...(init || {}), headers: { authorization: 'Bearer ' + tk, ...((init || {}).headers || {}) } });
  if (r.status === 204) return { ok: true };
  const j = await r.json().catch(() => ({}));
  if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 180));
  return j;
};

(async () => {
  const purpose = process.argv[2];
  const apply = process.argv.includes('--apply');
  const doDelete = process.argv.includes('--delete');
  const doPublish = process.argv.includes('--publish');
  if (apply && !doDelete && !doPublish) {
    console.error('--apply 에는 --delete 또는 --publish 를 함께 줘야 한다');
    process.exit(2);
  }
  const store = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  const list = Array.isArray(store) ? store : (store.profiles || []);
  const p = list.find((x) => x.purpose === purpose);
  if (!p) { console.error('프로필 없음: ' + purpose); process.exit(2); }
  const tk = await token(p);
  const ch = await api(tk, 'https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&mine=true');
  const up = ch.items[0].contentDetails.relatedPlaylists.uploads;
  console.log('채널: %s (%s)', ch.items[0].snippet.title, purpose);

  const ids = [];
  let pt = '';
  while (ids.length < 600) {
    const pl = await api(tk, `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${up}${pt ? '&pageToken=' + pt : ''}`);
    for (const it of pl.items || []) ids.push(it.contentDetails.videoId);
    if (!pl.nextPageToken) break;
    pt = pl.nextPageToken;
  }
  const rows = [];
  for (let i = 0; i < ids.length; i += 50) {
    const v = await api(tk, `https://www.googleapis.com/youtube/v3/videos?part=snippet,status,statistics,contentDetails&id=${ids.slice(i, i + 50).join(',')}`);
    for (const it of v.items || []) {
      const blocked = ((it.contentDetails || {}).regionRestriction || {}).blocked || [];
      rows.push({
        id: it.id, at: it.snippet.publishedAt, title: it.snippet.title,
        privacy: it.status.privacyStatus, status: it.status,
        views: Number(it.statistics.viewCount || 0), blocked: blocked.length
      });
    }
  }

  const toDelete = rows.filter((r) => r.blocked > 0 || PROBE.test(r.title));
  const toPublish = rows.filter((r) => r.privacy !== 'public' && r.blocked === 0 && !PROBE.test(r.title));
  console.log('전체 %d편', rows.length);
  console.log('  삭제 대상 %d편 (차단 %d · probe %d)  ★되돌릴 수 없다',
    toDelete.length, toDelete.filter((r) => r.blocked > 0).length,
    toDelete.filter((r) => PROBE.test(r.title)).length);
  console.log('    그중 현재 공개 중: %d편 (누적 조회 %d)',
    toDelete.filter((r) => r.privacy === 'public').length,
    toDelete.filter((r) => r.privacy === 'public').reduce((s, r) => s + r.views, 0));
  console.log('  공개 전환 대상 %d편 (누적 조회 %d)',
    toPublish.length, toPublish.reduce((s, r) => s + r.views, 0));

  const line = (r) => '  ' + [r.at.slice(0, 10), r.id, String(r.views).padStart(6) + '회',
    r.privacy.padEnd(8), r.blocked ? String(r.blocked) + '개국차단' : '        ',
    r.title.slice(0, 40)].join(' ');

  if (!apply) {
    console.log('\n== 삭제 %d편 ==', toDelete.length);
    for (const r of toDelete.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) console.log(line(r));
    console.log('\n== 공개 전환 %d편 ==', toPublish.length);
    for (const r of toPublish.sort((a, b) => b.views - a.views)) console.log(line(r));
    console.log('\n(대상만 표시 — 실제 실행은 --apply)');
    return;
  }

  fs.mkdirSync(LOG, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rec = { purpose, at: new Date().toISOString(), deleted: [], published: [], failed: [] };

  for (const r of doPublish ? toPublish : []) {
    try {
      const st = { ...r.status };
      delete st.publishAt;
      st.privacyStatus = 'public';
      await api(tk, 'https://www.googleapis.com/youtube/v3/videos?part=status', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: r.id, status: st })
      });
      rec.published.push({ id: r.id, title: r.title });
      console.log('공개 %s %s', r.id, r.title.slice(0, 32));
    } catch (e) { rec.failed.push({ id: r.id, op: 'publish', error: e.message }); console.log('★공개 실패 %s %s', r.id, e.message); }
  }
  for (const r of doDelete ? toDelete : []) {
    try {
      await api(tk, 'https://www.googleapis.com/youtube/v3/videos?id=' + r.id, { method: 'DELETE' });
      rec.deleted.push({ id: r.id, title: r.title, views: r.views, blocked: r.blocked });
      console.log('삭제 %s %s', r.id, r.title.slice(0, 32));
    } catch (e) { rec.failed.push({ id: r.id, op: 'delete', error: e.message }); console.log('★삭제 실패 %s %s', r.id, e.message); }
  }
  const out = path.join(LOG, `${purpose}-${stamp}.json`);
  fs.writeFileSync(out, JSON.stringify(rec, null, 1));
  console.log('\n공개 %d · 삭제 %d · 실패 %d\n기록: %s',
    rec.published.length, rec.deleted.length, rec.failed.length, out);
})().catch((e) => { console.error('[cleanup]', e.message); process.exit(1); });

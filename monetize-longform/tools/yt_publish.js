// 수창 롱폼: 올라간 영상을 공개로 바꾸고(또는 그대로 두고) AI 생성 표시(status.containsSyntheticMedia)를 넣고, 고정용 댓글을 단다 — 어느 업로드 프로필이든 --purpose 로.
// (소유주 10-22 «바로 올리고 바로 공개», 관리자: containsSyntheticMedia=true, 댓글은 API로 달고 고정은 스튜디오.)
//
//   node monetize-longform/tools/yt_publish.js <videoId> <upload.json> --purpose <p> [--public] [--synthetic] [--comment] [--publish-at <ISO>] [--dry-run]
// 종료 코드: 0 성공 · 1 오류. 결과는 upload.json 옆 upload_log.jsonl 에 한 줄 추가.
// ★videos.update part=status 는 status 를 통째로 바꾼다 — 원래 status 를 읽어 필요한 칸만 바꿔 돌려보낸다.
const fs = require('fs');
const path = require('path');
const { OAuth2Client } = require(path.join('D:/midform', 'node_modules', 'google-auth-library'));

(async () => {
  const a = process.argv.slice(2);
  const [videoId, metaPath] = a;
  const purpose = a[a.indexOf('--purpose') + 1];
  if (!videoId || !metaPath || !a.includes('--purpose') || !purpose) throw new Error('usage: yt_publish.js <videoId> <upload.json> --purpose <p> [--public] [--synthetic] [--comment]');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const store = JSON.parse(fs.readFileSync('D:/midform/server/data/youtube_upload_profiles.json', 'utf8'));
  const p = store.profiles.find((x) => x.purpose === purpose);
  if (!p) throw new Error(`업로드 프로필 없음: ${purpose}`);
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  const H = { Authorization: `Bearer ${(await c.getAccessToken()).token}`, 'Content-Type': 'application/json' };
  const get = async () => (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status,snippet&id=${videoId}`, { headers: H })).json()).items?.[0];
  const item = await get();
  if (!item) throw new Error(`영상 없음 ${videoId}`);
  console.log(`[publish] ${item.snippet.channelTitle} · ${item.snippet.title.slice(0, 50)} — 지금 ${item.status.privacyStatus} · synthetic=${item.status.containsSyntheticMedia}`);
  const status = { privacyStatus: a.includes('--public') ? 'public' : item.status.privacyStatus, selfDeclaredMadeForKids: !!item.status.selfDeclaredMadeForKids,
                   embeddable: item.status.embeddable !== false, license: item.status.license || 'youtube', publicStatsViewable: item.status.publicStatsViewable !== false };
  if (a.includes('--synthetic')) status.containsSyntheticMedia = true;
  else if (item.status.containsSyntheticMedia !== undefined) status.containsSyntheticMedia = item.status.containsSyntheticMedia;
  if (item.status.publishAt) status.publishAt = item.status.publishAt;
  if (a.includes('--public')) delete status.publishAt;
  const pa = a.includes('--publish-at') ? a[a.indexOf('--publish-at') + 1] : null;   // 10-23 관리자: 태그·합성 표시 미확정이면 공개를 1시간씩 미룬다
  if (pa) { status.publishAt = new Date(pa).toISOString(); status.privacyStatus = 'private'; }
  if (a.includes('--dry-run')) { console.log('[publish] dry-run', JSON.stringify(status)); return; }
  const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', { method: 'PUT', headers: H, body: JSON.stringify({ id: videoId, status }) });
  if (!r.ok) throw new Error(`status update 실패 ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const after = await get();
  console.log(`[publish] 지금 ${after.status.privacyStatus} · synthetic=${after.status.containsSyntheticMedia}`);
  let commentId = null;
  if (a.includes('--comment') && meta.pinned_comment) {
    const cr = await fetch('https://www.googleapis.com/youtube/v3/commentThreads?part=snippet', { method: 'POST', headers: H,
      body: JSON.stringify({ snippet: { videoId, topLevelComment: { snippet: { textOriginal: meta.pinned_comment } } } }) });
    const cj = await cr.json();
    commentId = cj?.id || null;
    console.log(cr.ok ? `[comment] 달음 ${commentId} (고정은 스튜디오)` : `[comment] 실패 ${cr.status}: ${JSON.stringify(cj).slice(0, 200)}`);
  }
  const log = path.join(path.dirname(metaPath), 'upload_log.jsonl');
  fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), action: 'publish', videoId, privacy: after.status.privacyStatus, synthetic: after.status.containsSyntheticMedia, commentId }) + '\n');
  process.exitCode = 0;
})().catch((e) => { console.error(e.message); process.exitCode = 1; });

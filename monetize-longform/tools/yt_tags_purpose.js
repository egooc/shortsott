// 수창 롱폼: 올라간 영상에 upload.json 의 tags 를 넣고 다시 읽어 확인한다 — 어느 업로드 프로필이든 --purpose 로.
// (politics-hour/yt_tags.js 는 politics 프로필 고정, scripts/shop_yt_tags.js 단일 모드는 shopping 고정이라 수창 전용 사본 — 공용 도구는 안 고쳤다.)
//
//   node monetize-longform/tools/yt_tags_purpose.js <videoId> <upload.json> --purpose <p> [--dry-run]
// 종료 코드: 0 확인됨 · 4 넣었는데 다시 읽은 태그 수가 다름 · 5 처리 미완료/영상 없음
// ★videos.update 는 snippet 을 통째로 바꾼다 — 원래 snippet 을 읽어 tags 만 바꿔 돌려보낸다.
const fs = require('fs');
const path = require('path');
const { OAuth2Client } = require(path.join('D:/midform', 'node_modules', 'google-auth-library'));

(async () => {
  const a = process.argv.slice(2);
  const [videoId, metaPath] = a;
  const purpose = a[a.indexOf('--purpose') + 1];
  if (!videoId || !metaPath || !a.includes('--purpose') || !purpose) throw new Error('usage: yt_tags_purpose.js <videoId> <upload.json> --purpose <p> [--dry-run]');
  const tags = JSON.parse(fs.readFileSync(metaPath, 'utf8')).tags || [];
  if (!tags.length) throw new Error('upload.json 에 tags 가 없다');
  const store = JSON.parse(fs.readFileSync('D:/midform/server/data/youtube_upload_profiles.json', 'utf8'));
  const p = store.profiles.find((x) => x.purpose === purpose);
  if (!p) throw new Error(`업로드 프로필 없음: ${purpose}`);
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  const H = { Authorization: `Bearer ${(await c.getAccessToken()).token}`, 'Content-Type': 'application/json' };
  const get = async () => (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,status,processingDetails&id=${videoId}`, { headers: H })).json()).items?.[0];
  const item = await get();
  if (!item) { console.log(`[tags] 영상 없음 ${videoId}`); process.exitCode = 5; return; }
  const ps = item.processingDetails?.processingStatus;
  if (ps && ps !== 'succeeded') { console.log(`[tags] 처리 상태 ${ps} — 잠시 뒤 다시`); process.exitCode = 5; return; }
  console.log(`[tags] ${item.snippet.channelTitle} · ${item.snippet.title.slice(0, 50)} — 지금 ${(item.snippet.tags || []).length}개 → ${tags.length}개 (${item.status.privacyStatus})`);
  if (a.includes('--dry-run')) return;
  const snippet = { ...item.snippet, tags };
  delete snippet.thumbnails; delete snippet.localized; delete snippet.publishedAt; delete snippet.channelId; delete snippet.channelTitle; delete snippet.liveBroadcastContent;
  const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet', { method: 'PUT', headers: H, body: JSON.stringify({ id: videoId, snippet }) });
  if (!r.ok) throw new Error(`update 실패 ${r.status}: ${(await r.text()).slice(0, 300)}`);
  let n = 0;
  for (let k = 0; k < 6; k++) { const after = await get(); n = (after?.snippet?.tags || []).length; if (n === tags.length) break; await new Promise((r) => setTimeout(r, 20000)); }
  console.log(`[tags] 다시 읽음 ${n}개`);
  process.exitCode = n === tags.length ? 0 : 4;
})().catch((e) => { console.error(e.message); process.exitCode = 1; });

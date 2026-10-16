// 올라간 영상에 upload.json 의 tags 를 넣고, 다시 읽어 확인한다(yt-upload.js 는 태그를 넣지 않는다 — 10/16편 태그 0개 사고).
//
//   node politics-hour/yt_tags.js <videoId> <upload.json> [--dry-run]
// ★videos.update 는 snippet 을 통째로 바꾼다 — 원래 값을 읽어 와서 tags 만 바꿔 돌려보낸다.
const fs = require('fs');
const path = require('path');
const { OAuth2Client } = require(path.join(__dirname, '..', 'node_modules', 'google-auth-library'));

(async () => {
  const [videoId, metaPath] = process.argv.slice(2);
  if (!videoId || !metaPath) throw new Error('usage: node politics-hour/yt_tags.js <videoId> <upload.json> [--dry-run]');
  const tags = JSON.parse(fs.readFileSync(metaPath, 'utf8')).tags || [];
  if (!tags.length) throw new Error('upload.json 에 tags 가 없다');
  const store = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'data', 'youtube_upload_profiles.json'), 'utf8'));
  const p = store.profiles.find((x) => x.purpose === 'politics');
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  const H = { Authorization: `Bearer ${(await c.getAccessToken()).token}`, 'Content-Type': 'application/json' };
  const get = async () => (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}`, { headers: H })).json()).items?.[0];
  const item = await get();
  if (!item) throw new Error(`영상 없음 ${videoId}`);
  console.log(`[tags] ${item.snippet.title.slice(0, 50)} — 지금 ${(item.snippet.tags || []).length}개 → ${tags.length}개`);
  if (process.argv.includes('--dry-run')) return;
  const s = item.snippet;
  const snippet = { title: s.title, description: s.description, tags, categoryId: s.categoryId, defaultLanguage: s.defaultLanguage, defaultAudioLanguage: s.defaultAudioLanguage };
  const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet', { method: 'PUT', headers: H, body: JSON.stringify({ id: videoId, snippet }) });
  const j = await r.json();
  if (j.error) throw new Error(`실패 ${JSON.stringify(j.error).slice(0, 300)}`);
  // 바로 읽으면 옛 값이 온다(반영 지연) — 몇 번 다시 읽는다
  let after, ok = false;
  for (let i = 0; i < 6 && !ok; i++) {
    await new Promise((res) => setTimeout(res, 5000));
    after = await get();
    ok = (after.snippet.tags || []).length === tags.length && after.snippet.title === s.title && after.snippet.description === s.description;
  }
  console.log(`[tags] 확인 ${(after.snippet.tags || []).length}개 · 제목·설명 그대로 ${ok} · ${new Date().toISOString()}`);
  if (!ok) process.exit(1);
})().catch((e) => { console.error('[tags]', e.message); process.exit(1); });

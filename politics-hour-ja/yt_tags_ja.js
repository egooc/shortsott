// 올라간 영상에 upload.json 의 tags 를 넣고, 다시 읽어 확인한다(yt-upload.js 는 태그를 넣지 않는다 — 10/16편 태그 0개 사고).
//
//   node politics-hour/yt_tags.js <videoId> <upload.json> [--dry-run] [--gate]
// --gate: 확인이 끝내 안 되면 공개 예약을 취소한다(비공개로 두고 publishAt 삭제) — 관리자 10/16 «태그 확인 빠지면 공개 멈춤».
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
  const p = store.profiles.find((x) => x.purpose === (process.env.PURPOSE || "politics_ja"));
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
  // 10/17편: 30초 안에는 0개로 읽혔고 그 뒤에 20개가 보였다 — 최대 3분 기다린다
  for (let i = 0; i < 18 && !ok; i++) {
    await new Promise((res) => setTimeout(res, 10000));
    after = await get();
    ok = (after.snippet.tags || []).length === tags.length && after.snippet.title === s.title && after.snippet.description === s.description;
  }
  console.log(`[tags] 확인 ${(after.snippet.tags || []).length}개 · 제목·설명 그대로 ${ok} · ${new Date().toISOString()}`);
  if (!ok && process.argv.includes('--gate')) {
    const st = (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status&id=${videoId}`, { headers: H })).json()).items[0].status;
    const status = { privacyStatus: 'private', embeddable: st.embeddable, license: st.license, publicStatsViewable: st.publicStatsViewable, selfDeclaredMadeForKids: st.madeForKids };
    const g = await (await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', { method: 'PUT', headers: H, body: JSON.stringify({ id: videoId, status }) })).json();
    console.log(g.error ? `[gate] 공개 취소 실패 ${JSON.stringify(g.error).slice(0, 200)}` : `[gate] 태그 확인 실패 → 공개 예약 취소(비공개 유지, 예약 ${st.publishAt || '없음'} 삭제) · 관리자 보고 필요`);
    process.exit(2);
  }
  if (!ok) process.exit(1);
})().catch((e) => { console.error('[tags]', e.message); process.exit(1); });

// 최애모먼트 태그 넣기·확인 — politics-hour/yt_tags.js 를 팬튜브용으로(yt-upload.js 는 태그를 넣지 않는다, 10/16 쟁점브리핑 태그 0개 사고).
//   node fantube/yt_tags.js <videoId> <upload.json> [--check] [--gate] [--reschedule <ISO>] [--unschedule]
// tags 는 upload.json 의 tags, 없으면 설명란 해시태그 + 기본 묶음. --check 는 개수만 읽는다.
// --title <제목>: 제목도 같이 바꾼다(포장 교체, 10/17 소유주 «트렌드 멤버 먼저»).
// --gate: 넣은 뒤 다시 읽어 0개면 예약을 풀고 비공개로 둔다(공개 금지) — exit 2.
// ★videos.update 는 snippet 을 통째로 바꾼다 — 원래 값을 읽어 tags 만 바꿔 돌려보낸다.
const fs = require('fs');
const path = require('path');
const { OAuth2Client } = require(path.join(__dirname, '..', 'node_modules', 'google-auth-library'));

const BASE = ['엔믹스', 'NMIXX', '규진', 'KYUJIN', '장규진', '엔믹스 규진', 'NMIXX KYUJIN', '최애모먼트', 'kpop', '아이돌', '케이팝', 'shorts'];

function tagsOf(meta) {
  if (Array.isArray(meta.tags) && meta.tags.length) return meta.tags;
  const hash = ((meta.description || '') + ' ' + (meta.title || '')).match(/#[^\s#]+/g) || [];
  const all = [...hash.map((h) => h.slice(1)), ...BASE];
  const out = [];
  for (const t of all) if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  while (out.join(',').length > 450) out.pop();
  return out;
}

(async () => {
  const [videoId, metaPath] = process.argv.slice(2);
  if (!videoId || !metaPath) throw new Error('usage: node fantube/yt_tags.js <videoId> <upload.json> [--check] [--gate]');
  const tags = tagsOf(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
  const store = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'data', 'youtube_upload_profiles.json'), 'utf8'));
  const p = store.profiles.find((x) => x.purpose === 'idol_fantube_ko');
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  const H = { Authorization: `Bearer ${(await c.getAccessToken()).token}`, 'Content-Type': 'application/json' };
  const get = async () => (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${videoId}`, { headers: H })).json()).items?.[0];
  const item = await get();
  if (!item) throw new Error(`영상 없음 ${videoId}`);
  const now = (item.snippet.tags || []).length;
  console.log(`[tags] ${videoId} ${item.snippet.title.slice(0, 40)} — 지금 ${now}개 → ${tags.length}개`);
  if (process.argv.includes('--check')) return;
  if (process.argv.includes('--unschedule')) {      // 교체된 예약분 내리기 — 비공개·예약 없음(10/17 관리자: 장부엔 retracted)
    const st = { privacyStatus: 'private', selfDeclaredMadeForKids: item.status.selfDeclaredMadeForKids };
    const r = await (await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', { method: 'PUT', headers: H, body: JSON.stringify({ id: videoId, status: st }) })).json();
    console.log(`[tags] 예약 해제 ${r.error ? '실패 ' + JSON.stringify(r.error).slice(0, 200) : r.status.privacyStatus + ' ' + (r.status.publishAt || '예약 없음')}`);
    return;
  }
  const re = process.argv.indexOf('--reschedule');
  if (re > 0) {                                     // 게이트가 푼 예약을 되살린다
    const st = { privacyStatus: 'private', publishAt: new Date(process.argv[re + 1]).toISOString(), selfDeclaredMadeForKids: item.status.selfDeclaredMadeForKids };
    const r = await (await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', { method: 'PUT', headers: H, body: JSON.stringify({ id: videoId, status: st }) })).json();
    console.log(`[tags] 예약 ${r.error ? '실패 ' + JSON.stringify(r.error).slice(0, 200) : r.status.publishAt}`);
    return;
  }
  const s = item.snippet;
  const ti = process.argv.indexOf('--title');
  if (ti > 0) s.title = process.argv[ti + 1];
  const snippet = { title: s.title, description: s.description, tags, categoryId: s.categoryId, defaultLanguage: s.defaultLanguage, defaultAudioLanguage: s.defaultAudioLanguage };
  // 갓 올린 영상은 처리 중이라 403 forbidden 이 난다(ep09, 10/16) — 20초 간격으로 다시
  for (let i = 0; i < 6; i++) {
    const j = await (await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet', { method: 'PUT', headers: H, body: JSON.stringify({ id: videoId, snippet }) })).json();
    if (!j.error) break;
    console.error(`[tags] 넣기 실패 ${i + 1}회 ${JSON.stringify(j.error).slice(0, 200)}`);
    await new Promise((res) => setTimeout(res, 20000));
  }
  let after, ok = false;
  for (let i = 0; i < 12 && !ok; i++) {       // 바로 읽으면 옛 값이 온다 — 갓 올린 영상은 30초 넘게 0개로 읽혔다(ep12, 10/16)
    await new Promise((res) => setTimeout(res, 10000));
    after = await get();
    ok = (after.snippet.tags || []).length > 0 && after.snippet.title === s.title && after.snippet.description === s.description;
  }
  const n = (after.snippet.tags || []).length;
  console.log(`[tags] 확인 ${n}개 · 제목·설명 그대로 ${ok}`);
  if (!ok && process.argv.includes('--gate') && n === 0) {
    const st = { privacyStatus: 'private', selfDeclaredMadeForKids: after.status.selfDeclaredMadeForKids };
    await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', { method: 'PUT', headers: H, body: JSON.stringify({ id: videoId, status: st }) });
    console.error(`[tags] 게이트: 태그 0개 → 예약 해제·비공개 유지, 관리자 보고 필요 (${videoId})`);
    process.exit(2);
  }
  if (!ok) process.exit(1);
})().catch((e) => { console.error('[tags]', e.message); process.exit(1); });

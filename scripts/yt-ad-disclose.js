// 쿠팡파트너스 쇼츠 규정 맞추기: 제목 앞 [광고] + "유료 광고 포함" 표시 + 댓글 맨 앞 대가성 문구.
//
//   node scripts/yt-ad-disclose.js --purpose arabshot <videoId> [...]        이미 올린 영상 고치기
//   (신규 업로드는 yt-upload.js 가 같은 규칙으로 올린다)
//
// 규정(쿠팡파트너스 숏폼 활동 예시): ① 댓글에도 대가성 문구 필수, "더보기" 없이 보이게 맨 앞에
// ② 제목에 [광고] 또는 영상의 "유료 광고 포함" 표시 — 우리는 ②를 표시로만 충족한다.
const fs = require('fs');
const path = require('path');
const { OAuth2Client } = require('google-auth-library');

const PROFILES = path.join(path.resolve(__dirname, '..'), 'server', 'data', 'youtube_upload_profiles.json');
const DISC = '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.';
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };

// 제목에는 [광고]를 넣지 않는다(소유주 2026-10-01) — 붙어 있으면 뗀다. 규정은 '유료 광고 포함' 표시로 충족
const adTitle = (t) => t.replace(/^\[광고\]\s*/, '');
const commentText = (link, what) => `"${DISC}"\n\n${what || '영상 속 제품'} 👉 ${link}`;

async function headers(purpose) {
  const s = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  const p = s.profiles.find((x) => x.purpose === purpose);
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  return { Authorization: `Bearer ${(await c.getAccessToken()).token}`, 'Content-Type': 'application/json' };
}

async function fixVideo(H, id) {
  const v = (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,paidProductPlacementDetails&id=${id}`, { headers: H })).json()).items[0];
  const sn = v.snippet;
  const body = { id, snippet: { title: adTitle(sn.title), description: sn.description, categoryId: sn.categoryId,
                                tags: sn.tags, defaultLanguage: sn.defaultLanguage, defaultAudioLanguage: sn.defaultAudioLanguage },
                 paidProductPlacementDetails: { hasPaidProductPlacement: true } };
  const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet,paidProductPlacementDetails', { method: 'PUT', headers: H, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${id} 수정 실패 ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  console.log(`  ✓ ${id} 제목 "${j.snippet.title}" · 유료 광고 포함 ${j.paidProductPlacementDetails && j.paidProductPlacementDetails.hasPaidProductPlacement}`);
  return sn.description;
}

async function fixComment(H, id, link, what) {
  const ch = (await (await fetch('https://www.googleapis.com/youtube/v3/channels?part=id&mine=true', { headers: H })).json()).items[0].id;
  const th = await (await fetch(`https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${id}&maxResults=50`, { headers: H })).json();
  if (th.error) return console.log(`  · ${id} 댓글 조회 불가(${th.error.code}) — 아직 비공개면 공개 뒤 comments 작업이 새 문구로 단다`);
  const mine = (th.items || []).map((t) => t.snippet.topLevelComment).filter((c) => c.snippet.authorChannelId && c.snippet.authorChannelId.value === ch);
  const text = commentText(link, what);
  if (!mine.length) {
    const r = await fetch('https://www.googleapis.com/youtube/v3/commentThreads?part=snippet', { method: 'POST', headers: H,
      body: JSON.stringify({ snippet: { videoId: id, topLevelComment: { snippet: { textOriginal: text } } } }) });
    return console.log(r.ok ? `  ✓ ${id} 댓글 새로 작성` : `  ✗ ${id} 댓글 작성 실패 ${r.status}`);
  }
  for (const c of mine) {
    if (c.snippet.textOriginal.startsWith(`"${DISC}"`)) { console.log(`  · ${id} 댓글 이미 규정대로`); continue; }
    const r = await fetch('https://www.googleapis.com/youtube/v3/comments?part=snippet', { method: 'PUT', headers: H,
      body: JSON.stringify({ id: c.id, snippet: { textOriginal: text } }) });
    console.log(r.ok ? `  ✓ ${id} 댓글 수정(대가성 문구 맨 앞)` : `  ✗ ${id} 댓글 수정 실패 ${r.status}`);
  }
}

module.exports = { DISC, adTitle, commentText };

if (require.main === module) {
  (async () => {
    const purpose = arg('--purpose', 'arabshot');
    const ids = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--purpose');
    const H = await headers(purpose);
    for (const id of ids) {
      const desc = await fixVideo(H, id);
      const link = (desc.match(/https:\/\/link\.coupang\.com\/a\/\w+/) || [])[0];
      const what = (desc.match(/🛒 (영상 속 제품)/) || [])[1];
      if (link) await fixComment(H, id, link, '영상 속 선풍기 청소솔');
    }
  })().catch((e) => { console.error(e.message); process.exit(1); });
}

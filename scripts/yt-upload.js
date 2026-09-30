// 메타데이터 json 하나로 유튜브에 올리고, 링크 댓글을 단다(쇼핑 편용 가벼운 업로더).
//
//   node scripts/yt-upload.js <meta.json> --purpose arabshot [--privacy public|unlisted|private] [--publish-at <ISO>] [--dry-run]
//
// meta.json: { file, title, description, pinned_comment, privacy, categoryId, defaultLanguage, madeForKids }
// 업로드 전 채널 id·제목을 찍고, 결과(videoId·댓글 id)를 meta 옆 upload_log.jsonl 에 남긴다.
// 댓글 "고정"은 API 가 지원하지 않는다 — 스튜디오에서 사람이 누른다.
const fs = require('fs');
const path = require('path');
const { OAuth2Client } = require('google-auth-library');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };

(async () => {
  const metaPath = process.argv[2];
  const purpose = arg('--purpose');
  if (!metaPath || !purpose) throw new Error('usage: node scripts/yt-upload.js <meta.json> --purpose <p>');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const privacy = arg('--privacy', meta.privacy || 'private');
  const store = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  const p = store.profiles.find((x) => x.purpose === purpose);
  if (!p) throw new Error(`profile ${purpose} 없음`);
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  const token = (await c.getAccessToken()).token;
  const H = { Authorization: `Bearer ${token}` };
  const ch = (await (await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: H })).json()).items[0];
  if (ch.id !== p.channelId) throw new Error(`토큰 채널 ${ch.id} ≠ 프로필 ${p.channelId}`);
  const size = fs.statSync(meta.file).size;
  console.log(`[upload] ${ch.snippet.title} (${ch.id}) ← ${path.basename(meta.file)} ${(size / 1e6).toFixed(1)}MB · ${privacy}\n  ${meta.title}`);
  if (process.argv.includes('--dry-run')) return;

  // --publish-at 2026-10-01T08:00:00+09:00 → 비공개로 올리고 유튜브가 그 시각에 공개한다(PC 가 꺼져 있어도 된다)
  const publishAt = arg('--publish-at', null);
  const status = { privacyStatus: publishAt ? 'private' : privacy, selfDeclaredMadeForKids: !!meta.madeForKids };
  if (publishAt) {
    const t = new Date(publishAt);
    if (!(t > new Date(Date.now() + 15 * 60 * 1000))) throw new Error(`publishAt ${publishAt} 이 15분 이내이거나 과거다`);
    status.publishAt = t.toISOString();
  }
  const body = {
    snippet: { title: meta.title,  // [광고]는 제목에 넣지 않는다 — '유료 광고 포함' 표시로 규정 충족(소유주 2026-10-01) description: meta.description, categoryId: meta.categoryId || '26',
               defaultLanguage: meta.defaultLanguage || 'ko', defaultAudioLanguage: meta.defaultLanguage || 'ko' },
    status,
    // 쿠팡파트너스 규정: 제휴 링크가 있으면 "유료 광고 포함" 표시
    ...(meta.affiliate_link ? { paidProductPlacementDetails: { hasPaidProductPlacement: true } } : {}),
  };
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status,paidProductPlacementDetails', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/mp4' },
    body: JSON.stringify(body),
  });
  if (!init.ok) throw new Error(`업로드 시작 실패 ${init.status}: ${(await init.text()).slice(0, 300)}`);
  const loc = init.headers.get('location');
  const put = await fetch(loc, { method: 'PUT', headers: { ...H, 'Content-Type': 'video/mp4', 'Content-Length': String(size) }, body: fs.readFileSync(meta.file) });
  const v = await put.json();
  if (!put.ok || !v.id) throw new Error(`업로드 실패 ${put.status}: ${JSON.stringify(v).slice(0, 300)}`);
  console.log(`[upload] 완료 https://youtube.com/shorts/${v.id}${status.publishAt ? ` · 예약 공개 ${status.publishAt}` : ''}`);

  let commentId = null;
  // 예약(비공개) 영상에는 댓글을 못 단다(403) — 공개 뒤 shop_schedule.js comments 가 단다
  if (meta.pinned_comment && !status.publishAt) {
    const cr = await fetch('https://www.googleapis.com/youtube/v3/commentThreads?part=snippet', {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ snippet: { videoId: v.id, topLevelComment: { snippet: { textOriginal: meta.pinned_comment } } } }),
    });
    const cj = await cr.json();
    commentId = cj.id || null;
    console.log(cr.ok ? `[comment] 댓글 작성 ${commentId} — 스튜디오에서 "고정" 눌러 주세요` : `[comment] 실패 ${cr.status}: ${JSON.stringify(cj).slice(0, 200)}`);
  }
  fs.appendFileSync(path.join(path.dirname(metaPath), 'upload_log.jsonl'), JSON.stringify({
    at: new Date().toISOString(), meta: path.basename(metaPath), channel: ch.id, videoId: v.id,
    privacy: status.privacyStatus, publishAt: status.publishAt || null, commentId,
  }) + '\n');
  console.log(JSON.stringify({ videoId: v.id, commentId, publishAt: status.publishAt || null }));
})().catch((e) => { console.error(`[upload] ${e.message}`); process.exit(1); });

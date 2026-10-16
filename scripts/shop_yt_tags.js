// 쇼핑 유튜브 영상에 태그를 넣고 다시 읽어 확인한다(yt-upload.js 는 태그를 넣지 않는다 — 10/16 쟁점브리핑 태그 0개 사고, 관리자 전 세션 공지).
//
//   node scripts/shop_yt_tags.js <videoId> <meta.json> [--dry-run]     한 편
//   node scripts/shop_yt_tags.js --audit [--days 7] [--dry-run]        schedule_shopping.json 최근 N일 공개·예약분 점검, 0개면 넣는다
//   require('./shop_yt_tags').ensureTags(videoId, metaPath) → 확인된 태그 개수(0 이면 실패)
// 태그는 메타 "tags" 가 있으면 그것, 없으면 제목 해시태그 + 상품명 낱말 + 쇼핑 공통 태그로 만든다.
// ★videos.update 는 snippet 을 통째로 바꾼다 — 원래 값을 읽어 와서 tags 만 바꿔 돌려보낸다(참고: politics-hour/yt_tags.js).
const fs = require('fs');
const path = require('path');
const { OAuth2Client } = require(path.join(__dirname, '..', 'node_modules', 'google-auth-library'));

const QUEUE = 'D:/volcano-runs/_upload/schedule_shopping.json';
const COMMON = ['살림템', '살림꿀팁', '생활꿀팁', '꿀템', '정리정돈', '자취템', '살림', '생활용품', '쿠팡추천템', '쇼츠'];
const STOP = new Set(['세트', '개입', '대형', '소형', '중형', '1개', '2개', '3개', '4개', '5개', '다용도', '길이조절']);

function buildTags(meta) {
  if (Array.isArray(meta.tags) && meta.tags.length) return meta.tags;
  const out = [];
  const add = (t) => { t = String(t).replace(/^#/, '').trim(); if (t.length >= 2 && !out.includes(t)) out.push(t); };
  for (const h of String(meta.title || '').match(/#[^\s#]+/g) || []) add(h);
  const words = String(meta.product || '').replace(/[()[\]\-·,/+]/g, ' ').split(/\s+/)
    .filter((w) => /[가-힣]/.test(w) && w.length >= 2 && !STOP.has(w) && !/^\d/.test(w));
  // 상품명 낱말을 하나씩 넣으면 «소변»·«있는»·«핑크» 같은 쓰레기 태그가 생긴다 — 끝 명사구만(마지막 1·2·3 낱말)
  const nouns = words.filter((w) => !/(할|는|은|한|된|그레이|화이트|블랙|핑크)$/.test(w));
  if (nouns.length) add(nouns[nouns.length - 1]);
  if (nouns.length >= 2) add(nouns.slice(-2).join(' '));
  if (nouns.length >= 3) add(nouns.slice(-3).join(' '));
  for (const c of COMMON) add(c);
  // 유튜브 태그 한도 500자(쉼표 포함) — 여유 있게 400자 안으로
  const kept = [];
  for (const t of out) { if ([...kept, t].join(',').length > 400) break; kept.push(t); }
  return kept;
}

async function headers() {
  const store = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'data', 'youtube_upload_profiles.json'), 'utf8'));
  const p = store.profiles.find((x) => x.purpose === 'shopping');
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  return { Authorization: `Bearer ${(await c.getAccessToken()).token}`, 'Content-Type': 'application/json' };
}

async function getItem(H, videoId) {
  return (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}`, { headers: H })).json()).items?.[0];
}

async function ensureTags(videoId, metaPath, { dryRun = false, H } = {}) {
  H = H || await headers();
  const item = await getItem(H, videoId);
  if (!item) { console.log(`  ✗ 태그: 영상 없음 ${videoId}`); return 0; }
  const s = item.snippet;
  const now = (s.tags || []).length;
  if (now > 0) { console.log(`  ✓ 태그 ${videoId} 이미 ${now}개`); return now; }
  const tags = buildTags(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
  console.log(`  [tags] ${videoId} ${s.title.slice(0, 40)} — 0개 → ${tags.length}개: ${tags.join(', ')}`);
  if (dryRun) return 0;
  const snippet = { title: s.title, description: s.description, tags, categoryId: s.categoryId,
                    defaultLanguage: s.defaultLanguage, defaultAudioLanguage: s.defaultAudioLanguage };
  const j = await (await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet', { method: 'PUT', headers: H,
    body: JSON.stringify({ id: videoId, snippet }) })).json();
  if (j.error) { console.log(`  ✗ 태그 넣기 실패 ${videoId} ${JSON.stringify(j.error).slice(0, 200)}`); return 0; }
  // 바로 읽으면 옛 값이 온다(반영 지연) — 몇 번 다시 읽는다
  for (let i = 0; i < 6; i++) {
    await new Promise((res) => setTimeout(res, 5000));
    const a = (await getItem(H, videoId)).snippet;
    const n = (a.tags || []).length;
    if (n > 0 && a.title === s.title && a.description === s.description) { console.log(`  ✓ 태그 ${videoId} 확인 ${n}개`); return n; }
  }
  console.log(`  ✗ 태그 ${videoId} 다시 읽어도 0개`);
  return 0;
}

// 태그 관문에서 떨어진 편은 예약 공개를 거둔다(비공개로 남기고 보고) — 태그 0개로 공개하지 않는다
async function holdPrivate(videoId) {
  const H = await headers();
  const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', { method: 'PUT', headers: H,
    body: JSON.stringify({ id: videoId, status: { privacyStatus: 'private', selfDeclaredMadeForKids: false } }) });
  return r.ok;
}

module.exports = { ensureTags, buildTags, holdPrivate };

if (require.main === module) {
  (async () => {
    const a = process.argv.slice(2);
    const dryRun = a.includes('--dry-run');
    if (a[0] === '--audit') {
      const days = Number(a[a.indexOf('--days') + 1]) || 7;
      const since = Date.now() - days * 864e5;
      const q = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
      const H = await headers();
      let total = 0, zero = 0, fixed = 0;
      for (const i of q.items.filter((x) => x.videoId && new Date(x.publishAt).getTime() >= since)) {
        total++;
        const it = await getItem(H, i.videoId);
        if (it && (it.snippet.tags || []).length) { console.log(`  ✓ ${i.videoId} ${path.basename(i.meta)} ${it.snippet.tags.length}개`); continue; }
        zero++;
        if (await ensureTags(i.videoId, i.meta, { dryRun, H })) fixed++;
      }
      console.log(`점검 ${total}편 · 0개였던 편 ${zero} · 넣고 확인 ${fixed}${dryRun ? ' (dry-run)' : ''}`);
      process.exit(zero > fixed && !dryRun ? 1 : 0);
    }
    const [videoId, metaPath] = a.filter((x) => !x.startsWith('--'));
    if (!videoId || !metaPath) throw new Error('usage: node scripts/shop_yt_tags.js <videoId> <meta.json> [--dry-run] | --audit [--days 7]');
    process.exit((await ensureTags(videoId, metaPath, { dryRun })) || dryRun ? 0 : 1);
  })().catch((e) => { console.error('[tags]', e.message); process.exit(1); });
}

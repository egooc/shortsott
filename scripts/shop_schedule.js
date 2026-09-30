// 쇼핑쇼츠 발행 대기열 — 매일 08:00·18:00(KST) 슬롯에 예약 공개로 올린다.
//
//   node scripts/shop_schedule.js add <meta.json> [...]     다음 빈 슬롯을 잡아 예약 업로드(비공개 + publishAt)
//   node scripts/shop_schedule.js list                      슬롯·재고 보기 (남은 예약 편수 = 재고 일수 × 2)
//   node scripts/shop_schedule.js comments                  댓글이 안 달린 공개 영상에 링크 댓글 달기(작업 스케줄러가 부른다)
//
// 왜 예약 공개인가: 유튜브가 그 시각에 공개하므로 PC·세션이 꺼져 있어도 슬롯이 지켜진다.
// 대기열: D:/volcano-runs/_upload/schedule.json. 채널은 purpose=arabshot(쓸모연구소, 구 Mansa).
// 댓글 "고정"은 API 가 없다 — list 가 "고정 필요"로 보여 준다.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { OAuth2Client } = require('google-auth-library');

const ROOT = path.resolve(__dirname, '..');
const DIR = 'D:/volcano-runs/_upload';
const QUEUE = path.join(DIR, 'schedule.json');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const PURPOSE = 'arabshot';
const SLOTS = ['08:00', '18:00'];            // KST
const MIN_LEAD_MIN = 30;                     // 업로드 처리 시간을 감안해 30분 이상 남은 슬롯만

const readQ = () => (fs.existsSync(QUEUE) ? JSON.parse(fs.readFileSync(QUEUE, 'utf8')) : { items: [] });
const writeQ = (q) => fs.writeFileSync(QUEUE, JSON.stringify(q, null, 2) + '\n', 'utf8');
const kst = (d) => new Date(d.getTime() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16) + ' KST';

function slotsFrom(now) {
  const out = [];
  const base = new Date(now.getTime() + 9 * 3600e3);              // KST 달력
  for (let day = 0; day < 60; day++) {
    for (const hm of SLOTS) {
      const [h, m] = hm.split(':').map(Number);
      const t = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + day, h - 9, m));
      if (t.getTime() - now.getTime() >= MIN_LEAD_MIN * 60e3) out.push(t);
    }
  }
  return out;
}

async function api() {
  const s = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  const p = s.profiles.find((x) => x.purpose === PURPOSE);
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  return { Authorization: `Bearer ${(await c.getAccessToken()).token}` };
}

async function add(files) {
  const q = readQ();
  const taken = new Set(q.items.filter((i) => i.publishAt).map((i) => i.publishAt));
  for (const f of files) {
    const meta = path.resolve(f);
    if (q.items.some((i) => i.meta === meta)) { console.log(`  건너뜀(이미 대기열) ${path.basename(meta)}`); continue; }
    const slot = slotsFrom(new Date()).find((t) => !taken.has(t.toISOString()));
    const r = spawnSync('node', [path.join(__dirname, 'yt-upload.js'), meta, '--purpose', PURPOSE, '--publish-at', slot.toISOString()],
      { encoding: 'utf8' });
    process.stdout.write(r.stdout); process.stderr.write(r.stderr);
    if (r.status) { console.log(`  ✗ ${path.basename(meta)} 업로드 실패 — 대기열에 넣지 않음`); continue; }
    const res = JSON.parse(r.stdout.trim().split('\n').pop());
    taken.add(slot.toISOString());
    q.items.push({ meta, videoId: res.videoId, publishAt: slot.toISOString(), commentId: res.commentId, pinned: false,
                   addedAt: new Date().toISOString() });
    writeQ(q);
    console.log(`  ✓ ${path.basename(meta)} → ${kst(slot)} 예약 (https://youtube.com/shorts/${res.videoId})`);
  }
}

function list() {
  const q = readQ();
  const now = Date.now();
  const future = q.items.filter((i) => new Date(i.publishAt) > now);
  console.log(`예약 대기 ${future.length}편 (= ${(future.length / 2).toFixed(1)}일치)`);
  for (const i of q.items.slice().sort((a, b) => a.publishAt.localeCompare(b.publishAt))) {
    const done = new Date(i.publishAt) <= now;
    console.log(`  ${kst(new Date(i.publishAt))} ${done ? '공개됨' : '예약  '} ${path.basename(i.meta).padEnd(18)} ${i.videoId}` +
      `${i.commentId ? '' : ' · 댓글 없음'}${i.commentId && !i.pinned ? ' · 고정 필요' : ''}`);
  }
  const next = slotsFrom(new Date()).find((t) => !q.items.some((i) => i.publishAt === t.toISOString()));
  console.log(`다음 빈 슬롯: ${kst(next)}`);
}

async function comments() {
  const q = readQ();
  const H = await api();
  for (const i of q.items.filter((x) => !x.commentId && new Date(x.publishAt) <= Date.now())) {
    const meta = JSON.parse(fs.readFileSync(i.meta, 'utf8'));
    const r = await fetch('https://www.googleapis.com/youtube/v3/commentThreads?part=snippet', {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ snippet: { videoId: i.videoId, topLevelComment: { snippet: { textOriginal: meta.pinned_comment } } } }),
    });
    const j = await r.json();
    if (r.ok) { i.commentId = j.id; console.log(`  ✓ 댓글 ${i.videoId}`); } else console.log(`  ✗ 댓글 ${i.videoId} ${r.status}`);
  }
  writeQ(q);
}

const [cmd, ...rest] = process.argv.slice(2);
({ add: () => add(rest), list: async () => list(), comments }[cmd] || (() => { console.error('add|list|comments'); process.exit(2); }))()
  .catch((e) => { console.error(e.message); process.exit(1); });

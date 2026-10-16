// 쇼핑쇼츠 발행 대기열 — 매일 08:00·18:00(KST) 슬롯에 예약 공개로 올린다.
//
//   node scripts/shop_schedule.js add <meta.json> [...]     다음 빈 슬롯을 잡아 예약 업로드(비공개 + publishAt)
//   node scripts/shop_schedule.js list                      슬롯·재고 보기 (남은 예약 편수 = 재고 일수 × 2)
//   node scripts/shop_schedule.js fill [N]                  재고에서 다음 편들을 예약(한 번에 최대 N=3, 원리형·스토리형 번갈아, 앞으로 6슬롯까지)
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
// 채널: --purpose <p> 또는 _upload/channel.json 의 {"purpose": ...}. 기본은 arabshot(쓸모연구소).
// 2026-10-03 소유주: 쇼핑은 새 채널로 옮긴다 — 채널마다 대기열·재생목록을 따로 둔다.
const argv = process.argv.slice(2);
const pi = argv.indexOf('--purpose');
const CHANNEL_FILE = path.join(DIR, 'channel.json');
const PURPOSE = pi >= 0 ? argv.splice(pi, 2)[1]
  : (fs.existsSync(CHANNEL_FILE) ? JSON.parse(fs.readFileSync(CHANNEL_FILE, 'utf8')).purpose : 'arabshot');
const QUEUE = path.join(DIR, PURPOSE === 'arabshot' ? 'schedule.json' : `schedule_${PURPOSE}.json`);
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
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

function profileLinkMeta(metaPath) {
  const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const wd = path.dirname(m.file);
  const social = path.join(wd, `${path.basename(wd)}_social.mp4`);
  if (!fs.existsSync(social)) return metaPath;
  let n = 0;
  try { n = JSON.parse(fs.readFileSync(path.join(DIR, 'product_numbers.json'), 'utf8')).numbers[path.basename(wd)] || 0; } catch { /* 번호 없음 */ }
  const where = n ? `채널 프로필 링크 ${n}번` : '채널 프로필 링크';
  m.file = social;
  m.description = String(m.description).replace(/🛒 영상 속 제품: (\S+)/, `🛒 영상 속 제품은 ${where}에서 (쿠팡 링크: $1)`);
  const out = path.join(DIR, '_yt', path.basename(metaPath));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(m, null, 2)}
`, 'utf8');
  return out;
}

// 관리자 성과 보고용 제작 장부(docs/production-ledger.md, 2026-10-15 소유주) — 밤 생산이 적은 줄을 이어받아 유튜브 ID·공개 시각을 더한 줄을 덧붙인다(마지막 줄이 이긴다)
const LEDGER = 'D:/midform/server/data/production_ledger.jsonl';
function ledgerPublish(id, videoId, slot) {
  try {
    let prev = {};
    if (fs.existsSync(LEDGER)) {
      for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
        try { const r = JSON.parse(line); if (r.lane === 'shop' && r.id === id) prev = r; } catch { /* 빈 줄 */ }
      }
    }
    const kstIso = (d) => new Date(d.getTime() + 9 * 3600e3).toISOString().replace(/\.\d+Z$/, '+09:00');
    const rec = { session: '쇼핑', lane: 'shop', gpt_calls: 0, rejected: 0, note: '', ...prev, id,
                  at: kstIso(new Date()), youtube_id: videoId, publish_at: kstIso(slot) };
    fs.appendFileSync(LEDGER, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) { console.log(`    ✗ 제작 장부 기록 실패 ${e.message}`); }
}

async function add(files) {
  const q = readQ();
  const taken = new Set(q.items.filter((i) => i.publishAt).map((i) => i.publishAt));
  for (const f of files) {
    const meta = path.resolve(f);
    if (q.items.some((i) => i.meta === meta)) { console.log(`  건너뜀(이미 대기열) ${path.basename(meta)}`); continue; }
    // channel.json 의 startAt 이전 슬롯은 쓰지 않는다(2026-10-06 소유주: 새 채널은 «내일부터» — 첫 실행이 당일 18:00 을 잡았다)
    const startAt = Date.parse((fs.existsSync(CHANNEL_FILE) && JSON.parse(fs.readFileSync(CHANNEL_FILE, 'utf8')).startAt) || 0) || 0;
    const slot = slotsFrom(new Date()).find((t) => !taken.has(t.toISOString()) && t.getTime() >= startAt);
    // 쇼츠 설명·댓글 URL 은 클릭이 안 된다(YouTube 공식, 2026-10-08 확인) — 유튜브도 «프로필 링크 N번» 판(<작업폴더>_social.mp4)을 올리고
    // 설명란 첫 안내를 채널 프로필 링크(인포크)로 바꾼 파생 메타로 올린다. 원본 메타는 그대로 둔다.
    const upMeta = PURPOSE === 'shopping' ? profileLinkMeta(meta) : meta;
    const r = spawnSync('node', [path.join(__dirname, 'yt-upload.js'), upMeta, '--purpose', PURPOSE, '--publish-at', slot.toISOString()],
      { encoding: 'utf8' });
    process.stdout.write(r.stdout); process.stderr.write(r.stderr);
    if (r.status) { console.log(`  ✗ ${path.basename(meta)} 업로드 실패 — 대기열에 넣지 않음`); continue; }
    const res = JSON.parse(r.stdout.trim().split('\n').pop());
    // 태그 관문(10/16 쟁점브리핑 태그 0개 사고): 넣고 다시 읽어 0개면 예약 공개를 거두고 퍼뜨리지 않는다
    const tagN = await require('./shop_yt_tags').ensureTags(res.videoId, meta);
    if (!tagN) {
      const held = await require('./shop_yt_tags').holdPrivate(res.videoId);
      console.log(`  ✗ ${path.basename(meta)} 태그 0개 — 예약 공개 ${held ? '거둠(비공개 유지)' : '거두기도 실패'} · 퍼뜨리지 않음, 보고 필요`);
      q.items.push({ meta, videoId: res.videoId, publishAt: '', blocked: 'tags', addedAt: new Date().toISOString() });
      writeQ(q);
      continue;
    }
    taken.add(slot.toISOString());
    q.items.push({ meta, videoId: res.videoId, publishAt: slot.toISOString(), commentId: res.commentId, pinned: false,
                   addedAt: new Date().toISOString() });
    writeQ(q);
    console.log(`  ✓ ${path.basename(meta)} → ${kst(slot)} 예약 (https://youtube.com/shorts/${res.videoId})`);
    // 쇼핑 채널은 같은 시각에 Blotato 4곳·네이버 클립으로도 나간다(2026-10-06 소유주). 실패해도 유튜브 예약은 유지.
    if (PURPOSE === 'shopping') {
      const fail = await require('./shop_fanout').fanout(meta, slot.toISOString());
      const it = q.items.find((x) => x.meta === meta); it.fanout = fail ? 'partial' : 'ok'; writeQ(q);
      ledgerPublish(path.basename(meta, '.json'), res.videoId, slot);
    }
    // 시리즈 재생목록(_upload/playlist.json 의 japan_no1)에 자동 추가 — 메타에 "playlist": false 면 건너뜀
    const plFile = path.join(DIR, 'playlist.json');
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (fs.existsSync(plFile) && m.playlist !== false) {
      const pls = JSON.parse(fs.readFileSync(plFile, 'utf8'));
      const pl = pls[`${PURPOSE}:${m.playlist || 'no1'}`] || (PURPOSE === 'arabshot' ? pls[m.playlist || 'japan_no1'] : null);
      if (!pl) { console.log(`    (재생목록 없음: ${PURPOSE})`); continue; }
      const H = { ...(await api()), 'Content-Type': 'application/json' };
      const pr = await fetch('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', { method: 'POST', headers: H,
        body: JSON.stringify({ snippet: { playlistId: pl, resourceId: { kind: 'youtube#video', videoId: res.videoId } } }) });
      console.log(pr.ok ? `    + 재생목록 ${pl}` : `    ✗ 재생목록 추가 실패 ${pr.status}`);
    }
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
  const startAt = Date.parse((fs.existsSync(CHANNEL_FILE) && JSON.parse(fs.readFileSync(CHANNEL_FILE, 'utf8')).startAt) || 0) || 0;
  const next = slotsFrom(new Date()).find((t) => t.getTime() >= startAt && !q.items.some((i) => i.publishAt === t.toISOString()));
  console.log(`다음 빈 슬롯: ${kst(next)}`);
}

async function comments() {
  const q = readQ();
  const H = await api();
  for (const i of q.items.filter((x) => !x.commentId && new Date(x.publishAt) <= Date.now())) {
    const meta = JSON.parse(fs.readFileSync(i.meta, 'utf8'));
    // 플랫폼별 링크 분리(10/17 소유주 «링크 구조 분할 진행»): 고정 댓글의 쿠팡 링크는 subId yt 판으로 — 리포트에서 유튜브 댓글 경로를 따로 본다
    let text = meta.pinned_comment;
    if (meta.affiliate_link && text.includes(meta.affiliate_link)) {
      const yt = await require('./shop_fanout').subLink(meta, 'yt').catch(() => '');
      if (yt) text = text.split(meta.affiliate_link).join(yt);
    }
    const r = await fetch('https://www.googleapis.com/youtube/v3/commentThreads?part=snippet', {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ snippet: { videoId: i.videoId, topLevelComment: { snippet: { textOriginal: require('./disclosure_cfg').stripText(text) } } } }),
    });
    const j = await r.json();
    if (r.ok) { i.commentId = j.id; console.log(`  ✓ 댓글 ${i.videoId}`); } else console.log(`  ✗ 댓글 ${i.videoId} ${r.status}`);
  }
  writeQ(q);
}

// fill: 재고(_upload/stock_new_channel.json 의 ready)에서 아직 안 올린 편을 다음 빈 슬롯에 올린다.
// 유튜브 하루 업로드 한도(메모 youtube-daily-upload-cap — 4편째에서 막힌다) 때문에 한 번에 3편까지만.
// 원리형(ffshop)·스토리형(ffstory)을 번갈아 고른다(2026-10-06 소유주: 한 채널에서 두 스타일 믹스).
async function fill(rest) {
  const max = Number(rest[0] || 3);
  const stock = JSON.parse(fs.readFileSync(path.join(DIR, 'stock_new_channel.json'), 'utf8'));
  const q = readQ();
  const used = new Set(q.items.map((i) => path.basename(i.meta)));
  const ahead = q.items.filter((i) => new Date(i.publishAt) > Date.now()).length;
  const want = Math.min(max, Math.max(0, 6 - ahead));            // 3일치(6슬롯)만 앞서 잡는다
  const skip = new Set(stock.skip || []);   // 다른(옛) 채널에 이미 공개된 편 — 새 채널에 다시 안 올린다
  const left = stock.ready.filter((n) => !used.has(n) && !skip.has(n));
  const story = left.filter((n) => n.startsWith('ffstory')), plain = left.filter((n) => !n.startsWith('ffstory'));
  const lastStory = q.items.length && path.basename(q.items[q.items.length - 1].meta).startsWith('ffstory');
  const pick = [];
  for (let turnStory = !lastStory; pick.length < want && (story.length || plain.length); turnStory = !turnStory) {
    const src = (turnStory && story.length) || !plain.length ? story : plain;
    pick.push(src.shift());
  }
  console.log(`예약 대기 ${ahead}편 · 재고 ${left.length}편 · 이번에 ${pick.length}편`);
  if (pick.length) await add(pick.map((n) => path.join(DIR, n)));
}

const [cmd, ...rest] = argv;   // --purpose 는 위에서 뺐다
({ add: () => add(rest), list: async () => list(), comments, fill: () => fill(rest) }[cmd] || (() => { console.error('add|list|comments'); process.exit(2); }))()
  .catch((e) => { console.error(e.message); process.exit(1); });

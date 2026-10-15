// 쇼핑쇼츠 성과 모아 보기 — 편별·플랫폼별 조회와 클릭·매출을 하루 한 번 기록한다.
//   node scripts/shop_metrics.js            오늘 스냅샷 → D:/volcano-runs/_upload/metrics/<YYYYMMDD>.json · .md, history.csv 누적
//
// 출처:
//   유튜브   — YouTube Data API(purpose shopping 채널, 대기열 schedule_shopping.json 의 videoId)
//   인스타·스레드·페이스북 — Blotato GET /posts(게시물 analytics, Blotato 가 주기적으로 갱신)
//   틱톡     — Zernio GET /posts/{id}(제출 id 는 shop_fanout_state.json 의 zernio:…) → 영상 URL → TikHub 조회수
//   인포크   — 크롬 9334 관리 화면의 블록별 «총 N» 클릭(번호표 product_numbers.json 으로 편과 잇는다)
//   네이버 클립 — clipcreators 스튜디오 목록 API(contents/cursor 의 playCount), 쇼핑 프로필 naverclip-shopping 세션으로 읽는다(2026-10-12)
//   쿠팡     — Partners Open API reports/clicks·orders·commission (최근 7일 합)
// 성과는 플랫폼별로 따로 본다(메모 judge-performance-per-platform-not-overall).
const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { OAuth2Client } = require('google-auth-library');
const { api: blotato } = require('./blotato-publish');
const coupang = require('./coupang_api');

const DIR = 'D:/volcano-runs/_upload';
const OUT = path.join(DIR, 'metrics');
const ROOT = path.join(__dirname, '..');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const kstDay = (ms = Date.now()) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');

async function youtube(ids) {
  const s = readJson(path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json'), { profiles: [] });
  const p = s.profiles.find((x) => x.purpose === 'shopping');
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  const H = { Authorization: `Bearer ${(await c.getAccessToken()).token}` };
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const j = await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids.slice(i, i + 50).join(',')}`, { headers: H })).json();
    for (const v of j.items || []) out[v.id] = { views: +v.statistics.viewCount || 0, likes: +v.statistics.likeCount || 0, comments: +v.statistics.commentCount || 0 };
  }
  return out;
}

async function blotatoPosts(sinceIso) {
  const out = [];
  let cursor = '';
  do {
    const r = await blotato('GET', `/posts?since=${sinceIso}&limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...(r.items || []));
    cursor = r.cursor;
  } while (cursor && out.length < 2000);
  return out;
}

async function tiktok(submissionId) {
  const zid = String(submissionId).replace(/^zernio:/, '');
  const z = await (await fetch(`https://zernio.com/api/v1/posts/${zid}`, { headers: { Authorization: `Bearer ${process.env.ZERNIO_API_KEY}` } })).json();
  const url = ((z.post || z).platforms || [])[0]?.platformPostUrl || '';
  const id = (url.match(/video\/(\d+)/) || [])[1];
  if (!id) return { url, views: null };
  const K = fs.readFileSync(path.join(os.homedir(), '.volcano', 'keys', 'tikhub'), 'utf8').trim();
  const r = await fetch(`https://api.tikhub.io/api/v1/tiktok/app/v3/fetch_one_video?aweme_id=${id}`, { headers: { Authorization: `Bearer ${K}`, 'User-Agent': 'Mozilla/5.0' } });
  const v = (await r.json()).data?.aweme_detail;
  return { url, views: v?.statistics?.play_count ?? null, likes: v?.statistics?.digg_count ?? null };
}

async function naverclip() {
  // 공개 API 가 없다 — 업로드에 쓰는 크롬 프로필로 스튜디오에 들어가 스튜디오 자체 API 를 같은 세션으로 부른다(2026-10-12 실측)
  const { chromium } = require('playwright-core');
  const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const ctx = await chromium.launchPersistentContext(path.join(ROOT, 'server', 'data', 'browser-profiles', 'naverclip-shopping'), {
    channel: 'chrome', executablePath: fs.existsSync(CHROME) ? CHROME : undefined, headless: true,
    locale: 'ko-KR', timezoneId: 'Asia/Seoul', args: ['--disable-blink-features=AutomationControlled'],
  });
  try {
    const p = ctx.pages()[0] || await ctx.newPage();
    await p.goto('https://clipcreators.naver.com/web/contents/clips', { waitUntil: 'domcontentloaded' });
    return await p.evaluate(async () => {
      const API = 'https://clip-service-elb-public.io.naver.com/studio/webapi';
      const get = async (u) => { const r = await fetch(API + u, { credentials: 'include' }); if (!r.ok) throw new Error(`${u} ${r.status}`); return r.json(); };
      const key = (await get('/profiles/self'))[0]?.profileKey;
      if (!key) throw new Error('로그인 세션 없음');
      const j = await get(`/profiles/${key}/contents/cursor?type=VOD&size=100`);
      // 초안(업로드 실패 잔여물)은 빼고, 본문 첫 줄 = 편 제목
      return (j.items || []).filter((x) => !x.draft).map((x) => ({ head: String(x.description || '').replace(/\s+/g, ' ').trim(), views: x.playCount ?? null, likes: x.likeCount ?? null, at: x.registerDateTime }));
    });
  } finally { await ctx.close(); }
}

async function inpock() {
  const { openInpock, gotoAdmin } = require('./inpock_browser');
  let h;
  try {
    h = await openInpock();
    await gotoAdmin(h.page);
    const t = await h.page.evaluate(() => document.body.innerText);
    const visits = (t.match(/전체\s*(\d+)/) || [])[1];
    const clicks = {};
    for (const m of t.matchAll(/(\d+)\. [^\n]+\n[\s\S]{0,40}?총 (\d+)/g)) clicks[m[1]] = +m[2];
    // 매니저 DM 자동화 카드: «<인스타 본문 앞부분> … 전송 N 읽음 N 클릭 N» (2026-10-09)
    const dm = [];
    await h.page.goto('https://link.inpock.co.kr/admin/manager/?tab=trigger', { waitUntil: 'networkidle' });
    await h.page.waitForTimeout(2500);
    // 카드는 스크롤해야 더 붙는다 — 끝까지 내린다
    for (let i = 0, prev = -1; i < 30; i += 1) {
      const n = await h.page.getByText('즉시 발송', { exact: true }).count();
      if (n === prev) break;
      prev = n;
      await h.page.mouse.wheel(0, 4000); await h.page.waitForTimeout(1200);
    }
    const mt = await h.page.evaluate(() => document.body.innerText);
    // «즉시 발송»으로 자른다: 조각 k 앞부분 = 카드 k 의 메시지·숫자, 조각 k-1 의 마지막 빈 줄 뒤 = 카드 k 의 인스타 본문(본문 안 줄바꿈 있음)
    const parts = mt.split('즉시 발송');
    for (let k = 1; k < parts.length; k += 1) {
      const head = parts[k - 1].split(/\n\n/).filter((x) => x.trim()).pop() || '';
      const n = parts[k].match(/전송\n(\d*)\n?읽음\n(\d*)\n?클릭\n(\d*)/) || [];
      dm.push({ head: head.trim().replace(/\s+/g, ' '), sent: +(n[1] || 0), read: +(n[2] || 0), click: +(n[3] || 0) });
    }
    return { visits: visits ? +visits : null, clicks, dm };
  } catch (e) { return { error: `인포크: ${e.message.slice(0, 100)}` }; } finally { if (h) await h.close(); }
}

(async () => {
  const q = readJson(path.join(DIR, 'schedule_shopping.json'), { items: [] });
  const st = readJson(path.join(ROOT, 'server', 'data', 'shop_fanout_state.json'), { history: [] });
  const nums = readJson(path.join(DIR, 'product_numbers.json'), { numbers: {} }).numbers;
  // 유튜브 대기열(새 채널) + 옛 채널 대기열 + 다른 플랫폼에만 나간 편(fanout 기록)까지 — 공개 시각이 지난 것
  const old = readJson(path.join(DIR, 'schedule_shopping_old_ssulmo.json'), { items: [] }).items.map((i) => ({ ...i, oldChannel: true }));
  const byKey = new Map();
  for (const i of [...old, ...q.items]) byKey.set(path.basename(i.meta, '.json'), i);
  for (const h of st.history) {
    if (!byKey.has(h.key)) byKey.set(h.key, { meta: path.join(DIR, `${h.key}.json`), publishAt: h.scheduledTime });
  }
  const published = [...byKey.values()].filter((i) => Date.parse(i.publishAt) <= Date.now())
    .sort((a, b) => a.publishAt.localeCompare(b.publishAt));
  const keyOf = (meta) => path.basename(meta, '.json');

  const yt = await youtube(published.filter((i) => i.videoId && !i.oldChannel).map((i) => i.videoId)).catch((e) => ({ _error: e.message }));
  const since = new Date(Date.now() - 30 * 86400e3).toISOString();
  const posts = await blotatoPosts(since).catch(() => []);
  const ip = await inpock();
  const nv = await naverclip().catch((e) => ({ error: `네이버 클립: ${e.message.slice(0, 100)}` }));
  const day = kstDay();
  const from = kstDay(Date.now() - 6 * 86400e3);
  const cp = {};
  for (const k of ['clicks', 'orders', 'commission']) {
    try { cp[k] = (await coupang.report(k, from, day)).data || []; } catch (e) { cp[k] = { error: e.message.slice(0, 120) }; }
  }

  const rows = [];
  for (const it of published) {
    const key = keyOf(it.meta);
    const meta = readJson(it.meta, {});
    const title = String(meta.title || '').replace(/#[^\s#]+/g, '').trim();
    const row = { key, title, style: meta.style || 'deco', publishAt: it.publishAt, n: nums[key] || null,   // style: clean(흰 자막만)·deco(배지·효과음·색) 비교(10/14)
    youtube: it.oldChannel ? '옛채널' : (yt[it.videoId]?.views ?? null) };
    for (const h of st.history.filter((x) => x.key === key)) {
      if (h.platform === 'tiktok') { row.tiktok = (await tiktok(h.submissionId).catch(() => ({ views: null }))).views; continue; }
      const p = posts.find((x) => String(x.account?.id) === String(h.accountId) && x.platform === h.platform && String(x.text || '').includes(title));   // 인스타 캡션 첫 줄은 DM 안내(10/12) — 포함으로 찾는다
      const m = p?.state?.analytics?.latest?.metrics;
      row[h.platform] = m ? +(m.viewsCount ?? m.reachCount ?? 0) : null;
      if (h.platform === 'instagram' && m) row.ig_comments = m.commentsCount ?? m.commentCount ?? null;
      if (h.platform === 'instagram' && m) row.ig_watch_s = Math.round((+m.watchTimeMsAvg || 0) / 100) / 10;
    }
    if (Array.isArray(nv)) { const c = nv.find((x) => title && x.head.includes(title)); row.naver = c ? c.views : null; }
    row.inpock_clicks = row.n && ip.clicks ? (ip.clicks[String(row.n)] ?? null) : null;
    const d = (ip.dm || []).find((x) => title && x.head.includes(title.slice(0, 12)));
    if (d) Object.assign(row, { dm_sent: d.sent, dm_read: d.read, dm_click: d.click });
    rows.push(row);
  }

  const sum = (arr, f) => (Array.isArray(arr) ? arr.reduce((a, x) => a + (+x[f] || 0), 0) : null);
  const snap = {
    at: new Date().toISOString(), rows,
    inpock: { visits: ip.visits ?? null, dmRules: (ip.dm || []).length, error: ip.error },
    naverError: Array.isArray(nv) ? undefined : nv.error,
    coupang7d: { clicks: sum(cp.clicks, 'click'), orders: Array.isArray(cp.orders) ? cp.orders.length : null, commission: sum(cp.commission, 'commission') },
    // subId 별(빈 값 = 인포크·유튜브 등 기본 링크, igdm = 인스타 DM, threads, pinterest)
    coupangBySub: (() => {
      const o = {};
      const add = (arr, f, k) => { if (Array.isArray(arr)) for (const x of arr) { const s = x.subId || '기본'; o[s] = o[s] || { clicks: 0, orders: 0, commission: 0 }; o[s][k] += f(x); } };
      add(cp.clicks, (x) => +x.click || 0, 'clicks'); add(cp.orders, () => 1, 'orders'); add(cp.commission, (x) => +x.commission || 0, 'commission');
      return o;
    })(),
    coupangDaily: Array.isArray(cp.clicks) ? cp.clicks.reduce((o, x) => { o[x.date] = (o[x.date] || 0) + (+x.click || 0); return o; }, {}) : null,
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${day}.json`), `${JSON.stringify(snap, null, 2)}\n`, 'utf8');

  const cols = ['youtube', 'instagram', 'tiktok', 'facebook', 'threads'];
  // naver 는 history.csv 끝 열(10/12 추가) — 앞 열 순서를 바꾸면 예전 줄이 어긋난다
  const md = [`# 쇼핑 성과 ${day}`, '',
    `인포크 방문 누적 ${snap.inpock.visits ?? '?'} · 쿠팡 최근 7일 클릭 ${snap.coupang7d.clicks ?? '?'} · 주문 ${snap.coupang7d.orders ?? '?'} · 수수료 ${snap.coupang7d.commission ?? '?'}원`, '',
    '| 번호 | 편 | 공개 | 유튜브 | 인스타(평균 시청초) | 틱톡 | 페이스북 | 스레드 | 네이버 클립 | 인포크 클릭 | DM 전송/클릭 |', '|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((r) => `| ${r.n ?? ''} | ${r.style === 'clean' ? '[깨끗] ' : ''}${r.title.slice(0, 22)} | ${new Date(Date.parse(r.publishAt) + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ')} | ${r.youtube ?? '-'} | ${r.instagram ?? '-'}${r.ig_watch_s ? ` (${r.ig_watch_s}s)` : ''} | ${r.tiktok ?? '-'} | ${r.facebook ?? '-'} | ${r.threads ?? '-'} | ${r.naver ?? '-'} | ${r.inpock_clicks ?? '-'} | ${r.dm_sent != null ? `${r.dm_sent}/${r.dm_click}` : '-'} |`)];
  fs.writeFileSync(path.join(OUT, `${day}.md`), `${md.join('\n')}\n`, 'utf8');

  const hist = path.join(OUT, 'history.csv');
  const header = `date,key,${cols.join(',')},inpock_clicks,naver`;
  if (!fs.existsSync(hist)) fs.writeFileSync(hist, `${header}\n`, 'utf8');
  else { const h = fs.readFileSync(hist, 'utf8'); if (!h.startsWith(`${header}\n`)) fs.writeFileSync(hist, `${header}\n${h.slice(h.indexOf('\n') + 1)}`, 'utf8'); }
  fs.appendFileSync(hist, rows.map((r) => [day, r.key, ...cols.map((c) => r[c] ?? ''), r.inpock_clicks ?? '', r.naver ?? ''].join(',')).join('\n') + '\n', 'utf8');
  console.log(md.join('\n'));
})().catch((e) => { console.error(e.message); process.exit(1); });

// AI 오피스 허브 (VPS littlecreek, /opt/ai-office, systemd ai-office). 의존성: ws.
//
//   GET  /                       화면(public/index.html)
//   GET  /config.js              수파베이스 주소·anon 키(공개용 값)
//   WS   /agent                  기기 연결기(office/agent.js). 첫 메시지 hello 의 기기 토큰으로 기기를 정한다.
//   GET  /api/state              [소유주] 기기·세션·결정·조작 기록
//   POST /api/cmd                [소유주] {device, op, args} → 그 기기 연결기로 전달. op 는 read·send·launch·close·refresh 만.
//   POST /api/decisions/:id      [소유주] {answer} 결정 답
//   POST /api/ingest             (옛 수집기) 기기 토큰으로 스냅샷 저장
//   POST /api/device/decisions   (기기 토큰) 세션의 결정 요청 — office/ask.js. media_ids 로 결과물을 붙일 수 있다
//   POST /api/device/share       (기기 토큰) 결과물 올리기 — office/share.js (media.js)
//   POST /api/upload             [소유주] 스크린샷 등 올리기 → 세션이 받아 볼 서명 주소
//   POST /api/projects           [소유주] 프로젝트 이름·담당 세션, 오피스 담당 세션 지정
//   GET  /media/:id?e=&s=        서명 주소로 결과물 보기(Range 지원)
//
// [소유주] = 수파베이스 로그인 토큰을 /auth/v1/user 로 확인하고 OFFICE_OWNER_UID 와 같을 때만.
// .env (커밋 금지): SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, OFFICE_OWNER_UID,
//   OFFICE_DEVICE_TOKENS=기기:토큰,…   PORT=3300
// 키·토큰 값은 응답·로그 어디에도 찍지 않는다(handoff-office §6).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const webpush = require('web-push');

function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
loadEnv(path.join(__dirname, '.env'));
const media = require('./media'); // .env 를 읽은 뒤에 불러야 서명 키가 잡힌다

// 프로젝트 설정: 이름·담당(관리자) 세션. 오피스 담당 세션은 «총괄» 대화창이 말을 거는 곳.
const PROJECTS = path.join(__dirname, 'projects.json');
const readProjects = () => { try { return JSON.parse(fs.readFileSync(PROJECTS, 'utf8')); } catch { return { projects: {}, office: null }; } };
const writeProjects = (p) => fs.writeFileSync(PROJECTS, JSON.stringify(p, null, 2) + '\n', 'utf8');

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, OFFICE_OWNER_UID } = process.env;
const PORT = Number(process.env.PORT || 3300);
const TOKENS = new Map((process.env.OFFICE_DEVICE_TOKENS || '').split(',').filter(Boolean).map((p) => {
  const i = p.indexOf(':');
  return [p.slice(i + 1), p.slice(0, i)];
}));
const PUBLIC = path.join(__dirname, 'public');
const ACTIONS = path.join(__dirname, 'actions.jsonl');
const SUBS = path.join(__dirname, 'push-subs.json');
const ROUTES = path.join(__dirname, 'decision-routes.json'); // 결정 id → 물어본 기기·터미널
const readRoutes = () => { try { return JSON.parse(fs.readFileSync(ROUTES, 'utf8')); } catch { return {}; } };
const writeRoutes = (r) => fs.writeFileSync(ROUTES, JSON.stringify(r, null, 2) + '\n', 'utf8');
const DEVICE_NAMES = { 'main-pc': '메인 PC', 'mini-pc': '미니 PC', laptop: '노트북', vps: 'VPS' };
const devName = (d) => DEVICE_NAMES[d] || d;
const STATIC = {
  '/manifest.webmanifest': 'application/manifest+json; charset=utf-8',
  '/sw.js': 'text/javascript; charset=utf-8',
  '/icon-192.png': 'image/png',
  '/icon-512.png': 'image/png',
};
const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) webpush.setVapidDetails('https://office.grow-up.kr', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
const OPS = new Set(['read', 'chat', 'send', 'launch', 'launch_cu', 'close', 'compact', 'refresh']);
const LOGGED_OPS = new Set(['send', 'launch', 'launch_cu', 'close', 'compact']);

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

// 토큰 칸은 원문 또는 «sha256:해시». 새 기기는 자기가 만든 토큰의 해시만 알려 주면 된다(원문이 메시지로 오가지 않게).
function deviceFor(token) {
  if (!token || typeof token !== 'string') return null;
  const hashed = 'sha256:' + crypto.createHash('sha256').update(token).digest('hex');
  for (const [t, device] of TOKENS) {
    const cand = t.startsWith('sha256:') ? hashed : token;
    const a = Buffer.from(t), b = Buffer.from(cand);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return device;
  }
  return null;
}

async function readBody(req, max = 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw Object.assign(new Error('too large'), { code: 413 });
    chunks.push(c);
  }
  const t = Buffer.concat(chunks).toString('utf8');
  return t ? JSON.parse(t) : {};
}

const sbHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json' };
const sb = (p, init = {}) => fetch(`${SUPABASE_URL}/rest/v1/${p}`, { ...init, headers: { ...sbHeaders, ...(init.headers || {}) } });

// ── 소유주 확인 (토큰 → uid, 5분 캐시) ──
const authCache = new Map();
async function isOwner(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return false;
  const hit = authCache.get(token);
  if (hit && hit.until > Date.now()) return hit.ok;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${token}` } });
  const u = r.ok ? await r.json() : null;
  const ok = !!u && u.id === OFFICE_OWNER_UID;
  authCache.set(token, { ok, until: Date.now() + 5 * 60e3 });
  if (authCache.size > 200) authCache.delete(authCache.keys().next().value);
  return ok;
}

// ── 기기 ──
const devices = new Map(); // device → { ws, state, connected_at }
const pending = new Map(); // id → { resolve, timer }

async function loadSnapshots() {
  try {
    const r = await sb('office_snapshots?select=device,at,data');
    for (const row of r.ok ? await r.json() : []) {
      if (!devices.has(row.device)) devices.set(row.device, { ws: null, state: row.data, connected_at: null });
    }
  } catch (e) { console.error('[office] 스냅샷 불러오기 실패', e.message); }
}

const lastSaved = new Map();
async function saveSnapshot(device, state) {
  if (Date.now() - (lastSaved.get(device) || 0) < 60e3) return;
  lastSaved.set(device, Date.now());
  const r = await sb('office_snapshots?on_conflict=device', {
    method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    // 글을 잘라 쓰다 반쪽 남은 이모지(짝 없는 서로게이트)·NUL 이 하나라도 있으면 수파베이스가 통째로 거부한다(10-30 02:59~ main-pc 400)
    body: JSON.stringify({ device, at: state.at || new Date().toISOString(), data: state, updated_at: new Date().toISOString() },
      (k, v) => (typeof v === 'string' ? v.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�').replace(/\u0000/g, '') : v)),
  });
  if (!r.ok) console.error(`[office] 저장 실패 ${device} ${r.status}`, (await r.text().catch(() => '')).slice(0, 200));
}

function command(device, op, args) {
  const d = devices.get(device);
  if (!d || !d.ws || d.ws.readyState !== 1) return Promise.resolve({ ok: false, error: '기기가 연결돼 있지 않다' });
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: '기기 응답 없음(시간 초과)' }); }, 100e3);
    pending.set(id, { resolve, timer });
    d.ws.send(JSON.stringify({ type: 'cmd', id, op, args }));
  });
}

// ── 푸시 알림 (소유주 폰·PC 브라우저) ──
const readSubs = () => { try { return JSON.parse(fs.readFileSync(SUBS, 'utf8')); } catch { return []; } };
const writeSubs = (s) => fs.writeFileSync(SUBS, JSON.stringify(s, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
async function notify(payload) {
  if (!VAPID_PRIVATE_KEY) return 0;
  const subs = readSubs();
  const keep = [];
  let sent = 0;
  for (const s of subs) {
    try { await webpush.sendNotification(s, JSON.stringify(payload), { TTL: 3600 }); keep.push(s); sent++; }
    catch (e) { if (e.statusCode !== 404 && e.statusCode !== 410) keep.push(s); }
  }
  if (keep.length !== subs.length) writeSubs(keep);
  return sent;
}

// 새 결정이 올라오면 알린다. 처음 켤 때 이미 있던 것은 알리지 않는다.
const seenDecisions = new Set();
let decisionsPrimed = false;
async function watchDecisions() {
  const r = await sb('office_decisions?select=id,lane,question&status=eq.open&order=created_at.asc').catch(() => null);
  if (!r || !r.ok) return;
  for (const d of await r.json()) {
    if (seenDecisions.has(d.id)) continue;
    seenDecisions.add(d.id);
    if (decisionsPrimed) await notify({ title: `결정 대기 · ${d.lane}`, body: d.question, tag: `decision-${d.id}`, url: '/#decisions' });
  }
  decisionsPrimed = true;
}

// 기기가 끊긴 채 10분이 지나면 한 번 알린다.
const offlineSince = new Map();
function watchDevices() {
  for (const [device, d] of devices) {
    const online = !!(d.ws && d.ws.readyState === 1);
    if (online) { offlineSince.delete(device); continue; }
    if (!d.connected_at) continue; // 이번 실행에서 한 번도 안 붙은 기기는 조용히
    const o = offlineSince.get(device) || { at: Date.now(), told: false };
    offlineSince.set(device, o);
    if (!o.told && Date.now() - o.at > 10 * 60e3) {
      o.told = true;
      notify({ title: '기기 연결 끊김', body: `${device} 가 10분째 오피스에 안 붙어 있습니다.`, tag: `device-${device}`, url: '/' });
    }
  }
}

// 결정 답 묶음 전달: 기기·터미널마다 첫 답이 들어온 뒤 60초를 기다렸다가 모은 답을 한 번에 넣는다.
const answerQueue = new Map(); // `${device}|${handle}` → { lines, timer }
function queueAnswer(device, handle, line) {
  const key = `${device}|${handle}`;
  const q = answerQueue.get(key) || { lines: [], timer: null };
  q.lines.push(line);
  if (!q.timer) q.timer = setTimeout(() => flushAnswers(key, device, handle), 60e3);
  answerQueue.set(key, q);
}
async function flushAnswers(key, device, handle) {
  const q = answerQueue.get(key); answerQueue.delete(key);
  if (!q || !q.lines.length) return;
  const text = (q.lines.length === 1 ? `[오피스 결정 답] ${q.lines[0]}`
    : `[오피스 결정 답 ${q.lines.length}건] ` + q.lines.join(' / ')).slice(0, 4000);
  const r = await command(device, 'send', { handle, text });
  logAction({ op: 'deliver', device, label: `결정 답 ${q.lines.length}건 전달`, text: r.ok ? '' : r.error, ok: r.ok });
}

function logAction(entry) {
  fs.appendFileSync(ACTIONS, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
}
function recentActions(n = 80) {
  try {
    return fs.readFileSync(ACTIONS, 'utf8').trimEnd().split('\n').slice(-n).reverse().map((l) => JSON.parse(l));
  } catch { return []; }
}

// ── HTTP ──
async function api(req, res, url) {
  if (url.pathname === '/api/ingest' && req.method === 'POST') {
    const device = deviceFor(req.headers['x-office-token']);
    if (!device) return send(res, 401, { error: 'unknown device' });
    const snap = await readBody(req);
    const d = devices.get(device) || { ws: null, state: {}, connected_at: null };
    // 연결기가 붙어 있으면 그쪽 상태가 더 풍부하다. 수집기는 snapshot 칸만 채운다.
    d.state = { ...(d.state || {}), device, at: d.ws ? d.state.at : snap.at, snapshot: snap };
    devices.set(device, d);
    await saveSnapshot(device, d.state);
    return send(res, 200, { ok: true, device });
  }

  // 세션의 결정 요청(office/ask.js). 기기 토큰으로 인증, 답을 돌려줄 터미널을 기억해 둔다.
  if (url.pathname.startsWith('/api/device/')) {
    const device = deviceFor(req.headers['x-office-token']);
    if (!device) return send(res, 401, { error: 'unknown device' });
    // 결과물 올리기(office/share.js). 본문 = 파일 그대로, 정보는 주소 뒤 ?name=&title=&lane=&project=&from=&note=
    if (url.pathname === '/api/device/share' && req.method === 'POST') {
      const q = url.searchParams;
      let item;
      try {
        item = await media.save(req, { name: q.get('name'), title: q.get('title'), lane: q.get('lane'), project: q.get('project'), from: q.get('from'), note: q.get('note'), device });
      } catch (e) { return send(res, e.code && e.code < 600 ? e.code : 500, { error: e.message }); }
      if (q.get('notify') !== '0') notify({ title: `새 결과물 · ${item.lane || devName(device)}`, body: item.title, tag: `media-${item.id}`, url: '/#results' }).catch(() => {});
      logAction({ device, op: 'share', label: `${item.lane ? item.lane + ': ' : ''}${item.title}`.slice(0, 160), text: `${item.mime} · ${(item.size / 1048576).toFixed(1)}MB`, ok: true });
      return send(res, 200, { ok: true, id: item.id });
    }
    if (url.pathname === '/api/device/decisions' && req.method === 'POST') {
      const b = await readBody(req, 32 * 1024);
      if (!b.lane || !b.question) return send(res, 400, { error: 'lane·question 이 필요하다' });
      const row = {
        lane: String(b.lane).slice(0, 60), question: String(b.question).slice(0, 1000),
        options: Array.isArray(b.options) ? b.options.slice(0, 6).map((o) => String(o).slice(0, 120)) : [],
        recommended: b.recommended ? String(b.recommended).slice(0, 120) : null,
        asked_by: [b.asked_by, devName(device)].filter(Boolean).join(' · ').slice(0, 120),
      };
      const r = await sb('office_decisions', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify(row) });
      const out = r.ok ? (await r.json())[0] : null;
      if (!out) return send(res, 502, { error: '저장 실패' });
      const mediaIds = Array.isArray(b.media_ids) ? b.media_ids.filter((x) => typeof x === 'string' && media.get(x)).slice(0, 6) : [];
      for (const mid of mediaIds) media.link(mid, out.id);
      const routes = readRoutes();
      routes[out.id] = { device, handle: typeof b.handle === 'string' ? b.handle : null, media: mediaIds };
      writeRoutes(routes);
      seenDecisions.add(out.id);
      notify({ title: `결정 대기 · ${row.lane}`, body: row.question, tag: `decision-${out.id}`, url: '/#decisions' }).catch(() => {});
      logAction({ device, op: 'ask', label: `${row.lane}: ${row.question}`.slice(0, 160), text: row.options.join(' / '), ok: true });
      return send(res, 200, { ok: true, id: out.id });
    }
    const dm = url.pathname.match(/^\/api\/device\/decisions\/(\d+)$/);
    if (dm && req.method === 'GET') {
      const r = await sb(`office_decisions?id=eq.${dm[1]}&select=id,status,answer,answered_at`);
      const row = r.ok ? (await r.json())[0] : null;
      return row ? send(res, 200, row) : send(res, 404, { error: '없는 결정' });
    }
    return send(res, 404, { error: 'not found' });
  }

  if (!(await isOwner(req))) return send(res, 401, { error: 'login' });

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const decisions = await sb('office_decisions?select=*&order=created_at.desc&limit=100').then((r) => r.ok ? r.json() : []);
    const routes = readRoutes();
    for (const d of decisions) d.media = (routes[d.id]?.media || []);
    return send(res, 200, {
      devices: [...devices.entries()].map(([device, d]) => ({
        device, online: !!(d.ws && d.ws.readyState === 1), connected_at: d.connected_at, state: d.state,
      })),
      decisions, actions: recentActions(), media: media.listForOwner(), config: readProjects(),
    });
  }

  // 소유주가 올리는 스크린샷 등(총괄·담당 대화창 첨부). 세션이 받아 볼 수 있게 절대 서명 주소를 돌려준다.
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    let item;
    try { item = await media.save(req, { name: url.searchParams.get('name'), title: url.searchParams.get('name'), by_owner: true }); }
    catch (e) { return send(res, e.code && e.code < 600 ? e.code : 500, { error: e.message }); }
    return send(res, 200, { ok: true, id: item.id, url: `https://office.grow-up.kr${media.signedUrl(item.id)}` });
  }

  // 프로젝트 담당 세션 지정 {key, name?, manager?} · 오피스 담당 {office: {device, title}}
  if (url.pathname === '/api/projects' && req.method === 'POST') {
    const b = await readBody(req, 16 * 1024);
    const cfg = readProjects();
    if (b.office) cfg.office = { device: String(b.office.device || ''), title: String(b.office.title || '').slice(0, 120) };
    if (b.key) {
      const p = cfg.projects[b.key] || {};
      if (b.name != null) p.name = String(b.name).slice(0, 60);
      if (b.manager != null) p.manager = String(b.manager).slice(0, 120);
      cfg.projects[b.key] = p;
    }
    writeProjects(cfg);
    logAction({ op: 'config', label: b.key ? `프로젝트 ${b.key} 설정` : '오피스 담당 설정', text: JSON.stringify(b).slice(0, 200), ok: true });
    return send(res, 200, { ok: true, config: cfg });
  }

  if (url.pathname === '/api/cmd' && req.method === 'POST') {
    const { device, op, args = {}, label } = await readBody(req);
    if (!OPS.has(op)) return send(res, 400, { error: '허용되지 않은 명령' });
    const r = await command(device, op, args);
    if (LOGGED_OPS.has(op)) {
      logAction({ device, op, label: label || args.title || null, text: op === 'send' ? String(args.text || '').slice(0, 200) : undefined, ok: r.ok, error: r.error });
    }
    return send(res, r.ok ? 200 : 502, r);
  }

  if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
    const { subscription } = await readBody(req, 16 * 1024);
    if (!subscription || !subscription.endpoint || !/^https:\/\//.test(subscription.endpoint)) return send(res, 400, { error: '구독 정보가 없다' });
    const subs = readSubs().filter((s) => s.endpoint !== subscription.endpoint);
    subs.push(subscription);
    writeSubs(subs.slice(-10));
    return send(res, 200, { ok: true, count: subs.length });
  }
  if (url.pathname === '/api/push/test' && req.method === 'POST') {
    const sent = await notify({ title: 'AI 오피스', body: '알림이 켜졌습니다. 결정 대기와 기기 끊김을 알려 드립니다.', tag: 'test', url: '/' });
    return send(res, 200, { ok: sent > 0, sent });
  }

  const m = url.pathname.match(/^\/api\/decisions\/(\d+)$/);
  if (m && req.method === 'POST') {
    const { answer } = await readBody(req);
    if (!answer) return send(res, 400, { error: '답이 없다' });
    const r = await sb(`office_decisions?id=eq.${m[1]}&status=eq.open`, {
      method: 'PATCH', headers: { prefer: 'return=representation' },
      body: JSON.stringify({ status: 'answered', answer: String(answer).slice(0, 2000), answered_at: new Date().toISOString() }),
    });
    const rows = r.ok ? await r.json() : [];
    // 물어본 세션 터미널에 답을 넣는다. 같은 세션에 가는 답은 1분 모아 한 번에(세션이 답마다 깨어나 대화 전체를 다시 읽지 않게).
    let delivered = null;
    const route = rows[0] && readRoutes()[rows[0].id];
    if (route && route.handle) {
      queueAnswer(route.device, route.handle, `#${rows[0].id} ${String(rows[0].question).replace(/\s*\n\s*/g, ' ').slice(0, 300)} → ${answer}`);
      delivered = '1분 안에 세션에 전달';
    }
    logAction({ op: 'decision', device: route?.device, label: rows[0] ? `${rows[0].lane}: ${rows[0].question}`.slice(0, 160) : `#${m[1]}`, text: answer + (delivered ? ` (${delivered})` : ''), ok: rows.length > 0 });
    return send(res, rows.length ? 200 : 409, rows.length ? { ok: true, delivered } : { error: '이미 답했거나 없는 결정' });
  }

  send(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const mm = url.pathname.match(/^\/media\/([A-Za-z0-9_-]{12})$/);
    if (mm && req.method === 'GET') return media.serve(req, res, mm[1], url.searchParams);
    if (req.method !== 'GET') return send(res, 405, { error: 'method' });
    if (url.pathname === '/config.js') {
      return send(res, 200, `window.OFFICE=${JSON.stringify({ url: SUPABASE_URL, anon: SUPABASE_ANON_KEY, vapid: VAPID_PUBLIC_KEY || null })};`, 'text/javascript; charset=utf-8');
    }
    if (STATIC[url.pathname]) {
      res.writeHead(200, { 'content-type': STATIC[url.pathname], 'cache-control': url.pathname === '/sw.js' ? 'no-cache' : 'public, max-age=86400' });
      return res.end(fs.readFileSync(path.join(PUBLIC, url.pathname.slice(1))));
    }
    if (url.pathname === '/health') return send(res, 200, { ok: true, devices: [...devices.values()].filter((d) => d.ws).length });
    // 다른 기기가 연결기를 받아 가는 곳(비밀 없음 — 토큰은 기기에서 만든다).
    if (['/agent.js', '/ask.js', '/cu.js', '/share.js'].includes(url.pathname)) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, url.pathname.slice(1)), 'utf8'), 'text/javascript; charset=utf-8');
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[office]', e.message);
    if (!res.headersSent) send(res, e.code === 413 ? 413 : 500, { error: e.code === 413 ? 'too large' : 'server' });
  }
});

// ── 연결기 WebSocket ──
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/agent') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', (ws) => {
  let device = null;
  const helloTimer = setTimeout(() => ws.close(4001, 'hello'), 5000);
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!device) {
      if (m.type !== 'hello') return ws.close(4001, 'hello');
      device = deviceFor(m.token);
      clearTimeout(helloTimer);
      if (!device) return ws.close(4003, 'unknown device');
      const prev = devices.get(device);
      if (prev?.ws && prev.ws !== ws) prev.ws.close(4000, 'replaced');
      devices.set(device, { ws, state: prev?.state || null, connected_at: new Date().toISOString() });
      console.log(`[agent] ${device} 연결`);
      return;
    }
    if (m.type === 'state' && m.state) {
      const d = devices.get(device);
      // 세션이 묻고 멈췄거나 허가를 기다리기 시작하면 알림(허브 재시작 직후 첫 상태는 비교할 게 없어 건너뜀)
      const askKey = (x) => `${x.title}|${x.ask.kind}|${x.ask.at || ''}`;
      const before = d.state ? new Set((d.state.sessions || []).filter((x) => x.ask).map(askKey)) : null;
      if (before) for (const x of (m.state.sessions || []).filter((y) => y.ask && !before.has(askKey(y)))) {
        notify({ title: `${x.ask.kind === 'permission' ? '허가 대기' : '세션이 답을 기다려요'} · ${String(x.title || '').replace(/^[^\p{L}\p{N}]+/u, '')}`,
          body: String(x.ask.text || '').replace(/\s+/g, ' ').slice(-140) || '승인해야 진행합니다', tag: `ask-${x.title}`, url: '/#decisions' }).catch(() => {});
      }
      d.state = { ...m.state, device };
      saveSnapshot(device, d.state).catch(() => {});
    } else if (m.type === 'result' && pending.has(m.id)) {
      const p = pending.get(m.id);
      clearTimeout(p.timer); pending.delete(m.id);
      p.resolve({ ok: !!m.ok, result: m.result, error: m.error });
    }
  });
  ws.on('close', () => {
    clearTimeout(helloTimer);
    const d = device && devices.get(device);
    if (d && d.ws === ws) { d.ws = null; console.log(`[agent] ${device} 끊김`); }
  });
  ws.on('error', () => {});
});

setInterval(() => { for (const c of wss.clients) if (c.readyState === 1) c.ping(); }, 30e3);
setInterval(() => { watchDecisions().catch(() => {}); watchDevices(); }, 30e3);
setInterval(() => { try { media.cleanup(); } catch (e) { console.error('[media] 정리 실패', e.message); } }, 3600e3);
watchDecisions().catch(() => {});

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY || !OFFICE_OWNER_UID) {
  console.error('[office] .env 값이 빠졌다');
  process.exit(1);
}
loadSnapshots().then(() => {
  server.listen(PORT, '127.0.0.1', () => console.log(`[office] 127.0.0.1:${PORT} · 기기 토큰 ${TOKENS.size}개`));
});

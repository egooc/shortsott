// AI 오피스 허브 (VPS littlecreek, /opt/ai-office, systemd ai-office). 의존성: ws.
//
//   GET  /                       화면(public/index.html)
//   GET  /config.js              수파베이스 주소·anon 키(공개용 값)
//   WS   /agent                  기기 연결기(office/agent.js). 첫 메시지 hello 의 기기 토큰으로 기기를 정한다.
//   GET  /api/state              [소유주] 기기·세션·결정·조작 기록
//   POST /api/cmd                [소유주] {device, op, args} → 그 기기 연결기로 전달. op 는 read·send·launch·close·refresh 만.
//   POST /api/decisions/:id      [소유주] {answer} 결정 답
//   POST /api/ingest             (옛 수집기) 기기 토큰으로 스냅샷 저장
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

function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
loadEnv(path.join(__dirname, '.env'));

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, OFFICE_OWNER_UID } = process.env;
const PORT = Number(process.env.PORT || 3300);
const TOKENS = new Map((process.env.OFFICE_DEVICE_TOKENS || '').split(',').filter(Boolean).map((p) => {
  const i = p.indexOf(':');
  return [p.slice(i + 1), p.slice(0, i)];
}));
const PUBLIC = path.join(__dirname, 'public');
const ACTIONS = path.join(__dirname, 'actions.jsonl');
const OPS = new Set(['read', 'send', 'launch', 'close', 'refresh']);
const LOGGED_OPS = new Set(['send', 'launch', 'close']);

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
    body: JSON.stringify({ device, at: state.at || new Date().toISOString(), data: state, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) console.error(`[office] 저장 실패 ${device} ${r.status}`);
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

  if (!(await isOwner(req))) return send(res, 401, { error: 'login' });

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const decisions = await sb('office_decisions?select=*&order=created_at.desc&limit=100').then((r) => r.ok ? r.json() : []);
    return send(res, 200, {
      devices: [...devices.entries()].map(([device, d]) => ({
        device, online: !!(d.ws && d.ws.readyState === 1), connected_at: d.connected_at, state: d.state,
      })),
      decisions, actions: recentActions(),
    });
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

  const m = url.pathname.match(/^\/api\/decisions\/(\d+)$/);
  if (m && req.method === 'POST') {
    const { answer } = await readBody(req);
    if (!answer) return send(res, 400, { error: '답이 없다' });
    const r = await sb(`office_decisions?id=eq.${m[1]}&status=eq.open`, {
      method: 'PATCH', headers: { prefer: 'return=representation' },
      body: JSON.stringify({ status: 'answered', answer: String(answer).slice(0, 2000), answered_at: new Date().toISOString() }),
    });
    const rows = r.ok ? await r.json() : [];
    logAction({ op: 'decision', label: rows[0] ? `${rows[0].lane}: ${rows[0].question}`.slice(0, 160) : `#${m[1]}`, text: answer, ok: rows.length > 0 });
    return send(res, rows.length ? 200 : 409, rows.length ? { ok: true } : { error: '이미 답했거나 없는 결정' });
  }

  send(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET') return send(res, 405, { error: 'method' });
    if (url.pathname === '/config.js') {
      return send(res, 200, `window.OFFICE=${JSON.stringify({ url: SUPABASE_URL, anon: SUPABASE_ANON_KEY })};`, 'text/javascript; charset=utf-8');
    }
    if (url.pathname === '/health') return send(res, 200, { ok: true, devices: [...devices.values()].filter((d) => d.ws).length });
    // 다른 기기가 연결기를 받아 가는 곳(비밀 없음 — 토큰은 기기에서 만든다).
    if (url.pathname === '/agent.js') return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'agent.js'), 'utf8'), 'text/javascript; charset=utf-8');
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

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY || !OFFICE_OWNER_UID) {
  console.error('[office] .env 값이 빠졌다');
  process.exit(1);
}
loadSnapshots().then(() => {
  server.listen(PORT, '127.0.0.1', () => console.log(`[office] 127.0.0.1:${PORT} · 기기 토큰 ${TOKENS.size}개`));
});

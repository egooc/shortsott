// AI 오피스 서버 (VPS littlecreek, /opt/ai-office). 의존성 없음 — node 20 내장 http·fetch 만 쓴다.
//
//   GET  /                 화면(public/index.html). 로그인·조회는 브라우저가 수파베이스에 직접 한다(RLS = 소유주 1명).
//   GET  /config.js        수파베이스 주소와 anon 키(원래 공개용 값)만 내려준다.
//   POST /api/ingest       기기 수집기가 스냅샷을 올린다. 기기별 토큰이 맞아야 하고, 저장은 service role 로.
//
// .env (이 폴더, 커밋 금지): SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//   OFFICE_DEVICE_TOKENS=기기:토큰,기기:토큰   PORT=3300
// 키 값은 응답·로그 어디에도 찍지 않는다(handoff-office §6).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
loadEnv(path.join(__dirname, '.env'));

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const PORT = Number(process.env.PORT || 3300);
const TOKENS = new Map((process.env.OFFICE_DEVICE_TOKENS || '').split(',').filter(Boolean).map((p) => {
  const i = p.indexOf(':');
  return [p.slice(i + 1), p.slice(0, i)];
}));
const MAX_BODY = 1024 * 1024;
const PUBLIC = path.join(__dirname, 'public');

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

function deviceFor(token) {
  if (!token) return null;
  for (const [t, device] of TOKENS) {
    const a = Buffer.from(t), b = Buffer.from(token);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return device;
  }
  return null;
}

async function ingest(req, res) {
  const device = deviceFor(req.headers['x-office-token']);
  if (!device) return send(res, 401, { error: 'unknown device' });
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) return send(res, 413, { error: 'too large' });
    chunks.push(c);
  }
  let snap;
  try { snap = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'bad json' }); }
  // 기기 이름은 토큰이 정한다. 본문이 다른 기기를 사칭해도 덮지 못한다.
  const row = { device, at: snap.at || new Date().toISOString(), data: { ...snap, device }, updated_at: new Date().toISOString() };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/office_snapshots?on_conflict=device`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    console.error(`[ingest] ${device} supabase ${r.status}`);
    return send(res, 502, { error: 'store failed', status: r.status });
  }
  console.log(`[ingest] ${device} ${row.at}`);
  send(res, 200, { ok: true, device });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/api/ingest') return await ingest(req, res);
    if (req.method !== 'GET') return send(res, 405, { error: 'method' });
    if (url.pathname === '/config.js') {
      return send(res, 200, `window.OFFICE=${JSON.stringify({ url: SUPABASE_URL, anon: SUPABASE_ANON_KEY })};`, 'text/javascript; charset=utf-8');
    }
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[office]', e.message);
    send(res, 500, { error: 'server' });
  }
});

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[office] .env 에 수파베이스 값이 없다');
  process.exit(1);
}
server.listen(PORT, '127.0.0.1', () => console.log(`[office] 127.0.0.1:${PORT} · 기기 ${TOKENS.size}대`));

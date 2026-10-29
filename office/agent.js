// AI 오피스 기기 연결기 — 이 기기를 office.grow-up.kr 허브에 붙인다.
//
//   node office/agent.js            상주(끊기면 다시 붙는다)
//   node office/agent.js --once     상태 한 번 보내고 끝(시험용)
//
// 하는 일
//   · 30초마다: Orca 터미널(세션) 목록·프로젝트(repo) 목록 + 자원 스냅샷(collector.js 와 같은 자료)을 올린다.
//   · 5분마다: office/modules/*.js 프로젝트 대시보드 모듈을 돌려 함께 올린다(프로젝트를 아는 세션이 모듈을 만든다).
//   · 허브가 보낸 명령 중 정해 둔 다섯 가지만 실행한다: read · send · launch · close · refresh.
//     아무 셸 명령이나 받지 않는다(handoff-office §4). Orca CLI 인자 배열로만 부르고 셸을 거치지 않는다.
//   · 닫기는 렌더 락이 있으면 force 없이는 거절한다. 띄우기·닫기는 §10 에 한 줄 남긴다.
// 설정: D:/midform/.env.office (OFFICE_DEVICE, OFFICE_DEVICE_TOKEN, OFFICE_HUB_URL) — 토큰 값은 찍지 않는다.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const env = Object.fromEntries((() => { try { return fs.readFileSync(path.join(ROOT, '.env.office'), 'utf8'); } catch { return ''; } })()
  .split('\n').map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const DEVICE = process.env.OFFICE_DEVICE || env.OFFICE_DEVICE || os.hostname();
const TOKEN = env.OFFICE_DEVICE_TOKEN;
const HUB = process.env.OFFICE_HUB_URL || env.OFFICE_HUB_URL || 'wss://office.grow-up.kr/agent';
const ORCA = process.env.ORCA_BIN || env.ORCA_BIN || (process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData/Local/Programs/orca/resources/bin/orca.exe') : 'orca');
const LOCKS = ['politics-hour/RENDERING.lock', 'politics-hour/RENDERING-ja.lock', 'politics-hour-ja/RENDERING-ja.lock'];
const HANDOFF = path.join(ROOT, 'docs/handoff-manager-20261014.md');
const ONCE = process.argv.includes('--once');

const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

function orca(args, timeout = 30e3) {
  return new Promise((resolve, reject) => {
    execFile(ORCA, [...args, '--json'], { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      let j = null;
      try { j = JSON.parse(stdout); } catch {}
      if (j && j.ok !== false) return resolve(j.result ?? j);
      reject(new Error((j && (j.error?.message || j.error)) || (stderr || String(err?.message || 'orca 실패')).slice(0, 300)));
    });
  });
}

const activeLocks = () => LOCKS.filter((rel) => fs.existsSync(path.join(ROOT, rel)));

// 프로젝트 대시보드 모듈: office/modules/*.js — { project: <Orca 저장소 이름>, run(): 대시보드 JSON }.
// 5분마다 돌려 결과를 상태에 싣는다. 모듈 하나가 실패해도 나머지는 올린다.
const MODULE_DIR = path.join(__dirname, 'modules');
let dashboards = {};
async function runModules() {
  let files = [];
  try { files = fs.readdirSync(MODULE_DIR).filter((f) => f.endsWith('.js')); } catch { return; }
  const next = {};
  for (const f of files) {
    const p = path.join(MODULE_DIR, f);
    try {
      delete require.cache[require.resolve(p)]; // 모듈을 고치면 연결기를 다시 띄우지 않아도 반영
      const m = require(p);
      next[m.project] = await Promise.race([m.run(), new Promise((_, rej) => setTimeout(() => rej(new Error('시간 초과')), 120e3))]);
    } catch (e) {
      log('모듈 실패', f, e.message);
      const m = (() => { try { return require(p); } catch { return null; } })();
      if (m && m.project) next[m.project] = { title: m.title || m.project, error: e.message, tabs: [] };
    }
  }
  dashboards = next;
}

function appendHandoff(line) {
  if (!fs.existsSync(HANDOFF)) return;
  const t = new Date(Date.now() + 9 * 3600e3).toISOString();
  fs.appendFileSync(HANDOFF, `- AI 오피스(${t.slice(5, 10)} ${t.slice(11, 16)}, ${DEVICE}): ${line}\n`, 'utf8');
}

async function state() {
  const [terms, repos] = await Promise.all([
    orca(['terminal', 'list']).catch((e) => ({ error: e.message })),
    orca(['repo', 'list']).catch((e) => ({ error: e.message })),
  ]);
  let snapshot = null;
  try {
    const out = await new Promise((res, rej) => execFile(process.execPath, [path.join(__dirname, 'collector.js'), '--print'],
      { timeout: 30e3, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (e, so) => e ? rej(e) : res(so)));
    snapshot = JSON.parse(out);
  } catch {}
  const sessions = (terms.terminals || []).filter((t) => !t.orphaned).map((t) => ({
    handle: t.handle, title: (t.title || '').replace(/^[✳*·\s]+/, '') || null, agent: t.agentIdentity || null,
    folder: t.worktreePath, repo_id: String(t.worktreeId || '').split('::')[0] || null,
    last_output_at: t.lastOutputAt || null, connected: t.connected, writable: t.writable,
    preview: String(t.preview || '').slice(-600),
  }));
  const repoList = (repos.repos || repos || []);
  return {
    device: DEVICE, platform: process.platform, at: new Date().toISOString(),
    orca_ok: !terms.error, orca_error: terms.error || null,
    repos: Array.isArray(repoList) ? repoList.map((r) => ({ id: r.id, name: r.displayName || r.name, path: r.path })) : [],
    sessions, render_locks: activeLocks(), snapshot, dashboards,
  };
}

// 허브 명령 → Orca CLI. 여기 없는 op 는 전부 거절.
const OPS = {
  async refresh() { return { ok: true }; },
  async read({ handle, cursor }) {
    const args = ['terminal', 'read', '--terminal', handle, '--limit', '400'];
    if (cursor != null) args.push('--cursor', String(cursor)); else args.push('--screen');
    return orca(args);
  },
  async send({ handle, text }) {
    if (!text || text.length > 8000) throw new Error('보낼 글이 비었거나 너무 길다');
    return orca(['terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--wait-submit', '5'], 40e3);
  },
  async launch({ folder, agent = 'claude', prompt, title }) {
    if (!['claude', 'codex'].includes(agent)) throw new Error('claude·codex 만 띄운다');
    if (!folder) throw new Error('작업 폴더가 없다');
    const args = ['agent', 'launch', '--agent', agent, '--worktree', `path:${folder}`, '--surface', 'terminal'];
    if (prompt) args.push('--prompt', prompt);
    const r = await orca(args, 90e3);
    appendHandoff(`세션 띄움 — ${agent} · ${title || path.basename(folder)}`);
    return r;
  },
  async close({ handle, title, force }) {
    const locks = activeLocks();
    if (locks.length && !force) throw new Error(`렌더 중(${locks.join(', ')}) — 확인 후 다시`);
    const r = await orca(['terminal', 'close', '--terminal', handle, '--tab'], 60e3);
    appendHandoff(`세션 닫음 — ${title || handle}${force ? ' (렌더 중 강행 확인)' : ''}`);
    return r;
  },
};

let ws = null;
let timer = null;
const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };

async function pushState() {
  try { send({ type: 'state', state: await state() }); } catch (e) { log('state 실패', e.message); }
}

function connect() {
  if (!TOKEN) { log('.env.office 에 OFFICE_DEVICE_TOKEN 이 없다'); process.exit(1); }
  // 토큰은 주소(로그에 남는다)가 아니라 첫 메시지로 보낸다.
  ws = new WebSocket(HUB);
  ws.onopen = async () => {
    ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
    log('허브 연결', new URL(HUB).host, DEVICE);
    if (!Object.keys(dashboards).length) await runModules();
    await pushState();
    if (ONCE) { setTimeout(() => process.exit(0), 1500); return; }
    clearInterval(timer);
    timer = setInterval(pushState, 30e3);
  };
  ws.onmessage = async (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type !== 'cmd') return;
    const fn = OPS[m.op];
    try {
      if (!fn) throw new Error(`모르는 명령 ${m.op}`);
      const result = await fn(m.args || {});
      send({ type: 'result', id: m.id, ok: true, result });
      log('명령', m.op, '성공');
      if (['send', 'launch', 'close'].includes(m.op)) setTimeout(pushState, 3000);
    } catch (e) {
      send({ type: 'result', id: m.id, ok: false, error: e.message });
      log('명령', m.op, '실패', e.message);
    }
  };
  ws.onclose = () => {
    clearInterval(timer);
    if (ONCE) process.exit(1);
    log('연결 끊김 — 15초 뒤 다시');
    setTimeout(connect, 15e3);
  };
  ws.onerror = () => {};
}

if (!ONCE) setInterval(() => runModules().catch((e) => log('모듈 실패', e.message)), 5 * 60e3);
connect();

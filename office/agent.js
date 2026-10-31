// AI 오피스 기기 연결기 — 이 기기를 office.grow-up.kr 허브에 붙인다.
//
//   node office/agent.js            상주(끊기면 다시 붙는다)
//   node office/agent.js --once     상태 한 번 보내고 끝(시험용)
//
// 하는 일
//   · 30초마다: Orca 터미널(세션) 목록·프로젝트(repo) 목록 + 자원 스냅샷(collector.js 와 같은 자료)을 올린다.
//   · 5분마다: office/modules/*.js 프로젝트 대시보드 모듈을 돌려 함께 올린다(프로젝트를 아는 세션이 모듈을 만든다).
//   · 허브가 보낸 명령 중 정해 둔 것만 실행한다: read · chat · send · pick · launch · launch_cu · close · compact(인계 남기고 비우기) · refresh · orca_open(인자 없음, `orca open` 하나).
//   · 30초마다 허브와 왕복 확인(ping/pong). 90초 넘게 답이 없으면 그 연결을 버리고 다시 붙는다. 부팅 시각·Orca 상태도 함께 올린다.
//   · OFFICE_ORCA_AUTOSTART=1 인 기기: 이번 부팅에 Orca 를 한 번도 못 봤으면 한 번만 켠다. 이번 부팅에 돌다가 꺼진 것은 소유주가 끈 것으로 보고 안 켠다(경고·버튼만).
//     아무 셸 명령이나 받지 않는다(handoff-office §4). Orca CLI 인자 배열로만 부르고 셸을 거치지 않는다.
//   · Claude Code 상태 파일로 Orca 밖 세션·허가 대기·«묻고 멈춤»도 올린다(claudeSessions).
//   · launch_cu: «GPT 손»(화면 조작 Codex) 세션을 띄우고 5초마다 멈춤 화면을 감시한다(office/cu.js).
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
const BOOT_AT = new Date(Date.now() - os.uptime() * 1000).toISOString();
const AUTOSTART = String(process.env.OFFICE_ORCA_AUTOSTART || env.OFFICE_ORCA_AUTOSTART || '') === '1';
const BOOT_FILE = path.join(__dirname, 'data/orca-boot.json');

const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

function orca(args, timeout = 30e3, windowsHide = true) {
  return new Promise((resolve, reject) => {
    execFile(ORCA, [...args, '--json'], { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide }, (err, stdout, stderr) => {
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

// 구독 한도(클로드 5시간·주간, GPT 주간 등). Orca 가 상태줄 훅으로 받아 둔 값을 `account list` 로 읽는다.
// 계정 이메일 등은 버리고 퍼센트·리셋 시각만 싣는다. 자주 바뀌지 않으니 2분마다만.
let limits = null, limitsAt = 0;
async function readLimits() {
  if (Date.now() - limitsAt < 120e3) return limits;
  limitsAt = Date.now();
  try {
    const r = await orca(['account', 'list']);
    const pick = (w) => w ? { used: w.usedPercent, resets_at: w.resetsAt || null } : null;
    const out = {};
    for (const [k, v] of Object.entries(r.rateLimits || {})) {
      if (!v || v.status !== 'ok') continue;
      out[k] = { session: pick(v.session), weekly: pick(v.weekly), fable_weekly: pick(v.fableWeekly), updated_at: v.updatedAt || null };
    }
    limits = out;
  } catch {}
  return limits;
}

// 세션별 대화 크기(다음 턴이 다시 읽을 토큰). ~/.claude/sessions/*.json 의 이름 → 대화 기록 끝의 usage.
// 기록 파일 끝 400KB 만 읽는다(무거운 스캔 금지).
const cleanName = (t) => String(t || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
// Claude Code 세션 상태 파일(~/.claude/sessions/*.json)과 대화 꼬리(최대 400KB)만 읽는다.
// Orca 밖 세션(데스크톱 앱·원격 제어로 띄운 것)도 여기서 보이고, «허가 대기»·«소유주에게 묻고 멈춤»을 잡는다(10-30 N100 질문 놓침).
const ASK_RE = /[?？]\s*\**\s*$|할까요|될까요|좋을까요|괜찮을까요|골라 주|선택해 주|정해 주|하시겠어요|어느 쪽|어떤 걸로/;
// 키·토큰처럼 보이는 값(이름=값, sk-/ghp_/Bearer, 32자 넘는 무작위 덩어리)은 허브로 보내기 전에 가린다
const redact = (t) => String(t || '')
  .replace(/(?<![?&\w])([A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASS)[A-Z0-9_]*)\s*[=:]\s*\S+/gi, '$1=••••')
  .replace(/\b(Bearer\s+)\S+/gi, '$1••••')
  .replace(/\b(sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{10,}/g, '••••')
  .replace(/(?<![\w/%.=-])[A-Za-z0-9_+/-]{32,}={0,2}(?![\w/%])/g, (m) => /[0-9]/.test(m) && /[A-Za-z]/.test(m) ? '••••' : m);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n') : '';
const ACT = { Bash: '명령', PowerShell: '명령', Read: '읽기', Edit: '고치기', Write: '쓰기', Grep: '찾기', Glob: '파일 찾기', Agent: '도우미', WebSearch: '검색', WebFetch: '웹 읽기', SendMessage: '다른 세션에 전달', AskUserQuestion: '질문', ToolSearch: '도구 준비' };
const actText = (y) => { const i = y.input || {}; const k = ACT[y.name] || y.name.replace(/^mcp__[^_]+__/, '');
  return i.description ? i.description : i.file_path ? `${k} · ${path.basename(String(i.file_path))}` : i.summary ? i.summary : k; };
// 사람(또는 다른 세션) 지시 첫 줄 — 시스템 줄·명령 줄은 건너뛴다
const taskText = (raw, meta) => {
  let t = String(raw || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/^Another Claude session sent a message:\s*/, '').replace(/<\/?(cross-session-message|pasted_content)[^>]*>/g, '').trim();
  if (meta && !/^\[/.test(t)) return null;
  if (!t || /^<|^\[Image|^Caveat:|^This session is being continued/.test(t)) return null;
  t = t.replace(/^\[오피스 · 소유주\]\s*/, '').replace(/^\[[^\]]{1,40}\]\s*/, '').split('\n').find((l) => l.trim()) || '';
  return t.trim() || null;
};
let ccCache = { at: 0, list: [] };
const handleTitles = new Map();
const handleCc = new Map(); // Orca 탭 이름과 세션 이름이 달라 폴더로 짝지은 것: 터미널 → 세션ID
function claudeSessions() {
  if (Date.now() - ccCache.at < 20e3) return ccCache.list;
  const list = [];
  const dir = path.join(os.homedir(), '.claude/sessions');
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return list; }
  for (const f of files) {
    let s; try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!s.sessionId || !s.cwd || (s.pid && !pidAlive(s.pid))) continue;
    const x = { name: cleanName(s.name || ''), session_id: s.sessionId, cwd: s.cwd, status: s.status || null, entrypoint: s.entrypoint || null,
      updated_at: s.statusUpdatedAt || s.updatedAt || null, bridge: /^session_\w+$/.test(s.bridgeSessionId || '') ? s.bridgeSessionId : null, tokens: null, model: null, last_text: '', ask: null, task: null, acts: [] };
    const tr = path.join(os.homedir(), '.claude/projects', s.cwd.replace(/[:\\/.]/g, '-'), `${s.sessionId}.jsonl`);
    try {
      const fd = fs.openSync(tr, 'r'); const size = fs.fstatSync(fd).size; const n = Math.min(size, 400000);
      const buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n); fs.closeSync(fd);
      let lastSeen = false;
      for (const l of buf.toString('utf8').split('\n').reverse()) {
        let j; try { j = JSON.parse(l); } catch { continue; }
        // 관제실 카드: 지금 맡은 일(마지막 사람·세션 지시 첫 줄) + 그 뒤 최근 움직임 4개
        if (!x.task && !j.isSidechain) {
          const c = j.message?.content;
          if (j.type === 'assistant' && Array.isArray(c)) {
            for (const y of [...c].reverse()) {
              if (x.acts.length >= 4) break;
              if (y.type === 'tool_use' && (/[가-힣]/.test(y.input?.description || '') || y.input?.file_path)) x.acts.push({ at: j.timestamp, t: redact(actText(y)).slice(0, 90) });
              else if (y.type === 'text' && y.text.trim()) x.acts.push({ at: j.timestamp, t: redact(y.text.trim().split('\n')[0]).slice(0, 90), say: true });
            }
          } else if (j.type === 'user' && !(Array.isArray(c) && c.every((y) => y.type === 'tool_result'))) {
            const t = taskText(textOf(c), j.isMeta);
            if (t) x.task = { t: redact(t).slice(0, 120), at: j.timestamp };
          }
        }
        const u = j.message && j.message.usage;
        if (u && x.tokens == null) { x.tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); x.model = j.message.model || null; }
        if (!lastSeen && (j.type === 'assistant' || j.type === 'user') && !j.isMeta && !j.isSidechain) {
          lastSeen = true;
          const c = j.message?.content;
          const ask = Array.isArray(c) && c.find((y) => y && y.type === 'tool_use' && y.name === 'AskUserQuestion');
          if (j.type === 'assistant' && ask) {
            const qs = (ask.input?.questions || []).map((q) => ({ q: redact(q.question || ''), head: redact(q.header || ''), multi: !!q.multiSelect, opts: (q.options || []).map((o) => ({ label: redact(o.label || ''), desc: redact(o.description || '').slice(0, 200) })) }));
            x.ask = { kind: 'menu', qs, text: qs.map((q) => q.q + (q.opts.length ? ' — ' + q.opts.map((o) => o.label).join(' / ') : '')).join('\n'), at: j.timestamp };
          }
          else if (j.type === 'assistant') {
            x.last_text = redact(textOf(c).trim());
            const tail = x.last_text.split('\n').filter((t) => t.trim()).slice(-3).join('\n');
            if (x.last_text && !(Array.isArray(c) && c.some((y) => y.type === 'tool_use')) && ASK_RE.test(tail)) x.ask = { kind: 'question', text: x.last_text.slice(-1500), at: j.timestamp };
          }
        }
        if (lastSeen && x.tokens != null && x.task) break;
      }
    } catch {}
    if (s.status === 'requires_action') x.ask = { kind: 'permission', text: x.ask?.text || x.last_text.slice(-600), at: x.updated_at };
    else if (s.status === 'busy') x.ask = null; // 일하는 중이면 묻는 게 아니다
    list.push(x);
  }
  ccCache = { at: Date.now(), list };
  return list;
}
const transcriptOf = (c) => path.join(os.homedir(), '.claude/projects', c.cwd.replace(/[:\\/.]/g, '-'), `${c.session_id}.jsonl`);
const stripTags = (t) => String(t || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
// 턴(사람 말 하나)마다: 사람 말 + 세션의 마지막 글(중간 진행 글은 개수만). 진행 중인 턴은 최신 글.
// 긴 세션은 도구 출력이 커서 꼬리 0.8MB 에 말이 몇 개 안 남는다(10-31 «기존 대화기록이 다 지워졌어») — 사람 말이 turns 개 찰 때까지 더 넓게 읽고, 파일이 그대로면 다시 안 읽는다.
const chatCache = new Map();
function readChat(c, turns = 20) {
  const file = transcriptOf(c);
  let size; try { size = fs.statSync(file).size; } catch { return []; }
  const hit = chatCache.get(file);
  if (hit && hit.size === size && hit.turns === turns) return hit.out;
  let out = [];
  for (const n0 of [800e3, 4e6, 16e6]) {
    const n = Math.min(size, n0);
    try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, size - n); fs.closeSync(fd); out = parseChat(b.toString('utf8'), turns); } catch { return []; }
    if (n === size || out.length >= turns) break;
  }
  chatCache.set(file, { size, turns, out });
  return out;
}
function parseChat(buf, turns) {
  const out = [];
  let cur = null;
  for (const l of buf.split('\n')) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.isSidechain) continue;
    const cont = j.message?.content;
    if (j.type === 'user') {
      if (Array.isArray(cont) && cont.every((x) => x.type === 'tool_result')) continue;
      let t = stripTags(textOf(cont)).replace(/^Another Claude session sent a message:\s*/, '').replace(/<\/?pasted_content[^>]*>/g, '').trim();
      const peer = /^<cross-session-message/.test(t);
      if (j.isMeta && !peer) continue; // 다른 세션 메시지만 숨은 줄로 들어온다
      if (!t || /^<(command-|local-command|task-notification|bash-)/.test(t) || /^Caveat:/.test(t)) continue;
      let who = 'me';
      if (peer) { who = 'peer'; const m = t.match(/from-name="([^"]+)"/); t = (m ? `[${m[1]}] ` : '[다른 세션] ') + t.replace(/<\/?cross-session-message[^>]*>/g, '').replace(/\n*This came from another Claude session[\s\S]*$/, '').trim(); }
      else if (/^This session is being continued/.test(t)) { who = 'sys'; t = '대화를 비우고 이어서 시작'; }
      cur = { who, text: redact(t).slice(0, 3000), at: j.timestamp, replies: [] };
      out.push(cur);
    } else if (j.type === 'assistant' && cur) {
      const t = textOf(cont).trim();
      if (t) cur.replies.push(redact(t));
      if (Array.isArray(cont) && cont.some((x) => x.type === 'tool_use')) cur.tools = (cur.tools || 0) + 1;
    }
  }
  return out.filter((x, i) => !(x.who === 'sys' && i === 0)).slice(-turns).map((x) => ({ who: x.who, text: x.text, at: x.at, reply: (x.replies[x.replies.length - 1] || '').slice(0, 6000), notes: Math.max(0, x.replies.length - 1), tools: x.tools || 0 }));
}
function contextSizes() {
  return new Map(claudeSessions().filter((x) => x.name && x.tokens != null).map((x) => [x.name, { tokens: x.tokens, model: x.model }]));
}

// «인계 남기고 비우기»: 쉴 때까지 기다림 → 인계 파일 쓰게 함 → 파일 확인 → /clear → 인계 파일로 다시 시작.
// 오래 걸리므로 허브에는 바로 «시작함»을 돌려주고 뒤에서 진행, 결과는 §10 과 로그로 남긴다.
const handoffDir = () => fs.existsSync(path.join(ROOT, 'docs')) ? path.join(ROOT, 'docs/session-handoffs') : path.join(ROOT, 'handoffs');
const slug = (t) => cleanName(t).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'session';
const compacting = new Set();
async function compact(handle, title) {
  const file = path.join(handoffDir(), `${slug(title)}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t0 = Date.now();
  const idle = (ms) => orca(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', String(ms)], ms + 30e3);
  const say = (text) => orca(['terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--wait-submit', '10'], 60e3);
  try {
    await idle(15 * 60e3);
    await say(`[오피스] 소유주가 이 세션 대화를 비우기로 했다(토큰 절약). 비우기 전에 인계 파일을 써라: ${file.replace(/\\/g, '/')} (덮어쓰기, UTF-8). 담을 것: 이 세션의 이름·역할·담당 레인, 진행 중인 일과 바로 다음 단계, 대기 중인 결정·약속한 일정, 지켜야 할 규칙과 겪은 함정, 자주 쓰는 파일·명령 경로. 새 세션이 이 파일 하나만 읽고 이어갈 수 있게 쓴다. 다 쓰면 다른 일은 하지 말고 끝낸다.`);
    await new Promise((r) => setTimeout(r, 5000));
    await idle(20 * 60e3);
    const st = fs.existsSync(file) && fs.statSync(file);
    if (!st || st.mtimeMs < t0 || st.size < 200) throw new Error('인계 파일이 안 써졌다 — 비우지 않았다');
    await say('/clear');
    await new Promise((r) => setTimeout(r, 4000));
    await idle(120e3);
    await say(`이 세션 이름은 «${cleanName(title)}» 이다. 이름이 다르면 /rename ${cleanName(title)} 로 바꿔라. 직전 대화는 토큰 절약을 위해 비웠다. 인계 파일 ${file.replace(/\\/g, '/')} 을 읽고 거기 적힌 다음 단계부터 이어서 하라. 공통 규칙: 저장소 AGENTS.md·CLAUDE.md, 소유주 결정·결과물은 D:/midform/docs/office-decisions.md.`);
    appendHandoff(`세션 비움 — ${cleanName(title)} (인계 ${path.basename(file)})`);
    log('비우기 완료', title);
  } catch (e) {
    appendHandoff(`세션 비우기 실패 — ${cleanName(title)}: ${e.message}`);
    log('비우기 실패', title, e.message);
  } finally { compacting.delete(handle); setTimeout(pushState, 3000); }
}

// Orca 켜기: 이미 돌면 그대로 둔다. 숨김 플래그 없이 띄운다(숨김이 첫 창까지 이어지면 화면에 안 보인다).
const orcaStatus = async () => { const r = await orca(['status'], 20e3); return { running: !!r.app?.running, window: r.app?.desktopWindowStatus || null, runtime: r.runtime?.state || null }; };
let orcaOpening = false;
async function openOrca(why) {
  if (orcaOpening) throw new Error('이미 켜는 중');
  orcaOpening = true;
  try {
    const before = await orcaStatus().catch(() => null);
    if (before?.running && before.runtime === 'ready') return { already: true, ...before };
    await orca(['open'], 90e3, false);
    const after = await orcaStatus().catch(() => null);
    appendHandoff(`Orca 켬 (${why}) — 창 ${after?.window || '확인 못 함'}`);
    return { opened: true, ...(after || {}) };
  } finally { orcaOpening = false; setTimeout(pushState, 3000); }
}

// 부팅 뒤 자동 켜기: 부팅마다 한 번, 이번 부팅에 Orca 를 본 적이 없을 때만. 렌더 락이 있으면 풀릴 때까지 미룬다.
const readBoot = () => { try { const b = JSON.parse(fs.readFileSync(BOOT_FILE, 'utf8')); if (Math.abs(Date.parse(b.boot_at) - Date.parse(BOOT_AT)) <= 120e3) return b; } catch {} return { boot_at: BOOT_AT, seen_running: false, auto_opened_at: null }; };
const writeBoot = (b) => { try { fs.mkdirSync(path.dirname(BOOT_FILE), { recursive: true }); fs.writeFileSync(BOOT_FILE, JSON.stringify(b, null, 2) + '\n', 'utf8'); } catch (e) { log('부팅 기록 실패', e.message); } };
function watchOrcaBoot(ok) {
  const b = readBoot();
  if (ok) { if (!b.seen_running) { b.seen_running = true; writeBoot(b); } return; }
  if (!AUTOSTART || ONCE || b.seen_running || b.auto_opened_at || orcaOpening) return;
  if (os.uptime() < 60 || activeLocks().length) return;
  b.auto_opened_at = new Date().toISOString(); writeBoot(b);
  log('부팅 뒤 Orca 자동 켜기');
  openOrca('부팅 뒤 자동').catch((e) => { log('Orca 자동 켜기 실패', e.message); appendHandoff(`Orca 자동 켜기 실패: ${e.message.slice(0, 120)}`); });
}

let lastTerms = null, lastRepos = null, orcaError = null;
async function state() {
  const [terms, repos] = await Promise.all([
    // Orca 가 잠깐 답을 안 하면 직전 목록을 쓴다(빈 목록이면 모든 세션이 «Orca 밖»으로 떨어져 보내기가 막혔다, 10-31)
    orca(['terminal', 'list']).then((r) => (lastTerms = { at: Date.now(), r }, orcaError = null, r)).catch((e) => (orcaError = e.message, lastTerms && Date.now() - lastTerms.at < 10 * 60e3 ? lastTerms.r : ({ error: e.message }))),
    orca(['repo', 'list']).then((r) => (lastRepos = r, r)).catch((e) => lastRepos || ({ error: e.message })),
    readLimits(),
  ]);
  watchOrcaBoot(!orcaError);
  let snapshot = null;
  try {
    const out = await new Promise((res, rej) => execFile(process.execPath, [path.join(__dirname, 'collector.js'), '--print'],
      { timeout: 30e3, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (e, so) => e ? rej(e) : res(so)));
    snapshot = JSON.parse(out);
  } catch {}
  const ctx = contextSizes();
  // orphaned = Orca 창에 탭이 없을 뿐(CLI 로 띄운 세션). 연결돼 있고 이름·에이전트가 있으면 살아 있는 세션이다.
  for (const t of terms.terminals || []) if (t.handle && t.title) handleTitles.set(t.handle, t.title.replace(/^[✳*·\s]+/, ''));
  const sessions = (terms.terminals || []).filter((t) => !t.orphaned || (t.connected && (t.title || t.agentIdentity))).map((t) => {
    const c = t.agentIdentity === 'claude' ? ctx.get(cleanName(t.title)) : null;
    return {
      handle: t.handle, title: (t.title || '').replace(/^[✳*·\s]+/, '') || null, agent: t.agentIdentity || null,
      folder: t.worktreePath, repo_id: String(t.worktreeId || '').split('::')[0] || null,
      last_output_at: t.lastOutputAt || null, connected: t.connected, writable: t.writable,
      preview: String(t.preview || '').slice(-600),
      context_tokens: c ? c.tokens : null, model: c ? c.model : null, compacting: compacting.has(t.handle),
    };
  });
  const repoList = (repos.repos || repos || []);
  const ccs = claudeSessions();
  const byName = new Map(ccs.filter((x) => x.name).map((x) => [x.name, x]));
  const link = (x, c) => { x.cc_status = c.status; x.ask = c.ask; x.bridge = c.bridge; x.task = c.task; x.acts = c.acts; if (x.context_tokens == null) { x.context_tokens = c.tokens; x.model = c.model; } c.matched = true; };
  for (const x of sessions) { const c = byName.get(cleanName(x.title)); if (c) link(x, c); }
  // 탭 이름을 따로 붙인 세션(예: «그로우업 관리자» = growupup-cd): 같은 작업 폴더에 남은 짝이 하나씩뿐이면 같은 세션이다(10-31 N100 «Orca 밖» 오인)
  const nf = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  handleCc.clear();
  for (const x of sessions) {
    if (x.cc_status !== undefined || x.agent !== 'claude' || !x.folder) continue;
    const ts = sessions.filter((y) => y.cc_status === undefined && y.agent === 'claude' && nf(y.folder) === nf(x.folder));
    const cs = ccs.filter((c) => !c.matched && c.entrypoint !== 'sdk-cli' && nf(c.cwd) === nf(x.folder));
    if (ts.length === 1 && cs.length === 1) { link(x, cs[0]); handleCc.set(x.handle, cs[0].session_id); }
  }
  // Orca 밖 세션: 이름 없는 일회성(sdk 등)은 빼고, 저장소는 작업 폴더로 맞춘다. 화면은 대화 꼬리로 보여 준다(보내기는 못 함).
  const rl = Array.isArray(repoList) ? repoList : [];
  for (const c of ccs) {
    if (c.matched || !c.name || c.entrypoint === 'sdk-cli') continue;
    const cw = c.cwd.replace(/\\/g, '/').toLowerCase();
    const repo = rl.find((r) => r.path && cw.startsWith(String(r.path).replace(/\\/g, '/').toLowerCase()))
      || rl.find((r) => cw.includes(`/workspaces/${String(r.displayName || r.name || '').toLowerCase()}/`));
    sessions.push({ handle: `cc:${c.session_id}`, title: c.name, agent: 'claude', folder: c.cwd, repo_id: repo ? repo.id : null,
      last_output_at: c.updated_at, connected: true, writable: false, external: true, preview: c.last_text.slice(-600),
      context_tokens: c.tokens, model: c.model, cc_status: c.status, ask: c.ask, bridge: c.bridge, task: c.task, acts: c.acts, compacting: false });
  }
  return {
    device: DEVICE, platform: process.platform, at: new Date().toISOString(), boot_at: BOOT_AT,
    // 목록은 직전 값을 잠깐 쓰더라도 Orca 상태는 사실대로 올린다(허브가 2분 이어질 때만 경고)
    orca_ok: !orcaError, orca_error: orcaError ? orcaError.slice(0, 200) : null,
    repos: Array.isArray(repoList) ? repoList.map((r) => ({ id: r.id, name: r.displayName || r.name, path: r.path })) : [],
    sessions, render_locks: activeLocks(), snapshot, dashboards, limits, caps: cu.caps(),
  };
}

// 허브 명령 → Orca CLI. 여기 없는 op 는 전부 거절. 기기 주인이 .env.office 의 OFFICE_DISABLE_OPS(쉼표)로 더 끌 수 있다.
const DISABLED_OPS = new Set(String(process.env.OFFICE_DISABLE_OPS || env.OFFICE_DISABLE_OPS || '').split(',').map((x) => x.trim()).filter(Boolean));
// cu.js 가 없으면 «GPT 손»만 꺼진 채로 뜬다(연결기가 멈추지 않게)
const makeCu = (() => { try { return require('./cu').makeCu; } catch { return () => ({ caps: () => ({}), watch: async () => {}, launch: async () => { throw new Error('이 기기에는 GPT 손(cu.js)이 없다'); } }); } })();
let cu = null; // appendHandoff·orca 가 정의된 뒤 만든다

const OPS = {
  async refresh() { return { ok: true }; },
  async read({ handle, cursor }) {
    if (String(handle).startsWith('cc:')) {
      ccCache.at = 0;
      const c = claudeSessions().find((x) => `cc:${x.session_id}` === handle);
      if (!c) throw new Error('세션이 닫혔다');
      return { terminal: { tail: [`(Orca 밖 세션 · ${c.status || ''} — 여기서는 마지막 말만 보이고, 답은 그 기기의 Claude 화면에서)`, '', ...(c.ask?.text || c.last_text || '').split('\n')] } };
    }
    const args = ['terminal', 'read', '--terminal', handle, '--limit', '400'];
    if (cursor != null) args.push('--cursor', String(cursor)); else args.push('--screen');
    return orca(args);
  },
  // 대화로 보기: Orca 세션은 이름으로, Orca 밖 세션은 cc:세션ID 로 찾는다
  async chat({ handle }) {
    const list = claudeSessions();
    const c = String(handle).startsWith('cc:') ? list.find((x) => `cc:${x.session_id}` === handle)
      : list.find((x) => x.session_id === handleCc.get(handle)) || list.find((x) => x.name && x.name === cleanName(handleTitles.get(handle)));
    if (!c) throw new Error('대화 기록을 못 찾았다(Claude 세션이 아니거나 이름이 다름)');
    return { status: c.status, ask: c.ask, turns: readChat(c) };
  },
  async send({ handle, text }) {
    if (String(handle).startsWith('cc:')) throw new Error('Orca 밖 세션이라 여기서 보낼 수 없다 — 그 기기의 Claude 화면에서 답해야 한다');
    if (!text || text.length > 8000) throw new Error('보낼 글이 비었거나 너무 길다');
    // 세션이 일하는 중이면 글은 들어갔는데 제출 확인만 늦는다 — 실패로 돌리면 소유주가 같은 말을 또 보낸다
    try { return await orca(['terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--wait-submit', '5'], 40e3); }
    catch (e) {
      if (/submit|timed? ?out|timeout|ETIMEDOUT|killed/i.test(e.message)) return { queued: true, note: e.message.slice(0, 120) };
      throw e;
    }
  },
  // 터미널 선택 메뉴(AskUserQuestion)에 번호 키를 차례로 누른다. 질문이 여럿이면 끝에 «제출»(1).
  async pick({ handle, keys }) {
    if (String(handle).startsWith('cc:')) throw new Error('Orca 밖 세션이라 여기서 보낼 수 없다 — 그 기기의 Claude 화면에서 답해야 한다');
    const c = claudeSessions().find((x) => x.session_id === handleCc.get(handle)) || claudeSessions().find((x) => x.name && x.name === cleanName(handleTitles.get(handle)));
    const qs = c?.ask?.kind === 'menu' ? c.ask.qs : null;
    if (!qs || !qs.length) throw new Error('지금은 선택 메뉴가 떠 있지 않다 — 대화창에서 확인해 주세요');
    if (qs.some((q) => q.multi)) throw new Error('여러 개 고르는 질문이라 터미널에서 직접 골라야 한다');
    if (!Array.isArray(keys) || keys.length !== qs.length || keys.some((k, i) => !/^[1-9]$/.test(String(k)) || +k > qs[i].opts.length)) throw new Error('고른 번호가 질문과 맞지 않는다');
    const seq = qs.length > 1 ? [...keys.map(String), '1'] : keys.map(String);
    for (const k of seq) {
      await orca(['terminal', 'send', '--terminal', handle, '--text', k], 20e3);
      await new Promise((r) => setTimeout(r, 700));
    }
    ccCache.at = 0;
    return { picked: keys };
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
  // GPT 손: 화면 조작 Codex 세션 띄우기(렌더 중·소유주 사용 중이면 거절, 기기당 하나)
  async launch_cu({ force }) { return cu.launch({ force: !!force }); },
  async orca_open() { return openOrca('오피스 버튼'); },
  async compact({ handle, title }) {
    if (!handle || !title) throw new Error('세션이 없다');
    if (compacting.has(handle)) throw new Error('이미 비우는 중');
    compacting.add(handle);
    compact(handle, title); // 뒤에서 진행(수 분)
    return { started: true };
  },
  async close({ handle, title, force }) {
    const locks = activeLocks();
    if (locks.length && !force) throw new Error(`렌더 중(${locks.join(', ')}) — 확인 후 다시`);
    const r = await orca(['terminal', 'close', '--terminal', handle, '--tab'], 60e3);
    appendHandoff(`세션 닫음 — ${title || handle}${force ? ' (렌더 중 강행 확인)' : ''}`);
    return r;
  },
};

cu = makeCu({ orca, activeLocks, appendHandoff, log, device: DEVICE });
if (!ONCE) setInterval(() => cu.watch().catch(() => {}), 5e3);

let ws = null;
let timer = null;
let lastPong = 0, hubAnswersPing = false;
const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };

async function pushState() {
  try { send({ type: 'state', state: await state() }); } catch (e) { log('state 실패', e.message); }
}

// 허브가 재시작되는 순간에 붙으면 소켓이 «연결 중»에서 열리지도 닫히지도 않은 채 멈춘다(VPS 10-29 16:53 이후 실측).
// onclose 만 믿지 말고, 30초 넘게 열려 있지 않으면 버리고 다시 붙는다.
let triedAt = 0;
if (!ONCE) setInterval(() => {
  if (ws && ws.readyState === 1) return;
  if (Date.now() - triedAt < 30e3) return;
  log('허브 연결 안 됨 — 다시 붙는다');
  const old = ws; ws = null;
  if (old) { old.onclose = null; try { old.close(); } catch {} }
  connect();
}, 10e3);

// 왕복 확인: 열려 보여도 죽은 연결이면 버리고 다시 붙는다. 허브가 pong 을 한 번이라도 준 뒤에만 잰다(옛 허브와 맞물려 끊기지 않게).
if (!ONCE) setInterval(() => {
  if (!ws || ws.readyState !== 1) return;
  if (hubAnswersPing && Date.now() - lastPong > 90e3) {
    log('왕복 확인 실패 — 버리고 다시 붙는다');
    const old = ws; ws = null; old.onclose = null; clearInterval(timer);
    try { old.close(); } catch {}
    connect();
    return;
  }
  send({ type: 'ping', t: Date.now() });
}, 30e3);

function connect() {
  if (!TOKEN) { log('.env.office 에 OFFICE_DEVICE_TOKEN 이 없다'); process.exit(1); }
  triedAt = Date.now();
  // 토큰은 주소(로그에 남는다)가 아니라 첫 메시지로 보낸다.
  try { ws = new WebSocket(HUB); } catch (e) { log('연결 실패', e.message); ws = null; return; }
  const me = ws;
  ws.onopen = async () => {
    ws.send(JSON.stringify({ type: 'hello', token: TOKEN }));
    log('허브 연결', new URL(HUB).host, DEVICE);
    lastPong = Date.now();
    if (ONCE) { if (!Object.keys(dashboards).length) await runModules(); await pushState(); setTimeout(() => process.exit(0), 1500); return; }
    clearInterval(timer);
    timer = setInterval(pushState, 30e3);
    // 모듈은 몇 분 걸릴 수 있다 — 상태부터 올리고 뒤에서 채운다
    await pushState();
    if (!Object.keys(dashboards).length) { await runModules(); await pushState(); }
  };
  ws.onmessage = async (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'pong') { lastPong = Date.now(); hubAnswersPing = true; return; }
    if (m.type !== 'cmd') return;
    const fn = DISABLED_OPS.has(m.op) ? null : OPS[m.op];
    try {
      if (!fn) throw new Error(DISABLED_OPS.has(m.op) ? `이 기기에서 끈 명령 ${m.op}` : `모르는 명령 ${m.op}`);
      const result = await fn(m.args || {});
      send({ type: 'result', id: m.id, ok: true, result });
      log('명령', m.op, '성공');
      if (['send', 'launch', 'launch_cu', 'close'].includes(m.op)) setTimeout(pushState, 3000);
    } catch (e) {
      send({ type: 'result', id: m.id, ok: false, error: e.message });
      log('명령', m.op, '실패', e.message);
    }
  };
  ws.onclose = () => {
    if (ws !== me) return; // 감시가 이미 버리고 새로 붙인 소켓
    clearInterval(timer);
    if (ONCE) process.exit(1);
    log('연결 끊김 — 15~25초 뒤 다시');
    ws = null; triedAt = Date.now() - 15e3; // 다시 붙는 건 위 감시가 한다(한 군데서만)
  };
  ws.onerror = () => {};
}

if (!ONCE) setInterval(() => runModules().catch((e) => log('모듈 실패', e.message)), 5 * 60e3);
connect();

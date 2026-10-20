// 디스크 한 줄 요약(10-20 관리자: C: 97% 로 하이퍼프레임이 «Low disk space» 에 멈춤) — 07:40 보고용, API 0.
//
//   node scripts/disk_summary.js [--json] [--fresh]
//   const { diskSummary } = require('./disk_summary'); diskSummary() → { line, drives, sessions, hf }
//
// C:·D: 빈 공간 · %TEMP%/claude 아래 세션 폴더(scratchpad) 크기 상위 5(세션 이름은 ~/.claude/projects/<프로젝트>/<uuid>.jsonl 의
// customTitle — 파일 끝·앞 2MB 만 읽는다) · %TEMP%/hf-render-* 잔재 수와 크기.
// D: 폴더(10-20 관리자, D: 하루 ~50GB 감소): D:/volcano-runs(편 폴더는 «ls*·rinbox*» 처럼 숫자 뗀 레인 묶음)·D:/midform 1단계 상위 5,
//   훑기 ~1분이라 server/data/disk_cache.json 에 1시간 캐시. 하루 1줄 server/data/disk_daily.jsonl(날짜별 첫 실행)에 남기고
//   직전 날짜 줄과 차이(빈 공간·폴더별 증감 상위 3)를 붙인다.
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEMP = os.tmpdir();
const CLAUDE_TMP = path.join(TEMP, 'claude');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const DRIVES = ['C:/', 'D:/'];
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'server', 'data');
const CACHE = path.join(DATA, 'disk_cache.json');
const DAILY = path.join(DATA, 'disk_daily.jsonl');
const TREES = [{ root: 'D:/volcano-runs', group: true }, { root: 'D:/midform', group: false }];
const CACHE_MS = 3600 * 1000;

function dirSize(d) {
  let n = 0;
  let st;
  try { st = fs.lstatSync(d); } catch { return 0; }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let ents = [];
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return 0; }
  for (const e of ents) n += e.isDirectory() ? dirSize(path.join(d, e.name)) : (() => { try { return fs.lstatSync(path.join(d, e.name)).size; } catch { return 0; } })();
  return n;
}

function free(drive) {
  try { const s = fs.statfsSync(drive); return { drive: drive[0], free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { return { drive: drive[0], free: null, total: null }; }
}

function chunk(f, start, len) {
  const fd = fs.openSync(f, 'r');
  try { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, start); return b.subarray(0, n).toString('utf8'); } finally { fs.closeSync(fd); }
}

function sessionTitle(project, uuid) {
  const f = path.join(PROJECTS, project, `${uuid}.jsonl`);
  let size;
  try { size = fs.statSync(f).size; } catch { return null; }
  const W = 2 * 1024 * 1024;
  for (const [a, l] of [[Math.max(0, size - W), Math.min(W, size)], [0, Math.min(W, size)]]) {
    const m = [...chunk(f, a, l).matchAll(/"customTitle":"([^"]+)"/g)].pop();
    if (m) return m[1];
  }
  return null;
}

// rinbox102ja·ls34·lx01 → rinbox*·ls*·lx* (편 폴더를 레인으로 묶는다), 숫자 없는 이름은 그대로
const laneOf = (name) => (/^([A-Za-z_-]*?[A-Za-z])[-_]?\d+[A-Za-z]*$/.test(name) ? name.replace(/^([A-Za-z_-]*?[A-Za-z])[-_]?\d+[A-Za-z]*$/, '$1*') : name);

function scanTrees() {
  const out = {};
  for (const { root, group } of TREES) {
    const m = {};
    let ents = [];
    try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const k = group ? laneOf(e.name) : e.name;
      m[k] = (m[k] || 0) + dirSize(path.join(root, e.name));
    }
    out[root] = m;
  }
  return out;
}

function trees({ fresh = false, now = Date.now() } = {}) {
  if (!fresh) {
    try { const c = JSON.parse(fs.readFileSync(CACHE, 'utf8')); if (now - c.at < CACHE_MS) return c; } catch {}
  }
  const c = { at: now, trees: scanTrees() };
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(c, null, 2) + '\n', 'utf8'); } catch {}
  return c;
}

function kstDate(ms) { return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10); }

function daily(drives, t, { now = Date.now(), file = DAILY } = {}) {
  /* 오늘 줄이 없으면 쓰고, 오늘보다 앞선 마지막 줄을 돌려준다(차이 계산용). */
  const today = kstDate(now);
  let rows = [];
  try { rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  if (!rows.some((r) => r.date === today)) {
    const rec = { date: today, at: new Date(now).toISOString(), free: Object.fromEntries(drives.map((d) => [d.drive, d.free])), trees: t };
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8'); } catch {}
  }
  return rows.filter((r) => r.date < today).pop() || null;
}

function sgb(n) { return `${n >= 0 ? '+' : '−'}${(Math.abs(n) / 1024 ** 3).toFixed(1)}GB`; }

const gb = (n) => (n == null ? '?' : `${(n / 1024 ** 3).toFixed(1)}GB`);
const mb = (n) => `${Math.round(n / 1024 ** 2)}MB`;

function diskSummary({ top = 5, fresh = false, now = Date.now(), dailyFile = DAILY } = {}) {
  const drives = DRIVES.map(free);
  const tc = trees({ fresh, now });
  const prev = daily(drives, tc.trees, { now, file: dailyFile });
  const sessions = [];
  let projects = [];
  try { projects = fs.readdirSync(CLAUDE_TMP, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch {}
  for (const p of projects) {
    let ids = [];
    try { ids = fs.readdirSync(path.join(CLAUDE_TMP, p), { withFileTypes: true }).filter((e) => e.isDirectory() && /^[0-9a-f-]{36}$/.test(e.name)).map((e) => e.name); } catch {}
    for (const id of ids) sessions.push({ project: p, uuid: id, bytes: dirSize(path.join(CLAUDE_TMP, p, id)) });
  }
  sessions.sort((a, b) => b.bytes - a.bytes);
  const tops = sessions.slice(0, top).map((s) => ({ ...s, title: sessionTitle(s.project, s.uuid) }));
  let hfDirs = [];
  try { hfDirs = fs.readdirSync(TEMP).filter((n) => n.startsWith('hf-render-')); } catch {}
  const hf = { count: hfDirs.length, bytes: hfDirs.reduce((n, d) => n + dirSize(path.join(TEMP, d)), 0) };
  const line = `디스크 — ${drives.map((d) => `${d.drive}: 빈 ${gb(d.free)}${d.total ? `(${Math.round(100 * (1 - d.free / d.total))}%)` : ''}`).join(' · ')}`
    + ` · Temp/claude 상위 ${tops.map((s) => `${s.title || s.uuid.slice(0, 8)} ${mb(s.bytes)}`).join(', ') || '없음'}`
    + ` · hf-render 잔재 ${hf.count}개${hf.count ? ` ${mb(hf.bytes)}` : ''}`;
  const treeTop = Object.fromEntries(Object.entries(tc.trees).map(([r, m]) => [r, Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, top)]));
  let line2 = 'D: 폴더 — ' + Object.entries(treeTop).map(([r, l]) => `${r.replace('D:/', '')} ${l.map(([n, b]) => `${n} ${gb(b)}`).join(', ')}`).join(' · ')
    + ` (훑은 시각 ${new Date(tc.at + 9 * 3600 * 1000).toISOString().slice(11, 16)})`;
  let delta = null;
  if (prev) {
    const dFree = (drives.find((d) => d.drive === 'D') || {}).free;
    const ch = [];
    for (const [r, m] of Object.entries(tc.trees)) {
      const old = (prev.trees || {})[r] || {};
      for (const k of new Set([...Object.keys(m), ...Object.keys(old)])) ch.push([`${r.replace('D:/', '')}/${k}`, (m[k] || 0) - (old[k] || 0)]);
    }
    ch.sort((a, b) => b[1] - a[1]);
    delta = { since: prev.date, d_free: dFree != null && prev.free?.D != null ? dFree - prev.free.D : null, grew: ch.slice(0, 3) };
    line2 += ` · ${prev.date} 대비 D: 빈 공간 ${delta.d_free == null ? '?' : sgb(delta.d_free)}, 늘어난 곳 ${delta.grew.filter(([, b]) => b > 0).map(([n, b]) => `${n} ${sgb(b)}`).join(', ') || '없음'}`;
  } else line2 += ' · 어제 기록 없음(오늘부터 disk_daily.jsonl 에 쌓음)';
  return { line: `${line}\n${line2}`, line1: line, line2, drives, sessions: tops, hf, trees: treeTop, delta };
}

module.exports = { diskSummary, sessionTitle, dirSize, laneOf, daily };

if (require.main === module) {
  const r = diskSummary({ fresh: process.argv.includes('--fresh') });
  console.log(process.argv.includes('--json') ? JSON.stringify(r, null, 2) : r.line);
}

// 디스크 한 줄 요약(10-20 관리자: C: 97% 로 하이퍼프레임이 «Low disk space» 에 멈춤) — 07:40 보고용, API 0.
//
//   node scripts/disk_summary.js [--json]
//   const { diskSummary } = require('./disk_summary'); diskSummary() → { line, drives, sessions, hf }
//
// C:·D: 빈 공간 · %TEMP%/claude 아래 세션 폴더(scratchpad) 크기 상위 5(세션 이름은 ~/.claude/projects/<프로젝트>/<uuid>.jsonl 의
// customTitle — 파일 끝·앞 2MB 만 읽는다) · %TEMP%/hf-render-* 잔재 수와 크기.
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEMP = os.tmpdir();
const CLAUDE_TMP = path.join(TEMP, 'claude');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const DRIVES = ['C:/', 'D:/'];

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

const gb = (n) => (n == null ? '?' : `${(n / 1024 ** 3).toFixed(1)}GB`);
const mb = (n) => `${Math.round(n / 1024 ** 2)}MB`;

function diskSummary({ top = 5 } = {}) {
  const drives = DRIVES.map(free);
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
  return { line, drives, sessions: tops, hf };
}

module.exports = { diskSummary, sessionTitle, dirSize };

if (require.main === module) {
  const r = diskSummary();
  console.log(process.argv.includes('--json') ? JSON.stringify(r, null, 2) : r.line);
}

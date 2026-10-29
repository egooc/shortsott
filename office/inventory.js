// AI 오피스 세션 목록 — 이 기기의 클로드·코덱스 세션을 «살아 있음·마지막 활동» 기준으로 센다. 읽기 전용.
//
//   node office/inventory.js           표로 출력
//   node office/inventory.js --json    JSON
//
// 클로드: ~/.claude/sessions/*.json (pid 로 생존 확인) + ~/.claude/projects/<폴더>/<sessionId>.jsonl 의 수정 시각
// 코덱스: ~/.codex/session_index.jsonl (스레드 이름) + ~/.codex/sessions/YYYY/MM/DD/*.jsonl 수정 시각 (최근 14일만 훑는다)

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const now = Date.now();
const projDir = (cwd) => path.join(HOME, '.claude/projects', cwd.replace(/[:\\/.]/g, '-'));
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function claude() {
  const dir = path.join(HOME, '.claude/sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => {
    let s; try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
    const last = s.cwd && s.sessionId ? mtime(path.join(projDir(s.cwd), `${s.sessionId}.jsonl`)) : null;
    return {
      tool: 'claude', name: s.name || s.sessionId, kind: s.kind || null,
      folder: s.cwd || null, started_at: s.startedAt || null, last_active: last,
      alive: alive(s.pid), id: s.sessionId,
    };
  }).filter(Boolean);
}

function codex() {
  const names = new Map();
  try {
    for (const l of fs.readFileSync(path.join(HOME, '.codex/session_index.jsonl'), 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { const e = JSON.parse(l); names.set(e.id, e.thread_name); } catch {}
    }
  } catch {}
  const out = [];
  for (let d = 0; d < 14; d++) {
    const day = new Date(now - d * 864e5);
    const dir = path.join(HOME, '.codex/sessions', String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    let fs_; try { fs_ = fs.readdirSync(dir); } catch { continue; }
    for (const f of fs_) {
      const id = (f.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/) || [])[1];
      out.push({ tool: 'codex', name: names.get(id) || null, id, last_active: mtime(path.join(dir, f)) });
    }
  }
  return out;
}

const result = { device: process.env.OFFICE_DEVICE || os.hostname(), at: new Date(now).toISOString(), claude: claude(), codex: codex() };

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  const ago = (ms) => ms ? `${Math.round((now - ms) / 36e5)}시간 전` : '기록 없음';
  console.log(`[클로드] ${result.claude.length}개`);
  for (const s of result.claude.sort((a, b) => (b.last_active || 0) - (a.last_active || 0))) {
    console.log(`  ${s.alive ? '살아있음' : '꺼짐    '} | ${ago(s.last_active).padEnd(9)} | ${s.name}`);
  }
  const cx = result.codex;
  const named = cx.filter((c) => c.name);
  console.log(`[코덱스] 최근 14일 ${cx.length}개 (이름 있는 대화 ${named.length}개, 나머지는 gpt-ask 같은 자동 호출)`);
}

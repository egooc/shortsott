// AI 오피스 수집기 — 이 기기의 상태를 한 장(snapshot)으로 묶는다. 읽기 전용.
//
//   node office/collector.js            office/data/snapshot-<기기>.json 에 쓴다
//   node office/collector.js --print    쓰지 않고 화면에만
//
// 읽는 것 (이미 다른 도구가 만들어 두는 파일만 — 직접 무겁게 재지 않는다)
//   · 자원: server/output/metrics/resources-YYYYMMDD.jsonl 마지막 줄 (resource-sample.ps1 이 5분마다 씀)
//   · 렌더 락: politics-hour(-ja)/RENDERING*.lock 존재 여부
//   · 세션: ~/.claude/sessions/*.json (이름·종류·작업 폴더·살아 있는지)
//   · 재고·다음 공개: server/data/production_ledger.jsonl 의 publish_at
//   · 오늘 바뀐 것: docs/handoff-manager-20261014.md §10 의 새 줄
// 지킬 것 (handoff-office §6): 키·토큰 값은 읽지도 싣지도 않는다. du·전체 grep 금지. 다른 세션 파일을 고치지 않는다.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEVICE = process.env.OFFICE_DEVICE || 'main-pc';
const OUT_DIR = path.join(__dirname, 'data');
const PRINT = process.argv.includes('--print');
const now = Date.now();
const kst = (ms) => new Date(ms + 9 * 3600e3).toISOString().replace('Z', '+09:00');
const today = kst(now).slice(0, 10);

const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const lastLine = (p) => { const t = readText(p); if (!t) return null; const ls = t.trimEnd().split('\n'); return ls[ls.length - 1]; };
const safe = (fn, fallback = null) => { try { return fn(); } catch (e) { return { error: String(e.message || e) }; } };

const LOCKS = [
  'politics-hour/RENDERING.lock',
  'politics-hour/RENDERING-ja.lock',
  'politics-hour-ja/RENDERING-ja.lock',
];

function locks() {
  return LOCKS.filter((rel) => fs.existsSync(path.join(ROOT, rel)))
    .map((rel) => ({ path: rel, since: kst(fs.statSync(path.join(ROOT, rel)).mtimeMs) }));
}

function resources() {
  const f = path.join(ROOT, 'server/output/metrics', `resources-${today.replace(/-/g, '')}.jsonl`);
  const line = lastLine(f);
  if (!line) return { error: '오늘 자원 기록 없음' };
  const r = JSON.parse(line);
  const stale_min = Math.round((now - Date.parse(r.at)) / 60e3);
  return {
    at: r.at, stale_min,
    cpu_pct: r.cpu_pct,
    ram_used_gb: +(r.ram_used_mb / 1024).toFixed(1), ram_total_gb: +(r.ram_total_mb / 1024).toFixed(1),
    gpu_pct: r.gpu_pct, gpu_temp_c: r.gpu_temp_c,
    disk_d_free_gb: r.disk_d_free_gb,
    procs: { claude: r.markers?.claude, codex: r.markers?.codex, python: r.markers?.python, ffmpeg: r.markers?.ffmpeg },
  };
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function sessions() {
  const dir = path.join(os.homedir(), '.claude/sessions');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    const s = JSON.parse(readText(path.join(dir, f)));
    return {
      name: s.name || null, kind: s.kind || null,
      folder: s.cwd ? path.basename(s.cwd) : null,
      started_at: s.startedAt ? kst(s.startedAt) : null,
      alive: alive(s.pid),
    };
  }).filter((s) => s.alive).sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko'));
}

// 장부는 같은 id 가 여러 줄(제작 끝 → 예약 붙음)이라 마지막 줄을 그 편의 상태로 본다.
function lanes() {
  const t = readText(path.join(ROOT, 'server/data/production_ledger.jsonl')) || '';
  const byId = new Map();
  for (const line of t.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const key = `${e.lane}|${e.id}`;
    byId.set(key, { ...(byId.get(key) || {}), ...e });
  }
  const out = {};
  const dayAgo = now - 864e5;
  for (const e of byId.values()) {
    const lane = e.lane || '?';
    const L = out[lane] ||= { session: e.session, stock: 0, next_publish: null, made_24h: 0, rejected_24h: 0 };
    const pub = e.publish_at ? Date.parse(e.publish_at) : null;
    if (pub && pub > now) {
      L.stock += 1;
      if (!L.next_publish || pub < Date.parse(L.next_publish.at)) L.next_publish = { at: kst(pub), title: e.title || e.id };
    }
    if (e.finished_at && Date.parse(e.finished_at) > dayAgo) L.made_24h += 1;
    if (e.rejected && Date.parse(e.at) > dayAgo) L.rejected_24h += e.rejected;
  }
  return out;
}

// §10 은 «- 세션(10-29 16:13): …» 줄의 나열. 오늘 날짜(MM-DD)가 앞부분에 붙은 줄만 «오늘 바뀐 것»으로.
function changes() {
  const t = readText(path.join(ROOT, 'docs/handoff-manager-20261014.md')) || '';
  const i = t.indexOf('\n## 10.');
  if (i < 0) return [];
  const md = today.slice(5);
  return t.slice(i).split('\n')
    .filter((l) => l.startsWith('- ') && l.slice(0, 40).includes(md))
    .map((l) => {
      const m = l.match(/^- ([^(:：\d][^(:：]{0,20}?)\s*[(:：]/);
      return { who: m ? m[1].trim() : null, text: l.slice(2, 400) };
    });
}

const snapshot = {
  device: DEVICE,
  at: kst(now),
  resources: safe(resources),
  render_locks: safe(locks, []),
  sessions: safe(sessions, []),
  lanes: safe(lanes, {}),
  changes_today: safe(changes, []),
};

// --push: D:/midform/.env.office 의 OFFICE_INGEST_URL·OFFICE_DEVICE_TOKEN 으로 오피스 서버에 올린다(토큰 값은 찍지 않는다).
async function push(json) {
  const env = Object.fromEntries((readText(path.join(ROOT, '.env.office')) || '').split('\n')
    .map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
  const url = process.env.OFFICE_INGEST_URL || env.OFFICE_INGEST_URL;
  const token = env.OFFICE_DEVICE_TOKEN;
  if (!url || !token) throw new Error('.env.office 에 OFFICE_INGEST_URL·OFFICE_DEVICE_TOKEN 이 없다');
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-office-token': token }, body: json });
  if (!r.ok) throw new Error(`올리기 실패 HTTP ${r.status}`);
  console.log(`올림 → ${new URL(url).host}`);
}

const json = JSON.stringify(snapshot, null, 2);
if (PRINT) {
  process.stdout.write(json + '\n');
} else {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `snapshot-${DEVICE}.json`), json + '\n', 'utf8');
  console.log(`snapshot-${DEVICE}.json  세션 ${snapshot.sessions.length} · 레인 ${Object.keys(snapshot.lanes).length} · 오늘 변경 ${snapshot.changes_today.length}`);
  if (process.argv.includes('--push')) push(json).catch((e) => { console.error(e.message); process.exitCode = 1; });
}

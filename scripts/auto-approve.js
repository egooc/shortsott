// 승인을 자동으로 찍는다. 사람 대신 **기계가 볼 수 있는 것만** 검사하고 통과시킨다.
//
//   node scripts/auto-approve.js            무엇을 승인할지 보여주기만(dry-run)
//   node scripts/auto-approve.js --approve  실제 승인
//   node scripts/auto-approve.js --approve --max 6   한 번에 승인할 최대 편수(기본 6)
//
// 왜 (2026-09-20 소유주 지시)
//   "명화관 스타일은 내가 매번 승인해야 된다고? 스케쥴대로 자동으로 올리라니까."
//   그동안 승인은 사람이 mp4 를 보고 하는 절차였다(2026-09-07 지시). 그 게이트 때문에 09-18 이후
//   승인이 멈추자 **발행도 생산도 같이 멈췄다** — 재고가 14편에서 안 빠지니 시간당 생산이 매시간 건너뛰었다.
//   소유주가 자동화를 지시했으므로 사람 게이트를 기계 게이트로 바꾼다.
//
// 기계가 검사하는 것 (사람 눈을 대신하지는 못한다 — 아래 넷만 본다)
//   1) 배급사 등급이 `banned` 인 영화는 승인하지 않는다.
//   2) Content ID 프로브 판정이 `BLOCKED` 인 영화는 승인하지 않는다.
//   3) 이미 올라갔거나 이미 승인된 것은 건너뛴다.
//   4) mp4 가 실제로 있고 길이가 규격(60~200초) 안이어야 한다.
// ★그림이 깨졌는지, 자막이 틀렸는지는 **기계가 못 본다.** 업로드 뒤 `check-claims.js` 가
//   차단을 잡아 예약을 해제하는 것이 마지막 안전망이다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DRAFTS_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');
const EXPORT_DIR = path.join(DRAFTS_DIR, '_automation factory');
const APPROVALS = path.join(ROOT, 'server', 'data', 'publish_approvals.json');
const STATE = path.join(ROOT, 'server', 'data', 'auto_publish_state.json');
const PROBES = path.join(ROOT, 'server', 'data', 'claim_probes.json');
const CATALOG = path.join(ROOT, 'midform', 'config', 'movie_catalog.json');

const MIN_SEC = 60;
const MAX_SEC = 200;
const argv = process.argv.slice(2);
const doApprove = argv.includes('--approve');
const maxIdx = argv.indexOf('--max');
const MAX = maxIdx > 0 ? Number(argv[maxIdx + 1]) || 6 : 6;
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

const approvals = readJson(APPROVALS, {});
const published = new Set((readJson(STATE, { history: [] }).history || []).map((h) => h.draft));
const movies = readJson(CATALOG, { movies: {} }).movies || {};
const probes = (() => {
  const raw = readJson(PROBES, []);
  const rows = Array.isArray(raw) ? raw : raw.probes || [];
  const out = {};
  for (const r of rows) out[r.movieKey] = String(r.verdict || '');
  return out;
})();

// 드래프트 이름(20260920a-terminal_goat-ko)에서 영화를 찾는다. 슬러그의 첫 토막이 영화를 가리킨다.
function movieOf(draft) {
  const m = /^\d{8}[a-z]?-([a-z0-9]+)_/.exec(draft);
  if (!m) return null;
  const slug = m[1];
  for (const [key, v] of Object.entries(movies)) {
    const flat = key.replace(/-/g, '');
    if (flat.includes(slug) || slug.includes(flat)) return [key, v];
  }
  // 슬러그가 짧게 줄어든 경우(central → central-intelligence)를 위해 접두 비교도 한다
  for (const [key, v] of Object.entries(movies)) {
    if (key.replace(/-/g, '').startsWith(slug)) return [key, v];
  }
  return null;
}

function durationOf(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8', timeout: 60000 });
  return Number((r.stdout || '').trim()) || 0;
}

const exported = fs.existsSync(EXPORT_DIR)
  ? fs.readdirSync(EXPORT_DIR).filter((f) => /^\d{8}[a-z]?-.+-(ko|ja)\.mp4$/.test(f)).map((f) => f.replace(/\.mp4$/, ''))
  : [];
const pending = exported.filter((n) => !approvals[n] && !published.has(n)).sort();

console.log(`승인 대기 ${pending.length}건 · 한 번에 최대 ${MAX}건\n`);
const ok = [];
for (const draft of pending) {
  const found = movieOf(draft);
  const key = found ? found[0] : null;
  const tier = found ? found[1].distributor_tier : null;
  const verdict = key ? probes[key] || '' : '';
  const file = path.join(EXPORT_DIR, `${draft}.mp4`);
  const dur = fs.existsSync(file) ? durationOf(file) : 0;

  let why = null;
  if (!found) why = '카탈로그에서 영화를 못 찾음';
  else if (tier === 'banned') why = `배급사 등급 banned (${key})`;
  else if (/BLOCKED/i.test(verdict)) why = `Content ID 프로브 ${verdict} (${key})`;
  else if (!dur) why = 'mp4 없음';
  else if (dur < MIN_SEC || dur > MAX_SEC) why = `길이 ${dur.toFixed(0)}초가 규격(${MIN_SEC}~${MAX_SEC}) 밖`;

  if (why) { console.log(`  보류 ${draft}\n       ${why}`); continue; }
  console.log(`  승인 ${draft}  (${key} · ${tier || 'tier없음'} · ${verdict || '프로브없음'} · ${dur.toFixed(0)}초)`);
  ok.push(draft);
  if (ok.length >= MAX) break;
}

if (!ok.length) { console.log('\n승인할 것이 없다.'); process.exit(0); }
if (!doApprove) { console.log(`\n${ok.length}건 승인 예정 — 실제로 찍으려면 --approve`); process.exit(0); }

// 승인은 approve-publish.js 에 맡긴다. build hash 결속을 그쪽이 하기 때문이다(P0-2).
const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'approve-publish.js'), ...ok],
  { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
console.log((r.stdout || '') + (r.stderr || ''));
if (r.status !== 0) { console.error('[auto-approve] approve-publish 실패'); process.exit(1); }
console.log(`\n승인 완료 ${ok.length}건. auto-publish 가 다음 슬롯에 올린다.`);

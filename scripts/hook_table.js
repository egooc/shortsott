// 쇼츠 후킹 비교표(devo V15, 10-20 관리자 큐 ④) — 레인별 최근 30일 쇼츠의 첫 문장·첫 장면(0~2초 프레임 한 줄)·본 비율·AVP 를
// «본 비율 70% 위/아래» 두 묶음으로 나눈다. 월 1회.
//
//   node scripts/hook_table.js [--lane fantube,ja,ko_longshort,shop,politics_short] [--days 30] [--api] [--no-gpt] [--limit N]
//
// 편 목록: server/data/production_ledger.jsonl 의 youtube_id(레인·id) + 정치 쇼츠 politics-hour/shorts/<날짜>/upload_log.jsonl.
//          N100 레인은 이 PC 에 제작 폴더가 없어 뺀다.
// 첫 문장: scripts/script_audit.py --json 의 first_sentence(레인 어댑터 그대로, 읽기만).
// 첫 장면: 최종 영상 1.0초 프레임(ffmpeg) → gpt-ask.js 한 줄 설명. server/data/hook_table/frames.json 에 videoId 별 캐시.
// 수치: --api 일 때만 retention_curve.shortsStay(Analytics, 채널 OAuth 읽기 전용 — 발굴 키·Data API 아님) → stay_ratio(engagedViews/views)·avp.
//       --api 없으면 수치 칸은 «—», 묶음 나누기 생략(로컬 칸만 채워 점검).
// 출력: server/data/hook_table/<YYYYMMDD>.{json,md}. 키·토큰 값은 찍지 않는다.
// import: const { collect, resolve, build } = require('./hook_table');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNS = 'D:/volcano-runs';
const OUT = path.join(ROOT, 'server', 'data', 'hook_table');
const LEDGER = path.join(ROOT, 'server', 'data', 'production_ledger.jsonl');
const FRAMES = path.join(OUT, 'frames.json');
const STAY_SPLIT = 70;
// 장부 레인 → { Analytics 프로필 purpose, 옛 채널 purpose(조회용), script_audit --lane }
const LANES = {
  fantube: { purpose: 'idol3sec_ko', old: ['idol_fantube_ko'], audit: 'fantube' },   // 10-27 새 채널 «아이돌 3초», 옛 최애모먼트 편은 옛 키로 조회
  ja: { purpose: 'jp_highlight', audit: 'rinbox' },
  ko_longshort: { purpose: 'ko_highlight', audit: 'longshort' },
  shop: { purpose: 'shopping', audit: 'shopping' },
  politics_short: { purpose: 'politics', audit: 'politics_ko' },
};

const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const exists = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const stamp = () => new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10).replace(/-/g, '');

function collect({ lanes = Object.keys(LANES), days = 30, now = Date.now(), ledger = LEDGER, politicsRoot = path.join(ROOT, 'politics-hour', 'shorts') } = {}) {
  /* → [{lane, id, videoId, at}] 최신 기록 우선, videoId 중복 제거 */
  const since = now - days * 864e5;
  const seen = new Map();
  const add = (r) => { if (!seen.has(r.videoId) && lanes.includes(r.lane) && Date.parse(r.at) >= since) seen.set(r.videoId, r); };
  for (const r of readJsonl(ledger).reverse()) {
    if (!r.youtube_id || !LANES[r.lane] || r.lane === 'politics_short') continue;   // 정치 쇼츠는 upload_log 가 정본(장부 id 는 날짜 묶음이라 폴더를 못 푼다)
    for (const v of String(r.youtube_id).split(',').map((x) => x.trim()).filter(Boolean)) add({ lane: r.lane, id: r.id, videoId: v, at: r.publish_at || r.at });
  }
  let dates = [];
  try { dates = fs.readdirSync(politicsRoot).filter((d) => /^\d{8}$/.test(d)); } catch {}
  for (const d of dates) {
    for (const r of readJsonl(path.join(politicsRoot, d, 'upload_log.jsonl')).reverse()) {
      if (r.videoId && r.meta) add({ lane: 'politics_short', id: `${d}/${String(r.meta).replace(/\.upload\.json$/, '')}`, videoId: r.videoId, at: r.publishAt || r.at });
    }
  }
  return [...seen.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function resolve(lane, id, { runs = RUNS, politicsRoot = path.join(ROOT, 'politics-hour', 'shorts') } = {}) {
  /* → { spec, video } 없으면 null 칸 */
  const pick = (fs_) => fs_.find(exists) || null;
  if (lane === 'fantube') { const d = path.join(runs, 'fantube', id); return { spec: pick([path.join(d, 'spec.json')]), video: pick([path.join(d, 'out.mp4'), path.join(d, '_render', 'final.mp4')]) }; }
  if (lane === 'ja') { const n = /^rinbox/.test(id) ? id : `rinbox${id}`; const d = path.join(runs, n); return { spec: pick([path.join(d, 'plan_local.json')]), video: pick([path.join(d, '_render', `${n}-local.mp4`), path.join(d, '_render', 'final.mp4')]) }; }
  if (lane === 'ko_longshort') { const d = path.join(runs, id); return { spec: pick([path.join(d, 'plan.json')]), video: pick([path.join(d, `${id}.mp4`), path.join(d, '_render', 'final.mp4'), path.join(d, '_ff', 'final.mp4')]) }; }
  if (lane === 'shop') { const m = path.join(runs, '_upload', `${id}.json`); const meta = readJson(m) || {}; return { spec: exists(m) ? m : null, video: pick([meta.file].filter(Boolean)) }; }
  if (lane === 'politics_short') {
    const [d, s] = String(id).split('/');
    if (!s) return { spec: null, video: null };
    const dir = path.join(politicsRoot, 'ls', d, s);
    return { spec: pick([path.join(dir, 'plan.json')]), video: pick([path.join(dir, '_render', 'final.mp4')]) };
  }
  return { spec: null, video: null };
}

function firstSentence(spec, lane) {
  if (!spec) return null;
  const tmp = path.join(OUT, `_audit_${process.pid}.json`);
  try {
    fs.mkdirSync(OUT, { recursive: true });
    execFileSync('python', ['-X', 'utf8', path.join(ROOT, 'scripts', 'script_audit.py'), spec, '--lane', LANES[lane].audit, '--kind', 'shorts', '--json', tmp], { stdio: 'ignore', timeout: 60e3 });
  } catch { /* 경고 종료 코드도 json 은 남는다 */ }
  const r = readJson(tmp);
  try { fs.rmSync(tmp, { force: true }); } catch {}
  return r ? (r.first_sentence || (r.error ? `(읽기 실패: ${r.error})` : null)) : null;
}

function describeFrame(video, videoId, { gpt = true, cache = readJson(FRAMES) || {} } = {}) {
  if (cache[videoId]) return cache[videoId];
  if (!video) return null;
  const jpg = path.join(OUT, 'frames', `${videoId}.jpg`);
  try {
    fs.mkdirSync(path.dirname(jpg), { recursive: true });
    if (!exists(jpg)) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '1.0', '-i', video, '-frames:v', '1', '-vf', 'scale=540:-2', jpg], { timeout: 60e3 });
  } catch { return null; }
  if (!gpt) return `(프레임 ${path.relative(ROOT, jpg).replace(/\\/g, '/')})`;
  try {
    const ans = execFileSync('node', [path.join(ROOT, 'scripts', 'gpt-ask.js'), '--no-search', '--effort', 'low', '--session', '도구개발 hook_table', '--attach', jpg,
      '쇼츠 영상 1초 지점 화면이다. 무엇이 보이는지 한국어 한 줄(30자 안팎)로만 답해라. 인물 이름 추측 금지, 화면 글자는 «»로 인용.'], { encoding: 'utf8', timeout: 180e3 });
    const line = ans.trim().split(/\r?\n/).filter(Boolean).pop() || null;
    if (line) { cache[videoId] = line; fs.writeFileSync(FRAMES, JSON.stringify(cache, null, 2) + '\n', 'utf8'); }
    return line;
  } catch { return null; }
}

function split(rows, at = STAY_SPLIT) {
  const has = rows.filter((r) => r.stay_ratio != null);
  return { high: has.filter((r) => r.stay_ratio >= at), low: has.filter((r) => r.stay_ratio < at), none: rows.filter((r) => r.stay_ratio == null) };
}

function md(rows, { api }) {
  const L = [`# 쇼츠 후킹 비교표 (${stamp()}) — 본 비율 ${STAY_SPLIT}% 기준`, ''];
  const row = (r) => `| ${r.lane} | ${r.id} | ${r.videoId} | ${r.stay_ratio ?? '—'} | ${r.avp ?? '—'} | ${r.likes ?? '—'} | ${r.comments ?? '—'} | ${r.shares ?? '—'} | ${(r.first_sentence || '—').replace(/\|/g, '/')} | ${(r.first_scene || '—').replace(/\|/g, '/')} |`;
  const head = ['| 레인 | 편 | 영상 | 본 비율% | AVP% | 좋아요 | 댓글 | 공유 | 첫 문장 | 첫 장면(1초) |', '|---|---|---|---|---|---|---|---|---|---|'];
  if (!api) { L.push('_수치 없음(--api 안 줌) — 로컬 칸만 점검_', '', ...head, ...rows.map(row)); return L.join('\n') + '\n'; }
  const g = split(rows);
  for (const [k, t] of [['high', `${STAY_SPLIT}% 이상`], ['low', `${STAY_SPLIT}% 미만`], ['none', '집계 없음']]) {
    if (!g[k].length) continue;
    L.push(`## ${t} (${g[k].length}편)`, '', ...head, ...g[k].sort((a, b) => (b.stay_ratio ?? -1) - (a.stay_ratio ?? -1)).map(row), '');
  }
  return L.join('\n') + '\n';
}

async function build({ lanes, days = 30, api = false, gpt = true, limit = Infinity } = {}) {
  const items = collect({ lanes, days }).slice(0, limit);
  const cache = readJson(FRAMES) || {};
  const rows = items.map((it) => {
    const { spec, video } = resolve(it.lane, it.id);
    return { ...it, spec: spec && spec.replace(/\\/g, '/'), video: video && video.replace(/\\/g, '/'), first_sentence: firstSentence(spec, it.lane), first_scene: describeFrame(video, it.videoId, { gpt, cache }), stay_ratio: null, avp: null };
  });
  if (api) {
    const { shortsStay } = require('./retention_curve');
    for (const lane of [...new Set(rows.map((r) => r.lane))]) {
      const mine = rows.filter((r) => r.lane === lane);
      const [main, ...old] = [LANES[lane].purpose, ...(LANES[lane].old || [])];
      for (const purpose of [main, ...old]) {
        const left = purpose === main ? mine : mine.filter((r) => r.stay_ratio == null);   // 옛 채널 키는 새 채널에서 안 잡힌 편만
        if (!left.length) break;
        try {
          for (const s of await shortsStay(left.map((r) => r.videoId), { purpose })) Object.assign(left.find((r) => r.videoId === s.id) || {}, { stay_ratio: s.stay_ratio, avp: s.avp, views: s.views, likes: s.likes, comments: s.comments, shares: s.shares });
        } catch (e) {
          if (e.stop) throw e;   // 403·429 는 그 자리에서 멈춘다(우회 금지)
          if (purpose === main) mine.forEach((r) => { r.api_error = e.message.slice(0, 120); });
        }
      }
    }
  }
  fs.mkdirSync(OUT, { recursive: true });
  const base = path.join(OUT, stamp());
  fs.writeFileSync(`${base}.json`, JSON.stringify({ at: new Date().toISOString(), days, api, split_at: STAY_SPLIT, rows }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(`${base}.md`, md(rows, { api }), 'utf8');
  return { rows, out: `${base}.md` };
}

module.exports = { collect, resolve, split, md, build, LANES };

if (require.main === module) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  build({ lanes: opt('--lane') ? opt('--lane').split(',') : undefined, days: +(opt('--days') || 30), api: a.includes('--api'), gpt: !a.includes('--no-gpt'), limit: +(opt('--limit') || Infinity) })
    .then(({ rows, out }) => {
      const n = (k) => rows.filter((r) => r[k] && !String(r[k]).startsWith('(')).length;
      console.log(`쇼츠 ${rows.length}편 · 첫 문장 ${n('first_sentence')} · 첫 장면 ${n('first_scene')} · 수치 ${rows.filter((r) => r.stay_ratio != null).length} → ${path.relative(ROOT, out)}`);
    })
    .catch((e) => { console.error(`멈춤: ${e.message}`); process.exit(e.stop ? 3 : 1); });
}

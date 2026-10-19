// 관리자 성과 보고 — 하루치를 한 장으로 만든다(소유주 2026-10-15: «진행 상황 말고 성과 보고», 매일 07:40).
//
//   node scripts/manager-report.js                 어제(KST) 치
//   node scripts/manager-report.js --date 2026-10-15
//   node scripts/manager-report.js --no-youtube    API 호출 없이(토큰·자원·장부만)
//
// 읽는 것
//   · 성과: 연결된 유튜브 채널의 최근 업로드 통계(그제 발행분 = 37~55시간, 어제 발행분 = 이른 신호). 프로필당 API 3단위.
//   · Claude 토큰: ~/.claude/projects/**/*.jsonl 의 usage 를 세션별로 합산(세션 이름은 ~/.claude/sessions/*.json).
//   · GPT: server/output/task-logs/gpt-ask.jsonl (세션별 호출·토큰·주간 한도 사용률).
//   · 편수·편당 시간: server/data/production_ledger.jsonl (docs/production-ledger.md 규격).
//   · 병목: server/output/metrics/resources-YYYYMMDD.jsonl (5분 샘플) → 시간대별 CPU·GPU·RAM, 포화 구간, 그때 돈 프로세스.
// 결과: docs/reports/YYYY-MM-DD-perf.md  (한 항목이 실패해도 나머지는 쓴다)
//
// 못 잡는 것: Claude 5시간·주간 한도의 남은 양(앱 /usage 에서만 보인다). 조회수는 하루 한 번만 읽어 할당량을 아낀다.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch {}
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const PROFILES = path.join(ROOT, 'server/data/youtube_upload_profiles.json');
const LEDGER = path.join(ROOT, 'server/data/production_ledger.jsonl');
const GPT_LOG = path.join(ROOT, 'server/output/task-logs/gpt-ask.jsonl');
const METRICS = path.join(ROOT, 'server/output/metrics');
const OUT_DIR = path.join(ROOT, 'docs/reports');
const CORES = os.cpus().length;

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const NO_YT = process.argv.includes('--no-youtube');
const kstDate = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const DATE = arg('--date', kstDate(Date.now() - 864e5));
const DAY0 = Date.parse(DATE + 'T00:00:00+09:00');
const DAY1 = DAY0 + 864e5;
const PREV = kstDate(DAY0 - 864e5);
const PREV0 = DAY0 - 864e5;
const inDay = (ms, a = DAY0, b = DAY1) => ms >= a && ms < b;
const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');
const hhmm = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(11, 16);
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };

// ── 성과(유튜브) ───────────────────────────────────────────────────────────────
async function token(p) {
  const body = new URLSearchParams({ client_id: p.oauthClientId, client_secret: p.oauthClientSecret, refresh_token: p.refreshToken, grant_type: 'refresh_token' });
  const j = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } })).json();
  if (!j.access_token) throw new Error('토큰 갱신 실패');
  return j.access_token;
}
const get = async (tk, url) => { const j = await (await fetch(url, { headers: { authorization: 'Bearer ' + tk } })).json(); if (j.error) throw new Error(j.error.message); return j; };

async function youtubeSection() {
  if (NO_YT) return '_(유튜브 조회 생략)_';
  const store = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  const profiles = (Array.isArray(store) ? store : store.profiles || []).filter((p) => p.refreshToken);
  const rows = []; const notes = [];
  for (const p of profiles) {
    try {
      const tk = await token(p);
      const ch = await get(tk, 'https://www.googleapis.com/youtube/v3/channels?part=contentDetails,statistics&mine=true');
      const c = ch.items && ch.items[0]; if (!c) throw new Error('채널 없음');
      const pl = await get(tk, `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${c.contentDetails.relatedPlaylists.uploads}`);
      const ids = (pl.items || []).map((i) => i.contentDetails.videoId);
      const v = ids.length ? await get(tk, `https://www.googleapis.com/youtube/v3/videos?part=snippet,status,statistics&id=${ids.join(',')}`) : { items: [] };
      // 예약 편은 snippet.publishedAt 이 업로드 시각이라 status.publishAt 을 우선한다. 아직 공개 전이면 «예약 대기»로만 센다.
      const now = Date.now();
      const vids = (v.items || []).map((x) => ({ id: x.id, title: x.snippet.title, pub: x.status.publishAt ? Date.parse(x.status.publishAt) : Date.parse(x.snippet.publishedAt), privacy: x.status.privacyStatus, views: Number(x.statistics.viewCount || 0) }));
      const live = vids.filter((x) => x.pub <= now);
      const pending = vids.filter((x) => x.pub > now).length;
      const d2 = live.filter((x) => inDay(x.pub, PREV0, DAY0)); // 그제 발행 = 37~55시간
      const d1 = live.filter((x) => inDay(x.pub, DAY0, DAY1)); // 어제 발행 = 이른 신호
      const stat = (xs) => xs.length ? `${xs.length}편 · 중앙 ${fmt(median(xs.map((x) => x.views)))} · 최고 ${fmt(Math.max(...xs.map((x) => x.views)))} · 100 미만 ${xs.filter((x) => x.views < 100).length} · 비공개 ${xs.filter((x) => x.privacy !== 'public').length}` : '—';
      const best = d2.sort((a, b) => b.views - a.views)[0];
      rows.push(`| ${p.channelTitle || p.purpose} | ${p.purpose} | ${fmt(c.statistics.subscriberCount)} | ${stat(d2)} | ${stat(d1)} | ${pending} | ${best ? `${best.title.slice(0, 28)} (${fmt(best.views)})` : '—'} |`);
    } catch (e) { notes.push(`- ${p.channelTitle || p.purpose}: 조회 실패 — ${e.message}`); }
  }
  return [`| 채널 | purpose | 구독 | 그제(${PREV}) 발행 · 37~55h | 어제(${DATE}) 발행 · 이른 신호 | 예약 대기 | 그제 최고 편 |`, '|---|---|---|---|---|---|---|', ...rows, ...notes].join('\n');
}

// ── Claude 토큰 ────────────────────────────────────────────────────────────────
function sessionNames() {
  const m = {};
  try { for (const f of fs.readdirSync(path.join(CLAUDE_HOME, 'sessions'))) { if (!f.endsWith('.json')) continue; const s = parse(fs.readFileSync(path.join(CLAUDE_HOME, 'sessions', f), 'utf8')); if (s && s.sessionId) m[s.sessionId] = s.name || ''; } } catch {}
  return m;
}
async function claudeSection() {
  const names = sessionNames(); const out = {};
  const projects = path.join(CLAUDE_HOME, 'projects');
  for (const d of fs.readdirSync(projects)) {
    const dir = path.join(projects, d); if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(dir, f); if (fs.statSync(fp).mtimeMs < DAY0) continue;
      const sid = f.replace('.jsonl', ''); const key = names[sid] || (d === 'D--midform' ? `헤드리스(D:/midform)/${sid.slice(0, 8)}` : `${d.replace(/^C--Users-[^-]+-/, '').slice(0, 24)}/${sid.slice(0, 8)}`);
      const rl = readline.createInterface({ input: fs.createReadStream(fp, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.includes('"usage"')) continue;
        const ev = parse(line); const u = ev && ev.message && ev.message.usage; const ts = ev && Date.parse(ev.timestamp);
        if (!u || !inDay(ts)) continue;
        const o = out[key] || (out[key] = { msgs: 0, out: 0, inp: 0, cw: 0, cr: 0, model: '' });
        o.msgs++; o.out += u.output_tokens || 0; o.inp += u.input_tokens || 0; o.cw += u.cache_creation_input_tokens || 0; o.cr += u.cache_read_input_tokens || 0; o.model = (ev.message.model || o.model).replace('claude-', '');
      }
    }
  }
  const rows = Object.entries(out).sort((a, b) => b[1].out - a[1].out);
  const T = rows.reduce((t, [, v]) => ({ msgs: t.msgs + v.msgs, out: t.out + v.out, cw: t.cw + v.cw, cr: t.cr + v.cr }), { msgs: 0, out: 0, cw: 0, cr: 0 });
  return ['| 세션 | 메시지 | 출력 토큰 | 캐시 쓰기 | 캐시 읽기 | 모델 |', '|---|---|---|---|---|---|',
    ...rows.map(([k, v]) => `| ${k} | ${fmt(v.msgs)} | ${fmt(v.out)} | ${fmt(v.cw)} | ${fmt(v.cr)} | ${v.model} |`),
    `| **합계** | ${fmt(T.msgs)} | ${fmt(T.out)} | ${fmt(T.cw)} | ${fmt(T.cr)} | |`,
    '', '_5시간·주간 한도의 남은 양은 앱 `/usage` 에서만 보인다._'].join('\n');
}

// ── GPT ──────────────────────────────────────────────────────────────────────
function gptSection() {
  const all = readLines(GPT_LOG).map(parse).filter(Boolean);
  const day = all.filter((r) => inDay(Date.parse(r.at)));
  const by = {};
  for (const r of day) { const o = by[r.session || '(이름 없음)'] || (by[r.session || '(이름 없음)'] = { n: 0, img: 0, secs: 0, inp: 0, out: 0, fail: 0 }); o.n++; if (r.mode === 'image') o.img++; o.secs += r.secs || 0; if (r.usage) { o.inp += r.usage.input || 0; o.out += r.usage.output || 0; } if (r.exit !== 0) o.fail++; }
  const last = [...all].reverse().find((r) => r.limits && r.limits.primary);
  const lim = last ? `주간 한도 사용 **${last.limits.primary.used_pct}%** (리셋 ${last.limits.primary.resets_at ? hhmm(Date.parse(last.limits.primary.resets_at)) + ' ' + kstDate(Date.parse(last.limits.primary.resets_at)) : '?'}, 플랜 ${last.limits.plan}, ${kstDate(Date.parse(last.at))} 기준)` : '한도 기록 없음';
  const rows = Object.entries(by).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `| ${k} | ${v.n} | ${v.img} | ${Math.round(v.secs / Math.max(v.n, 1))}s | ${fmt(v.inp)} | ${fmt(v.out)} | ${v.fail} |`);
  return [lim, '', '| 세션 | 호출 | 이미지 | 평균 소요 | 입력 토큰 | 출력 토큰 | 실패 |', '|---|---|---|---|---|---|---|', ...(rows.length ? rows : ['| — | 0 | | | | | |'])].join('\n');
}

// ── 편수·편당 시간(장부) ───────────────────────────────────────────────────────
function ledgerSection() {
  const recs = {}; for (const r of readLines(LEDGER).map(parse).filter(Boolean)) recs[`${r.lane}/${r.id}`] = { ...(recs[`${r.lane}/${r.id}`] || {}), ...r };
  const day = Object.values(recs).filter((r) => inDay(Date.parse(r.finished_at || r.at)));
  if (!day.length) return '_장부에 적힌 편이 없다(세션들이 production_ledger.jsonl 에 기록해야 집계된다)._';
  const by = {};
  for (const r of day) { const o = by[r.lane] || (by[r.lane] = { n: 0, mins: [], render: [], gpt: 0, rej: 0, up: 0 }); o.n++; const begin = r.prep_started_at || r.started_at; if (begin && r.finished_at) o.mins.push((Date.parse(r.finished_at) - Date.parse(begin)) / 60e3); if (r.render_secs) o.render.push(r.render_secs); o.gpt += r.gpt_calls || 0; o.rej += r.rejected || 0; if (r.youtube_id) o.up++; }
  return ['| 레인 | 편수 | 편당 제작(중앙, 분) | 편당 렌더(중앙, 분) | GPT 호출 | 반려 | 업로드 |', '|---|---|---|---|---|---|---|',
    ...Object.entries(by).map(([k, v]) => `| ${k} | ${v.n} | ${v.mins.length ? Math.round(median(v.mins)) : '—'} | ${v.render.length ? Math.round(median(v.render) / 60) : '—'} | ${v.gpt} | ${v.rej} | ${v.up} |`)].join('\n');
}

// ── 병목(자원 샘플) ────────────────────────────────────────────────────────────
function resourceSection() {
  const f = path.join(METRICS, `resources-${DATE.replace(/-/g, '')}.jsonl`);
  const s = readLines(f).map(parse).filter(Boolean).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!s.length) return '_자원 샘플 없음(midform-resource-sample 작업 확인)._';
  const H = Array.from({ length: 24 }, () => ({ cpu: [], gpu: [], ram: [], sat: 0, lock: 0, proc: {} }));
  let prev = null;
  for (const x of s) {
    const h = new Date(Date.parse(x.at) + 9 * 3600e3).getUTCHours(); const b = H[h];
    b.cpu.push(x.cpu_pct || 0); if (x.gpu_pct != null) b.gpu.push(x.gpu_pct); b.ram.push(x.ram_used_mb || 0);
    if ((x.cpu_pct || 0) >= 90 || (x.gpu_pct || 0) >= 90) b.sat++; if (x.markers && x.markers.politics_render_lock) b.lock++;
    if (prev) { const dt = (Date.parse(x.at) - Date.parse(prev.at)) / 1e3; const pm = Object.fromEntries((prev.top || []).map((t) => [t.pid, t.cpu_s]));
      for (const t of x.top || []) { const d = t.cpu_s - (pm[t.pid] ?? t.cpu_s); if (d > 0 && dt > 0 && dt < 1800) b.proc[t.name] = (b.proc[t.name] || 0) + d; } }
    prev = x;
  }
  const avg = (xs) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  const rows = H.map((b, h) => b.cpu.length ? `| ${String(h).padStart(2, '0')}시 | ${avg(b.cpu)} / ${Math.max(...b.cpu)} | ${b.gpu.length ? `${avg(b.gpu)} / ${Math.max(...b.gpu)}` : '—'} | ${(avg(b.ram) / 1024).toFixed(1)} | ${b.sat}/${b.cpu.length}${b.lock ? ' 🔒' : ''} | ${Object.entries(b.proc).sort((a, c) => c[1] - a[1]).slice(0, 3).map(([n, v]) => `${n} ${Math.round(v / 60)}분`).join(', ')} |` : null).filter(Boolean);
  const satHours = H.map((b, h) => (b.cpu.length && b.sat / b.cpu.length >= 0.5) ? h : null).filter((h) => h != null);
  const peakRam = Math.max(...s.map((x) => x.ram_used_mb || 0)); const ramTotal = s[0].ram_total_mb || 0;
  const gpuPeak = Math.max(...s.map((x) => x.gpu_pct || 0)); const gpuMemPeak = Math.max(...s.map((x) => x.gpu_mem_mb || 0));
  const summary = [`- 샘플 ${s.length}개(5분 간격). CPU 90% 이상이 절반 넘는 시간대: ${satHours.length ? satHours.map((h) => h + '시').join(', ') : '없음'}. 🔒 = 정치 렌더 lock.`,
    `- RAM 최고 ${(peakRam / 1024).toFixed(1)} / ${(ramTotal / 1024).toFixed(0)} GB · GPU 최고 ${gpuPeak}% (메모리 최고 ${(gpuMemPeak / 1024).toFixed(1)} / ${((s[0].gpu_mem_total_mb || 0) / 1024).toFixed(0)} GB) · 코어 ${CORES}개 · D: 남은 ${s[s.length - 1].disk_d_free_gb} GB`];
  return [...summary, '', '| 시 | CPU 평균/최고 % | GPU 평균/최고 % | RAM GB | 포화 샘플 | CPU 많이 쓴 프로세스(CPU-분) |', '|---|---|---|---|---|---|', ...rows].join('\n');
}

// 6. 결 탐지 — 도구개발 scripts/thread_report.js(10-16). 채널 토큰 videos.list만 쓰고 검색은 하지 않는다.
async function threadsSection() {
  const { buildThreads } = require('./thread_report');
  const { markdown } = await buildThreads();
  return markdown || '_집계할 편이 없습니다._';
}

// 7. 태그 점검 — 쇼핑 scripts/shop_yt_tags.js --list(9aef2f1). 10-16 사고(태그 0개로 공개 → 조회 3) 뒤 전 레인 게이트.
//    프로필마다 최근 2일 공개·예약분을 읽어 0개 편을 적는다(고치지 않음). 쓸모연구소(shopping_old_ssulmo)는 논외.
async function tagsSection() {
  const { execFileSync } = require('child_process');
  const store = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  const purposes = store.profiles.map((p) => p.purpose).filter((p) => p && p !== 'shopping_old_ssulmo');
  const rows = []; let zeroTotal = 0;
  for (const purpose of purposes) {
    try {
      const out = execFileSync('node', [path.join(ROOT, 'scripts/shop_yt_tags.js'), '--list', '--purpose', purpose, '--days', '2'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
      const lines = out.trim().split('\n'); rows.push(`- ${lines[lines.length - 1]}`);
    } catch (e) {
      const out = String(e.stdout || '').trim();
      if (e.status === 4 && out) { const ls = out.split('\n'); zeroTotal++; rows.push(`- ⚠ ${ls[ls.length - 1]}`, ...ls.slice(0, -1).map((l) => `    - ${l}`)); }
      else rows.push(`- ${purpose}: _확인 실패: ${(e.stderr || e.message || '').toString().trim().split('\n')[0]}_`);
    }
  }
  return [zeroTotal ? `**⚠ 태그 0개 채널 ${zeroTotal}곳 — 해당 세션에 즉시 삽입·확인 지시.**` : '태그 0개 편 없음(최근 2일 공개·예약분).', '', ...rows].join('\n');
}

// 8. 포장 경고 — 정치 ko politics-hour/views_check.js(3bc1009)가 공개 +3h·+6h 조회를 server/data/politics_views.jsonl 에 남기고,
//    직전 편 같은 시점의 절반 미만이면 politics_alerts.jsonl 에 한 줄 쓴다(스케줄 작업이라 세션에 말을 못 걸어 여기서 읽는다).
//    소유주 10-17 «항상 문제는 거기»: 미달이면 영상이 아니라 제목·태그·썸네일부터 다시 쓴다(재업로드 금지). 보고일과 그 전날 기록을 보인다.
async function packagingSection() {
  const readJsonl = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean) : [];
  const views = readJsonl(path.join(ROOT, 'server/data/politics_views.jsonl'));
  const alerts = readJsonl(path.join(ROOT, 'server/data/politics_alerts.jsonl'));
  const today = kstDate(Date.now());
  const inWindow = (r) => { const d = kstDate(Date.parse(r.at)); return d === DATE || d === today; };
  const vs = views.filter(inWindow); const as = alerts.filter(inWindow);
  if (!vs.length && !as.length) return `기록 없음(${DATE}·${today}). 사후 점검은 정치 ko 10/18편부터 비교가 시작된다.`;
  const out = [as.length ? `**⚠ 포장 경고·교체 ${as.length}건 — 자동 교체는 결과만 확인, 미달 경고는 해당 세션에 제목·태그·썸네일 재작성 지시(재업로드 금지).**` : '포장 경고 없음.', ''];
  // 10-19: alerts 는 두 꼴 — 자동 포장 교체·소진 기록(alert 문구 있음)과 옛 절반 미달 경고(h·views·prev). 문구가 있으면 그대로 보인다.
  for (const a of as) out.push(a.alert
    ? `- ⚠ ${a.id} ${String(a.alert).slice(0, 120)} (${a.at.slice(11, 16)}Z)`
    : `- ⚠ ${a.id} «${(a.title || '').slice(0, 40)}» +${a.h}h 조회 ${a.views} < 직전 편 ${a.prev?.views ?? '?'}의 절반 (${a.at.slice(11, 16)}Z)`);
  if (as.length) out.push('');
  out.push('| 편 | 제목 | +h | 조회 | 직전 편 같은 시점 | 판정 |', '|---|---|---|---|---|---|');
  for (const r of vs) out.push(`| ${r.id} | ${(r.title || '').slice(0, 40)} | +${r.h}h | ${r.views.toLocaleString()} | ${r.prev ? `${r.prev.views.toLocaleString()} (${r.prev.id})` : '기록 없음(첫 기준)'} | ${r.prev && r.views < r.prev.views / 2 ? '⚠ 미달' : '통과'} |`);
  return out.join('\n');
}

(async () => {
  const sec = async (title, fn) => { try { return `## ${title}\n\n${await fn()}`; } catch (e) { return `## ${title}\n\n_실패: ${e.message}_`; } };
  const parts = [`# 성과 보고 ${DATE} (KST, 다음 날 07:40 기준)`, '',
    await sec('1. 성과 — 유튜브', youtubeSection), '', await sec('2. 편수·편당 시간 (제작 장부)', ledgerSection), '',
    await sec('3. Claude 토큰 (세션별, 그날 00~24시)', claudeSection), '', await sec('4. GPT (gpt-ask)', gptSection), '',
    await sec('5. 병목 — 시간대별 자원', resourceSection), '',
    await sec('6. 결 탐지 (레인 중앙값 3배 넘은 편의 공통 속성, 공개 72시간 경과분)', threadsSection), '',
    await sec('7. 태그 점검 (최근 2일 공개·예약분, 0개면 ⚠)', tagsSection), '',
    await sec('8. 포장 경고·자동 교체 (롱폼 공개 +4h·+8h·+12h·+24h·매일 조회, 바닥 미달이면 다음 포장)', packagingSection), ''];
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${DATE}-perf.md`);
  fs.writeFileSync(out, parts.join('\n') + '\n', 'utf8');
  console.log(out);
})().catch((e) => { console.error(e.message); process.exit(1); });

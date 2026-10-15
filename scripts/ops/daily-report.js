// N100 하루 성과 JSON — 관리자 세션이 매일 07:40 성과 보고에 합친다(2026-10-15 관리자 요청, 소유주 지시).
//   node scripts/ops/daily-report.js [YYYY-MM-DD]   (기본: 어제 KST 00~24시) → stdout JSON + server/output/daily-report/<date>.json
//   전송은 이 PC 세션이 SendMessage 로 07:20 전에 한다(스크립트는 세션 메시지를 못 보낸다).
// 값 출처
//   videos   volcano-runs/*/uploaded.json (그날 업로드한 편) · lane = config/channels.json 의 profileId 대응
//            started_at = 회차 폴더 생성 · finished_at = final_tight.mp4 · render_secs = 컷 렌더 + 마무리 사슬(파일 시각 추정)
//            subject_read_secs = subject_pos sheet→check 간격(화면 글자 피사체 칸 판독) · rejected 는 기록이 없어 null
//   gpt      tools/gpt-ask.jsonl 의 session=N100 호출 수 · weekly_used_pct 는 마지막 호출 limits 의 주간 창(로그인 전엔 null)
//   load     server/output/metrics/resources-YYYYMMDD.jsonl (5분 샘플, 작업 volcano-resource-sample)
//   volcano_watch server/output/volcano-watch/<오늘>.json (06:30 setup 감시, volcano-setup-watch.js)
//   recovery 도구의쓸모·JP 회복 시험 — 신호=새 편 24h 100회, 회복=연속 2편 48h 1,000회 (videos.list 1단위/채널)
const fs = require('fs');
const path = require('path');
const HOME = process.env.USERPROFILE || process.env.HOME;
const ROOT = path.join(HOME, 'volcano-channel');
const RUNS = path.join(HOME, 'volcano-runs');
const SHORTSOTT = path.join(HOME, 'orca', 'shortsott');
const KST = 9 * 3600000;
const date = process.argv[2] || new Date(Date.now() + KST - 86400000).toISOString().slice(0, 10);
const d0 = Date.parse(date + 'T00:00:00+09:00'), d1 = d0 + 86400000;
const iso = (ms) => (ms ? new Date(ms + KST).toISOString().replace('Z', '+09:00').slice(0, 19) + '+09:00' : null);
const st = (p) => { try { return fs.statSync(p); } catch { return null; } };
const readJ = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const lines = (p) => { try { return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

const reg = readJ(path.join(ROOT, 'config', 'channels.json'), {}).channels || {};
const laneOf = (pid) => (Object.entries(reg).sort(([, a], [, b]) => (b.status === '운영중') - (a.status === '운영중')).find(([, c]) => c.profileId === pid) || [pid])[0];   // 휴면 옛 칸(ja_dormant)보다 운영중 칸
const timing = lines(path.join(RUNS, '_scratch', 'subject_pos_timing.jsonl'));

const videos = [];
for (const w of fs.readdirSync(RUNS)) {
  const wd = path.join(RUNS, w);
  const u = readJ(path.join(wd, 'uploaded.json'), null);
  if (!u || !u.videoId || !u.at) continue;
  const at = Date.parse(u.at);
  if (at < d0 || at >= d1) continue;
  const tight = st(path.join(wd, 'final_tight.mp4'));
  // 컷 렌더: 최신 편집 폴더 생성 → final-own.mp4 · 마무리: final_recap/plain 생성 → final_tight
  let render = null;
  try {
    const eds = fs.readdirSync(path.join(wd, 'edits')).map((e) => path.join(wd, 'edits', e)).filter((e) => st(path.join(e, 'final-own.mp4')));
    const ed = eds.sort((a, b) => st(path.join(b, 'final-own.mp4')).mtimeMs - st(path.join(a, 'final-own.mp4')).mtimeMs)[0];
    const cut = st(path.join(ed, 'final-own.mp4')).mtimeMs - st(ed).birthtimeMs;
    const fin0 = st(path.join(wd, 'final_recap.mp4')) || st(path.join(wd, 'final_plain.mp4'));
    const fin = tight && fin0 ? tight.mtimeMs - fin0.birthtimeMs : 0;
    if (cut > 0) render = Math.round((cut + Math.max(0, fin)) / 1000);
  } catch {}
  const tw = timing.filter((x) => x.wd === w);
  const sh = tw.filter((x) => x.cmd === 'sheet').pop(), ck = tw.filter((x) => x.cmd === 'check' && sh && x.at > sh.at).shift();
  videos.push({
    lane: laneOf(u.profileId), id: w.replace(/-(ko|ja)$/, ''), channel: u.channel || null,
    started_at: iso(st(wd).birthtimeMs), finished_at: iso(tight && tight.mtimeMs), render_secs: render,
    subject_read_secs: sh && ck ? Math.round(ck.at - sh.at) : null,
    gpt_calls: 0, youtube_id: u.videoId, publish_at: u.publishAt ? iso(Date.parse(u.publishAt)) : iso(at), rejected: null,
  });
}

const gptLog = lines(path.join(ROOT, 'server', 'output', 'task-logs', 'gpt-ask.jsonl')).filter((x) => x.session === 'N100' && Date.parse(x.at) >= d0 && Date.parse(x.at) < d1);

// 주간 구독 한도 사용률 — gpt-ask.js 가 남기는 limits(window_min 10080 = 주간) 중 가장 최근 값
function weeklyPct() {
  const all = lines(path.join(ROOT, 'server', 'output', 'task-logs', 'gpt-ask.jsonl')).filter((x) => x.session === 'N100' && x.limits);
  const l = all.pop(); if (!l) return null;
  const w = [l.limits.primary, l.limits.secondary].find((x) => x && x.window_min === 10080);
  return w ? w.used_pct : null;
}

const samples = lines(path.join(ROOT, 'server', 'output', 'metrics', `resources-${date.replace(/-/g, '')}.jsonl`));
const byHour = {};
for (const s of samples) { const h = new Date(Date.parse(s.at) + KST).getUTCHours(); (byHour[h] = byHour[h] || []).push(s.cpu_pct); }
const satHours = Object.entries(byHour).filter(([, v]) => v.filter((x) => x >= 90).length >= v.length / 2).map(([h]) => Number(h));
const load = { cpu_sat_hours: satHours, ram_peak_gb: samples.length ? Math.max(...samples.map((s) => s.ram_used_gb || 0)) : 0,
  note: samples.length ? `5분 샘플 ${samples.length}개` : '샘플 없음(volcano-resource-sample 10-15 낮 시작)' };

async function recovery(pid, since) {
  const { OAuth2Client } = require(path.join(SHORTSOTT, 'server', 'node_modules', 'google-auth-library'));
  const raw = readJ(path.join(SHORTSOTT, 'server', 'data', 'youtube_upload_profiles.json'), []);
  const p = (Array.isArray(raw) ? raw : raw.profiles || []).find((x) => x.id === pid && x.refreshToken);
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri); c.setCredentials({ refresh_token: p.refreshToken });
  const tk = await c.getAccessToken(); const tok = typeof tk === 'string' ? tk : tk.token;
  const ids = fs.readdirSync(RUNS).map((w) => readJ(path.join(RUNS, w, 'uploaded.json'), null)).filter((u) => u && u.profileId === pid && u.videoId).map((u) => u.videoId);
  const vids = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=status,statistics,snippet&id=' + ids.slice(i, i + 50).join(','), { headers: { Authorization: 'Bearer ' + tok } });
    const j = await r.json(); if (!r.ok) throw new Error(`${r.status} ${j.error && j.error.message}`);
    vids.push(...j.items);
  }
  const test = vids.filter((v) => v.status.privacyStatus === 'public' && Date.parse(v.snippet.publishedAt) >= since)
    .sort((a, b) => Date.parse(a.snippet.publishedAt) - Date.parse(b.snippet.publishedAt))
    .map((v) => ({ h: Math.round((Date.now() - Date.parse(v.snippet.publishedAt)) / 3600000), views: Number(v.statistics.viewCount || 0) }));
  if (!test.length) return '시험 편 공개 0편';
  const sig = test.some((t) => t.h >= 24 && t.views >= 100) || test.some((t) => t.views >= 100);
  const rec = test.some((t, i) => i > 0 && t.h >= 48 && t.views >= 1000 && test[i - 1].views >= 1000);
  const verdict = rec ? '회복' : sig ? '회복 신호' : (test.every((t) => t.h >= 24) ? '계속 정지' : '판정 전');
  return `${verdict} — ` + test.map((t) => `${t.h}h ${t.views}회`).join(' · ');
}

(async () => {
  const since = Date.parse('2026-10-14T00:00:00+09:00');   // 회복 시험 시작(도구의쓸모 10-14 12시 편부터)
  const rv = {};
  for (const [k, pid] of [['dogu', 'profile_f8c1a989'], ['jp', 'profile_470cee51']]) {
    try { rv[k] = await recovery(pid, since); } catch (e) { rv[k] = '조회 실패: ' + e.message; }
  }
  // 볼케이노 서버 변동 감시(06:30 setup 1회, 결정 2) — 보고 당일 아침 기록을 한 줄로 합친다.
  const today = new Date(Date.now() + KST).toISOString().slice(0, 10);
  const vw = readJ(path.join(ROOT, 'server', 'output', 'volcano-watch', today + '.json'), null);
  const volcano_watch = vw ? `${vw.verdict} · 엔진 ${vw.engine} · 채널 ${vw.presets.length}개${vw.changed && vw.changed.length ? ' · ' + vw.changed.join(' / ') : ''}` : `${today} 06:30 기록 없음`;
  const out = { date, source: 'N100', videos, gpt: { calls: gptLog.length, weekly_used_pct: weeklyPct() }, load, recovery: rv, volcano_watch };
  const dir = path.join(ROOT, 'server', 'output', 'daily-report'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, date + '.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify(out) + '\n');
})().catch((e) => { console.error(e); process.exit(1); });

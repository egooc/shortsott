// AI 오피스 프로젝트 모듈 — 유튜브(shortsott/midform). 연결기(office/agent.js)가 5분마다 부른다. 읽기 전용, API 호출 0.
//
// 탭: 한눈에(업로드·성과) · 개요 · 콘텐츠 진행표 · 채널 성과 · 업로드 일정 · 자동화
// 읽는 것(전부 다른 도구가 이미 만들어 두는 파일)
//   server/data/production_ledger.jsonl      편별 제작·업로드·예약 (세션들이 적는 장부)
//   server/data/youtube_upload_history.json  업로드·예약 공개 시각 (uploadProfileId → 채널)
//   server/data/youtube_upload_profiles.json 채널 이름·용도 (토큰 칸은 읽지 않는다)
//   server/data/ypp_status.json              채널별 구독·쇼츠 90일 조회·롱폼 시간 (매일)
//   server/data/youtube_metrics.json         편별 조회수 스냅샷
//   docs/reports/YYYY-MM-DD-perf.md          관리자 성과 보고 1절 표
//   server/output/task-logs/gpt-ask.jsonl    GPT 주간 한도
//   Windows 예약 작업 midform-*               마지막 실행 결과
//   docs/office/hypotheses.json              채널마다 지금 거는 가설(카테고리·주제·소재)·시작일·성공 기준 — 레인 세션이 고친다
//   office/data/up-track.json                우리 채널 공개 수치(구독·편별 조회) — lib/uptrack 이 한 시간마다 공개 API 로 잰다
// 화면 규격(섹션 종류)은 office/server/public/index.html 의 renderDashboard 와 맞춘다.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
delete require.cache[require.resolve('./lib/uptrack')];
const { refreshUploads } = require('./lib/uptrack');

const ROOT = path.resolve(__dirname, '../..');
const D = (p) => path.join(ROOT, p);
const readJson = (p, fb = null) => { try { return JSON.parse(fs.readFileSync(D(p), 'utf8')); } catch { return fb; } };
const readLines = (p) => { try { return fs.readFileSync(D(p), 'utf8').split('\n').filter((l) => l.trim()); } catch { return []; } };
const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };
const kst = (ms) => new Date(ms + 9 * 3600e3);
const hhmm = (ms) => kst(ms).toISOString().slice(11, 16);
const mdhm = (ms) => { const d = kst(ms); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hhmm(ms)}`; };
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const fmt = (n) => n == null ? '—' : n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}만` : n.toLocaleString('ko-KR');

const LANES = {
  ja: '린박스 JA', ko_longshort: '롱투숏', fantube: '팬튜브', shop: '쇼핑', politics_long: '정치 ko 롱폼',
  politics_short: '정치 ko 쇼츠', politics_ja: '정치 JA 쇼츠', politics_ja_longform: '정치 JA 롱폼', nenkin_ja: '연금 JA', corp: '기업흥망',
};
// 재고 경고는 예약 공개로 운영하는 레인만(N100 레인은 바로 공개라 재고 개념이 없다).
const STOCK_LANES = new Set(['ja', 'ko_longshort', 'fantube', 'shop', 'politics_long', 'politics_short', 'politics_ja', 'politics_ja_longform']);
// 레인 → 맡은 세션 이름(오피스 카드의 [세션 열기]).
const LANE_SESSIONS = {
  ja: 'YTHOME-SF-JP 린박스 C', ko_longshort: 'YTHOME-SF-KO 롱투숏 A', fantube: 'YTHOME-SF-KO 팬튜브 B', shop: 'YTHOME-SF-KO 쇼핑',
  politics_long: 'YTHOME-LF-KO 정치', politics_short: 'YTHOME-LF-KO 정치', politics_ja: 'YTHOME-LF-JP 정치', politics_ja_longform: 'YTHOME-LF-JP 정치',
  nenkin_ja: 'YTHOME-LF-JP 연금', corp: 'YTHOME-LF-KO 기업흥망',
};
const laneName = (k) => LANES[k] || (k.startsWith('n100_') ? `N100 ${k.slice(5)}` : k);

function profiles() {
  const p = readJson('server/data/youtube_upload_profiles.json', []);
  const arr = Array.isArray(p) ? p : (p.profiles || Object.values(p));
  return new Map(arr.map((x) => [x.id, { name: x.channelTitle || x.name, purpose: x.purpose }]));
}

function ledger() {
  const recs = {};
  for (const r of readLines('server/data/production_ledger.jsonl').map(parse).filter(Boolean)) {
    const k = `${r.lane}/${r.id}`;
    recs[k] = { ...(recs[k] || {}), ...r };
  }
  return Object.values(recs);
}

function stageOf(r, now) {
  const pub = r.publish_at ? Date.parse(r.publish_at) : null;
  if (r.retracted) return '회수';
  if (pub && pub <= now) return '공개';
  if (r.youtube_id && pub) return '예약';
  if (r.youtube_id) return '업로드';
  if (r.finished_at) return '제작 완료';
  return '제작 중';
}
const STAGE_TONE = { '제작 중': 'busy', '제작 완료': 'warn', 업로드: 'muted', 예약: 'ok', 공개: 'muted', 회수: 'bad' };

function scheduledTasks() {
  const ps = "Get-ScheduledTask -TaskName 'midform-*' | ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; [pscustomobject]@{ n = $_.TaskName; s = [string]$_.State; l = $(if ($i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToString('o') } else { '' }); r = $i.LastTaskResult; x = $(if ($i.NextRunTime) { $i.NextRunTime.ToString('o') } else { '' }) } } | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 40e3, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (e, out) => {
      try { const j = JSON.parse(out); resolve(Array.isArray(j) ? j : [j]); } catch { resolve([]); }
    });
  });
}

// 관리자 성과 보고 1절(채널 표)을 그대로 가져온다 — 같은 숫자를 두 곳에서 따로 계산하지 않게.
function perfTable() {
  const dir = D('docs/reports');
  let files = []; try { files = fs.readdirSync(dir).filter((f) => /-perf\.md$/.test(f)).sort(); } catch {}
  const f = files[files.length - 1];
  if (!f) return null;
  const t = fs.readFileSync(path.join(dir, f), 'utf8');
  const sec = t.split('\n## ')[1] || '';
  const lines = sec.split('\n').filter((l) => l.startsWith('|'));
  if (lines.length < 3) return null;
  const cells = (l) => l.split('|').slice(1, -1).map((c) => c.trim());
  return { date: f.slice(0, 10), head: cells(lines[0]), rows: lines.slice(2).map(cells) };
}

// 성과 보고 한 칸(«3편 · 중앙 16,610 · 최고 …»)을 숫자 몇 개로 줄여 폰에서도 한눈에 보이게
const JA_NAME = { jp_highlight: '린박스 일본', politics_ja: '정치 일본', nenkin_ja: '연금 일본' };
function perfSection(perf) {
  const col = (re) => perf.head.findIndex((h) => re.test(h));
  const ci = { name: col(/^채널/), purpose: col(/^purpose/), subs: col(/^구독/), d2: col(/^그제.*발행/), d1: col(/^어제.*발행/), queue: col(/^예약/) };
  const day = (c) => { const m = String(c || '').match(/(\d+)편 · 중앙 ([\d,]+)/); return m ? { n: +m[1], med: +m[2].replace(/,/g, '') } : null; };
  const fmt = (d) => (d ? `${d.med.toLocaleString('ko-KR')} (${d.n}편)` : '—');
  const rows = perf.rows.map((r) => {
    const purpose = r[ci.purpose] || '';
    const name = /[぀-ヿ]/.test(r[ci.name]) ? (JA_NAME[purpose] || '일본 채널') : r[ci.name];
    return { name, subs: r[ci.subs], d2: day(r[ci.d2]), d1: day(r[ci.d1]), queue: r[ci.queue] };
  }).filter((x) => x.d2 || x.d1 || +String(x.queue).replace(/,/g, '') > 0)
    .sort((a, b) => (b.d2?.med || b.d1?.med || 0) - (a.d2?.med || a.d1?.med || 0));
  return { type: 'table', title: `채널별 조회 (${perf.date} 보고 · 편당 중앙값)`, columns: ['채널', '구독', '그제 올린 편', '어제 올린 편', '예약'],
    rows: rows.map((x) => [x.name, x.subs, fmt(x.d2), fmt(x.d1), x.queue]),
    note: '그제 편은 이틀 지난 조회, 어제 편은 첫날 신호입니다. 올린 편이 없는 채널은 뺐습니다.' };
}

// ── 한눈에: 채널별 업로드 달력 + 채널 카드(누르면 편별 조회 그래프) ──
// 화면은 한 화면 안에: 숫자 4칸 → 14일 업로드 달력 → 작은 채널 카드. 자세한 건 카드를 눌러야 나온다.
const PURPOSE_NAME = { jp_highlight: '린박스 일본', politics_ja: '정치 일본', nenkin_ja: '연금 일본' };
const hasKana = (x) => /[\u3040-\u30ff]/.test(String(x || ''));
const median = (a) => { const b = a.filter((x) => x != null).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
function glance(t, now) {
  const dayKey = (ms) => kst(ms).toISOString().slice(0, 10);
  const days = [...Array(14)].map((_, i) => dayKey(now - (13 - i) * 864e5));
  const today = days[13];
  const chans = Object.entries(t.channels || {}).map(([id, c]) => {
    const name = PURPOSE_NAME[c.purpose] || (hasKana(c.title) ? '일본 채널' : c.title || id);
    const vids = Object.entries(t.videos || {}).filter(([, v]) => v.ch === id && v.pub).map(([vid, v]) => {
      const last = v.snaps[v.snaps.length - 1] || {};
      return { vid, pub: v.pub, views: last.views ?? null, likes: last.likes, title: hasKana(v.title) ? `${name} ${mdhm(v.pub)} 편` : v.title || vid, snaps: v.snaps };
    }).sort((a, b) => a.pub - b.pub);
    const med = median(vids.filter((v) => now - v.pub > 48 * 3600e3).map((v) => v.views));
    const wk = vids.filter((v) => v.pub > now - 7 * 864e5);
    const old = (c.subs_hist || []).find((h) => h.at >= now - 7 * 864e5);
    return { id, c, name, vids, med, wk, perDay: days.map((d) => vids.filter((v) => dayKey(v.pub) === d).length),
      today: vids.filter((v) => dayKey(v.pub) === today), dSubs: old ? c.subs - old.subs : null, wkViews: wk.reduce((a, v) => a + (v.views || 0), 0) };
  }).filter((x) => x.vids.length || x.c.subs).sort((a, b) => b.wk.length - a.wk.length || b.c.subs - a.c.subs);

  const xTone = (v, med) => (v == null || !med ? 'muted' : v >= med * 2 ? 'ok' : v < med * 0.5 ? 'bad' : 'busy');
  const vidCard = (x, v) => ({ title: v.title, tone: xTone(v.views, x.med),
    sub: `${x.name} · ${mdhm(v.pub)}`, right: `${fmt(v.views)}회${x.med ? ` · 평소의 ${(v.views / x.med).toFixed(1)}배` : ''}`,
    spark: v.snaps.length >= 2 ? { pts: v.snaps.map((p) => [(p.at - v.pub) / 3600e3, p.views]), c: xTone(v.views, x.med), ref: x.med } : undefined,
    blocks: [{ title: '반응', kv: [['조회', `${fmt(v.views)}회`], ['채널 평소', x.med ? `${fmt(x.med)}회` : '—'], ['좋아요', fmt(v.likes)]], link: `https://www.youtube.com/watch?v=${v.vid}` }] });
  const todayAll = chans.flatMap((x) => x.today.map((v) => vidCard(x, v)));
  const sumSubs = chans.reduce((a, x) => a + (x.c.subs || 0), 0), dSubs = chans.reduce((a, x) => a + (x.dSubs || 0), 0);
  const cards = chans.map((x) => {
    const recent = x.vids.slice(-20);
    const best = [...x.wk].sort((a, b) => (b.views || 0) - (a.views || 0))[0];
    return {
      title: x.name, tone: x.today.length ? 'ok' : x.wk.length ? 'busy' : 'muted',
      sub: `구독 ${fmt(x.c.subs)}${x.dSubs ? ` (${x.dSubs > 0 ? '+' : ''}${fmt(x.dSubs)}/7일)` : ''} · 7일 ${x.wk.length}편`,
      right: x.med ? `편당 평소 ${fmt(x.med)}회${best ? ` · 7일 최고 ${fmt(best.views)}` : ''}` : '평소 조회 계산 전',
      spark: recent.length >= 2 ? { pts: recent.map((v, i) => [i, v.views || 0]), c: 'busy', ref: x.med } : undefined,
      chart: { title: '최근 편 조회 (공개 순, 점 하나 = 한 편)', xt: 'date', y: 'n', series: [{ name: '편별 조회', c: 'busy', pts: recent.map((v) => [v.pub, v.views || 0]) }],
        guides: x.med ? [{ y: x.med, label: `평소 ${fmt(x.med)}`, c: 'muted' }, { y: x.med * 2, label: '2배', c: 'ok' }] : [], empty: '최근 30일 공개 편이 없습니다.' },
      blocks: recent.slice(-4).reverse().map((v) => ({ title: v.title, badge: x.med && v.views != null ? { t: `평소의 ${(v.views / x.med).toFixed(1)}배`, c: xTone(v.views, x.med) } : null,
        kv: [['조회', `${fmt(v.views)}회`], ['공개', mdhm(v.pub)]], link: `https://www.youtube.com/watch?v=${v.vid}` })),
    };
  });
  // ── 지금 거는 가설: 시작일 전·후로 그 채널 편당 조회가 어떻게 달라졌나 ──
  const hyps = (readJson('docs/office/hypotheses.json', {}).items || []).filter((h) => h.hypothesis);
  const byPurpose = new Map(chans.map((x) => [x.c.purpose, x]));
  const hypCards = hyps.map((h) => {
    const x = byPurpose.get(h.purpose);
    const since = Date.parse(h.since || '') || null;
    const vids = x ? x.vids.filter((v) => now - v.pub > 24 * 3600e3) : []; // 공개 하루 지난 편만(첫날 숫자로 속지 않게)
    const before = since ? vids.filter((v) => v.pub < since) : [], after = since ? vids.filter((v) => v.pub >= since) : [];
    const mb = median(before.map((v) => v.views)), ma = median(after.map((v) => v.views));
    const ratio = mb && ma != null ? ma / mb : null;
    const m = h.metric || {};
    let verdict, tone;
    if (!since || since > now) [verdict, tone] = ['시작 전', 'muted'];
    else if (!x) [verdict, tone] = ['채널 수치 없음', 'muted'];
    else if (after.length < 5) [verdict, tone] = ['판정 이르다', 'busy'];
    else if (m.kind === 'median_abs' && m.value) [verdict, tone] = ma >= m.value ? ['기준 넘음', 'ok'] : ma >= m.value / 2 ? ['기준 절반 이상', 'warn'] : ['기준 못 미침', 'bad'];
    else if (ratio != null) [verdict, tone] = ratio >= 1.3 ? ['맞아가는 중', 'ok'] : ratio >= 0.9 ? ['변화 없음', 'warn'] : ['전보다 나쁨', 'bad']; // 시작 전·후 편당 조회 비교(편별 기준은 성공 기준 칸)
    else [verdict, tone] = ['비교할 전 편 없음', 'muted'];
    const pts = vids.filter((v) => v.views != null).map((v) => [v.pub, v.views]);
    return {
      title: `${x ? x.name : h.channel} — ${h.hypothesis}`, tone,
      sub: since ? `${mdhm(since).split(' ')[0]}부터 · 전 ${fmt(mb)}회 → 후 ${fmt(ma)}회${ratio != null ? ` (${ratio.toFixed(1)}배)` : ''}` : '시작일 미기재',
      chips: [{ t: verdict, c: tone }, { t: `후 ${after.length}편`, c: 'muted' }],
      spark: pts.length >= 2 ? { pts: pts.map(([t0, v]) => [(t0 - pts[0][0]) / 3600e3, v]), c: tone, ref: mb } : undefined,
      chart: { title: '편별 조회 — 세로 선이 가설 시작', xt: 'date', y: 'n', series: [{ name: '편별 조회', c: tone, pts }], marks: since ? [{ x: since, label: '시작' }] : [],
        guides: [mb && { y: mb, label: `전 중앙 ${fmt(mb)}`, c: 'muted' }, ma != null && { y: ma, label: `후 중앙 ${fmt(ma)}`, c: tone }].filter(Boolean), empty: '최근 60일 공개 편이 없습니다.' },
      blocks: [{ title: '가설', kv: [['바꾼 것', h.changed], ['판정', '시작 전·후 편당 조회 중앙값: 1.3배+ 맞아가는 중 · 0.9배 미만 나쁨'], ['성공 기준', h.success || '미정'], ['맡은 세션', h.owner_session]], quote: h.confidence === 'low' ? '이 가설 줄은 문서에서 확실히 찾지 못한 초안 — 맡은 세션이 확인할 것' : null }],
      session: h.owner_session,
    };
  }).sort((a, b) => ({ ok: 0, bad: 1, warn: 2, busy: 3, muted: 4 }[a.tone] - ({ ok: 0, bad: 1, warn: 2, busy: 3, muted: 4 }[b.tone])));

  return [
    { type: 'stats', items: [
      { label: '오늘 공개', value: todayAll.length, sub: `${chans.filter((x) => x.today.length).length}개 채널`, drill: { title: '오늘 공개한 편 — 누르면 반응', items: todayAll, empty: '오늘 공개한 편이 아직 없습니다.' } },
      { label: '7일 공개', value: chans.reduce((a, x) => a + x.wk.length, 0), sub: '편' },
      { label: '7일 새 편 조회', value: fmt(chans.reduce((a, x) => a + x.wkViews, 0)), sub: '지난 7일 올린 편 합' },
      { label: '구독 합계', value: fmt(sumSubs), sub: dSubs ? `7일 ${dSubs > 0 ? '+' : ''}${fmt(dSubs)}` : '추이 쌓는 중', tone: dSubs > 0 ? 'ok' : '' },
    ] },
    { type: 'list', title: '지금 거는 가설 — 맞아가고 있나', items: hypCards, compact: true, empty: '가설 장부(docs/office/hypotheses.json)가 아직 비어 있습니다.' },
    { type: 'grid', title: '채널별 업로드 — 최근 14일', cols: days.map((d) => +d.slice(8)), colTop: days.map((d) => d.slice(5, 7) + '월'),
      rows: chans.map((x) => ({ label: x.name, cells: x.perDay })), note: '칸 숫자 = 그날 공개한 편 수. 맨 오른쪽이 오늘.' },
    { type: 'list', title: '채널 — 누르면 편별 조회 그래프', items: cards, compact: true },
  ];
}

module.exports = {
  project: 'shortsott',
  title: '유튜브',
  async run() {
    const now = Date.now();
    const recs = ledger();
    const prof = profiles();
    const tasks = await scheduledTasks();
    const ypp = readJson('server/data/ypp_status.json', {});
    const metrics = (readJson('server/data/youtube_metrics.json', {}).snapshots || []).slice(-1)[0];
    const hist = readJson('server/data/youtube_upload_history.json', []);
    const gpt = [...readLines('server/output/task-logs/gpt-ask.jsonl').slice(-200)].reverse().map(parse).find((r) => r && r.limits && r.limits.primary);
    const profArr = (() => { const p = readJson('server/data/youtube_upload_profiles.json', []); return Array.isArray(p) ? p : (p.profiles || Object.values(p)); })();
    const up = await refreshUploads(profArr.filter((x) => x.channelId && x.purpose !== 'shopping_old_ssulmo').map((x) => ({ id: x.channelId, purpose: x.purpose })));
    const locks = ['politics-hour/RENDERING.lock', 'politics-hour/RENDERING-ja.lock', 'politics-hour-ja/RENDERING-ja.lock'].filter((p) => fs.existsSync(D(p)));

    // ── 콘텐츠 진행표 ──
    const recent = recs.filter((r) => Date.parse(r.finished_at || r.at || 0) > now - 14 * 864e5 || (r.publish_at && Date.parse(r.publish_at) > now));
    for (const r of recent) r.stage = stageOf(r, now);
    const stages = ['제작 중', '제작 완료', '예약', '공개'];
    const byLane = {};
    for (const r of recent) {
      const L = byLane[r.lane] ||= { session: r.session, made24: 0, rej24: 0, wait: 0, sched: 0, next: null, pub7: 0, last: null };
      const fin = Date.parse(r.finished_at || 0);
      if (fin > now - 864e5) L.made24++;
      if ((r.rejected || 0) && Date.parse(r.at) > now - 864e5) L.rej24 += r.rejected;
      if (r.stage === '제작 완료' || r.stage === '업로드') L.wait++;
      if (r.stage === '예약') { L.sched++; const p = Date.parse(r.publish_at); if (!L.next || p < L.next.at) L.next = { at: p, title: r.title }; }
      if (r.stage === '공개' && Date.parse(r.publish_at) > now - 7 * 864e5) L.pub7++;
      if (!L.last || fin > Date.parse(L.last.finished_at || 0)) L.last = r;
    }
    const laneRows = Object.entries(byLane).sort((a, b) => b[1].sched - a[1].sched).map(([k, L]) => [
      { text: laneName(k), sub: L.session || '' },
      { text: `${L.sched}편`, tone: !STOCK_LANES.has(k) ? '' : L.sched === 0 ? 'bad' : L.sched < 3 ? 'warn' : 'ok' },
      L.next ? { text: mdhm(L.next.at), sub: L.next.title || '' } : '—',
      L.wait ? { text: `${L.wait}편`, tone: 'warn' } : '0',
      `${L.made24} · ${L.rej24}`, `${L.pub7}편`,
    ]);
    const epRows = recent.sort((a, b) => Date.parse(b.finished_at || b.at || 0) - Date.parse(a.finished_at || a.at || 0)).slice(0, 40).map((r) => [
      { text: r.title || r.id, sub: r.id },
      laneName(r.lane),
      { text: r.stage, tone: STAGE_TONE[r.stage] },
      r.publish_at ? mdhm(Date.parse(r.publish_at)) : '—',
      r.finished_at ? mdhm(Date.parse(r.finished_at)) : '—',
      r.rejected ? { text: `${r.rejected}회`, tone: 'warn' } : '0',
    ]);

    // ── 업로드 일정 (앞으로 7일) ──
    const items = new Map();
    for (const h of Array.isArray(hist) ? hist : []) {
      const t = Date.parse(h.publishAt || ''); if (!(t > now && t < now + 7 * 864e5)) continue;
      const ch = prof.get(h.uploadProfileId);
      items.set(h.youtubeVideoId || `${h.title}|${t}`, { t, text: h.title || '(제목 없음)', who: ch ? ch.name : '채널 미상' });
    }
    for (const r of recs) {
      const t = Date.parse(r.publish_at || ''); if (!(t > now && t < now + 7 * 864e5)) continue;
      const k = r.youtube_id || `${r.title}|${t}`;
      if (!items.has(k)) items.set(k, { t, text: r.title || r.id, who: laneName(r.lane) });
    }
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d0 = kst(now + i * 864e5); const key = d0.toISOString().slice(0, 10);
      days.push({ date: key, label: `${d0.getUTCMonth() + 1}/${d0.getUTCDate()} (${DOW[d0.getUTCDay()]})${i === 0 ? ' 오늘' : ''}`,
        items: [...items.values()].filter((x) => kst(x.t).toISOString().slice(0, 10) === key).sort((a, b) => a.t - b.t)
          .map((x) => ({ time: hhmm(x.t), text: x.text, sub: x.who })) });
    }
    const todayCount = days[0].items.length;

    // ── 채널 성과 ──
    const perf = perfTable();
    const yppRows = (ypp.rows || []).map((r) => {
      const g = ypp.goal || { subs: 1000, long_hours: 4000, shorts_views: 10000000 };
      const pct = Math.max(Math.min(100, r.long_hours_365 / g.long_hours * 100), Math.min(100, r.shorts_views_90 / g.shorts_views * 100));
      return [{ text: r.name, sub: r.purpose }, fmt(r.subs), fmt(r.shorts_views_90), `${fmt(r.long_hours_365)}시간`,
        { text: `${Math.round(pct)}%`, tone: r.subs >= g.subs && pct >= 100 ? 'ok' : pct >= 30 ? 'warn' : 'muted' }];
    }).sort((a, b) => parseInt(b[4].text) - parseInt(a[4].text));
    const topVideos = metrics ? [...metrics.rows].filter((r) => r.privacy === 'public').sort((a, b) => b.viewsPerDay - a.viewsPerDay).slice(0, 10)
      .map((r) => [{ text: r.title, sub: r.locale }, fmt(r.views), `${fmt(r.viewsPerDay)}/일`, `${Math.round(r.ageDays)}일`]) : [];

    // ── 자동화 ──
    // 편마다 하나씩 만드는 SNS 게시 예약(…-ls33-ko.mp4 같은 이름)은 정기 작업과 따로 본다.
    const isPost = (t) => /\.mp4$|-local$|^midform-(facebook|naverclip|instagram|tiktok|threads)[_-]/i.test(t.n);
    const failedOf = (list) => list.filter((t) => t.s !== 'Disabled' && t.s !== 'Running' && t.l && t.r !== 0 && t.r !== 267009 && t.r !== 267011);
    const regular = tasks.filter((t) => !isPost(t));
    const posts = tasks.filter(isPost);
    const failed = failedOf(regular);
    const postFailed = failedOf(posts);
    const taskRow = (fails) => (t) => [
      t.n.replace(/^midform-/, ''),
      { text: t.s === 'Running' ? '실행 중' : t.s === 'Disabled' ? '꺼짐' : '대기', tone: t.s === 'Running' ? 'busy' : t.s === 'Disabled' ? 'muted' : '' },
      t.l ? mdhm(Date.parse(t.l)) : '—',
      fails.includes(t) ? { text: `실패 (${t.r})`, tone: 'bad' } : t.l ? { text: '정상', tone: 'ok' } : '—',
      t.x ? mdhm(Date.parse(t.x)) : '—',
    ];
    const sortFails = (fails) => (a, b) => (fails.includes(b) - fails.includes(a)) || a.n.localeCompare(b.n);
    const postRows = [...posts].sort(sortFails(postFailed)).slice(0, 60).map(taskRow(postFailed));
    const taskRows = [...regular].sort(sortFails(failed)).map((t) => [
      t.n.replace(/^midform-/, ''),
      { text: t.s === 'Running' ? '실행 중' : t.s === 'Disabled' ? '꺼짐' : '대기', tone: t.s === 'Running' ? 'busy' : t.s === 'Disabled' ? 'muted' : '' },
      t.l ? mdhm(Date.parse(t.l)) : '—',
      failed.includes(t) ? { text: `실패 (${t.r})`, tone: 'bad' } : t.l ? { text: '정상', tone: 'ok' } : '—',
      t.x ? mdhm(Date.parse(t.x)) : '—',
    ]);

    // ── 개요: 지금 확인할 것 ──
    // 카드를 누르면 detail(설명)·rec(추천)이 펼쳐지고, session(세션 이름)이 있으면 [세션 열기]가 붙는다.
    const todo = [];
    const tname = (t) => t.n.replace(/^midform-/, '');
    for (const [k, L] of Object.entries(byLane)) if (STOCK_LANES.has(k) && L.sched === 0) {
      const lastPub = recent.filter((r) => r.lane === k && r.stage === '공개').sort((a, b) => Date.parse(b.publish_at) - Date.parse(a.publish_at))[0];
      todo.push({ title: `${laneName(k)} — 장부에 예약된 편 없음`, sub: L.wait ? `완성됐지만 일정 없는 편 ${L.wait}개` : '다음에 공개할 편이 없습니다', tone: 'warn',
        detail: `앞으로 공개될 편이 제작 장부에 없습니다. 마지막 공개: ${lastPub ? `${mdhm(Date.parse(lastPub.publish_at))} «${lastPub.title || lastPub.id}»` : '최근 14일 없음'}. 24시간 제작 ${L.made24}편.`
          + (L.wait ? ` 완성 편 ${L.wait}개가 슬롯을 기다리는 중이라, 예약만 걸면 재고가 됩니다.` : ' 장부 밖에서 예약했다면 그 레인이 장부에 publish_at 을 안 적은 것입니다.'),
        rec: L.wait ? '완성 편을 다음 슬롯에 예약' : '레인 세션에 다음 편 제작 시작 지시', session: LANE_SESSIONS[k] });
    }
    for (const [k, L] of Object.entries(byLane)) if (L.wait > 0 && !(STOCK_LANES.has(k) && L.sched === 0)) {
      const ids = recent.filter((r) => r.lane === k && (r.stage === '제작 완료' || r.stage === '업로드')).map((r) => r.id).slice(0, 6);
      todo.push({ title: `${laneName(k)} 완성 편 ${L.wait}개 — 공개 일정 없음`, sub: ids.join(' · '), tone: 'warn',
        detail: `제작은 끝났는데 공개 예약이 없는 편: ${ids.join(', ')}. 슬롯 대기 중이거나, 검수에서 멈췄거나, 버린 편일 수 있습니다.`,
        rec: '올릴 편은 예약, 버린 편은 장부에 retracted 표시', session: LANE_SESSIONS[k] });
    }
    if (failed.length) todo.push({ title: `자동화 실패 ${failed.length}건`, sub: failed.slice(0, 4).map(tname).join(' · '), tone: 'bad',
      detail: '정기 작업 마지막 실행이 실패로 끝났습니다: ' + failed.map((t) => `${tname(t)}(${t.l ? mdhm(Date.parse(t.l)) : '?'}, 코드 ${t.r})`).join(', ') + '. 자세한 표는 «자동화» 탭.',
      rec: '도구개발 세션에 실패 원인 확인 맡기기 — 매일 도는 작업부터', session: 'YTHOME-M-도구개발' });
    if (postFailed.length) todo.push({ title: `SNS 게시 실패 ${postFailed.length}건`, sub: postFailed.slice(0, 3).map(tname).join(' · '), tone: 'warn',
      detail: '편별 SNS 게시 예약(페이스북·네이버 클립 등)이 실패했습니다: ' + postFailed.slice(0, 10).map(tname).join(', ') + (postFailed.length > 10 ? ' 외' : '') + '.',
      rec: '계정 로그인·차단 여부부터 확인, 같은 채널이 몰려 있으면 그 계정 문제', session: 'YTHOME-M-HEAD' });
    if (locks.length) todo.push({ title: '정치 렌더 진행 중', sub: '이 시간에는 무거운 작업·재부팅을 피합니다', tone: 'busy',
      detail: `렌더 락: ${locks.join(', ')}. 18:30~00:30 정치 렌더 시간에는 다른 레인의 렌더·STT·대량 작업과 PC 재부팅을 피합니다.`,
      rec: '끝날 때까지 기다리기', session: 'YTHOME-LF-KO 정치' });

    const all = recent;
    return {
      title: '유튜브',
      updated_at: new Date(now).toISOString(),
      tabs: [
        { key: 'glance', label: '한눈에', sections: glance(up, now) },
        { key: 'overview', label: '개요', sections: [
          { type: 'stats', items: [
            { label: '오늘 공개 예정', value: todayCount, sub: '편' },
            { label: '예약 재고', value: all.filter((r) => r.stage === '예약').length, sub: '앞으로 공개될 편' },
            { label: '24시간 제작', value: Object.values(byLane).reduce((a, L) => a + L.made24, 0), sub: `반려 ${Object.values(byLane).reduce((a, L) => a + L.rej24, 0)}회` },
            { label: '자동화 실패', value: failed.length, tone: failed.length ? 'bad' : 'ok', sub: `정기 작업 ${regular.length}개 중` },
            { label: 'GPT 주간 한도', value: gpt ? `${gpt.limits.primary.used_pct}%` : '—', sub: gpt && gpt.limits.primary.resets_at ? `리셋 ${mdhm(Date.parse(gpt.limits.primary.resets_at))}` : '' },
          ] },
          { type: 'list', title: '지금 확인할 것', empty: '확인할 것이 없습니다.', items: todo },
          { type: 'pipeline', title: '최근 14일 편 흐름', stages: stages.map((s) => ({ label: s, count: all.filter((r) => r.stage === s || (s === '제작 완료' && r.stage === '업로드')).length })) },
        ] },
        { key: 'content', label: '콘텐츠 진행표', sections: [
          { type: 'pipeline', title: '편 흐름 (최근 14일 + 예약)', stages: stages.map((s) => ({ label: s, count: all.filter((r) => r.stage === s || (s === '제작 완료' && r.stage === '업로드')).length })) },
          { type: 'table', title: '레인별', columns: ['레인', '예약 재고', '다음 공개', '공개 대기 완성편', '24시간 제작·반려', '7일 공개'], rows: laneRows },
          { type: 'table', title: '최근 편', columns: ['편', '레인', '단계', '공개', '완성', '반려'], rows: epRows,
            note: '제작 장부(production_ledger)에 적힌 편만 보입니다. 장부에 안 적는 레인은 여기 안 잡힙니다.' },
        ] },
        { key: 'perf', label: '채널 성과', sections: [
          perf ? perfSection(perf) : { type: 'note', text: '성과 보고가 아직 없습니다.' },
          { type: 'table', title: '수익 창출 조건 진행', columns: ['채널', '구독', '쇼츠 90일 조회', '롱폼 365일 시청', '진행'], rows: yppRows },
          { type: 'table', title: `조회 빠른 편 (영화 해설, ${metrics ? mdhm(Date.parse(metrics.at)) : '—'} 기준)`, columns: ['편', '조회', '하루 조회', '경과'], rows: topVideos },
        ] },
        { key: 'schedule', label: '업로드 일정', sections: [
          { type: 'calendar', title: '앞으로 7일 예약 공개', days },
        ] },
        { key: 'auto', label: '자동화', sections: [
          { type: 'stats', items: [
            { label: '예약 작업', value: tasks.length },
            { label: '실패', value: failed.length, tone: failed.length ? 'bad' : 'ok' },
            { label: '렌더', value: locks.length ? '진행 중' : '없음', tone: locks.length ? 'busy' : '' },
            { label: 'GPT 주간 한도', value: gpt ? `${gpt.limits.primary.used_pct}%` : '—' },
          ] },
          { type: 'table', title: '정기 작업 (실패가 위)', columns: ['작업', '상태', '마지막 실행', '결과', '다음 실행'], rows: taskRows },
          { type: 'table', title: `SNS 게시 예약 ${posts.length}건 · 실패 ${postFailed.length}`, columns: ['작업', '상태', '마지막 실행', '결과', '다음 실행'], rows: postRows,
            note: posts.length > 60 ? '실패가 위, 60건까지만 보입니다.' : undefined },
        ] },
      ],
    };
  },
};

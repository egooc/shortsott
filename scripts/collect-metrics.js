// 내보낸 편들이 실제로 어떻게 됐는지 읽어 온다. 스냅숏을 쌓아 «늘어난 양»까지 본다.
//
//   node scripts/collect-metrics.js [--json] [--top 15]
//
// 왜 (2026-09-22)
//   유튜브 26편·소셜 90건을 내보내 놓고 **조회수를 읽는 것이 하나도 없었다.**
//   무엇이 먹혔는지 모르는 채로 계속 만들고 있었다. 원고를 어느 쪽으로 조일지
//   정하려면 근거가 있어야 한다.
//
// 무엇을 읽나
//   · videos.list part=statistics — 조회·좋아요·댓글. **지금 토큰으로 바로 된다.**
//   · youtubeAnalytics.reports — 평균 시청 지속시간·유지율. 두 가지가 더 필요하다:
//       ① Google Cloud 프로젝트에서 YouTube Analytics API 사용 설정
//       ② 토큰에 yt-analytics.readonly 스코프 추가 후 재인증(scripts/yt-reauth.js)
//     안 되어 있으면 그 사실만 적고 공개 통계로 계속 간다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch { /* 환경에서 온다 */ }

const YT_STATE = path.join(ROOT, 'server', 'data', 'auto_publish_state.json');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const METRICS = path.join(ROOT, 'server', 'data', 'youtube_metrics.json');
const REPORTS = path.join(ROOT, 'server', 'output', 'metrics-reports');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const topN = Number(arg('--top', '15'));

async function accessToken(p) {
  const body = new URLSearchParams({
    client_id: p.oauthClientId, client_secret: p.oauthClientSecret,
    refresh_token: p.refreshToken, grant_type: 'refresh_token'
  });
  const d = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body })).json();
  if (!d.access_token) throw new Error(`토큰 갱신 실패: ${JSON.stringify(d).slice(0, 140)}`);
  return d;
}

// 유지율은 Analytics API 가 열려 있을 때만 온다. 안 열려 있으면 이유를 돌려준다.
async function retention(token, ids) {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const u = 'https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE'
    + `&startDate=${start}&endDate=${end}`
    + '&metrics=views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage'
    + `&dimensions=video&filters=video%3D%3D${ids.slice(0, 200).join('%2C')}&maxResults=200`;
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const t = await r.text();
    const needEnable = /has not been used in project|is disabled/.test(t);
    const needScope = /insufficient|scope/i.test(t);
    return { ok: false, why: needEnable ? 'API 미사용 설정' : needScope ? '스코프 부족' : `HTTP ${r.status}`, detail: t.slice(0, 300) };
  }
  const j = await r.json();
  const cols = (j.columnHeaders || []).map((c) => c.name);
  const out = {};
  for (const row of j.rows || []) {
    const o = {}; cols.forEach((c, i) => { o[c] = row[i]; });
    out[o.video] = o;
  }
  return { ok: true, rows: out };
}

async function main() {
  const state = readJson(YT_STATE, { history: [] });
  const entries = (state.history || []).filter((h) => h.url);
  const raw = readJson(PROFILES, []);
  const profiles = Array.isArray(raw) ? raw : (raw.profiles || []);
  const byLocale = { ko: profiles.find((p) => p.purpose === 'ko_highlight'), ja: profiles.find((p) => p.purpose === 'jp_highlight') };

  const now = new Date().toISOString();
  const rows = [];
  const notes = [];

  for (const [locale, profile] of Object.entries(byLocale)) {
    const mine = entries.filter((h) => h.locale === locale);
    const ids = [...new Set(mine.map((h) => (/[?&]v=([\w-]+)/.exec(h.url) || [])[1]).filter(Boolean))];
    if (!ids.length || !profile) continue;
    let tok;
    try { tok = (await accessToken(profile)).access_token; }
    catch (e) { notes.push(`[${locale}] ${e.message}`); continue; }

    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const r = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet,status,contentDetails&id=${batch.join(',')}`,
        { headers: { Authorization: `Bearer ${tok}` } });
      const j = await r.json();
      for (const it of j.items || []) {
        const e = mine.find((h) => h.url.includes(it.id)) || {};
        const s = it.statistics || {};
        const iso = ((it.contentDetails || {}).duration || '').match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
        rows.push({
          locale, videoId: it.id, draft: e.draft || '',
          title: (it.snippet || {}).title || '',
          privacy: (it.status || {}).privacyStatus || '',
          publishedAt: (it.snippet || {}).publishedAt || e.publishAt || '',
          durationSec: iso ? Number(iso[1] || 0) * 60 + Number(iso[2] || 0) : null,
          views: Number(s.viewCount || 0), likes: Number(s.likeCount || 0), comments: Number(s.commentCount || 0)
        });
      }
    }

    const ret = await retention(tok, ids);
    if (ret.ok) {
      for (const r2 of rows.filter((x) => x.locale === locale)) {
        const a = ret.rows[r2.videoId];
        if (a) { r2.avgViewSec = a.averageViewDuration; r2.avgViewPct = a.averageViewPercentage; }
      }
    } else if (!notes.some((n) => n.includes('유지율'))) {
      notes.push(`유지율을 못 읽었다 (${ret.why}). 공개 통계만으로 진행한다.`);
      if (ret.why === 'API 미사용 설정') {
        notes.push('  → Google Cloud 콘솔에서 YouTube Analytics API 를 켜고, 토큰에 yt-analytics.readonly 를 붙여 재인증하면 된다.');
      }
    }
  }

  // 스냅숏을 쌓는다. 다음 실행 때 «늘어난 양»을 보려면 이전 값이 필요하다.
  const store = readJson(METRICS, { snapshots: [] });
  const prev = (store.snapshots || [])[store.snapshots.length - 1];
  const prevBy = {};
  for (const r of (prev || {}).rows || []) prevBy[r.videoId] = r;
  for (const r of rows) {
    const p = prevBy[r.videoId];
    if (p) { r.dViews = r.views - p.views; }
    const age = r.publishedAt ? (Date.now() - Date.parse(r.publishedAt)) / 864e5 : null;
    r.ageDays = age && age > 0 ? Number(age.toFixed(1)) : null;
    r.viewsPerDay = r.ageDays ? Math.round(r.views / r.ageDays) : null;
  }
  store.snapshots = [...(store.snapshots || []), { at: now, rows }].slice(-60);
  fs.mkdirSync(path.dirname(METRICS), { recursive: true });
  fs.writeFileSync(METRICS, JSON.stringify(store, null, 2));

  if (process.argv.includes('--json')) { console.log(JSON.stringify({ at: now, rows, notes }, null, 2)); return; }

  const lines = [`# 성과 ${new Date().toLocaleString('ko-KR')}`, ''];
  for (const n of notes) lines.push(`_${n}_`);
  if (notes.length) lines.push('');
  const total = rows.reduce((a, r) => a + r.views, 0);
  lines.push(`공개된 편 ${rows.filter((r) => r.privacy === 'public').length}편 · 누적 조회 **${total.toLocaleString()}회**`
    + (prev ? ` · 직전 스냅숏 대비 +${rows.reduce((a, r) => a + (r.dViews || 0), 0).toLocaleString()}회` : ''), '');
  lines.push('## 조회순', '', '| 조회 | /일 | 증감 | 길이 | 로케일 | 제목 |', '|---:|---:|---:|---:|:--|:--|');
  for (const r of [...rows].sort((a, b) => b.views - a.views).slice(0, topN)) {
    lines.push(`| ${r.views.toLocaleString()} | ${r.viewsPerDay ?? '-'} | ${r.dViews != null ? (r.dViews >= 0 ? '+' : '') + r.dViews : '-'} `
      + `| ${r.durationSec ?? '-'}s | ${r.locale} | ${r.title.slice(0, 34)} |`);
  }
  const dead = rows.filter((r) => r.privacy === 'public' && r.ageDays >= 1 && r.views < 30);
  if (dead.length) {
    lines.push('', `## 하루 넘게 30회 미만 ${dead.length}편`, '');
    for (const r of dead) lines.push(`- [${r.locale}] ${r.views}회 · ${r.ageDays}일 · ${r.title.slice(0, 40)}`);
  }
  const text = lines.join('\n');
  console.log(text);
  fs.mkdirSync(REPORTS, { recursive: true });
  const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  fs.writeFileSync(path.join(REPORTS, `${stamp}-metrics.md`), `${text}\n`, 'utf8');
}

main().catch((e) => { console.error('collect-metrics fatal:', e.message || e); process.exitCode = 1; });

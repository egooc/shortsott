// 시청 지속 곡선(카이안 K9, 10-20 관리자 큐) — YouTube Analytics API audienceRetention(elapsedVideoTimeRatio 1%씩 100점).
//
//   node scripts/retention_curve.js <videoId> [<videoId> ...] --purpose politics|politics_ja|idol_fantube_ko|jp_highlight|ko_highlight
//   node scripts/retention_curve.js <videoId> --token <profile.json 경로> [--purpose …]     (기본 server/data/youtube_upload_profiles.json)
//   node scripts/retention_curve.js <쇼츠 id> ... --purpose idol_fantube_ko --shorts            쇼츠 본 비율(engagedViews/views, K10)
//
// 잰다: 1·2·5·10·25·50% 지점 시청 비율 · 첫 2% 이탈폭 · 가장 큰 1% 낙폭(어디서) · 되감기 구간(audienceWatchRatio 가 앞 점보다 오르는 곳)
//       · 상대 지속(relativeRetentionPerformance, 비슷한 길이 영상 대비 0~1) 중앙값.
// 출력: server/data/retention/<id>.json. 읽기 전용(yt-analytics.readonly) — 업로드·수정 없음. 키·토큰 값은 찍지 않는다.
// import(manager-report): const { retention, summarize } = require('./retention_curve');  await retention(id, { purpose }) → 요약
// 공개 2~3일 안 영상은 Analytics 집계가 비어 있을 수 있다 → «집계 전»으로 돌려준다(실패 아님).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'server', 'data', 'retention');
const LEDGER = path.join(ROOT, 'server', 'data', 'gate_errors.jsonl');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');

async function accessToken(purpose, tokenPath = PROFILES) {
  const { OAuth2Client } = require(path.join(ROOT, 'node_modules', 'google-auth-library'));
  const store = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  const p = (store.profiles || [store]).find((x) => !purpose || x.purpose === purpose);
  if (!p || !p.refreshToken) throw new Error(`프로필 없음/토큰 없음: ${purpose || '(첫 프로필)'}`);
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  return { token: (await c.getAccessToken()).token, channelId: p.channelId };
}

function summarize(rows) {
  // rows: [[ratio(0.01~1.0), watchRatio, relPerf], …]
  if (!rows.length) return null;
  const at = (x) => { const r = rows.reduce((a, b) => (Math.abs(b[0] - x) < Math.abs(a[0] - x) ? b : a)); return Math.round(r[1] * 1000) / 10; };
  let big = { raw: 0, drop: 0, at: null };
  const rewinds = [];
  for (let i = 1; i < rows.length; i++) {
    const d = rows[i - 1][1] - rows[i][1];
    if (d > big.raw) big = { raw: d, drop: Math.round(d * 1000) / 10, at: Math.round(rows[i][0] * 100) };
    if (rows[i][1] > rows[i - 1][1] + 0.005) rewinds.push(Math.round(rows[i][0] * 100));
  }
  // 이어진 되감기 점은 구간으로 묶는다
  const seg = [];
  for (const p of rewinds) { const s = seg[seg.length - 1]; if (s && p - s[1] <= 1) s[1] = p; else seg.push([p, p]); }
  const rel = rows.map((r) => r[2]).filter((x) => x != null).sort((a, b) => a - b);
  return {
    at_pct: { 1: at(0.01), 2: at(0.02), 5: at(0.05), 10: at(0.1), 25: at(0.25), 50: at(0.5) },
    first2_drop: Math.round((rows[0][1] - (rows.find((r) => r[0] >= 0.02) || rows[0])[1]) * 1000) / 10,
    largest_1pct_drop: { drop: big.drop, at: big.at },
    rewind_segments: seg.map(([a, b]) => (a === b ? `${a}%` : `${a}~${b}%`)),
    relative_median: rel.length ? Math.round(rel[Math.floor(rel.length / 2)] * 100) / 100 : null,
  };
}

async function retention(id, { purpose, tokenPath, token } = {}) {
  const auth = token ? { token } : await accessToken(purpose, tokenPath);
  const q = new URLSearchParams({ ids: 'channel==MINE', startDate: '2020-01-01', endDate: new Date().toISOString().slice(0, 10),
    metrics: 'audienceWatchRatio,relativeRetentionPerformance', dimensions: 'elapsedVideoTimeRatio', filters: `video==${id}` });
  const r = await fetch(`https://youtubeanalytics.googleapis.com/v2/reports?${q}`, { headers: { Authorization: `Bearer ${auth.token}` } });
  const j = await r.json().catch(() => ({}));
  if (r.status === 403 || r.status === 429) { const e = new Error(`Analytics ${r.status} ${(j.error && j.error.message || '').slice(0, 120)}`); e.stop = true; throw e; }
  if (!r.ok) throw new Error(`Analytics ${r.status} ${(j.error && j.error.message || '').slice(0, 120)}`);
  const rows = (j.rows || []).map((x) => [x[0], x[1], x[2]]);
  const res = { at: new Date().toISOString(), id, purpose: purpose || null, points: rows.length, summary: summarize(rows), rows, status: rows.length ? 'ok' : '집계 전(공개 2~3일 안이거나 조회 부족)' };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(res, null, 2) + '\n', 'utf8');
  return res;
}

// 쇼츠 «본 vs 넘김»(카이안 K10, 10-20 확인): 스튜디오의 «시청함/넘김» 비율 자체는 API 에 없다. 대신 views(재생 시작·반복 포함, 2025-03 개편)와
// engagedViews(몇 초 이상 본 조회 = 옛 조회수)가 있어 engagedViews/views 를 «본 비율» 근사로 쓴다. 평균 시청 비율·시간도 같이.
//   const { shortsStay } = require('./retention_curve'); await shortsStay(['id1','id2'], { purpose: 'idol_fantube_ko' })
async function shortsStay(ids, { purpose, tokenPath, token, start = '2020-01-01' } = {}) {
  const auth = token ? { token } : await accessToken(purpose, tokenPath);
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const q = new URLSearchParams({ ids: 'channel==MINE', startDate: start, endDate: new Date().toISOString().slice(0, 10),
      metrics: 'views,engagedViews,averageViewPercentage,averageViewDuration', dimensions: 'video', filters: `video==${ids.slice(i, i + 200).join(',')}` });
    const r = await fetch(`https://youtubeanalytics.googleapis.com/v2/reports?${q}`, { headers: { Authorization: `Bearer ${auth.token}` } });
    const j = await r.json().catch(() => ({}));
    if (r.status === 403 || r.status === 429) { const e = new Error(`Analytics ${r.status}`); e.stop = true; throw e; }
    if (!r.ok) throw new Error(`Analytics ${r.status} ${(j.error && j.error.message || '').slice(0, 120)}`);
    for (const [id, views, engaged, avp, avd] of j.rows || []) {
      out.push({ id, views, engaged_views: engaged, stay_ratio: views ? Math.round((engaged / views) * 1000) / 10 : null, avp: Math.round(avp * 10) / 10, avd_sec: avd });
    }
  }
  return out;
}

module.exports = { retention, summarize, accessToken, shortsStay };

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
    const ids = argv.filter((a, i) => !a.startsWith('--') && !['--purpose', '--token'].includes(argv[i - 1]));
    if (!ids.length) { console.log('usage: node scripts/retention_curve.js <videoId> ... --purpose <프로필 purpose> [--token profile.json]'); process.exit(2); }
    let auth;
    try { auth = await accessToken(opt('--purpose'), opt('--token')); } catch (e) { console.log(`⚠ 토큰 실패: ${e.message}`); process.exit(5); }
    if (argv.includes('--shorts')) {   // 쇼츠 본 비율(engagedViews/views) 표
      try {
        for (const s of await shortsStay(ids, { token: auth.token })) console.log(`${s.id} · 조회 ${s.views} · 본 조회 ${s.engaged_views} · 본 비율 ${s.stay_ratio}% · 평균 시청 ${s.avp}% (${s.avd_sec}초)`);
      } catch (e) { console.log(`⚠ 쇼츠 본 비율 실패: ${e.message}`); process.exit(e.stop ? 9 : 5); }
      return;
    }
    for (const id of ids) {
      try {
        const r = await retention(id, { token: auth.token, purpose: opt('--purpose') });
        const s = r.summary;
        console.log(s ? `${id} · 1% ${s.at_pct[1]} · 5% ${s.at_pct[5]} · 10% ${s.at_pct[10]} · 25% ${s.at_pct[25]} · 50% ${s.at_pct[50]} · 첫 2% 이탈 ${s.first2_drop} · 최대 낙폭 ${s.largest_1pct_drop.drop}(${s.largest_1pct_drop.at}%) · 되감기 ${s.rewind_segments.join(',') || '-'} · 상대 ${s.relative_median}`
          : `${id} · ${r.status}`);
      } catch (e) {
        console.log(`⚠ ${id} 지속 곡선 실패: ${e.message}`);
        fs.appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), gate: 'retention_curve', script: id, error: e.message }) + '\n', 'utf8');
        if (e.stop) process.exit(9);
      }
    }
  })();
}

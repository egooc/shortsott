// 수익 창출(YPP) 조건 현황 — 채널 OAuth Analytics `dimensions=creatorContentType` 로 쇼츠/롱폼을 나눠 센다(관리자 ypp_split.js 정식화, 10-21).
//
//   node scripts/ypp_status.js [--purpose politics,idol_fantube_ko] [--json]
//   const { yppStatus, yppLine } = require('./ypp_status'); (await yppLine()) → 07:40 보고 §1 한 줄
//
// 조건(유튜브 기준): 구독 1,000 + 롱폼 공개 시청 4,000시간(365일) 또는 쇼츠 조회 1,000만(90일). 쇼츠 시청 시간은 롱폼 시간에 안 셈.
// 롱폼 시간 = videoOnDemand + liveStream 의 estimatedMinutesWatched. 구독 수 = Data API channels.list(mine, statistics) 1단위(채널 OAuth, 검색 아님).
// 읽기 전용. 키·토큰 값은 찍지 않는다. 403·429 는 그 자리에서 멈춘다(우회 금지). 쓸모연구소(shopping_old_ssulmo)는 늘 뺀다.
const fs = require('fs');
const path = require('path');
const { accessToken } = require('./retention_curve');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const OUT = path.join(ROOT, 'server', 'data', 'ypp_status.json');
const SKIP = new Set(['shopping_old_ssulmo']);   // 쓸모연구소는 항상 논외(소유주 10-12·10-13)
const NAMES = { politics: '쟁점브리핑', politics_ja: '国会ノート', idol_fantube_ko: '최애모먼트', ko_highlight: '지구관측소', jp_highlight: '沼落ちシネマ', shopping: '쇼핑', arabshot: '어랍숏' };
const LONG_TYPES = ['videoOnDemand', 'liveStream', 'VIDEO_ON_DEMAND', 'LIVE_STREAM'];   // API 값은 camelCase(videoOnDemand·shorts) — 10-21 실측
const GOAL = { subs: 1000, long_hours: 4000, shorts_views: 10000000 };

class Stop extends Error {}

async function getJson(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (r.status === 403 || r.status === 429) throw new Stop(`${r.status} ${(j.error && j.error.message || '').slice(0, 80)}`);
  if (!r.ok) throw new Error(`${r.status} ${(j.error && j.error.message || '').slice(0, 80)}`);
  return j;
}

async function byType(token, days) {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const q = new URLSearchParams({ ids: 'channel==MINE', startDate: start, endDate: end, metrics: 'views,estimatedMinutesWatched', dimensions: 'creatorContentType' });
  const j = await getJson(`https://youtubeanalytics.googleapis.com/v2/reports?${q}`, token);
  const o = {};
  for (const [type, views, minutes] of j.rows || []) o[type] = { views, hours: Math.round(minutes / 60) };
  return o;
}

async function yppStatus({ purposes } = {}) {
  const store = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  const profiles = (Array.isArray(store) ? store : store.profiles || []).filter((p) => !SKIP.has(p.purpose) && (!purposes || purposes.includes(p.purpose)));
  const rows = [];
  for (const p of profiles) {
    const row = { purpose: p.purpose, name: NAMES[p.purpose] || p.purpose };
    try {
      const { token } = await accessToken(p.purpose);
      const [y, n] = [await byType(token, 365), await byType(token, 90)];
      const ch = await getJson('https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true', token);
      const st = (ch.items && ch.items[0] && ch.items[0].statistics) || {};
      Object.assign(row, {
        subs: st.hiddenSubscriberCount ? null : +st.subscriberCount || 0,
        long_hours_365: LONG_TYPES.reduce((s, t) => s + ((y[t] && y[t].hours) || 0), 0),
        shorts_views_90: ((n.shorts || n.SHORTS || {}).views) || 0,
        shorts_hours_365: ((y.shorts || y.SHORTS || {}).hours) || 0,
        by_type_365: y, by_type_90: n,
      });
    } catch (e) {
      if (e instanceof Stop) { row.error = `멈춤 ${e.message}`; rows.push(row); break; }
      row.error = e.message.slice(0, 100);
    }
    rows.push(row);
  }
  const res = { at: new Date().toISOString(), goal: GOAL, rows };
  try { fs.writeFileSync(OUT, JSON.stringify(res, null, 2) + '\n', 'utf8'); } catch {}
  return res;
}

const pct = (a, b) => `${Math.min(100, Math.round((100 * a) / b))}%`;

function formatLine(res) {
  return 'YPP — ' + res.rows.map((r) => (r.error ? `${r.name} ⚠${r.error}` :
    `${r.name} 구독 ${r.subs == null ? '비공개' : r.subs.toLocaleString()}(${r.subs == null ? '?' : pct(r.subs, GOAL.subs)}) · 롱폼 365일 ${r.long_hours_365.toLocaleString()}h(${pct(r.long_hours_365, GOAL.long_hours)}) · 쇼츠 90일 ${r.shorts_views_90.toLocaleString()}회(${pct(r.shorts_views_90, GOAL.shorts_views)})`)).join(' / ');
}

async function yppLine(opts) { return formatLine(await yppStatus(opts)); }

module.exports = { yppStatus, yppLine, formatLine, GOAL };

if (require.main === module) {
  const a = process.argv.slice(2);
  const purposes = a.includes('--purpose') ? a[a.indexOf('--purpose') + 1].split(',') : undefined;
  yppStatus({ purposes }).then((r) => console.log(a.includes('--json') ? JSON.stringify(r, null, 2) : formatLine(r).replace(/ \/ /g, '\n'))).catch((e) => { console.error(`멈춤: ${e.message}`); process.exit(1); });
}

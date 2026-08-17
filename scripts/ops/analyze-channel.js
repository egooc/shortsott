// Structural read of any public channel, in the same terms we measure our own.
//
// Three questions, each needing different numbers:
//   material  - which subjects actually carry, judged by the outlier tail
//   format    - length, title shape, shorts/long mix
//   growth    - cadence, series, how concentrated the views are
//
// What is NOT here, and cannot be: retention, click-through, traffic sources.
// Those are owner-only. Anything about hooks or pacing is inference from the
// view spread, not measurement, and is labelled as such.
//
//   node scripts/ops/analyze-channel.js <channelId|url|@handle> [--limit 50] [--json]
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { OAuth2Client } = require(path.join(ROOT, 'node_modules', 'google-auth-library'));

const target = process.argv[2] || '';
const limitIdx = process.argv.indexOf('--limit');
const limit = limitIdx > -1 ? Number(process.argv[limitIdx + 1]) : 50;
if (!target) {
  console.log('사용법: node scripts/ops/analyze-channel.js <channelId|url|@handle> [--limit 50]');
  process.exitCode = 1;
  return;
}

function anyProfile() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json'), 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.profiles || []);
  return list.find((p) => p.refreshToken && p.oauthClientId) || null;
}

function parseTarget(value) {
  const v = String(value).trim();
  let m = v.match(/channel\/(UC[A-Za-z0-9_-]{20,})/);
  if (m) return { id: m[1] };
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(v)) return { id: v };
  m = v.match(/@([A-Za-z0-9._-]+)/);
  if (m) return { handle: m[1] };
  return { handle: v.replace(/^\/+/, '') };
}

const isoToSec = (iso) => {
  const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
};
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '-');

(async () => {
  const profile = anyProfile();
  if (!profile) { console.log('연결된 프로필이 없어 API를 쓸 수 없습니다.'); process.exitCode = 1; return; }
  const client = new OAuth2Client(profile.oauthClientId, profile.oauthClientSecret, profile.oauthRedirectUri);
  client.setCredentials({ refresh_token: profile.refreshToken });
  const tok = await client.getAccessToken();
  const headers = { Authorization: `Bearer ${typeof tok === 'string' ? tok : tok?.token}` };
  const api = async (url) => (await fetch(`https://www.googleapis.com/youtube/v3/${url}`, { headers })).json();

  const t = parseTarget(target);
  const chRes = t.id
    ? await api(`channels?part=snippet,statistics,contentDetails,brandingSettings&id=${t.id}`)
    : await api(`channels?part=snippet,statistics,contentDetails,brandingSettings&forHandle=${encodeURIComponent(t.handle)}`);
  const ch = chRes.items?.[0];
  if (!ch) { console.log(`채널을 찾지 못했습니다: ${target}\n${JSON.stringify(chRes).slice(0, 200)}`); process.exitCode = 1; return; }

  const st = ch.statistics || {};
  const subs = Number(st.subscriberCount || 0);
  const totalViews = Number(st.viewCount || 0);
  const videoCount = Number(st.videoCount || 0);

  console.log(`=== ${ch.snippet.title} ===`);
  console.log(`개설 ${String(ch.snippet.publishedAt).slice(0, 10)} | 국가 ${ch.snippet.country || '-'} | 언어 ${ch.snippet.defaultLanguage || '-'}`);
  console.log(`구독자 ${subs.toLocaleString()} | 영상 ${videoCount.toLocaleString()} | 총조회 ${totalViews.toLocaleString()}`);
  console.log(`영상당 평균 조회 ${videoCount ? Math.round(totalViews / videoCount).toLocaleString() : '-'} | 구독자당 조회 ${subs ? (totalViews / subs).toFixed(1) : '-'}`);
  if (ch.snippet.description) console.log(`소개: ${ch.snippet.description.replace(/\s+/g, ' ').slice(0, 160)}`);

  // Recent uploads
  const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
  const items = [];
  let pageToken = '';
  while (items.length < limit) {
    const res = await api(`playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}${pageToken ? `&pageToken=${pageToken}` : ''}`);
    for (const i of res.items || []) items.push(i.contentDetails.videoId);
    pageToken = res.nextPageToken || '';
    if (!pageToken) break;
  }
  const ids = items.slice(0, limit);
  const vids = [];
  for (let i = 0; i < ids.length; i += 50) {
    const res = await api(`videos?part=snippet,statistics,contentDetails&id=${ids.slice(i, i + 50).join(',')}`);
    vids.push(...(res.items || []));
  }

  const rows = vids.map((v) => ({
    id: v.id,
    at: v.snippet.publishedAt,
    title: v.snippet.title,
    tags: v.snippet.tags || [],
    desc: v.snippet.description || '',
    sec: isoToSec(v.contentDetails?.duration),
    views: Number(v.statistics?.viewCount || 0),
    likes: Number(v.statistics?.likeCount || 0),
    comments: Number(v.statistics?.commentCount || 0)
  })).sort((a, b) => String(b.at).localeCompare(String(a.at)));

  if (!rows.length) { console.log('영상 없음'); return; }

  // ---- growth: cadence and how concentrated the views are
  const days = (new Date(rows[0].at) - new Date(rows[rows.length - 1].at)) / 86400000;
  const perDay = days > 0 ? (rows.length / days) : rows.length;
  const views = rows.map((r) => r.views).sort((a, b) => a - b);
  const median = views[Math.floor(views.length / 2)];
  const sum = views.reduce((s, v) => s + v, 0);
  const top10 = views.slice(-Math.max(1, Math.round(views.length * 0.1))).reduce((s, v) => s + v, 0);
  const overMedian3x = rows.filter((r) => r.views > median * 3).length;

  console.log(`\n[성장 구조] 최근 ${rows.length}편, ${days.toFixed(0)}일`);
  console.log(`  발행 ${perDay.toFixed(2)}편/일 | 중앙값 ${median.toLocaleString()} | 평균 ${Math.round(sum / rows.length).toLocaleString()}`);
  console.log(`  상위 10%가 전체 조회의 ${pct(top10, sum)} | 중앙값 3배 초과 ${overMedian3x}편 (${pct(overMedian3x, rows.length)})`);
  const hours = {};
  rows.forEach((r) => { const h = new Date(r.at).getUTCHours(); hours[h] = (hours[h] || 0) + 1; });
  const topHours = Object.entries(hours).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([h, n]) => `${h}시UTC(${n})`);
  console.log(`  주요 발행 시각: ${topHours.join(' ')}`);

  // ---- format: length mix and title shape
  const shorts = rows.filter((r) => r.sec <= 60);
  const mid = rows.filter((r) => r.sec > 60 && r.sec <= 600);
  const long = rows.filter((r) => r.sec > 600);
  const avg = (a) => (a.length ? Math.round(a.reduce((s, r) => s + r.views, 0) / a.length) : 0);
  console.log(`\n[포맷] 쇼츠(<=60s) ${shorts.length}편 평균 ${avg(shorts).toLocaleString()} | 중간(1-10분) ${mid.length}편 평균 ${avg(mid).toLocaleString()} | 롱폼(>10분) ${long.length}편 평균 ${avg(long).toLocaleString()}`);
  const lens = rows.map((r) => r.sec).sort((a, b) => a - b);
  console.log(`  길이 중앙값 ${lens[Math.floor(lens.length / 2)]}초 (최소 ${lens[0]} / 최대 ${lens[lens.length - 1]})`);

  const has = (re) => rows.filter((r) => re.test(r.title)).length;
  console.log(`  제목: 평균 ${Math.round(rows.reduce((s, r) => s + r.title.length, 0) / rows.length)}자 | 물음표 ${pct(has(/[?？]/), rows.length)} | 감탄사 ${pct(has(/[!！]/), rows.length)} | 숫자 ${pct(has(/\d/), rows.length)} | 해시태그 ${pct(has(/#/), rows.length)}`);
  const withTags = rows.filter((r) => r.tags.length).length;
  console.log(`  태그 사용 ${pct(withTags, rows.length)} | 설명 평균 ${Math.round(rows.reduce((s, r) => s + r.desc.length, 0) / rows.length)}자`);

  // ---- material: what the outliers are about
  const top = rows.slice().sort((a, b) => b.views - a.views).slice(0, 10);
  console.log('\n[소재 - 상위 10편]');
  top.forEach((r) => console.log(`  ${String(r.views).padStart(9)}회 ${String(Math.round(r.sec)).padStart(4)}초 | ${r.title.slice(0, 58)}`));
  const bottom = rows.slice().sort((a, b) => a.views - b.views).slice(0, 5);
  console.log('[소재 - 하위 5편]');
  bottom.forEach((r) => console.log(`  ${String(r.views).padStart(9)}회 ${String(Math.round(r.sec)).padStart(4)}초 | ${r.title.slice(0, 58)}`));

  // Word frequency across titles, weighted by views - crude but it surfaces the
  // subjects the tail is actually made of.
  const stop = new Set(['the', 'a', 'an', 'of', 'in', 'to', 'and', 'is', 'for', 'how', 'with', 'this', 'that', 'on', 'it', 'you', 'are', 'from', 'by', 'at', 'be']);
  const freq = new Map();
  for (const r of rows) {
    const words = r.title.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
    for (const w of new Set(words)) {
      if (stop.has(w)) continue;
      const cur = freq.get(w) || { n: 0, views: 0 };
      cur.n += 1; cur.views += r.views;
      freq.set(w, cur);
    }
  }
  const byViews = [...freq.entries()].filter(([, v]) => v.n >= 2).sort((a, b) => (b[1].views / b[1].n) - (a[1].views / a[1].n)).slice(0, 12);
  console.log('\n[제목 키워드 - 편당 평균 조회 상위, 2회 이상 등장]');
  byViews.forEach(([w, v]) => console.log(`  ${w.padEnd(16)} ${v.n}편 평균 ${Math.round(v.views / v.n).toLocaleString()}회`));

  if (process.argv.includes('--json')) {
    fs.writeFileSync(path.join(ROOT, 'server', 'output', `channel-analysis-${ch.id}.json`), `${JSON.stringify({ channel: ch, rows }, null, 2)}\n`, 'utf8');
    console.log(`\nJSON: server/output/channel-analysis-${ch.id}.json`);
  }
})().catch((e) => console.error('FAILED', String(e.message || e).slice(0, 300)));

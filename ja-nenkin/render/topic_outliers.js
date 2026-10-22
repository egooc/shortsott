// 연금 JA 주제 레퍼런스 — 비슷한 연금 롱폼 채널에서 «그 채널 롱폼 조회 중앙값 ×3 이상» 터진 편과 그 길이를 뽑는다
// (소유주 10-22: 주제는 터진 편 레퍼런스 확인 뒤, 길이 기본 10분·8분 미만 금지·레퍼런스가 20분+면 그 길이).
// 발굴용 키(.env YOUTUBE_API_KEY_SEARCH), 쿼터 장부 scripts/api_quota.js(도구명 discovery_search).
//
//   node ja-nenkin/render/topic_outliers.js [--queries "年金 手取り,..."] [--ratio 3] [--max-channels 15]
//
// 채널 찾기: search.list(롱폼·JP·ja) 검색어마다 50편 → 2편 이상 걸린 채널(+ topic_channels.json 의 고정 목록).
// 채널마다 업로드 목록 최근 100편 → 8분+ 롱폼, 공개 72시간 안 편은 기준에서 뺌, 롱폼 5편 미만 채널은 버림.
// 출력: ja-nenkin/topic_outliers.json = {at, units, channels:[{id,title,subs,long_n,median}], outliers:[{channel,video_id,title,views,ratio,dur_min,published}]}
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const LANE = path.join(ROOT, 'ja-nenkin');
const quota = require(path.join(ROOT, 'scripts', 'api_quota'));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const QUERIES = arg('--queries', '年金 確定申告,年金 住民税,年金 手取り,年金 通知書 見方,扶養親族等申告書').split(',');
const RATIO = Number(arg('--ratio', 3));
const MAXCH = Number(arg('--max-channels', 15));
let units = 0;

function apiKey() {
  const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('YOUTUBE_API_KEY_SEARCH='));
  if (!line) throw new Error('발굴용 키 없음');
  return line.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
}
async function yt(key, endpoint, params) {
  units += quota.spend('discovery_search', endpoint);
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${new URLSearchParams({ ...params, key })}`);
  if (r.status === 403 || r.status === 429) { quota.markBlocked('discovery_search', `${endpoint} ${r.status}`); throw new Error(`${endpoint} ${r.status} — 오늘은 멈춤`); }
  if (!r.ok) throw new Error(`${endpoint} ${r.status}`);
  return r.json();
}
const mins = (iso) => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '') || []; return (+(m[1] || 0)) * 60 + (+(m[2] || 0)) + (+(m[3] || 0)) / 60; };
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

(async () => {
  const key = apiKey();
  const hits = {};
  for (const q of QUERIES) {
    const r = await yt(key, 'search', { part: 'snippet', q, type: 'video', videoDuration: 'long', regionCode: 'JP', relevanceLanguage: 'ja', maxResults: 50 });
    for (const it of r.items || []) hits[it.snippet.channelId] = (hits[it.snippet.channelId] || 0) + 1;
    const r2 = await yt(key, 'search', { part: 'snippet', q, type: 'video', videoDuration: 'medium', regionCode: 'JP', relevanceLanguage: 'ja', maxResults: 50 });
    for (const it of r2.items || []) hits[it.snippet.channelId] = (hits[it.snippet.channelId] || 0) + 1;
  }
  const fixedFile = path.join(LANE, 'topic_channels.json');
  const fixed = fs.existsSync(fixedFile) ? JSON.parse(fs.readFileSync(fixedFile, 'utf8')).channels || [] : [];
  const ids = [...new Set([...fixed, ...Object.entries(hits).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([id]) => id)])].slice(0, MAXCH);
  const channels = []; const outliers = [];
  const now = Date.now();
  for (let i = 0; i < ids.length; i += 50) {
    const cr = await yt(key, 'channels', { part: 'snippet,statistics,contentDetails', id: ids.slice(i, i + 50).join(',') });
    for (const c of cr.items || []) {
      const vids = []; let page;
      for (let p = 0; p < 2; p++) {
        const pl = await yt(key, 'playlistItems', { part: 'contentDetails', playlistId: c.contentDetails.relatedPlaylists.uploads, maxResults: 50, ...(page ? { pageToken: page } : {}) });
        vids.push(...pl.items.map((x) => x.contentDetails.videoId)); page = pl.nextPageToken; if (!page) break;
      }
      const vs = [];
      for (let j = 0; j < vids.length; j += 50) {
        const vr = await yt(key, 'videos', { part: 'snippet,statistics,contentDetails', id: vids.slice(j, j + 50).join(',') });
        vs.push(...vr.items);
      }
      const longs = vs.map((v) => ({ id: v.id, title: v.snippet.title, views: +(v.statistics.viewCount || 0), dur: mins(v.contentDetails.duration), pub: v.snippet.publishedAt }))
        .filter((v) => v.dur >= 8);
      const base = longs.filter((v) => now - Date.parse(v.pub) > 72 * 36e5);
      if (base.length < 5) continue;
      const med = median(base.map((v) => v.views));
      channels.push({ id: c.id, title: c.snippet.title, subs: +(c.statistics.subscriberCount || 0), long_n: base.length, median: Math.round(med), search_hits: hits[c.id] || 0 });
      for (const v of base) if (med > 0 && v.views >= med * RATIO) outliers.push({ channel: c.snippet.title, channel_id: c.id, video_id: v.id, title: v.title, views: v.views, ratio: +(v.views / med).toFixed(1), dur_min: +v.dur.toFixed(1), published: v.pub.slice(0, 10) });
    }
  }
  outliers.sort((a, b) => b.ratio - a.ratio);
  const out = { at: new Date().toISOString(), queries: QUERIES, ratio: RATIO, units, channels, outliers };
  fs.writeFileSync(path.join(LANE, 'topic_outliers.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  const d = outliers.map((o) => o.dur_min);
  console.log(`채널 ${channels.length} · 터진 편 ${outliers.length} · 길이 중앙 ${d.length ? median(d).toFixed(1) : '-'}분 · 쿼터 ${units}`);
  for (const o of outliers.slice(0, 15)) console.log(`${o.ratio}x ${o.views} ${o.dur_min}분 ${o.published} [${o.channel}] ${o.title}`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });

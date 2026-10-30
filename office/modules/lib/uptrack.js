// 우리 채널 업로드·성과 추적 — 연결된 채널(youtube_upload_profiles.json 의 channelId)의 공개 수치만 한 시간마다 잰다.
// 읽기 전용(공개 API 키: channels 1단위 + 채널마다 uploads 목록 1단위 + 30일 안 편 videos 1단위/50편 ≈ 시간당 20단위).
// 기록은 오피스 자기 파일 office/data/up-track.json. 키는 D:/midform/.env 의 YOUTUBE_API_KEY 를 요청에만 쓴다.

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '../../..');
const FILE = path.join(ROOT, 'office/data/up-track.json');
const EVERY = 60 * 60e3;
const KEEP_DAYS = 60; // 가설 «시작 전·후» 비교에 시작 전 편이 남아 있게

function apiKey() {
  try { return (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^YOUTUBE_API_KEY=(.+)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, '') || null; } catch { return null; }
}
function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { fetched_at: 0, channels: {}, videos: {} }; } }
function getJson(url) {
  return new Promise((res, rej) => {
    https.get(url, { timeout: 20e3 }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); })
      .on('error', rej).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}
const secs = (iso) => { const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : null; };

// chans: [{ id: channelId, purpose }] → 기록(채널별 구독 추이, 편별 조회 추이)
async function refreshUploads(chans) {
  const t = load();
  t.channels = t.channels || {}; t.videos = t.videos || {};
  const key = Date.now() - (t.fetched_at || 0) > EVERY && chans.length && apiKey();
  if (!key) return t;
  const q = (p) => getJson(`https://www.googleapis.com/youtube/v3/${p}&key=${encodeURIComponent(key)}`);
  try {
    const now = Date.now();
    const cj = await q(`channels?part=snippet,statistics,contentDetails&id=${chans.map((c) => c.id).join(',')}`);
    const fresh = [];
    for (const it of cj.items || []) {
      const c = t.channels[it.id] || (t.channels[it.id] = { subs_hist: [] });
      const purpose = chans.find((x) => x.id === it.id)?.purpose;
      Object.assign(c, { title: it.snippet?.title, purpose, uploads: it.contentDetails?.relatedPlaylists?.uploads,
        subs: +it.statistics?.subscriberCount || 0, views: +it.statistics?.viewCount || 0, videos: +it.statistics?.videoCount || 0 });
      const lastS = c.subs_hist[c.subs_hist.length - 1];
      if (!lastS || now - lastS.at > 6 * 3600e3) c.subs_hist.push({ at: now, subs: c.subs, views: c.views }); // 구독 추이는 6시간마다 한 점
      if (c.subs_hist.length > 400) c.subs_hist = c.subs_hist.slice(-400);
      if (!c.uploads) continue;
      try {
        let items = [], page = '';
        for (let k = 0; k < 2; k++) { // 최근 100편까지(하루 5편 채널도 3주 치)
          const pl = await q(`playlistItems?part=contentDetails&maxResults=50&playlistId=${c.uploads}${page ? '&pageToken=' + page : ''}`);
          items = items.concat(pl.items || []);
          if (!pl.nextPageToken || Date.parse(items[items.length - 1]?.contentDetails?.videoPublishedAt || 0) < now - KEEP_DAYS * 864e5) break;
          page = pl.nextPageToken;
        }
        for (const x of items) {
          const id = x.contentDetails?.videoId, pub = Date.parse(x.contentDetails?.videoPublishedAt || '');
          if (id && pub > now - KEEP_DAYS * 864e5) { fresh.push(id); const v = t.videos[id] || (t.videos[id] = { snaps: [] }); v.ch = it.id; v.pub = pub; }
        }
      } catch { /* 다음 회차 */ }
    }
    for (let i = 0; i < fresh.length; i += 50) {
      const vj = await q(`videos?part=snippet,statistics,contentDetails&id=${fresh.slice(i, i + 50).join(',')}`);
      for (const it of vj.items || []) {
        const v = t.videos[it.id];
        const st = it.statistics || {};
        Object.assign(v, { title: it.snippet?.title, dur: secs(it.contentDetails?.duration) });
        v.snaps.push({ at: now, views: +st.viewCount || 0, likes: st.likeCount != null ? +st.likeCount : null, comments: st.commentCount != null ? +st.commentCount : null });
        // 첫 이틀은 한 시간마다, 그 뒤는 6시간에 한 점만 남겨 파일을 작게
        v.snaps = v.snaps.filter((s, k, a) => k === a.length - 1 || s.at - v.pub < 48 * 3600e3 || !a[k + 1] || Math.floor(s.at / 216e5) !== Math.floor(a[k + 1].at / 216e5));
        if (v.snaps.length > 120) v.snaps = v.snaps.slice(-120);
      }
    }
    for (const [id, v] of Object.entries(t.videos)) if (!(v.pub > now - KEEP_DAYS * 864e5)) delete t.videos[id];
    t.fetched_at = now;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(t) + '\n', 'utf8');
  } catch { /* 다음 회차에 다시 */ }
  return t;
}

module.exports = { refreshUploads, loadUploads: load };

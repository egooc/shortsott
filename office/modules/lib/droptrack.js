// 잡탕 결 투하 편 추적 — status.json gyeol[].drops[].url 의 영상을 한 시간마다 공개 수치(조회·좋아요·댓글)로 재서 쌓는다.
// 읽기 전용(유튜브 공개 수치 조회만, videos.list 1단위/50편). 쌓은 기록은 오피스 자기 파일 office/data/drop-track.json.
// 키는 D:/midform/.env 의 YOUTUBE_API_KEY 를 읽어 요청에만 쓴다 — 화면·파일·로그에 남기지 않는다.

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '../../..');
const FILE = path.join(ROOT, 'office/data/drop-track.json');
const EVERY = 60 * 60e3;

const vid = (u) => (String(u || '').match(/(?:shorts\/|v=|youtu\.be\/)([\w-]{11})/) || [])[1] || null;
function apiKey() {
  try { return (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^YOUTUBE_API_KEY=(.+)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, '') || null; } catch { return null; }
}
function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { fetched_at: 0, videos: {} }; } }
function getJson(url) {
  return new Promise((res, rej) => {
    https.get(url, { timeout: 20e3 }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); })
      .on('error', rej).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

// drops 의 영상들을 (한 시간에 한 번) 재고 기록을 돌려준다.
async function refreshDrops(urls) {
  const t = load();
  const ids = [...new Set(urls.map(vid).filter(Boolean))];
  const due = ids.length && (Date.now() - (t.fetched_at || 0) > EVERY || ids.some((id) => !t.videos[id]));
  const key = due && apiKey();
  if (key) {
    try {
      for (let i = 0; i < ids.length; i += 50) {
        const j = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,status&id=${ids.slice(i, i + 50).join(',')}&key=${encodeURIComponent(key)}`);
        const seen = new Set();
        for (const it of j.items || []) {
          seen.add(it.id);
          const v = t.videos[it.id] || (t.videos[it.id] = { snaps: [] });
          Object.assign(v, { title: it.snippet?.title, channel: it.snippet?.channelTitle, published: it.snippet?.publishedAt, privacy: it.status?.privacyStatus, gone: false });
          const st = it.statistics || {};
          v.snaps.push({ at: Date.now(), views: +st.viewCount || 0, likes: st.likeCount != null ? +st.likeCount : null, comments: st.commentCount != null ? +st.commentCount : null });
          if (v.snaps.length > 200) v.snaps = v.snaps.slice(-200);
        }
        for (const id of ids.slice(i, i + 50)) if (!seen.has(id) && t.videos[id]) t.videos[id].gone = true; // 삭제·비공개로 안 보임
      }
      t.fetched_at = Date.now();
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(t, null, 2) + '\n', 'utf8');
    } catch { /* 다음 회차에 다시 */ }
  }
  return t;
}

module.exports = { refreshDrops, vid, loadTrack: load };

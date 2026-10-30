// 틱톡 수익 계정 추적 — docs/office/tiktok-accounts.json 의 계정만 잰다(읽기 전용).
//   Zernio 분석(연결된 계정): 한 시간마다 편별 조회·좋아요·댓글, 계정 팔로워. 길이는 보유율 곡선 칸 수(초)로 잡는다.
//   TikHub(연결 안 된 계정): 프로필 하루 1회, 최근 편 6시간마다(계정당 30편).
// 기록은 office/data/tiktok-track.json. 키는 D:/midform/.env 의 ZERNIO_API_KEY, ~/.volcano/keys/tikhub 를 요청에만 쓴다.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const FILE = path.join(ROOT, 'office/data/tiktok-track.json');
const ZN_EVERY = 60 * 60e3, TH_PROFILE_EVERY = 24 * 3600e3, TH_POSTS_EVERY = 6 * 3600e3;
const KEEP_DAYS = 40;

const znKey = () => { try { return (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^ZERNIO_API_KEY=(.+)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, '') || null; } catch { return null; } };
const thKey = () => { try { return fs.readFileSync(path.join(os.homedir(), '.volcano/keys/tikhub'), 'utf8').trim() || null; } catch { return null; } };
function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
const getJson = async (url, headers) => { const r = await fetch(url, { headers, signal: AbortSignal.timeout(30e3) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };

function snap(t, id, h, pub, s) {
  const v = t.videos[id] || (t.videos[id] = { snaps: [] });
  Object.assign(v, { h, pub, ...(s.title != null && { title: s.title }), ...(s.dur && { dur: s.dur }), ...(s.url && { url: s.url }) });
  const last = v.snaps[v.snaps.length - 1];
  if (last && s.at - last.at < 20 * 60e3) v.snaps.pop(); // 같은 회차 두 번이면 새 값으로
  v.snaps.push({ at: s.at, views: s.views, likes: s.likes, comments: s.comments });
  // 첫 이틀은 다 남기고, 그 뒤는 6시간에 한 점
  v.snaps = v.snaps.filter((x, k, a) => k === a.length - 1 || x.at - pub < 48 * 3600e3 || Math.floor(x.at / 216e5) !== Math.floor(a[k + 1].at / 216e5));
  if (v.snaps.length > 120) v.snaps = v.snaps.slice(-120);
}
function follow(t, h, followers, videos, src, now) {
  const a = t.accounts[h] || (t.accounts[h] = { hist: [] });
  Object.assign(a, { followers, src, at: now, ...(videos != null && { videos }) });
  const last = a.hist[a.hist.length - 1];
  if (!last || now - last.at > 6 * 3600e3) a.hist.push({ at: now, followers });
  if (a.hist.length > 300) a.hist = a.hist.slice(-300);
}

async function refreshTikTok(handles) {
  const t = load();
  for (const k of ['accounts', 'videos', 'th_profile_at', 'th_posts_at']) t[k] = t[k] || {};
  if (!handles.length) return t;
  const now = Date.now();
  let changed = false;

  // Zernio — 연결된 계정 전부를 한 번에
  const zk = znKey();
  if (zk && now - (t.zn_at || 0) > ZN_EVERY) {
    try {
      const H = { Authorization: `Bearer ${zk}` };
      const to = new Date(now).toISOString().slice(0, 10), from = new Date(now - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
      const linked = new Set();
      for (let page = 1; page <= 10; page++) {
        const j = await getJson(`https://zernio.com/api/v1/analytics?platform=tiktok&fromDate=${from}&toDate=${to}&page=${page}&limit=50`, H);
        for (const a of j.accounts || []) if (handles.includes(a.username)) { linked.add(a.username); follow(t, a.username, a.followersCount ?? null, null, 'zernio', now); }
        for (const p of j.posts || []) {
          const pl = (p.platforms || [])[0] || {};
          const h = pl.accountUsername, id = pl.platformPostId || p._id, an = p.analytics || {};
          if (!handles.includes(h)) continue;
          const dur = Object.keys(an.retentionCurve || {}).length || null;
          snap(t, id, h, Date.parse(p.publishedAt), { at: now, views: +an.views || 0, likes: an.likes ?? null, comments: an.comments ?? null, title: String(p.content || '').slice(0, 80), dur, url: p.platformPostUrl });
        }
        const pg = j.pagination || {};
        if (!pg.pages || page >= pg.pages) break;
      }
      t.zn_linked = [...linked];
      t.zn_at = now; changed = true;
    } catch (e) { t.zn_error = e.message; }
  }

  // TikHub — 프로필은 모두 하루 1회, 편 목록은 Zernio 에 없는 계정만 6시간마다
  const tk = thKey();
  if (tk) {
    const H = { Authorization: `Bearer ${tk}`, 'User-Agent': 'Mozilla/5.0' };
    for (const h of handles) {
      try {
        if (now - (t.th_profile_at[h] || 0) > TH_PROFILE_EVERY) {
          const j = await getJson(`https://api.tikhub.io/api/v1/tiktok/web/fetch_user_profile?uniqueId=${encodeURIComponent(h)}`, H);
          const st = j.data?.userInfo?.stats || {};
          if (!(t.zn_linked || []).includes(h) || t.accounts[h]?.followers == null) follow(t, h, st.followerCount ?? null, st.videoCount ?? null, 'tikhub', now);
          else t.accounts[h].videos = st.videoCount ?? t.accounts[h].videos;
          t.th_profile_at[h] = now; changed = true;
        }
        if (!(t.zn_linked || []).includes(h) && now - (t.th_posts_at[h] || 0) > TH_POSTS_EVERY) {
          const j = await getJson(`https://api.tikhub.io/api/v1/tiktok/app/v3/fetch_user_post_videos?unique_id=${encodeURIComponent(h)}&count=30&max_cursor=0`, H);
          for (const a of j.data?.aweme_list || []) {
            const pub = a.create_time * 1000, s = a.statistics || {};
            if (now - pub > KEEP_DAYS * 864e5) continue;
            snap(t, a.aweme_id, h, pub, { at: now, views: +s.play_count || 0, likes: s.digg_count ?? null, comments: s.comment_count ?? null, title: String(a.desc || '').slice(0, 80),
              dur: a.video?.duration ? Math.round(a.video.duration / 1000) : null, url: `https://www.tiktok.com/@${h}/video/${a.aweme_id}` });
          }
          t.th_posts_at[h] = now; changed = true;
        }
      } catch (e) { t.th_error = `${h}: ${e.message}`; }
    }
  }

  if (changed) {
    for (const [id, v] of Object.entries(t.videos)) if (!(v.pub > now - KEEP_DAYS * 864e5)) delete t.videos[id];
    t.fetched_at = now;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(t) + '\n', 'utf8');
  }
  return t;
}

module.exports = { refreshTikTok };

// 같은 포맷 경쟁 채널의 «옛날에 터졌고 · 지금도 안 막혔고 · 지금은 안 자라는» 영상을 찾는다.
//
//   node scripts/rival-backlog.js            과거 업로드를 깊게 훑어 스냅숏을 하나 뜬다
//   node scripts/rival-backlog.js --report   새로 안 받고 쌓인 것만 읽는다
//   node scripts/rival-backlog.js --pages 12 채널당 페이지 수(1페이지 50편)
//
// 왜 (2026-09-22 소유주)
//   "미드폼 1분 이상 3분 미만 무비리캡에서 발화 대사 살리는 구조의 채널에서,
//    옛날에 터졌던, 지금도 차단 안 된, 그러나 유입이 죽은 영상을 만들어도 된다는 거지."
//
//   세 조건이 각각 다른 것을 증명한다 — 이게 이 신호의 핵심이다.
//     ① **옛날에 터졌다** → 그 장면에 수요가 있다(증명된 수요).
//     ② **지금도 안 막혔다** → 그 영화가 **이 길이·이 구조**를 견딘다.
//        생클립 채널의 생존은 라이선스라 증거가 안 된다(사례 92). 같은 포맷 채널이어야 증거다.
//        2년을 버틴 2분짜리 리캡은 «우리가 올려도 된다»에 가장 가까운 증거다.
//     ③ **지금은 안 자란다** → 유튜브가 그 수요를 지금 아무에게도 안 먹이고 있다. 자리가 비었다.
//
//   ★①만 보면 킹콩(1.44억)처럼 수요는 크고 막히는 것을 집는다.
//    ②만 보면 아무도 안 보는 안전한 것을 집는다. **셋이 같이 가리킬 때만 집는다.**
//
// 차단 판정
//   `contentDetails.regionRestriction.blocked` 를 본다 — check-claims 와 같은 창이다.
//   목록에 남아 있어도 전세계 차단이면 blocked 에 나라가 쭉 들어온다.
//
// 죽었는지
//   한 장 사진으로 못 본다. 누적을 나이로 나누면 초기 폭발에 속는다.
//   두 스냅숏 사이 증가분을 본다 — **판정은 두 번째 실행부터다.**
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch { /* 환경에서 온다 */ }

const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const RIVALS = path.join(ROOT, 'server', 'data', 'rival_channels.json');
const STORE = path.join(ROOT, 'server', 'data', 'rival_backlog.json');
const REPORT_DIR = path.join(ROOT, 'server', 'output', 'scout-reports');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const PAGES = Number(arg('--pages', '10'));
const BAND = [60, 200];
const OLD_DAYS = 120;        // «옛날»의 하한. 최근 것은 아직 자랄 수 있어 «죽었다»를 못 본다.

async function accessToken(p) {
  const body = new URLSearchParams({ client_id: p.oauthClientId, client_secret: p.oauthClientSecret,
    refresh_token: p.refreshToken, grant_type: 'refresh_token' });
  const d = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body })).json();
  if (!d.access_token) throw new Error(`토큰 갱신 실패: ${JSON.stringify(d).slice(0, 140)}`);
  return d.access_token;
}
async function api(token, url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  if (j.error) throw new Error(`${j.error.code}: ${String(j.error.message).slice(0, 150)}`);
  return j;
}

async function collect(token, chId) {
  const ch = await api(token, `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${chId}`);
  const item = (ch.items || [])[0];
  if (!item) return [];
  const uploads = item.contentDetails.relatedPlaylists.uploads;
  const ids = [];
  let pageToken = '';
  for (let i = 0; i < PAGES; i += 1) {
    const pl = await api(token, 'https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50'
      + `&playlistId=${uploads}${pageToken ? `&pageToken=${pageToken}` : ''}`);
    for (const x of pl.items || []) ids.push(x.contentDetails.videoId);
    pageToken = pl.nextPageToken || '';
    if (!pageToken) break;
  }
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const vids = await api(token, 'https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics,snippet'
      + `&id=${ids.slice(i, i + 50).join(',')}`);
    for (const v of vids.items || []) {
      const mm = /PT(?:(\d+)M)?(?:(\d+)S)?/.exec((v.contentDetails || {}).duration || '') || [];
      const rr = ((v.contentDetails || {}).regionRestriction) || {};
      out.push({
        id: v.id,
        sec: Number(mm[1] || 0) * 60 + Number(mm[2] || 0),
        views: Number((v.statistics || {}).viewCount || 0),
        title: (v.snippet || {}).title || '',
        at: (v.snippet || {}).publishedAt || '',
        blocked: Array.isArray(rr.blocked) ? rr.blocked.length : 0,
      });
    }
  }
  return out;
}

async function main() {
  const rivals = readJson(RIVALS, { channels: {} }).channels || {};
  // 손으로 확인한 «같은 포맷» 채널만 본다. 생클립 채널은 증거가 안 된다(사례 92).
  const targets = Object.entries(rivals).filter(([, c]) => c.verified
    && c.medianSec >= BAND[0] && c.medianSec <= BAND[1]);
  if (!targets.length) { console.log('대상 채널이 없다 — 먼저 rival-scout.js 를 돌려라.'); return; }

  const store = readJson(STORE, { snapshots: [] });
  if (!process.argv.includes('--report')) {
    const raw = readJson(PROFILES, []);
    const profiles = Array.isArray(raw) ? raw : (raw.profiles || []);
    const profile = profiles.find((p) => p.purpose === 'ko_highlight') || profiles[0];
    if (!profile) { console.error('업로드 프로필이 없다.'); process.exit(1); }
    const token = await accessToken(profile);
    const snap = { at: new Date().toISOString(), rows: {} };
    for (const [id, c] of targets) {
      try {
        const rows = await collect(token, id);
        for (const r of rows) snap.rows[r.id] = { ...r, ch: c.title };
        console.log(`  ${c.title} — ${rows.length}편 (차단 ${rows.filter((r) => r.blocked).length}편)`);
      } catch (e) { console.log(`  [실패] ${c.title}: ${e.message}`); }
    }
    store.snapshots = [...(store.snapshots || []), snap].slice(-30);
    fs.writeFileSync(STORE, JSON.stringify(store, null, 2));
    console.log(`[backlog] 스냅숏 ${store.snapshots.length}개`);
  }

  const snaps = store.snapshots || [];
  const last = snaps[snaps.length - 1];
  const prev = snaps.length >= 2 ? snaps[snaps.length - 2] : null;
  if (!last) { console.log('스냅숏이 없다.'); return; }

  const lines = [`# 경쟁 채널 빈자리 ${new Date().toLocaleString('ko-KR')}`, ''];
  const all = Object.values(last.rows);
  const inBand = all.filter((r) => r.sec >= BAND[0] && r.sec <= BAND[1]);
  const alive = inBand.filter((r) => !r.blocked);
  const old = alive.filter((r) => r.at && (Date.now() - Date.parse(r.at)) / 864e5 >= OLD_DAYS);
  lines.push(`훑은 영상 ${all.length}편 · 우리 길이대 ${inBand.length}편 · 안 막힌 것 ${alive.length}편`
    + ` · ${OLD_DAYS}일 넘은 것 ${old.length}편`, '');

  if (!prev) {
    lines.push('**기준점만 만들었다.** «유입이 죽었는가»는 두 번째 실행부터 나온다 — 하루 뒤에 다시 돌려라.', '');
    lines.push('## 그때까지 참고 — 오래됐는데 크게 터진 것 (아직 «죽었는지»는 모른다)', '');
    for (const r of old.sort((a, b) => b.views - a.views).slice(0, 25)) {
      const age = Math.round((Date.now() - Date.parse(r.at)) / 864e5);
      lines.push(`- **${r.views.toLocaleString()}회** · ${r.sec}s · ${age}일 전 · _${r.ch}_`);
      lines.push(`  ${r.title.replace(/\s+/g, ' ').slice(0, 60)}`);
    }
  } else {
    const hours = Math.max(0.5, (Date.parse(last.at) - Date.parse(prev.at)) / 3600000);
    const rows = [];
    for (const r of old) {
      const b = prev.rows[r.id];
      if (!b) continue;
      const perDay = ((r.views - b.views) / hours) * 24;
      rows.push({ ...r, perDay });
    }
    // 상한 1,000/일 — 누적이 아무리 커도 그만큼 들어오면 죽은 게 아니다(사례 96).
    const dead = rows.filter((r) => r.views >= 200000
      && r.perDay < Math.min(r.views * 0.0005, 1000));
    lines.push(`간격 ${hours.toFixed(1)}시간 · 20만 이상 중 **지금 거의 안 자라는 것 ${dead.length}편**`, '');
    lines.push('## 빈자리 — 터졌고 · 안 막혔고 · 지금 안 자란다', '');
    for (const r of dead.sort((a, b) => b.views - a.views).slice(0, 25)) {
      const age = Math.round((Date.now() - Date.parse(r.at)) / 864e5);
      lines.push(`- **${r.views.toLocaleString()}회** · 지금 ${Math.round(r.perDay)}/일 · ${r.sec}s · ${age}일 전 · _${r.ch}_`);
      lines.push(`  ${r.title.replace(/\s+/g, ' ').slice(0, 60)}`);
    }
  }
  lines.push('', '_다음: 어느 영화인지 사람이 한 번 보고, 카탈로그의 생존자 신호와 맞춰 고른다._');
  lines.push('_★남의 영상을 다시 올리는 것이 아니다. 같은 장면을 우리 원고·우리 컷으로 새로 만든다._');

  const text = lines.join('\n');
  console.log('\n' + text);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  fs.writeFileSync(path.join(REPORT_DIR, `${stamp}-rival-backlog.md`), `${text}\n`, 'utf8');
}

main().catch((e) => { console.error('rival-backlog fatal:', e.message || e); process.exitCode = 1; });

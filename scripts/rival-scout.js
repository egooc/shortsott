// 우리와 «같은 포맷»으로 도는 채널을 찾는다 — 1~3분, 해설 + 원본 발화 리캡.
//
//   node scripts/rival-scout.js               우리가 만든 영화로 검색해 채널을 모으고 포맷을 잰다
//   node scripts/rival-scout.js --report       새로 안 받고 쌓인 것만 읽는다
//   node scripts/rival-scout.js --searches 12  검색 횟수 상한(1회 100 units)
//
// 왜 (2026-09-22 소유주: "명화관을 기준으로 알고리즘 추천 타고가면 쭉 나와")
//   지금까지 정찰한 14개 채널은 전부 **생클립 채널**(Movieclips·Binge Society·BestClips…)이다.
//   그들은 라이선스가 있고 길이도 5~10분이라 «우리 포맷이 견디는가»를 아무것도 증명하지 않는다.
//   증명하는 것은 **우리와 같은 물건**을 올리는 채널이다 — 1~3분, 해설이 깔리고 원본 대사가 살아 있는.
//   그런 채널의 2년 된 영상이 아직 안 막혀 있으면, 그 영화는 **이 길이·이 구조를 견딘다.**
//
//   ★유튜브 API 에는 «추천 영상»이 없다(relatedToVideoId 는 2023 에 폐기됐다).
//     그래서 같은 자리를 다른 문으로 간다 — **우리가 만든 영화 제목으로 검색**해서
//     우리 길이대에 있는 영상을 걷고, 거기 반복해서 나오는 채널을 후보로 본다.
//     사람이 추천을 타고 가며 보는 것과 결과가 비슷해진다. 알고리즘은 결국 같은 수요를 묶는다.
//
// 포맷 판정 — 채널 하나를 «우리 포맷»으로 부르려면
//   ① 최근 영상의 **중앙값 길이가 60~200초**. 5분짜리 채널은 우리 경쟁자가 아니다.
//   ② 그 길이대 영상이 최근 업로드의 **절반 이상**. 어쩌다 한 편 짧은 것은 셈에 안 넣는다.
//   ★해설 비중(발화 구조)은 여기서 안 잰다 — 오디오를 받아야 하고 실비가 든다.
//     길이와 제목 모양으로 1차만 거른 뒤, 사람이 한 번 보고 확정한다.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch { /* 환경에서 온다 */ }

const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const CATALOG = path.join(ROOT, 'midform', 'config', 'movie_catalog.json');
const YT_STATE = path.join(ROOT, 'server', 'data', 'auto_publish_state.json');
const STORE = path.join(ROOT, 'server', 'data', 'rival_channels.json');
const REPORT_DIR = path.join(ROOT, 'server', 'output', 'scout-reports');
const DRAFTS_DIR = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const SEARCHES = Number(arg('--searches', '12'));
const BAND = [60, 200];

// 우리가 2026-09-04·09-08 에 실측해 둔 «같은 포맷» 채널들. 이름만 알고 ID 가 없다.
// 검색으로 찾기 전에 이름으로 직접 집는다 — 정확도가 훨씬 높다.
const KNOWN = ['헛개리카노', '무비픽스', '파워무비', '한다요', '대한숏'];

// ★우리가 만든 영화로만 검색하면 **같은 대작만 되돌아온다** (2026-09-23).
//   후보 명단을 넓히려는 것이 목적이므로, 영화 제목이 아니라 «리캡 채널이 쓰는 말투»로 찾는다.
//   실측한 경쟁 채널 제목들: "모든 비극의 시작" · "~한 이유" · "~된 이유" · "~하자 ~했다".
//   영화명을 안 쓰는 것이 이 바닥의 관행이라(사례 93) 제목 대신 어미와 훅 문구를 씨앗으로 쓴다.
const GENERIC_SEEDS = [
  '영화 결말포함 요약',
  '영화 리뷰 결말포함',
  '드라마 요약 결말',
  '영화 명장면 해설',
  '영화 한편 요약',
  '넷플릭스 드라마 요약',
];

// 영화 채널인가. 카탈로그 142편의 match 패턴으로 최근 제목을 훑는다.
// ★길이만 보면 골동품 감정(숏해적)·잡학(뚝딱 상식 뚝배기) 채널이 섞인다 — 실측 2026-09-22.
//
// ★★그런데 이 저울은 **우리 진짜 경쟁자를 떨어뜨린다.** 같은 날 실측:
//     헛개리카노 131s·길이대 100% → 영화 0%   |   대한숏 130s·100% → 영화 2%
//   둘 다 우리가 손으로 확인한 «같은 포맷» 채널이다. 왜 0% 인가 —
//   **한국 리캡 채널은 제목에 영화 이름을 안 쓴다.** "모든 비극의 시작" 처럼 후킹 문구만 쓴다.
//   (우리도 그렇게 쓴다. 제목에 영화명을 박는 쪽은 오히려 생클립 채널이다.)
//   그래서 movieRatio 는 **버리는 저울이 아니라 참고 수치**로만 쓴다:
//   손으로 확인한 채널(KNOWN)은 무조건 통과시키고, 검색으로 새로 걸린 채널에만 약한 문턱을 건다.
function movieRatio(titles, movies) {
  const pats = [];
  for (const m of Object.values(movies)) {
    if (!m || !m.match) continue;
    try { pats.push(new RegExp(m.match, 'i')); } catch { /* 깨진 패턴은 건너뛴다 */ }
  }
  if (!pats.length || !titles.length) return 0;
  let hit = 0;
  for (const t of titles) if (pats.some((re) => re.test(t))) hit += 1;
  return hit / titles.length;
}

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
  if (j.error) throw new Error(`${j.error.code}: ${String(j.error.message).slice(0, 160)}`);
  return j;
}

// 우리가 실제로 만든 영화 = 검색어의 출발점. «명화관 기준»이 이것이다.
function ourMovies() {
  const movies = readJson(CATALOG, {}).movies || {};
  const keys = new Set();
  const consider = (draft) => {
    if (!draft) return;
    for (const loc of ['', '-ko', '-ja']) {
      const m = readJson(path.join(DRAFTS_DIR, draft + loc, 'upload_meta.json'), null);
      const k = m && m.movie && m.movie.key;
      if (k) { keys.add(k); return; }
    }
  };
  for (const h of (readJson(YT_STATE, { history: [] }).history || [])) consider(h.draft);
  try { for (const n of fs.readdirSync(DRAFTS_DIR)) consider(n); } catch { /* 이력만 */ }
  return [...keys].map((k) => ({ key: k, m: movies[k] })).filter((x) => x.m && x.m.title_ko);
}

async function main() {
  const store = readJson(STORE, { channels: {}, at: '' });

  if (!process.argv.includes('--report')) {
    const raw = readJson(PROFILES, []);
    const profiles = Array.isArray(raw) ? raw : (raw.profiles || []);
    const profile = profiles.find((p) => p.purpose === 'ko_highlight') || profiles[0];
    if (!profile) { console.error('업로드 프로필이 없다.'); process.exit(1); }
    const token = await accessToken(profile);

    // 알려진 레퍼런스 채널을 이름으로 먼저 집는다 (검색 1회 100 units씩)
    const hitsKnown = {};
    for (const name of KNOWN) {
      try {
        const j = await api(token, 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel'
          + `&maxResults=3&regionCode=KR&relevanceLanguage=ko&q=${encodeURIComponent(name)}`);
        for (const it of (j.items || []).slice(0, 1)) {
          const id = it.id.channelId || (it.snippet && it.snippet.channelId);
          if (id) { hitsKnown[id] = { title: it.snippet.channelTitle, videos: ['known', 'known'], verified: true }; }
        }
        console.log(`  [알려진] ${name} → ${(j.items || []).length}건`);
      } catch (e) { console.log(`  [알려진 실패] ${name}: ${e.message}`); }
    }

    const useGeneric = process.argv.includes('--generic');
    const seeds = useGeneric
      ? GENERIC_SEEDS.slice(0, SEARCHES).map((q) => ({ key: q, m: { title_ko: q }, generic: true }))
      : ourMovies().slice(0, SEARCHES);
    console.log(`[rival] ${useGeneric ? '리캡 말투' : '우리가 만든 영화'} ${seeds.length}개로 검색한다`
      + ' (검색 1회 100 units)');
    const hits = {};   // channelId -> {title, videos:Set}
    for (const s of seeds) {
      // 우리 길이대만 본다. videoDuration=short 는 4분 미만이라 1차로 쓰고 실제 길이로 다시 거른다.
      const q = encodeURIComponent(s.generic ? s.m.title_ko : `${s.m.title_ko} 결말포함`);
      const u = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoDuration=short`
        + `&maxResults=25&regionCode=KR&relevanceLanguage=ko&q=${q}`;
      let j;
      try { j = await api(token, u); }
      catch (e) { console.log(`  [건너뜀] ${s.key}: ${e.message}`); continue; }
      for (const it of j.items || []) {
        const ch = it.snippet.channelId;
        const c = (hits[ch] = hits[ch] || { title: it.snippet.channelTitle, videos: [] });
        c.videos.push(it.id.videoId);
      }
      console.log(`  ${s.key} → ${(j.items || []).length}편`);
    }

    // 후보 채널의 «포맷»을 잰다 — 최근 업로드 길이 분포
    for (const [id, c] of Object.entries(hitsKnown)) if (!hits[id]) hits[id] = c;
    const cands = Object.entries(hits).filter(([, c]) => c.videos.length >= 2);
    console.log(`[rival] 두 번 이상 나온 채널 ${cands.length}개의 포맷을 잰다`);
    for (const [chId, c] of cands) {
      try {
        const ch = await api(token, `https://www.googleapis.com/youtube/v3/channels?part=contentDetails,statistics&id=${chId}`);
        const item = (ch.items || [])[0];
        if (!item) continue;
        const uploads = item.contentDetails.relatedPlaylists.uploads;
        const pl = await api(token, `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}`);
        const ids = (pl.items || []).map((x) => x.contentDetails.videoId).slice(0, 50);
        if (!ids.length) continue;
        const vids = await api(token, `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics,snippet&id=${ids.join(',')}`);
        // ★설명문에 작품명을 적는 채널만이 «후보 명단»을 넓혀 준다 (2026-09-23).
        //   제목엔 영화명을 안 쓰므로(사례 93) 설명문이 유일한 실마리다.
        //   실측: 400편 중 20편만 설명문이 있었다 — 헛개리카노는 적고 무비픽스는 대부분 비어 있다.
        const withDesc = (vids.items || []).filter((v) => String((v.snippet || {}).description || '').trim().length > 20).length;
        const rows = (vids.items || []).map((v) => {
          const mm = /PT(?:(\d+)M)?(?:(\d+)S)?/.exec(v.contentDetails.duration || '') || [];
          return { id: v.id, sec: Number(mm[1] || 0) * 60 + Number(mm[2] || 0),
            views: Number((v.statistics || {}).viewCount || 0),
            title: v.snippet.title, at: v.snippet.publishedAt };
        }).filter((r) => r.sec > 0);
        if (!rows.length) continue;
        const secs = rows.map((r) => r.sec).sort((a, b) => a - b);
        const median = secs[Math.floor(secs.length / 2)];
        const inBand = rows.filter((r) => r.sec >= BAND[0] && r.sec <= BAND[1]).length;
        const mr = movieRatio(rows.map((r) => r.title), readJson(CATALOG, {}).movies || {});
        store.channels[chId] = {
          title: c.title,
          subs: Number((item.statistics || {}).subscriberCount || 0),
          medianSec: median,
          inBandRatio: inBand / rows.length,
          movieRatio: mr,
          descRatio: (vids.items || []).length ? withDesc / (vids.items || []).length : 0,
          verified: !!c.verified,
          sampled: rows.length,
          videos: rows.sort((a, b) => b.views - a.views).slice(0, 40),
        };
        console.log(`  ${c.title} — 중앙값 ${median}s · 길이대 ${(100 * inBand / rows.length).toFixed(0)}%`
          + ` · 영화 ${(100 * mr).toFixed(0)}%`
          + ` · 설명문 ${(100 * withDesc / Math.max(1, (vids.items || []).length)).toFixed(0)}%`);
      } catch (e) { console.log(`  [실패] ${c.title}: ${e.message}`); }
    }
    store.at = new Date().toISOString();
    fs.writeFileSync(STORE, JSON.stringify(store, null, 2));
  }

  // 보고 — 우리 포맷인 채널만
  const all = Object.entries(store.channels || {});
  // 길이 + «영화 채널인가». 카탈로그가 142편뿐이라 실제 영화 채널도 비중이 낮게 나온다 —
  // 그래서 문턱을 10% 로 낮게 잡는다. 0% 면 영화 채널이 아니라고 봐도 된다.
  const fits = (c) => c.medianSec >= BAND[0] && c.medianSec <= BAND[1] && c.inBandRatio >= 0.5;
  const ours = all.filter(([, c]) => fits(c) && (c.verified || (c.movieRatio ?? 0) >= 0.10));
  const rejected = all.filter(([, c]) => fits(c) && !c.verified && (c.movieRatio ?? 0) < 0.10);
  const lines = [`# 같은 포맷 경쟁 채널 ${new Date().toLocaleString('ko-KR')}`, ''];
  lines.push(`검색으로 걸린 채널 ${all.length}개 · 그중 **우리 포맷(중앙값 ${BAND[0]}~${BAND[1]}초, 길이대 50% 이상) ${ours.length}개**`, '');
  for (const [id, c] of ours.sort((a, b) => b[1].videos[0].views - a[1].videos[0].views)) {
    lines.push(`## ${c.title}  _(구독 ${c.subs.toLocaleString()} · 중앙값 ${c.medianSec}s`
      + ` · 길이대 ${(100 * c.inBandRatio).toFixed(0)}% · 영화 ${(100 * (c.movieRatio ?? 0)).toFixed(0)}%`
      + ` · **설명문 ${(100 * (c.descRatio ?? 0)).toFixed(0)}%**`
      + `${c.verified ? ' · 손으로 확인' : ''})_`);
    lines.push(`https://www.youtube.com/channel/${id}`);
    for (const v of c.videos.slice(0, 5)) {
      lines.push(`- ${v.views.toLocaleString()}회 · ${v.sec}s · ${String(v.at).slice(0, 10)} · ${v.title.slice(0, 50)}`);
    }
    lines.push('');
  }
  if (!ours.length) lines.push('_아직 없다. --searches 를 올리거나 검색어를 손보라._');
  if (rejected.length) {
    lines.push('## 길이는 맞지만 영화 채널이 아니다 (거름)', '');
    for (const [, c] of rejected) lines.push(`- ${c.title} — 중앙값 ${c.medianSec}s · 영화 ${(100 * (c.movieRatio ?? 0)).toFixed(0)}%`);
    lines.push('', '_★이 저울은 한국 리캡 채널을 잘못 떨어뜨린다 — 그들은 제목에 영화 이름을 안 쓴다._',
      '_여기 목록은 «버린 것»이 아니라 «사람이 한 번 봐야 할 것»이다._', '');
  }
  lines.push('_다음 단계: 이 채널들의 «옛날에 터졌고 · 아직 살아 있고 · 지금 안 자라는» 영상을 고른다 (demand-gap)._');

  const text = lines.join('\n');
  console.log('\n' + text);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  fs.writeFileSync(path.join(REPORT_DIR, `${stamp}-rivals.md`), `${text}\n`, 'utf8');
}

main().catch((e) => { console.error('rival-scout fatal:', e.message || e); process.exitCode = 1; });

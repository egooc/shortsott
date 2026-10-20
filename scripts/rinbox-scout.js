// 린박스 소재 정찰 — 공식 방송사 채널에서 «무료 전편»을 찾는다.
//
//   node scripts/rinbox-scout.js @drama_ABEMA @tvtokyo_drama
//   node scripts/rinbox-scout.js UCxxxx --pages 4 --min-sec 900 --max-sec 3600
//
// 왜 명화관 정찰(scout-sources.js)을 안 쓰나: 저쪽은 movie_catalog 와 «명장면 클립 채널»을
// 전제한다. 린박스는 다르다 — **권리자 본인이 올린 전편**을 쓴다(소유주 방침). 그래서 찾을
// 것이 「짧은 명장면」이 아니라 「20~50분짜리 본편」이고, 판정도 배급사 이름이 아니라
// 화면·권리 상태로 한다([[drama-clip-source-and-rights]]).
//
// 이 도구는 **후보만 낸다.** 실제 채택 전에 반드시 남은 두 관문을 통과해야 한다:
//   1) 박힌 자막 화면검사 (D:/volcano-runs/_preset_trials/소스_화면검사2.py)
//   2) claim-probe.js 로 실제 구간 프로브
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const keyFetch = require('./lib/ytKeyFetch'); // 발굴 키 쿼터 장부(10-20)
const KEY = process.env.YOUTUBE_API_KEY_SEARCH || process.env.YOUTUBE_API_KEY || process.env.YT_API_KEY || '';
const OUT_DIR = path.join(ROOT, 'server', 'output', 'rinbox-scout');

function parseArgs(argv) {
  const args = { channels: [], search: [], pages: 3, minSec: 900, maxSec: 3600, lang: '', json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pages') { i += 1; args.pages = Number(argv[i] || 3); }
    else if (a === '--min-sec') { i += 1; args.minSec = Number(argv[i]); }
    else if (a === '--max-sec') { i += 1; args.maxSec = Number(argv[i]); }
    else if (a === '--search') { i += 1; args.search.push(argv[i] || ''); }
    else if (a === '--lang') { i += 1; args.lang = argv[i] || ''; }
    else if (a === '--json') args.json = true;
    else if (a && !a.startsWith('--')) args.channels.push(a);
  }
  return args;
}

// 채널을 훑는 것보다 검색이 싸다: 공식 채널도 본편 공개는 드물고(テレ東 600편 중 3편),
// 대부분에 allowed 지역 한정이 걸려 있다. 검색은 **길이로 먼저 걸러** 준다.
async function searchLong(query, lang, pages) {
  const ids = [];
  let pt = '';
  for (let p = 0; p < pages; p += 1) {
    const j = await api('search', {
      part: 'id', type: 'video', maxResults: '50', q: query,
      videoDuration: 'long',              // 20분 초과만
      order: 'relevance',
      ...(lang ? { relevanceLanguage: lang } : {}),
      ...(pt ? { pageToken: pt } : {})
    });
    for (const it of j.items || []) if (it.id?.videoId) ids.push(it.id.videoId);
    if (!j.nextPageToken) break;
    pt = j.nextPageToken;
  }
  return ids;
}

async function api(endpoint, params) {
  const qs = new URLSearchParams({ ...params, key: KEY });
  const j = await keyFetch('rinbox-scout', endpoint, `https://www.googleapis.com/youtube/v3/${endpoint}?${qs}`);
  if (j.error) throw new Error(`${endpoint}: ${JSON.stringify(j.error.errors || j.error).slice(0, 200)}`);
  return j;
}

const isoSeconds = (iso) => {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ''));
  if (!m) return 0;
  return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + (+(m[4] || 0));
};

// 영상 ID 뭉치 -> 판정에 필요한 값만 뽑는다. 채널 훑기와 검색이 같은 표를 쓴다.
async function detailRows(ids) {
  const rows = [];
  for (let i = 0; i < ids.length; i += 50) {
    const v = await api('videos', { part: 'snippet,contentDetails,statistics', id: ids.slice(i, i + 50).join(',') });
    for (const it of v.items || []) {
      const cd = it.contentDetails || {};
      const rr = cd.regionRestriction || {};
      rows.push({
        id: it.id, title: it.snippet.title, channel: it.snippet.channelTitle,
        channelId: it.snippet.channelId, at: it.snippet.publishedAt.slice(0, 10),
        sec: isoSeconds(cd.duration),
        blocked: (rr.blocked || []).length,
        // ★allowed 목록도 우리에게는 차단이다 — 「일본만 허용」이면 소재를 받을 수 없다.
        allowed: (rr.allowed || []).length,
        licensed: cd.licensedContent === true,
        views: Number((it.statistics || {}).viewCount || 0)
      });
    }
  }
  return rows;
}

// 핸들(@name)·채널ID·URL 어느 형태로 줘도 채널을 찾는다.
async function resolveChannel(token) {
  const t = String(token).trim();
  if (/^UC[\w-]{20,}$/.test(t)) return api('channels', { part: 'snippet,contentDetails,statistics', id: t });
  const handle = t.replace(/^https?:\/\/(www\.)?youtube\.com\//, '').replace(/^@/, '').replace(/\/.*$/, '');
  return api('channels', { part: 'snippet,contentDetails,statistics', forHandle: handle });
}

async function main() {
  const args = parseArgs(process.argv);
  if (!KEY) throw new Error('YOUTUBE_API_KEY 가 .env 에 없다');
  if (!args.channels.length && !args.search.length) {
    throw new Error('채널(@handle 또는 UC...)이나 --search <질의> 를 줘라');
  }

  const report = { at: new Date().toISOString(), minSec: args.minSec, maxSec: args.maxSec, channels: [], searches: [] };

  for (const q of args.search) {
    let ids = [];
    try { ids = await searchLong(q, args.lang, args.pages); }
    catch (e) { console.log(`\n▷ "${q}" — 검색 실패: ${e.message}`); continue; }
    const rows = await detailRows(ids);
    // 본편 후보: 길이대 안 · 지역 차단 없음 · allowed 한정 없음(우리 지역에서 안 보이면 못 쓴다)
    const full = rows.filter((r) => r.sec >= args.minSec && r.sec <= args.maxSec && !r.blocked && !r.allowed);
    // 권리자 본인 업로드는 거의 매칭이다 — 여기서는 «공식으로 보이는 표시»로 쓴다.
    full.sort((a, b) => (b.licensed - a.licensed) || (b.views - a.views));
    const byCh = new Map();
    for (const r of full) byCh.set(r.channel, (byCh.get(r.channel) || 0) + 1);
    report.searches.push({ query: q, found: rows.length, inBand: full.length, top: full.slice(0, 15) });
    console.log(`\n▷ "${q}" — 긴 영상 ${rows.length}편 중 쓸 만한 길이·무제한 ${full.length}편`);
    console.log(`  채널 분포: ${[...byCh.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => `${c}(${n})`).join(' · ') || '없음'}`);
    for (const r of full.slice(0, 15)) {
      console.log(`    ${r.at} ${r.id} ${String(Math.round(r.sec / 60)).padStart(3)}분 ${String(r.views).padStart(8)}회 ${r.licensed ? '매칭' : '    '} [${String(r.channel).slice(0, 18)}] ${r.title.slice(0, 40)}`);
    }
  }

  for (const token of args.channels) {
    let info;
    try { info = await resolveChannel(token); }
    catch (e) { console.log(`■ ${token} — 조회 실패: ${e.message}`); continue; }
    const ch = (info.items || [])[0];
    if (!ch) { console.log(`■ ${token} — 채널 없음`); continue; }

    const uploads = ch.contentDetails.relatedPlaylists.uploads;
    const ids = [];
    let pt = '';
    for (let p = 0; p < args.pages; p += 1) {
      const pl = await api('playlistItems', { part: 'contentDetails', maxResults: '50', playlistId: uploads, ...(pt ? { pageToken: pt } : {}) });
      for (const it of pl.items || []) ids.push(it.contentDetails.videoId);
      if (!pl.nextPageToken) break;
      pt = pl.nextPageToken;
    }

    const rows = await detailRows(ids);
    // 본편 후보: 길이대 안 + 지역 차단 없음. 매칭은 걸러내지 않는다 —
    // 권리자 본인 채널은 자기 소유물이니 **항상** 매칭이고, 그게 바로 우리가 찾는 것이다.
    const full = rows.filter((r) => r.sec >= args.minSec && r.sec <= args.maxSec && !r.blocked);
    const entry = {
      token, channelId: ch.id, title: ch.snippet.title,
      subs: Number((ch.statistics || {}).subscriberCount || 0),
      scanned: rows.length,
      inBand: full.length,
      blockedInBand: rows.filter((r) => r.sec >= args.minSec && r.sec <= args.maxSec && r.blocked).length,
      allowlisted: rows.filter((r) => r.allowed).length,
      licensedShare: rows.length ? Math.round(100 * rows.filter((r) => r.licensed).length / rows.length) : 0,
      top: full.sort((a, b) => b.views - a.views).slice(0, 12)
    };
    report.channels.push(entry);

    console.log(`\n■ ${entry.title} (${entry.channelId}) 구독 ${entry.subs.toLocaleString()}`);
    console.log(`  훑음 ${entry.scanned}편 · 길이대(${args.minSec}~${args.maxSec}s) 통과 ${entry.inBand}편 · 그중 차단 ${entry.blockedInBand}편 · 소유권매칭 ${entry.licensedShare}%`);
    if (entry.allowlisted) console.log(`  ★allowed 목록이 걸린 편 ${entry.allowlisted}편 — 지역 한정 공개다. 따로 확인할 것`);
    for (const r of entry.top) {
      console.log(`    ${r.at} ${r.id} ${String(Math.round(r.sec / 60)).padStart(3)}분 ${String(r.views).padStart(8)}회 ${r.licensed ? '매칭' : '    '} ${r.title.slice(0, 46)}`);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-scout.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 1), 'utf8');
  console.log(`\n기록: ${out}`);
  console.log('★후보일 뿐이다. 채택 전에 ① 박힌 자막 화면검사 ② claim-probe 구간 프로브를 통과시켜라.');
}

main().catch((e) => { console.error('[rinbox-scout]', e.message); process.exitCode = 1; });

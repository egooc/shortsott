// 유튜브: 공개 뒤 일정 시간이 지났는데 조회 10 미만인 영상을 비공개로 돌린다 — 연결된 모든 채널.
//
//   node scripts/yt-low-views.js                    목록만 (기본)
//   node scripts/yt-low-views.js --apply            실제로 비공개
//   node scripts/yt-low-views.js --min 10 --hours 48 --days 30 [--purpose ko_highlight]
//   node scripts/yt-low-views.js --min 100 --hours 24 --days 7 --purposes jp_highlight,ko_highlight,idol_fantube_ko --apply
//        ↑ 예약 작업 midform-low-views-private (매시 :50) 이 이 줄로 돈다
//
// 왜 (2026-10-12 소유주: «린박스뿐만 아니라 blotato 랑 zernio 에서도 유튜브도 조회수가 업로드 후 10회 미만이면
//   비공개 처리하게끔 하자»): 전자책 1장 — 노출이 안 되는 영상은 비공개로 돌려야 채널 노출이 돌아온다.
//   조회 0~10 짜리가 채널에 쌓이면 다음 편까지 끌어내린다.
// 판정: privacyStatus=public · 공개 후 --hours(기본 48) 경과 · 조회 < --min(기본 10). 예약(publishAt) 대기 편은 안 건드린다.
// 2026-10-14 소유주: «메인 PC 세션 전부(롱폼·쇼핑 빼고 = 린박스·롱투숏·팬튜브) 24시간 100 미만 저조회 비공개 자동화».
//   → --purposes 로 대상 채널을 이름으로 못 박는다(어랍숏은 N100 에서 돌아서 뺀다, 팬튜브는 연결되면 이미 목록에 있다).
//   공개 시각은 snippet.publishedAt — 예약 편은 실제 공개된 시각으로 바뀐다(10-14 확인). 예약 대기 편은 private 이라 안 걸린다.
//   비공개 처리한 편은 rinbox_publish_state.json 해당 항목에 lowViewsPrivatedAt 을 남긴다(retracted 아님 — 지난 날짜 슬롯을 비우면 coverage 가 빈칸으로 센다).
// 비공개는 되돌릴 수 있다(스튜디오에서 공개로). 기록: server/data/yt_low_views_log.jsonl
// ★차단(regionRestriction)으로 0회인 편도 같이 걸린다 — 어차피 아무에게도 안 보이는 편이다.
// 2026-10-18 소유주(관리자 경유): «제재 표시 없이도 피드를 못 받으면(조회 0) 커뮤니티 가이드 위반»(범주: 위험 행위·칼·마약·총기·살인·피·어린아이 대상).
//   → 공개 --zero-hours(기본 6)시간 지난 쇼츠(길이 ≤ 180초)가 조회 0이면 24h 기준을 기다리지 않고 바로 비공개, 사유 guideline_zero_feed.
//   대상 채널·새 채널 유예·제외 목록은 위 규칙 그대로(같은 예약 줄에서 함께 돈다).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const LOG = path.join(ROOT, 'server', 'data', 'yt_low_views_log.jsonl');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const APPLY = argv.includes('--apply');
const MIN = Number(opt('--min', 10));
const HOURS = Number(opt('--hours', 48));
const DAYS = Number(opt('--days', 30));
const ONLY = opt('--purpose', '');
// 쇼핑 채널은 뺀다(2026-10-12 소유주: «쓸모연구소는 빼야 돼») — 제휴 링크가 달린 상품 영상은 조회가 적어도 남긴다.
// 정치 롱폼(politics)도 뺀다(2026-10-14 소유주) — 롱폼은 24시간 조회로 판정하지 않는다. ja 정치(politics_ja)도 같다(관리자 10-18, 포장 교체만).
const EXCLUDE = new Set(['shopping', 'shopping_old_ssulmo', 'politics', 'politics_ja']);
const PURPOSES = new Set(String(opt('--purposes', '')).split(',').map((x) => x.trim()).filter(Boolean));
// 새 채널 유예(2026-10-14 소유주, 팬튜브 건): 프로필 createdAt(=yt-connect 로 연결한 날)부터 --grace-days(기본 14)일 동안은
//   판정하지 않는다 — 새 채널 첫 쇼츠는 24시간 100회를 못 넘는 게 정상이다. 따로 알릴 필요 없이 연결 날짜로 자동 적용된다.
const GRACE_DAYS = Number(opt('--grace-days', 14));
const ZERO_HOURS = Number(opt('--zero-hours', 6));
const SHORT_MAX_SEC = 180;

function seconds(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  return m ? ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0)) : Infinity;
}

// 잡탕 광산 결 시험 편(2026-10-30 소유주 오피스 «진행»): 공개 48h 판정이 끝날 때까지 저조회 비공개에서 뺀다 — 판정 자료가 사라진다.
//   식별: 유튜브 태그 «jabtang-gNN»(N100) 또는 docs/jabtang-mine/drops.jsonl·status.json 의 영상 id. 48h 뒤엔 원래 규칙대로.
//   가이드 0회(guideline_zero_feed)는 채널 안전 규칙이라 그대로 둔다.
const JABTANG_HOURS = 48;
const JABTANG_IDS = (() => {
  const ids = new Set();
  const dir = path.join(ROOT, 'docs', 'jabtang-mine');
  try { for (const l of fs.readFileSync(path.join(dir, 'drops.jsonl'), 'utf8').split(/\r?\n/)) { try { const j = JSON.parse(l); if (j.video_id) ids.add(j.video_id); } catch {} } } catch {}
  try { const st = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
    for (const g of st.gyeol || []) for (const d of g.drops || []) { const m = /(?:v=|shorts\/|youtu\.be\/)([\w-]{11})/.exec(d.url || '') || [null, d.video_id]; if (m[1]) ids.add(m[1]); } } catch {}
  return ids;
})();
const isJabtangTest = (x) => JABTANG_IDS.has(x.id) || (x.snippet.tags || []).some((t) => /^jabtang-g\d+$/i.test(t));

// 판정 하나: 'guideline_zero_feed' | 'low_views' | null
function judge(x, now = Date.now(), o = {}) {
  const min = o.min ?? MIN, hours = o.hours ?? HOURS, zeroHours = o.zeroHours ?? ZERO_HOURS;
  if (x.status.privacyStatus !== 'public') return null;
  const hrs = (now - Date.parse(x.snippet.publishedAt)) / 36e5;
  const jabtangHold = isJabtangTest(x) && hrs < JABTANG_HOURS;
  const views = Number(x.statistics.viewCount || 0);
  if (views === 0 && hrs >= zeroHours && seconds(x.contentDetails?.duration) <= SHORT_MAX_SEC) return 'guideline_zero_feed';
  // 24h 저조회는 쇼츠만 — 롱폼은 24시간 조회로 판정하지 않는다(10-14 소유주). 10-22 수창 롱폼이 沼落ち(jp_highlight)에 들어와서 길이로 가른다.
  if (!jabtangHold && hrs >= hours && views < min && seconds(x.contentDetails?.duration) <= SHORT_MAX_SEC) return 'low_views';
  return null;
}
const STATE = path.join(ROOT, 'server', 'data', 'rinbox_publish_state.json');
function markState(id, rec) {
  try {
    const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    let hit = false;
    for (const h of st.history || []) if (String(h.url || '').endsWith('v=' + id)) { Object.assign(h, rec); hit = true; }
    if (hit) fs.writeFileSync(STATE, JSON.stringify(st, null, 2) + '\n', 'utf8');
  } catch (e) { console.log('  (발행 기록 갱신 실패: ' + e.message + ')'); }
}

async function token(p) {
  const body = new URLSearchParams({ client_id: p.oauthClientId, client_secret: p.oauthClientSecret,
    refresh_token: p.refreshToken, grant_type: 'refresh_token' });
  const j = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' } })).json();
  if (!j.access_token) throw new Error('토큰 갱신 실패');
  return j.access_token;
}
const get = async (tk, url) => {
  const j = await (await fetch(url, { headers: { authorization: 'Bearer ' + tk } })).json();
  if (j.error) throw new Error(j.error.message);
  return j;
};

async function main() {
  const store = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  const profiles = (Array.isArray(store) ? store : (store.profiles || []))
    .filter((p) => p.refreshToken && !EXCLUDE.has(p.purpose) && (!ONLY || p.purpose === ONLY)
      && (!PURPOSES.size || PURPOSES.has(p.purpose)));
  const since = Date.now() - DAYS * 864e5;
  let total = 0;
  for (const p of profiles) {
    const age = (Date.now() - Date.parse(p.createdAt || 0)) / 864e5;
    if (p.createdAt && age < GRACE_DAYS) {
      console.log(`
[${p.purpose}] ${p.channelTitle || ''} — 연결 ${age.toFixed(1)}일째, 새 채널 유예 ${GRACE_DAYS}일 중이라 건너뜀`);
      continue;
    }
    let tk;
    try { tk = await token(p); } catch (e) { console.log(`\n[${p.purpose}] ${p.channelTitle || ''} — ${e.message}`); continue; }
    const ch = await get(tk, 'https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&mine=true');
    const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    const title = ch.items?.[0]?.snippet?.title || p.channelTitle;
    if (!uploads) { console.log(`\n[${p.purpose}] ${title} — 업로드 목록 없음`); continue; }
    const ids = [];
    let pageToken = '';
    for (let i = 0; i < 20; i += 1) {
      const pl = await get(tk, `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}${pageToken ? '&pageToken=' + pageToken : ''}`);
      let old = false;
      for (const it of pl.items || []) {
        if (Date.parse(it.contentDetails.videoPublishedAt || 0) < since && it.contentDetails.videoPublishedAt) { old = true; continue; }
        ids.push(it.contentDetails.videoId);
      }
      if (old || !pl.nextPageToken) break;
      pageToken = pl.nextPageToken;
    }
    const low = [];
    for (let i = 0; i < ids.length; i += 50) {
      const v = await get(tk, `https://www.googleapis.com/youtube/v3/videos?part=snippet,status,statistics,contentDetails&id=${ids.slice(i, i + 50).join(',')}`);
      for (const x of v.items || []) {
        const why = judge(x);
        if (!why) continue;
        low.push({ x, hrs: (Date.now() - Date.parse(x.snippet.publishedAt)) / 36e5, views: Number(x.statistics.viewCount || 0), why });
      }
    }
    console.log(`\n[${p.purpose}] ${title} — 최근 ${DAYS}일 ${ids.length}편 중 조회 ${MIN} 미만(${HOURS}h)·0회 쇼츠(${ZERO_HOURS}h) ${low.length}편${APPLY ? '' : ' (목록만)'}`);
    for (const { x, hrs, views, why } of low) {
      let res = '';
      if (APPLY) {
        const st = x.status;
        const j = await (await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', {
          method: 'PUT', headers: { authorization: 'Bearer ' + tk, 'content-type': 'application/json' },
          body: JSON.stringify({ id: x.id, status: { privacyStatus: 'private', selfDeclaredMadeForKids: st.selfDeclaredMadeForKids,
            embeddable: st.embeddable, license: st.license, publicStatsViewable: st.publicStatsViewable } }) })).json();
        res = j.error ? ` 실패: ${j.error.message}` : ' → 비공개';
        if (!j.error) markState(x.id, { lowViewsPrivatedAt: new Date().toISOString(), lowViewsAtPrivate: views, lowViewsRule: why === 'guideline_zero_feed' ? `0 @${ZERO_HOURS}h` : `<${MIN} @${HOURS}h`, lowViewsReason: why });
        fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), purpose: p.purpose, id: x.id, title: x.snippet.title, views, hours: Math.round(hrs), ok: !j.error }) + '\n', 'utf8');
      }
      console.log(`  ${String(views).padStart(2)}회 ${String(Math.round(hrs)).padStart(4)}h  ${x.id}  ${x.snippet.title.slice(0, 40)}${why === 'guideline_zero_feed' ? ' [가이드 0회]' : ''}${res}`);
      total += 1;
    }
  }
  console.log(`\n합계 ${total}편${APPLY ? ' 처리' : ' — 실제 비공개는 --apply'}`);
}

module.exports = { judge, seconds };
if (require.main === module) main().catch((e) => { console.error('[yt-low-views]', e.message); process.exitCode = 1; });

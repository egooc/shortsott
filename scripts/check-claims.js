// Content ID preflight, layer 3 — automated. Reads whether a scheduled upload came back
// region-blocked, BEFORE it goes public.
//
//   node scripts/check-claims.js [--all] [--unschedule] [--json]
//
// The casebook said this layer could not be automated because Studio's Checks tab has no API.
// That is true of the tab, but not of its OUTCOME: a claim whose policy blocks shows up in
// videos.list as contentDetails.regionRestriction.blocked. Measured 2026-09-01 on four uploads
// of the same film - the two that were blocked worldwide carry the field listing every country,
// the two that passed have no regionRestriction key at all.
//
// So the check that was being done by eye, once, on the owner's phone, runs here instead. It
// matters because the window is the whole point of uploading private+publishAt: today's pair
// sat unwatched for six and a half hours and published into a worldwide block.
//
// Default is report-only. --unschedule additionally pulls the scheduled publish on anything
// blocked, so a dead video does not go public: the video stays private and the slot frees up.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); }
catch { /* env comes from the process */ }

const YT_STATE = path.join(ROOT, 'server', 'data', 'auto_publish_state.json');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const REPORTS_DIR = path.join(ROOT, 'server', 'output', 'claim-reports');

function parseArgs(argv) {
  const args = { all: false, unschedule: false, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--all') args.all = true;
    else if (argv[i] === '--unschedule') args.unschedule = true;
    else if (argv[i] === '--json') args.json = true;
  }
  return args;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

async function accessToken(profile) {
  const body = new URLSearchParams({
    client_id: profile.oauthClientId,
    client_secret: profile.oauthClientSecret,
    refresh_token: profile.refreshToken,
    grant_type: 'refresh_token'
  });
  const data = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body })).json();
  if (!data.access_token) throw new Error(`token refresh failed: ${JSON.stringify(data).slice(0, 140)}`);
  return data.access_token;
}

// A worldwide block lists every country; a territorial one lists some. Both matter, but only
// the first makes the video worthless, so they are reported apart.
function blockShape(item) {
  const blocked = ((item.contentDetails || {}).regionRestriction || {}).blocked || [];
  // licensedContent — 소유권이 매칭됐다는 표시다. **보고만 한다.**
  //   2026-09-29 에는 이것도 차단과 같이 취급했다(매칭된 ja 편이 4회에서 멈췄다는 근거).
  //   2026-09-30 철회: 그 4회는 매칭 때문이 아니라 내가 비공개로 돌려서 나온 숫자였다.
  //   2026-06 ja 는 44/46 이 매칭인 채로 편당 8,288회였다 — 매칭 자체는 도달을 죽이지 않는다.
  //   여전히 볼 값이긴 하다(소재 권리 상태를 알려 준다). 다만 발행을 막는 기준은 아니다.
  const licensed = ((item.contentDetails || {}).licensedContent === true);
  if (!blocked.length) return { blocked: false, licensed, countries: 0, worldwide: false };
  return { blocked: true, licensed, countries: blocked.length, worldwide: blocked.length >= 200 };
}

// Drop the scheduled publish without touching anything else in the snippet: videos.update
// replaces the parts it is given, so status must be sent whole.
async function unschedule(token, item) {
  const status = { ...(item.status || {}) };
  delete status.publishAt;
  status.privacyStatus = 'private';
  const response = await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: item.id, status })
  });
  if (!response.ok) throw new Error(`unschedule ${item.id}: ${response.status} ${(await response.text()).slice(0, 600)}`);
}

// ── 소셜 확산 동시 취소 (2026-09-06) ──
// 유튜브 예약만 내리면 반쪽이다: blotato-publish 는 같은 publishAt 으로 TikTok/IG/Threads/FB 에
// 확산 예약을 걸어두므로, 차단 판정난 영상이 유튜브에서만 빠지고 소셜엔 예정대로 나간다
// (09-01 벨라 볼테라가 정확히 그렇게 나갔다). Blotato v2 에 예약 취소 전용 라우트가 확인되지
// 않아(DELETE /posts/* 는 라우트 없음, 실측 2026-09-06) DELETE /schedules/{id} 를 시도하고,
// 안 되면 크게 소리내어 사람을 부른다 — 조용한 실패가 이 구멍의 원형이다.
const BLOTATO_STATE = path.join(ROOT, 'server', 'data', 'blotato_publish_state.json');

async function blotatoApi(method, endpoint) {
  // 발행 경로 스위치(10-29): Zernio 글·건너뛴 글·Blotato 끔은 공용 api() 가 판단한다(이 함수는 예전에 zernio: id 도 Blotato 에 물었다)
  if (require('./publish-routes').blotatoOff() || /^\/(?:posts|schedules)\/(?:zernio|skip):/.test(endpoint)) return require('./blotato-publish').api(method, endpoint);
  const key = String(process.env.BLOTATO_API_KEY || '').trim();
  if (!key) throw new Error('BLOTATO_API_KEY is not set');
  const response = await fetch(`https://backend.blotato.com/v2${endpoint}`, {
    method, headers: { 'blotato-api-key': key }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${endpoint} -> ${response.status} ${text.slice(0, 160)}`);
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

async function cancelSocialForDraft(draftName) {
  const pending = (readJson(BLOTATO_STATE, { history: [] }).history || [])
    .filter((h) => h.draft === draftName && h.submissionId
      && Date.parse(h.scheduledTime || 0) > Date.now());
  const results = [];
  for (const post of pending) {
    let status = '';
    try { status = String((await blotatoApi('GET', `/posts/${post.submissionId}`) || {}).status || ''); }
    catch { /* status is advisory */ }
    if (status === 'published') {
      results.push(`${post.platform}: 이미 발행됨 — Blotato/플랫폼에서 손으로 삭제할 것`);
      continue;
    }
    try {
      await blotatoApi('DELETE', `/schedules/${post.submissionId}`);
      results.push(`${post.platform}: 예약 취소됨`);
    } catch (error) {
      results.push(`${post.platform}: **취소 실패 — Blotato 대시보드에서 손으로 내릴 것** (${String(error.message).slice(0, 100)})`);
    }
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  const state = readJson(YT_STATE, { history: [] });
  const now = Date.now();
  const entries = (state.history || []).filter((h) => {
    if (!h.url) return false;
    if (args.all) return true;
    // Default: only what has not gone public yet — that is the window where this is actionable.
    return Date.parse(h.publishAt || 0) > now;
  });

  const raw = readJson(PROFILES, []);
  const profiles = Array.isArray(raw) ? raw : (raw.profiles || []);
  const byLocale = {
    ko: profiles.find((p) => p.purpose === 'ko_highlight'),
    ja: profiles.find((p) => p.purpose === 'jp_highlight')
  };

  const rows = [];
  let stateDirty = false;
  for (const [locale, profile] of Object.entries(byLocale)) {
    const mine = entries.filter((h) => h.locale === locale);
    if (!mine.length || !profile) continue;
    const ids = mine.map((h) => (/[?&]v=([\w-]+)/.exec(h.url) || [])[1]).filter(Boolean);
    if (!ids.length) continue;
    let token;
    try { token = await accessToken(profile); }
    catch (error) { rows.push({ locale, error: error.message }); continue; }
    const data = await (await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=status,contentDetails,snippet&id=${ids.join(',')}`,
      { headers: { Authorization: `Bearer ${token}` } }
    )).json();
    for (const item of data.items || []) {
      const entry = mine.find((h) => h.url.includes(item.id)) || {};
      const shape = blockShape(item);
      const row = {
        locale,
        videoId: item.id,
        draft: entry.draft || '',
        title: (item.snippet || {}).title || '',
        privacy: (item.status || {}).privacyStatus || '',
        publishAt: (item.status || {}).publishAt || entry.publishAt || '',
        durationSec: null,
        ...shape
      };
      const iso = ((item.contentDetails || {}).duration || '').match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
      if (iso) row.durationSec = Number(iso[1] || 0) * 60 + Number(iso[2] || 0);
      // A scheduled upload is private WITH publishAt — that is exactly the case to unschedule (2026-09-18 fix: the old
      // `privacy !== 'private'` gate meant --unschedule never fired on anything this script is for).
      // ★2026-09-21 두 번째 수리: 게이트가 **유튜브 응답의** publishAt 만 봤다. 예약 시각이 지나면
      //   API 가 그 칸을 비우므로, 우리 기록에는 예약이 남아 있는데 게이트는 통과하지 못했다.
      //   실측: 차단 5건 전부 `unscheduled=None` — 이 스크립트의 존재 이유인 동작이 한 번도 돈 적이 없다.
      //   그래서 두 곳 중 **어디서든** 예약을 봤으면 해제한다(row.publishAt 은 둘을 합친 값이다).
      //   이미 비공개인 영상에 다시 비공개를 거는 것은 무해하다.
      // ★2026-09-30 철회: 소유권 매칭(licensedContent)으로는 **예약을 내리지 않는다.**
      //   2026-09-29 에 「매칭된 ja 편이 4회에서 멈췄다」를 근거로 내리게 해 뒀는데, 그 4회는
      //   매칭이 만든 숫자가 아니라 **내린 것이 만든 숫자**였다 — 발행 창 동안 비공개였으니
      //   조회가 없는 게 당연하다. 순환 논증이었다.
      //   반례가 분명하다: 2026-06 ja 는 46편 중 44편이 매칭인데 편당 8,288회였다.
      //   매칭은 이 채널의 사실상 전편에 붙는 상태값이라(4개월 96~100%) 발행 여부의 기준이 될 수 없다.
      //   그래서 매칭은 **보고만** 한다. 예약을 내리는 것은 지역 차단(regionRestriction)뿐이다
      //   — 그건 봐도 안 보이는 상태라 내리는 게 맞다.
      const pull = shape.blocked && (row.publishAt || row.privacy !== 'private');
      if (pull && args.unschedule) {
        try { await unschedule(token, item); row.unscheduled = true; }
        catch (error) { row.unscheduleError = error.message; }
        // ★2026-09-22: 유튜브에서만 내리고 «우리 장부»는 그대로 둬서 그 슬롯이 계속
        //   점유된 것처럼 보였다. auto-publish 는 state.history 의 publishAt 으로 빈 슬롯을
        //   찾으므로, 차단된 편이 18:00 자리를 붙들고 앉아 그날 한 편이 통째로 날아갔다.
        //   해제했으면 장부에서도 예약을 지운다 — 기록은 남기고 자리만 비운다.
        if (row.unscheduled) {
          for (const h of state.history || []) {
            if (!h.url || !h.url.includes(item.id)) continue;
            // ★2026-09-30 수리: 이 자리에 `&& h.publishAt` 가 있었다. 예약이 한 번 해제되면
            //   그 뒤로는 blockedAt 이 **영영 안 붙는다.** 그래서 차단된 편이 장부에서
            //   «차단 아님»으로 집계됐고, 내가 소유주께 차단율을 42% 로 보고했다.
            //   전수 재검사로 21편이 뒤늦게 붙었고 실제는 67% 였다.
            //   → 차단 사실 기록과 예약 해제를 분리한다. 기록은 조건 없이, 해제는 있을 때만.
            if (!h.blockedAt) { h.blockedAt = new Date().toISOString(); stateDirty = true; }
            if (h.publishAt) {
              h.blockedPublishAt = h.publishAt;
              h.publishAt = '';
              stateDirty = true;
            }
          }
        }
        // 소유주 판단(2026-09-18): Content ID 는 유튜브 전용이다. 인스타·틱톡·스레드·페북은 차단과 무관하게 그대로 나간다.
        // 소셜까지 내리려면 --cancel-social 을 명시할 것(09-01 벨라 볼테라처럼 유튜브만 빠지는 상황을 다시 만들 때).
        if (entry.draft && process.argv.includes('--cancel-social')) row.socialCancel = await cancelSocialForDraft(entry.draft);
      }
      rows.push(row);
    }
  }

  if (stateDirty) {
    try { fs.writeFileSync(YT_STATE, JSON.stringify(state, null, 2)); }
    catch (error) { console.error('장부 갱신 실패:', error.message); }
  }

  if (args.json) { console.log(JSON.stringify(rows, null, 2)); return; }

  // ★조치·종료코드는 **지역 차단만** 본다. 매칭은 이 채널 사실상 전편에 붙어 있어서
  //   여기에 넣으면 ja 실행이 언제나 exit 1 이 되고, 부르는 쪽에서 실패로 읽힌다.
  const blocked = rows.filter((r) => r.blocked);
  const matched = rows.filter((r) => !r.blocked && r.licensed);
  const lines = [`# Content ID 3층 자동 확인 ${new Date().toISOString()}`, ''];
  if (!rows.length) lines.push('_확인 대상 없음 (공개 대기 중인 업로드가 없습니다)._');
  for (const r of rows) {
    if (r.error) { lines.push(`- 조회 실패 [${r.locale}]: ${r.error}`); continue; }
    const bad = r.blocked || r.licensed;
    const mark = r.blocked ? (r.worldwide ? '전세계 차단' : `${r.countries}개국 차단`)
      : r.licensed ? '소유권 매칭(licensedContent) — 참고값. 발행은 막지 않는다'
      : '클레임 없음';
    lines.push(`- ${bad ? '**' : ''}${mark}${bad ? '**' : ''} [${r.locale}] ${r.durationSec}s ${r.videoId} — ${r.title.slice(0, 40)}`
      + (r.unscheduled ? ' → 예약 해제됨' : '') + (r.unscheduleError ? ` → 해제 실패: ${r.unscheduleError}` : ''));
    for (const s of r.socialCancel || []) lines.push(`  - 소셜 ${s}`);
  }
  if (blocked.length) {
    lines.push('', '## 조치',
      '- 차단된 편은 공개해도 조회 0이다. 예약을 해제하고(`--unschedule`) 케이스북 배급사 대장에 결과를 기록할 것.',
      '- 같은 영화의 다른 컷도 위험하다. 1~3분 Short은 클레임이 붙으면 정책과 무관하게 차단된다.');
  }
  if (matched.length) {
    lines.push('', `## 참고 — 소유권 매칭 ${matched.length}건`,
      '- 매칭은 발행을 막지 않는다. 2026-06 ja 는 44/46 이 매칭인 채로 편당 8,288회였다.',
      '- 이 값으로 예약을 내리지 말 것. 2026-09-29 에 그렇게 했다가 발행 창을 날렸다(조회 3~4회는 그 결과다).');
  }
  const text = lines.join('\n');
  console.log(text);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  fs.appendFileSync(path.join(REPORTS_DIR, `${stamp}-claims.md`), `${text}\n\n`, 'utf8');
  if (blocked.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('check-claims fatal:', error.message || error);
  process.exitCode = 1;
});

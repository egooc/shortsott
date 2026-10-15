// 이미 올라간 린박스 편 중 «폭력·도박 장면인데 픽션 안내문이 없는» 편에 안내문을 덧붙인다.
//
//   node scripts/rinbox-desc-safety.js [ko|ja]           목록만 (기본)
//   node scripts/rinbox-desc-safety.js [ko|ja] --apply   실제로 설명란을 고친다
//
// 왜 (2026-10-12 소유주 전자책 1장): 총기·폭력 장면은 설명란에 «드라마 연출이며 소품»이라 적어 두면
// 노출 저하를 덜 맞는다. 발행기(rinbox-publish)는 이제 새 편에 자동으로 붙이지만 지난 편은 비어 있다.
// ★videos.update 는 snippet 을 통째로 바꾼다 — _yt-describe.js 처럼 원래 값을 읽어 와 description 만 바꾼다.
// ★공개된 영상을 고치는 일이라 기본은 목록만 보여 준다. --apply 는 사람이 보고 나서.
require('dotenv').config({ path: 'D:/midform/.env' });
const fs = require('fs');
const path = require('path');
const { riskOf, needsNote, withNote, describeHits } = require('./lib/feedSafety');

const ROOT = path.resolve(__dirname, '..');
const STATE = path.join(ROOT, 'server', 'data', 'rinbox_publish_state.json');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const PURPOSE = { ko: 'ko_highlight', ja: 'jp_highlight' };

const args = process.argv.slice(2);
const WANT = args.find((a) => !a.startsWith('--')) || '';
const APPLY = args.includes('--apply');

async function token(p) {
  const body = new URLSearchParams({
    client_id: p.oauthClientId, client_secret: p.oauthClientSecret,
    refresh_token: p.refreshToken, grant_type: 'refresh_token'
  });
  const j = await (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }
  })).json();
  if (!j.access_token) throw new Error('토큰 갱신 실패');
  return j.access_token;
}

(async () => {
  const hist = (JSON.parse(fs.readFileSync(STATE, 'utf8')).history || [])
    .filter((e) => e.url && !e.retracted).filter((e) => !WANT || e.locale === WANT);
  const store = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  const profiles = Array.isArray(store) ? store : (store.profiles || []);

  for (const loc of [...new Set(hist.map((e) => e.locale))].sort()) {
    const prof = profiles.find((x) => x.purpose === PURPOSE[loc]);
    if (!prof) { console.log(`[${loc}] 업로드 프로필 없음 — 건너뜀`); continue; }
    const tk = await token(prof);
    const ids = [...new Set(hist.filter((e) => e.locale === loc)
      .map((e) => (/[?&]v=([\w-]{11})/.exec(e.url) || /shorts\/([\w-]{11})/.exec(e.url) || [])[1]).filter(Boolean))];
    const todo = [];
    for (let i = 0; i < ids.length; i += 50) {
      const r = await (await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id='
        + ids.slice(i, i + 50).join(','), { headers: { authorization: 'Bearer ' + tk } })).json();
      if (r.error) throw new Error(r.error.message);
      for (const v of r.items || []) {
        if (!needsNote(v.snippet.title, v.snippet.description)) continue;
        todo.push(v);
      }
    }
    console.log(`\n══ ${loc}: 안내문이 필요한 편 ${todo.length}개${APPLY ? '' : ' (목록만 — 반영은 --apply)'}`);
    for (const v of todo) {
      console.log(`  ${v.id}  [${v.status.privacyStatus}]  ${v.snippet.title.slice(0, 32)}  — ${describeHits(riskOf(v.snippet.title, v.snippet.description))}`);
      if (!APPLY) continue;
      const s = v.snippet;
      const snippet = {
        title: s.title,
        description: withNote(s.description, loc, s.title),
        tags: s.tags || [],
        categoryId: s.categoryId,
        defaultLanguage: s.defaultLanguage,
        defaultAudioLanguage: s.defaultAudioLanguage
      };
      const j = await (await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet', {
        method: 'PUT',
        headers: { authorization: 'Bearer ' + tk, 'content-type': 'application/json' },
        body: JSON.stringify({ id: v.id, snippet })
      })).json();
      console.log(j.error ? `    실패: ${JSON.stringify(j.error).slice(0, 200)}` : '    반영됨');
    }
  }
})().catch((e) => { console.error('[desc-safety]', e.message); process.exitCode = 1; });

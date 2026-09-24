// 끊긴 프로브를 «영상 ID 만으로» 이어서 회수한다.
//
// 왜 필요한가: claim-probe.js 는 폴링 루프가 끝난 «뒤에야» 장부에 적는다. 150분 창(사례 106)을
// 다 돌기 전에 프로세스가 죽으면 비공개 업로드는 남는데 장부에 아무 흔적이 없고 --recheck 도 못 찾는다.
// 창을 30분 → 150분 으로 늘린 만큼 «오래 기다릴수록 잃기 쉬운» 모양이 됐다. 이 스크립트가 그 구멍을 메운다.
//
//   node scripts/probe-resume.js <videoId> --locale ko|ja [--movie-key k] [--until-min 150] [--poll-sec 120] [--log <file>]
//
// 업로드 시각은 YouTube 가 들고 있는 publishedAt 을 쓴다 — 우리 쪽 기록이 없어도 나이를 정확히 잰다.
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const LEDGER = path.join(ROOT, 'server', 'data', 'claim_probes.json');
const CATALOG = path.join(ROOT, 'midform', 'config', 'movie_catalog.json');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const rj = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

async function accessToken(p) {
  const body = new URLSearchParams({ client_id: p.oauthClientId, client_secret: p.oauthClientSecret, refresh_token: p.refreshToken, grant_type: 'refresh_token' });
  const d = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body })).json();
  if (!d.access_token) throw new Error(`token refresh failed: ${JSON.stringify(d).slice(0, 140)}`);
  return d.access_token;
}
async function state(token, id) {
  const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status,contentDetails,snippet&id=${id}`, { headers: { Authorization: `Bearer ${token}` } });
  const it = ((await r.json()).items || [])[0] || null;
  if (!it) return null;
  const blocked = ((it.contentDetails || {}).regionRestriction || {}).blocked || [];
  return { blocked: blocked.length > 0, countries: blocked.length, worldwide: blocked.length >= 200,
    uploadStatus: (it.status || {}).uploadStatus || '', at: it.snippet.publishedAt };
}

(async () => {
  const id = process.argv[2];
  if (!id) throw new Error('usage: node scripts/probe-resume.js <videoId> --locale ko|ja [--movie-key k] [--until-min 150]');
  const locale = arg('--locale', 'ko'); const movieKey = arg('--movie-key', '');
  const untilMin = Number(arg('--until-min', '150')); const pollSec = Number(arg('--poll-sec', '120'));
  const logFile = arg('--log', '');
  const say = (s) => { console.log(s); if (logFile) try { fs.appendFileSync(logFile, s + '\n'); } catch { /* 로그는 부차적이다 */ } };

  const profile = (rj(PROFILES, { profiles: [] }).profiles || []).find((x) => x.purpose === (locale === 'ko' ? 'ko_highlight' : 'jp_highlight'));
  if (!profile) throw new Error(`no upload profile for ${locale}`);

  let st = await state(await accessToken(profile), id);
  if (!st) throw new Error(`${id}: 이 계정에 없다 (이미 지웠거나 다른 프로필)`);
  const age = () => Math.round((Date.now() - Date.parse(st.at)) / 60000);
  say(`[resume] ${movieKey || id} [${locale}] ${id} — 업로드 +${age()}min · ${untilMin}min 까지 이어 본다`);

  let verdict = null;
  while (age() < untilMin) {
    st = await state(await accessToken(profile), id) || st;
    if (st.blocked) { verdict = st.worldwide ? 'BLOCKED-WORLDWIDE' : `BLOCKED-${st.countries}`; say(`[resume] +${age()}min ${verdict}`); break; }
    say(`[resume] +${age()}min upload=${st.uploadStatus} blocked=false`);
    // 장부를 «매 바퀴» 갱신한다 — 여기서 죽어도 다음 회차가 이어받을 수 있게(claim-probe 가 못 하던 것).
    writeLedger(`CLEAR-${age()}min`, age());
    await new Promise((r) => setTimeout(r, pollSec * 1000));
  }
  if (!verdict) verdict = `CLEAR-${age()}min`;
  say(`[resume] ${movieKey || id} [${locale}] -> ${verdict}`);
  writeLedger(verdict, age());

  if (verdict.startsWith('BLOCKED') && movieKey) {
    const cat = rj(CATALOG, null);
    if (cat && cat.movies[movieKey]) {
      cat.movies[movieKey].distributor_tier = 'banned';
      cat.movies[movieKey].claim_probe = `${new Date().toISOString().slice(0, 10)} ${locale} ${verdict} (+${age()}min)`;
      fs.writeFileSync(CATALOG, JSON.stringify(cat, null, 2));
      say(`[resume] 카탈로그 ${movieKey} -> banned`);
    }
  }

  function writeLedger(v, minutes) {
    const led = rj(LEDGER, { probes: [] });
    const row = led.probes.find((p) => p.videoId === id);
    if (row) { row.verdict = v; row.minutes = minutes; row.recheckedAt = new Date().toISOString(); }
    else led.probes.push({ at: st.at, locale, movieKey, videoId: id, mode: 'resume', verdict: v, minutes, deleted: false });
    fs.writeFileSync(LEDGER, JSON.stringify(led, null, 2));
  }
})();

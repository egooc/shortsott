// 채널에 남아 있는 프로브 영상을 지운다.
//
//   node scripts/purge-probe-uploads.js           무엇을 지울지 보여주기만 한다
//   node scripts/purge-probe-uploads.js --apply   실제로 지운다
//
// 왜 (2026-09-28 소유주: "차단 기록 하나 더 쌓이고 똑같이 만들어서 돈도 나가고")
//   프로브를 폐지했다(차단 예측 0/16, 사례 149). 그런데 대장을 보니 67건 중 **20건이
//   아직 채널에 비공개로 남아 있다** — 삭제가 실패했거나 `--keep` 으로 돌린 것들이다.
//   지금 남은 가장 유력한 가설이 「계정 단위로 심사가 다르다」인데, 그렇다면 쓸모도 없이
//   클레임 기록만 쌓아 두는 영상들이다. 치운다.
//
// ★대장(`claim_probes.json`)은 지우지 않는다. 프로브가 왜 안 맞았는지가 그 안에 있고,
//   그 기록이 오늘 폐지 결정의 근거다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch { /* 환경에서 온다 */ }
const LEDGER = path.join(ROOT, 'server', 'data', 'claim_probes.json');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const APPLY = process.argv.includes('--apply');

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

async function accessToken(p) {
  const body = new URLSearchParams({
    client_id: p.oauthClientId, client_secret: p.oauthClientSecret,
    refresh_token: p.refreshToken, grant_type: 'refresh_token',
  });
  const d = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body })).json();
  if (!d.access_token) throw new Error(`토큰 갱신 실패: ${JSON.stringify(d).slice(0, 140)}`);
  return d.access_token;
}

(async () => {
  const store = readJson(LEDGER, { probes: [] });
  const probes = store.probes || [];
  const alive = probes.filter((p) => !p.deleted && p.videoId);
  if (!alive.length) { console.log('채널에 남은 프로브 영상 없음'); return; }

  const raw = readJson(PROFILES, []);
  const profiles = Array.isArray(raw) ? raw : (raw.profiles || []);
  const tokens = {};
  for (const locale of ['ko', 'ja']) {
    const want = locale === 'ja' ? 'jp_highlight' : 'ko_highlight';
    const p = profiles.find((x) => x.purpose === want) || profiles[0];
    if (p) tokens[locale] = APPLY ? await accessToken(p) : 'dry';
  }

  let gone = 0;
  let failed = 0;
  for (const p of alive) {
    const locale = p.locale === 'ja' ? 'ja' : 'ko';
    const label = `${String(p.at).slice(0, 10)} ${p.videoId} ${locale} ${(p.movieKey || '(소스조각)').slice(0, 26)}`;
    if (!APPLY) { console.log(`  지울 것  ${label}`); continue; }
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${p.videoId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${tokens[locale]}` } });
    // 204 = 지웠다. 404 = 이미 없다(둘 다 «채널에 없다»로 기록한다).
    if (res.status === 204 || res.status === 404) {
      p.deleted = true;
      p.purged_at = new Date().toISOString();
      gone += 1;
      console.log(`  지움    ${label}${res.status === 404 ? ' (이미 없음)' : ''}`);
    } else {
      failed += 1;
      console.log(`  ★실패  ${label} — HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    }
  }

  if (APPLY) {
    fs.writeFileSync(LEDGER, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    console.log(`\n지움 ${gone}건 · 실패 ${failed}건 · 대장 갱신(기록 자체는 남긴다)`);
  } else {
    console.log(`\n계산만 · 대상 ${alive.length}건. 실제로 지우려면 --apply`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });

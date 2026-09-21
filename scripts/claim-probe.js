// Content ID preflight, layer 0 — BEFORE any editing/TTS/ASR is spent on a source.
//
//   node scripts/claim-probe.js --recheck                       (re-read every probe still on file)
//   node scripts/claim-probe.js <source.mp4 | volcano workdir> --locale ja|ko [--movie-key <catalog key>]
//                               [--start <sec>] [--len 150] [--wait-min 30] [--poll-sec 120] [--keep]
//
// There is no API that asks Content ID "will this be claimed?". What does exist: a private upload is
// scanned within minutes, and a claim whose policy blocks shows up in videos.list as
// contentDetails.regionRestriction.blocked (worldwide = every country listed). Measured 2026-09-01 (New Moon),
// 2026-09-18 (No Country ja: blocked 18 min after upload; Sherlock ko+ja: blocked, published unnoticed).
//
// So: cut a ~150s slice of the source (same length class as a finished 명화관 cut, because the owner's
// block rule is "matched length exceeds the limit they set"), upload it PRIVATE with no publishAt, poll
// until a block appears or the wait runs out, then report and record. The probe is left private (deleting
// needs youtube.force-ssl; run scripts/yt-reauth.js once and pass --delete later) unless the token allows it.
//
// Verdict: BLOCKED (do not produce from this source) / CLEAR-<n>min (no block within the window — not a
// guarantee, claims can land later, so check-claims still runs after the real upload and before publish).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');
const LEDGER = path.join(ROOT, 'server', 'data', 'claim_probes.json');
const CATALOG = path.join(ROOT, 'midform', 'config', 'movie_catalog.json');

function arg(name, fallback) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }

async function accessToken(profile) {
  const body = new URLSearchParams({ client_id: profile.oauthClientId, client_secret: profile.oauthClientSecret,
    refresh_token: profile.refreshToken, grant_type: 'refresh_token' });
  const data = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body })).json();
  if (!data.access_token) throw new Error(`token refresh failed: ${JSON.stringify(data).slice(0, 140)}`);
  return data.access_token;
}

function probeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number(r.stdout.trim()) || 0;
}

function cutSlice(src, start, len, out) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-i', src, '-t', String(len),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg slice failed: ${r.stderr.slice(0, 300)}`);
}

async function upload(token, file, title) {
  const size = fs.statSync(file).size;
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/mp4' },
    body: JSON.stringify({ snippet: { title, description: 'content id probe — private, not for publication', categoryId: '1' },
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: false } })
  });
  if (!init.ok) throw new Error(`upload session ${init.status}: ${(await init.text()).slice(0, 200)}`);
  const put = await fetch(init.headers.get('location'), { method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Length': String(size), 'Content-Type': 'video/mp4' }, body: fs.readFileSync(file) });
  const data = await put.json();
  if (!put.ok || !data.id) throw new Error(`upload failed ${put.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data.id;
}

async function blockState(token, id) {
  const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status,contentDetails&id=${id}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await r.json();
  const item = (data.items || [])[0] || {};
  const blocked = ((item.contentDetails || {}).regionRestriction || {}).blocked || [];
  return { blocked: blocked.length > 0, countries: blocked.length, worldwide: blocked.length >= 200, uploadStatus: (item.status || {}).uploadStatus || '' };
}

async function tryDelete(token, id) {
  const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  return r.status === 204;
}

async function recheck() {
  // Re-read every probe still on file (they stay private). A CLEAR verdict is only "not yet"; Sherlock's raw
  // slice was still clear 30 min in while its two published cuts were already blocked worldwide (2026-09-18).
  const ledger = readJson(LEDGER, { probes: [] }); const store = readJson(PROFILES, { profiles: [] });
  for (const p of ledger.probes) {
    if (p.deleted) continue;
    const profile = (store.profiles || []).find((x) => x.purpose === (p.locale === 'ko' ? 'ko_highlight' : 'jp_highlight'));
    const st = await blockState(await accessToken(profile), p.videoId);
    const age = Math.round((Date.now() - Date.parse(p.at)) / 60000);
    const verdict = st.blocked ? (st.worldwide ? 'BLOCKED-WORLDWIDE' : `BLOCKED-${st.countries}`) : `CLEAR-${age}min`;
    const changed = verdict.startsWith('BLOCKED') !== String(p.verdict).startsWith('BLOCKED');
    p.verdict = verdict; p.recheckedAt = new Date().toISOString();
    console.log(`[recheck] ${p.movieKey || p.source} [${p.locale}] ${p.videoId} +${age}min -> ${verdict}${changed ? '  ** CHANGED' : ''}`);
    if (st.blocked && p.movieKey) {
      const cat = readJson(CATALOG, null);
      if (cat && cat.movies[p.movieKey]) { const m = cat.movies[p.movieKey]; m.distributor_tier = 'banned'; m.claim_probe = `${new Date().toISOString().slice(0, 10)} ${p.locale} ${verdict} (+${age}min)`; fs.writeFileSync(CATALOG, JSON.stringify(cat, null, 2)); }
    }
  }
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
}

async function main() {
  if (process.argv[2] === '--recheck') return recheck();
  const target = process.argv[2];
  if (!target) throw new Error('usage: node scripts/claim-probe.js <source.mp4|workdir> --locale ja|ko [--movie-key k] [--start s] [--len 150] [--wait-min 30]');
  const locale = arg('--locale', 'ja'); const movieKey = arg('--movie-key', '');
  const len = Number(arg('--len', '150')); const waitMin = Number(arg('--wait-min', '30')); const pollSec = Number(arg('--poll-sec', '120'));
  let src = target;
  if (fs.statSync(target).isDirectory()) {
    src = ['volcano_src.orig.mp4', 'volcano_src.mp4'].map((n) => path.join(target, n)).find((p) => fs.existsSync(p));
    if (!src) throw new Error(`no volcano_src in ${target}`);
  }
  const dur = probeDuration(src);
  const start = Number(arg('--start', String(Math.max(0, Math.round((dur - len) / 2)))));
  const store = readJson(PROFILES, { profiles: [] });
  const profile = (store.profiles || []).find((p) => p.purpose === (locale === 'ko' ? 'ko_highlight' : 'jp_highlight'));
  if (!profile) throw new Error(`no upload profile for ${locale}`);

  const tmp = path.join(require('os').tmpdir(), `claim-probe-${Date.now()}.mp4`);
  cutSlice(src, start, Math.min(len, dur - start), tmp);
  const token = await accessToken(profile);
  const label = movieKey || path.basename(path.dirname(src) === '.' ? src : path.dirname(src));
  const title = `probe ${label} ${new Date().toISOString().slice(0, 16)}`;
  const id = await upload(token, tmp, title);
  fs.unlinkSync(tmp);
  console.log(`[probe] ${label} [${locale}] ${start}s+${len}s -> https://www.youtube.com/watch?v=${id} (private) — polling ${waitMin} min`);

  const t0 = Date.now(); let state = { blocked: false }; let minutes = 0;
  while (Date.now() - t0 < waitMin * 60 * 1000) {
    await new Promise((r) => setTimeout(r, pollSec * 1000));
    state = await blockState(await accessToken(profile), id);
    minutes = Math.round((Date.now() - t0) / 60000);
    console.log(`[probe] +${minutes}min upload=${state.uploadStatus} blocked=${state.blocked}${state.blocked ? ` (${state.countries} countries${state.worldwide ? ', worldwide' : ''})` : ''}`);
    if (state.blocked) break;
  }
  const verdict = state.blocked ? (state.worldwide ? 'BLOCKED-WORLDWIDE' : `BLOCKED-${state.countries}`) : `CLEAR-${minutes}min`;
  let deleted = false;
  if (!process.argv.includes('--keep')) deleted = await tryDelete(await accessToken(profile), id).catch(() => false);

  const ledger = readJson(LEDGER, { probes: [] });
  ledger.probes.push({ at: new Date().toISOString(), locale, movieKey, source: src, start, len, videoId: id, verdict, minutes, deleted });
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
  if (movieKey) {
    const cat = readJson(CATALOG, null);
    if (cat && cat.movies && cat.movies[movieKey]) {
      const m = cat.movies[movieKey];
      m.claim_probe = `${new Date().toISOString().slice(0, 10)} ${locale} ${start}s+${len}s ${verdict}`;
      if (state.blocked) { m.distributor_tier = 'banned'; m.note = `${m.note ? m.note + ' | ' : ''}claim-probe ${verdict} ${new Date().toISOString().slice(0, 10)}`; }
      fs.writeFileSync(CATALOG, JSON.stringify(cat, null, 2));
    }
  }
  console.log(`[probe] VERDICT ${verdict} | probe video ${deleted ? 'deleted' : 'left private (delete needs youtube.force-ssl)'}${movieKey ? ` | catalog ${movieKey} updated` : ''}`);
  process.exit(state.blocked ? 2 : 0);
}

main().catch((e) => { console.error(`[probe] ${e.message}`); process.exit(1); });

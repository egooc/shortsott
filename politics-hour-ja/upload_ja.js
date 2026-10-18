// 정치JA 업로드 한 번에 — 업로드 → 처리 완료 확인 → 태그 → 조회 점검 등록
//   node politics-hour-ja/upload_ja.js <episodeDir> --publish-at <ISO>
// 처리 확인(processingStatus=succeeded, ko yt_processed.js)이 되기 전엔
// 태그·조회 점검을 걸지 않는다(10-18: 미인증 채널 15분 제한으로 처리 거절된 영상을 «업로드 완료»로 믿었다 → 관리자 §7 규칙).
// 소유주 «올려» 뒤에만 실행. 게이트(upload_gate_ja.py)는 먼저 통과시켜 둘 것.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { OAuth2Client } = require(path.join(__dirname, '..', 'node_modules', 'google-auth-library'));

const ROOT = path.join(__dirname, '..');
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };

async function auth() {
  const store = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json'), 'utf8'));
  const p = store.profiles.find((x) => x.purpose === (process.env.PURPOSE || 'politics_ja'));
  if (!p) throw new Error('유튜브 연결 없음(purpose politics_ja)');
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  return { Authorization: `Bearer ${(await c.getAccessToken()).token}` };
}

async function main() {
  const ep = process.argv[2];
  const publishAt = arg('--publish-at');
  const only = arg('--check');   // 이미 올린 영상의 처리 확인→태그→점검만
  if (!ep || (!publishAt && !only)) throw new Error('usage: node politics-hour-ja/upload_ja.js <episodeDir> --publish-at <ISO> | --check <videoId>');
  const meta = path.join(ep, 'upload.json');
  let videoId = only, at = publishAt;
  if (!only) {
    const out = execFileSync('node', [path.join(ROOT, 'scripts', 'yt-upload.js'), meta, '--purpose', 'politics_ja', '--privacy', 'private', '--publish-at', publishAt], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    process.stdout.write(out);
    const last = out.trim().split('\n').reverse().find((l) => l.startsWith('{"videoId"'));
    if (!last) throw new Error('yt-upload 결과에 videoId 없음');
    videoId = JSON.parse(last).videoId;
  }
  // 처리 완료 확인은 ko politics-hour/yt_processed.js 를 쓴다 — yt_tags_ja·ko views_check(8265b53, JA 바닥·조회 0 보류 포함) 가 succeeded 아니면 종료코드 5로 멈춘다
  const done = await require('../politics-hour/yt_processed')(videoId, await auth());
  if (done !== true) { console.error(`[upload-ja] 처리 완료 아님 — ${done} · 태그·점검 안 걸고 멈춤, 관리자 보고`); process.exit(5); }
  if (!at) at = (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status&id=${videoId}`, { headers: await auth() })).json()).items[0].status.publishAt;
  execFileSync('node', [path.join(__dirname, 'yt_tags_ja.js'), videoId, meta, '--gate'], { cwd: ROOT, stdio: 'inherit' });
  if (at) execFileSync('node', [path.join(ROOT, 'politics-hour', 'views_check.js'), videoId, '--schedule', at], { cwd: ROOT, stdio: 'inherit' });
  const pk = path.join(ep, 'packages.json');
  if (fs.existsSync(pk)) {
    const p = JSON.parse(fs.readFileSync(pk, 'utf8'));
    if (p.video_id !== videoId) { p.video_id = videoId; fs.writeFileSync(pk, JSON.stringify(p, null, 2) + '\n', 'utf8'); }
  }
  console.log(JSON.stringify({ videoId, publishAt: at, processed: true }));
}

main().catch((e) => { console.error(e.message); process.exit(1); });

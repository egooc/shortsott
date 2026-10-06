// 예약 발행을 취소하고 비공개로 되돌린다 — 잘못 올린 편을 «지우지 않고» 세우는 길.
//
//   node scripts/_yt-unschedule.js <purpose> <videoId>
//   node scripts/_yt-unschedule.js <purpose> <videoId> --file final-xxxx.mp4
//   node scripts/_yt-unschedule.js <purpose> <videoId> --dry-run
//
// ★--file 을 주면 그 편의 **네이버 클립·페이스북 예약 작업까지 지운다.** 유튜브만 풀면
//   웹 발행 쪽은 그대로 남아, 같은 슬롯을 물려받은 «고친 판»과 함께 두 번 올라간다
//   (2026-10-03 실측: 사마귀 final-8bbe60f8f92ae163 가 10-05 08:00 에 중복 예약돼 있었다).
//
// 왜 (2026-10-02): 린박스 ja 「変身忍者 嵐」 1편에서 자막 한 칸을 잘못 고쳐 올렸다
// (「化身忍者」가 이 작품에서 맞는 말인데 「変身忍者」로 바꿔 뜻이 뒤집혔다).
// 고친 판을 다시 올려야 하는데, **이미 올라간 편을 지우는 것은 되돌릴 수 없다.**
// 예약만 풀어 비공개로 세워 두면 아무에게도 안 보이면서 되돌릴 수도 있다.
// 소유주가 지우라고 하면 그때 지우면 된다.
//
// ★videos.update 는 준 part 를 통째로 바꾼다. status 를 보낼 때는 원래 값을 읽어 와
//   고칠 칸만 바꿔야 한다 — 빠뜨리면 그 칸이 비워진다(_yt-describe.js 와 같은 함정).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = path.join(ROOT, 'server', 'data', 'youtube_upload_profiles.json');

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
  const [purpose, videoId] = process.argv.slice(2);
  const dry = process.argv.includes('--dry-run');
  if (!purpose || !videoId) {
    console.error('쓰는 법: node scripts/_yt-unschedule.js <purpose> <videoId>'
      + ' [--file final-xxxx.mp4] [--dry-run]');
    process.exit(2);
  }
  const store = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
  const list = Array.isArray(store) ? store : (store.profiles || []);
  const p = list.find((x) => x.purpose === purpose);
  if (!p) { console.error('프로필 없음: ' + purpose); process.exit(2); }
  const tk = await token(p);

  const cur = await (await fetch(
    'https://www.googleapis.com/youtube/v3/videos?part=status&id=' + videoId,
    { headers: { authorization: 'Bearer ' + tk } })).json();
  const item = (cur.items || [])[0];
  if (!item) { console.error('영상 없음: ' + videoId); process.exit(2); }

  const st = { ...item.status };
  console.log('현재 ' + videoId + ': privacy=' + st.privacyStatus
    + ' publishAt=' + (st.publishAt || '(없음)'));
  delete st.publishAt;                 // 예약 해제
  st.privacyStatus = 'private';        // 비공개로 세워 둔다(지우지 않는다)
  delete st.publishedAt;               // 읽기 전용 칸은 보내지 않는다

  if (dry) { console.log('dry-run: ' + JSON.stringify(st)); return; }

  const res = await fetch(
    'https://www.googleapis.com/youtube/v3/videos?part=status',
    {
      method: 'PUT',
      headers: { authorization: 'Bearer ' + tk, 'content-type': 'application/json' },
      body: JSON.stringify({ id: videoId, status: st })
    });
  const out = await res.json();
  if (!res.ok) { console.error(JSON.stringify(out)); process.exit(1); }
  // ★응답의 status 는 요청 전 값을 되비칠 때가 있다 — 지웠는지는 다시 읽어서 확인한다.
  const chk = await (await fetch(
    'https://www.googleapis.com/youtube/v3/videos?part=status&id=' + videoId,
    { headers: { authorization: 'Bearer ' + tk } })).json();
  const now = ((chk.items || [])[0] || {}).status || out.status;
  console.log('예약 해제 완료: ' + videoId
    + ' -> privacy=' + now.privacyStatus
    + ' publishAt=' + (now.publishAt || '(없음)'));

  dropWebTasks(argFile(), dry);
})();

// --file 로 받은 편의 웹 발행(네이버 클립·페이스북) 예약 작업을 지운다.
function argFile() {
  const i = process.argv.indexOf('--file');
  return i > 0 ? process.argv[i + 1] : null;
}

function dropWebTasks(file, dry) {
  if (!file) {
    console.log('※ --file 을 주지 않았다 — 네이버 클립·페이스북 예약은 그대로 남는다.'
      + ' 고친 판이 같은 슬롯을 쓰면 두 번 올라간다.');
    return;
  }
  const { execFileSync } = require('child_process');
  for (const site of ['naverclip', 'facebook_profile']) {
    const name = 'midform-' + site + '-' + file;
    if (dry) { console.log('dry-run: 예약 작업 삭제 ' + name); continue; }
    try {
      execFileSync('schtasks', ['/delete', '/tn', name, '/f'], { stdio: 'pipe' });
      console.log('예약 작업 삭제: ' + name);
    } catch (e) {
      // 애초에 없을 수도 있다 — 그건 오류가 아니다.
      console.log('예약 작업 없음(건너뜀): ' + name);
    }
  }
}

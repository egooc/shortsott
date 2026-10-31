// 최애모먼트 태그 넣기·확인 — politics-hour/yt_tags.js 를 팬튜브용으로(yt-upload.js 는 태그를 넣지 않는다, 10/16 쟁점브리핑 태그 0개 사고).
//   node fantube/yt_tags.js <videoId> <upload.json> [--check] [--gate] [--reschedule <ISO>] [--unschedule]
// tags 는 upload.json 의 tags, 없으면 설명란 해시태그 + 기본 묶음. --check 는 개수만 읽는다.
// --title <제목>: 제목도 같이 바꾼다(포장 교체, 10/17 소유주 «트렌드 멤버 먼저»).
// --gate: 넣은 뒤 다시 읽어 0개면 예약을 풀고 비공개로 둔다(공개 금지) — exit 2.
//   단 쓰기 응답이 정상이고 읽기만 0개면 전파 지연이다(10-31 연금 1편 약 30분, 2분 뒤 거짓 취소). 예약을 그대로 두고 더 본다(scripts/yt_tags_pending.js):
//   감시 작업(midform-yt-tags-watch)이 돌면 넘기고 끝(exit 0), 안 돌면 백그라운드 자식(--wait-pending)이 2분 간격으로 최대 47분(공개 20분 전까지) 다시 읽는다 — 부모는 exit 0.
//   자식 기록: D:/volcano-runs/fantube/_upload/tags_<videoId>.log, 결과는 handoff §10 «태그 감시» 줄(확인·취소). 취소는 publishAt:null 로 지우고 다시 읽어 확인(10/20 ep11).
// 종료 코드: 0 확인됨 또는 대기로 넘김 · 2 예약 취소 · 1 실패
// ★videos.update 는 snippet 을 통째로 바꾼다 — 원래 값을 읽어 tags 만 바꿔 돌려보낸다.
const fs = require('fs');
const path = require('path');
const { OAuth2Client } = require(path.join(__dirname, '..', 'node_modules', 'google-auth-library'));
const { spawn } = require('child_process');
const pending = require(path.join(__dirname, '..', 'scripts', 'yt_tags_pending'));
const LOGDIR = 'D:/volcano-runs/fantube/_upload';
const HANDOFF = process.env.YT_TAGS_HANDOFF_FILE || path.join(__dirname, '..', 'docs', 'handoff-manager-20261014.md');
function report(line) {                            // scripts/yt_tags_pending.js 의 report 와 같은 꼴(모듈이 안 내보내서 여기 복사)
  const t = new Date(Date.now() + 9 * 3600e3).toISOString();
  try { fs.appendFileSync(HANDOFF, `- 태그 감시(${t.slice(5, 10)} ${t.slice(11, 16)}): ${line}\n`, 'utf8'); } catch (e) { console.error('[tags] §10 기록 실패', e.message); }
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const BASE = ['엔믹스', 'NMIXX', '규진', 'KYUJIN', '장규진', '엔믹스 규진', 'NMIXX KYUJIN', '최애모먼트', 'kpop', '아이돌', '케이팝', 'shorts'];

function tagsOf(meta) {
  if (Array.isArray(meta.tags) && meta.tags.length) return meta.tags;
  const hash = ((meta.description || '') + ' ' + (meta.title || '')).match(/#[^\s#]+/g) || [];
  const all = [...hash.map((h) => h.slice(1)), ...BASE];
  const out = [];
  for (const t of all) if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  while (out.join(',').length > 450) out.pop();
  return out;
}

(async () => {
  const [videoId, metaPath] = process.argv.slice(2);
  if (!videoId || !metaPath) throw new Error('usage: node fantube/yt_tags.js <videoId> <upload.json> [--check] [--gate]');
  const META = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const tags = tagsOf(META);
  const store = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'data', 'youtube_upload_profiles.json'), 'utf8'));
  const purpose = META.purpose || 'idol3sec_ko';   // 레인별 채널(10/27 코르티스 레인 증설) — upload.json 의 purpose
  const p = store.profiles.find((x) => x.purpose === purpose);
  if (!p) throw new Error(`채널 프로필 없음: purpose=${purpose} — yt-connect.js 로 먼저 연결`);
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  const hdr = async () => ({ Authorization: `Bearer ${(await c.getAccessToken()).token}`, 'Content-Type': 'application/json' });
  let H = await hdr();
  const get = async () => (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${videoId}`, { headers: H })).json()).items?.[0];
  const item = await get();
  if (!item) throw new Error(`영상 없음 ${videoId}`);
  const now = (item.snippet.tags || []).length;
  console.log(`[tags] ${videoId} ${item.snippet.title.slice(0, 40)} — 지금 ${now}개 → ${tags.length}개`);
  if (process.argv.includes('--check')) return;
  if (process.argv.includes('--unschedule')) {      // 교체된 예약분 내리기 — 비공개·예약 없음(10/17 관리자: 장부엔 retracted)
    const st = { privacyStatus: 'private', publishAt: null, selfDeclaredMadeForKids: item.status.selfDeclaredMadeForKids };  // publishAt 을 빼면 예약이 그대로 남는다(10/20 ep11 실측) — null 로 지운다
    const r = await (await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', { method: 'PUT', headers: H, body: JSON.stringify({ id: videoId, status: st }) })).json();
    if (r.error) { console.log(`[tags] 예약 해제 실패 ${JSON.stringify(r.error).slice(0, 200)}`); process.exit(1); }
    const after = (await get()).status;               // 응답 본문은 옛 publishAt 을 돌려줄 때가 있다(10/20 ep09) — 다시 읽은 값으로 판정
    console.log(`[tags] 예약 해제 ${after.privacyStatus} ${after.publishAt || '예약 없음'}`);
    if (after.publishAt) process.exit(1);
    return;
  }
  if (process.argv.includes('--wait-pending')) {    // 백그라운드 자식: 전파 지연을 기다린다(감시 작업이 없을 때). 중간에 죽어도 예약은 그대로다.
    const st = item.status;
    const until = pending.waitUntil(st);
    const expected = tags.length, before = Number(process.env.YT_TAGS_BEFORE || 0);
    const name = `${videoId} ${item.snippet.title.slice(0, 40)} (${purpose})`;
    console.log(`[tags-wait] 시작 ${new Date().toISOString()} · 지금 ${now}개 → ${expected}개 · 예약 ${st.publishAt || '없음'} · ${new Date(until).toISOString()} 까지 2분마다`);
    while (Date.now() < until) {
      await sleep(120e3);
      let a;
      try { H = await hdr(); a = await get(); } catch (e) { console.log(`[tags-wait] 읽기 실패 ${e.message}`); continue; }
      if (!a) { pending.remove(videoId); report(`△ ${name} 영상을 못 찾아 대기 끝냄.`); console.log('[tags-wait] 영상 없음'); return; }
      const k = (a.snippet.tags || []).length;
      const mins = Math.round((Date.now() - Date.parse(a.snippet.publishedAt || 0)) / 60e3);
      console.log(`[tags-wait] ${new Date().toISOString()} ${k}/${expected}`);
      if (k > 0 && k !== before) {
        pending.remove(videoId);
        report(k === expected ? `${name} 태그 ${k}개 확인(업로드 뒤 약 ${mins}분), 예약 ${a.status.publishAt || '없음'} 유지.` : `△ ${name} 태그 ${k}/${expected}개만 보임, 0개가 아니라 예약 유지. 담당 세션 확인.`);
        console.log(`[tags-wait] 확인 ${k}개 · 예약 유지`);
        return;
      }
      if (a.status.privacyStatus !== 'private') { pending.remove(videoId); report(`★사고 ${name} 이미 공개인데 태그 0개. 담당 세션 확인.`); console.log('[tags-wait] 이미 공개·태그 0개'); return; }
    }
    pending.remove(videoId);
    let c;
    try { H = await hdr(); c = await pending.cancelSchedule(videoId, H); } catch (e) { c = { ok: false, why: e.message }; }
    if (c.ok) { report(`★${name} 공개 20분 전까지 태그 0개 → 예약 취소(비공개, 예약 ${c.was || '없음'} 삭제). 담당 세션 확인·수동 태그 뒤 --reschedule.`); console.log(`[tags-wait] 취소 ${c.was || ''}`); process.exit(2); }
    report(`★사고 ${name} 공개 임박·태그 0개인데 예약 취소 실패: ${c.why}. 즉시 수동 --unschedule.`);
    console.log(`[tags-wait] 취소 실패 ${c.why}`);
    process.exit(1);
  }
  const re = process.argv.indexOf('--reschedule');
  if (re > 0) {                                     // 게이트가 푼 예약을 되살린다
    const st = { privacyStatus: 'private', publishAt: new Date(process.argv[re + 1]).toISOString(), selfDeclaredMadeForKids: item.status.selfDeclaredMadeForKids };
    const r = await (await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', { method: 'PUT', headers: H, body: JSON.stringify({ id: videoId, status: st }) })).json();
    console.log(`[tags] 예약 ${r.error ? '실패 ' + JSON.stringify(r.error).slice(0, 200) : r.status.publishAt}`);
    return;
  }
  const s = item.snippet;
  const ti = process.argv.indexOf('--title');
  if (ti > 0) s.title = process.argv[ti + 1];
  const snippet = { title: s.title, description: s.description, tags, categoryId: s.categoryId, defaultLanguage: s.defaultLanguage, defaultAudioLanguage: s.defaultAudioLanguage };
  // 갓 올린 영상은 처리 중이라 403 forbidden 이 난다(ep09, 10/16) — 20초 간격으로 다시
  let wrote = null;                                 // 마지막 쓰기 응답(태그 개수) — 전파 지연 판정에 쓴다
  for (let i = 0; i < 6; i++) {
    const j = await (await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet', { method: 'PUT', headers: H, body: JSON.stringify({ id: videoId, snippet }) })).json();
    if (!j.error) { wrote = j; break; }
    console.error(`[tags] 넣기 실패 ${i + 1}회 ${JSON.stringify(j.error).slice(0, 200)}`);
    await new Promise((res) => setTimeout(res, 20000));
  }
  let after, ok = false;
  for (let i = 0; i < 12 && !ok; i++) {       // 바로 읽으면 옛 값이 온다 — 갓 올린 영상은 30초 넘게 0개로 읽혔다(ep12, 10/16)
    await new Promise((res) => setTimeout(res, 10000));
    after = await get();
    ok = (after.snippet.tags || []).length > 0 && after.snippet.title === s.title && after.snippet.description === s.description;
  }
  const n = (after.snippet.tags || []).length;
  console.log(`[tags] 확인 ${n}개 · 제목·설명 그대로 ${ok}`);
  if (!ok && process.argv.includes('--gate') && n === 0) {
    const st = after.status;
    const written = ((wrote && wrote.snippet && wrote.snippet.tags) || []).length;
    const before = (s.tags || []).length;
    const sameText = after.snippet.title === s.title && after.snippet.description === s.description;
    if (pending.isPropagating({ written, expected: tags.length, read: n, before, sameText }) && pending.canWait(st)) {
      pending.add({ videoId, purpose, expected: tags.length, before, title: s.title, tool: 'fantube/yt_tags' });
      if (pending.watcherAlive()) {
        console.log(`[tags] 감시로 넘김 — 쓰기 응답 ${written}개, 읽기 ${n}개(전파 지연으로 봄). 예약 ${st.publishAt || '없음'} 유지, 10분마다 다시 읽고 공개 20분 전까지 0개면 그때 취소. 결과는 §10 «태그 감시» 줄.`);
        return;
      }
      fs.mkdirSync(LOGDIR, { recursive: true });
      const log = path.join(LOGDIR, `tags_${videoId}.log`);
      const fd = fs.openSync(log, 'a');
      const child = spawn(process.execPath, [__filename, videoId, metaPath, '--wait-pending'], { detached: true, stdio: ['ignore', fd, fd], cwd: path.join(__dirname, '..'), windowsHide: true, env: { ...process.env, YT_TAGS_BEFORE: String(before) } });
      child.unref();
      console.log(`[tags] 전파 대기 — 쓰기 응답 ${written}개, 읽기 ${n}개(전파 지연으로 봄). 예약 ${st.publishAt || '없음'} 유지, 백그라운드(pid ${child.pid})가 ${new Date(pending.waitUntil(st)).toISOString()} 까지 2분마다 다시 읽고 공개 20분 전까지 0개면 그때 취소. 기록 ${log} · 결과는 §10 «태그 감시» 줄.`);
      return;
    }
    const c = await pending.cancelSchedule(videoId, H);
    console.error(c.ok ? `[tags] 게이트: 태그 0개(쓰기 응답 ${written}개·전파 지연 아님) → 예약 취소(비공개, 예약 ${c.was || '없음'} 삭제), 관리자 보고 필요 (${videoId})` : `[tags] 게이트: 태그 0개인데 예약 취소 실패 ${c.why} — 수동 --unschedule (${videoId})`);
    process.exit(2);
  }
  if (!ok) process.exit(1);
})().catch((e) => { console.error('[tags]', e.message); process.exit(1); });

// 태그 관문의 «쓰기는 됐는데 읽기만 안 보임» 대기 목록과 감시(10-31 연금 1편: 쓰기 200·응답 18개, 읽기 0개 → 3분 대기 끝에 거짓 취소, 약 30분 뒤 18개).
//
//   관문(yt_tags.js 등):  isPropagating(...) && canWait(...) 이면 add(...) 하고 예약을 그대로 둔다.
//     감시가 돌고 있으면(watcherAlive) 넘기고 끝, 안 돌면 관문이 직접 기다린다(waitUntil). 감시 없이 목록에만 올리면 아무도 안 본다.
//   감시(작업 스케줄러 midform-yt-tags-watch, 10분마다):  node scripts/yt_tags_pending.js --tick
//   보기:  node scripts/yt_tags_pending.js --list
//
// 태그 0개면 공개 안 한다는 관문의 뜻은 그대로다: 공개 20분 전까지 안 보이면 그때 예약을 취소한다.
// 대기 목록은 파일이라 재부팅해도 남는다(세션·백그라운드 프로세스에 맡기지 않는다).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = process.env.YT_TAGS_PENDING_FILE || path.join(ROOT, 'server/data/yt_tags_pending.json');
const HANDOFF = process.env.YT_TAGS_HANDOFF_FILE || path.join(ROOT, 'docs/handoff-manager-20261014.md');
const CANCEL_BEFORE_MS = 20 * 60e3;   // 감시가 10분 주기라 두 번은 볼 수 있게
const NO_SCHEDULE_GIVE_UP_MS = 6 * 3600e3;
const GATE_WAIT_MS = 47 * 60e3;       // 감시가 없을 때 관문이 직접 기다리는 한도(실측 지연 약 30분)
const HEARTBEAT = `${FILE}.heartbeat`;

// 쓰기 응답엔 태그가 다 있고 제목·설명도 그대로인데, 읽기만 0개(또는 쓰기 전 개수)면 전파 지연으로 본다.
function isPropagating({ written, expected, read, before = 0, sameText }) {
  return written === expected && expected > 0 && !!sameText && read !== expected && (read === 0 || read === before);
}

// 기다릴 수 있나: 비공개 + (예약이 20분 넘게 남음 또는 예약 없음). 이미 공개거나 공개가 임박하면 기다리지 않는다.
function canWait({ privacyStatus, publishAt }, now = Date.now()) {
  if (privacyStatus !== 'private') return false;
  if (!publishAt) return true;
  return Date.parse(publishAt) - now > CANCEL_BEFORE_MS;
}

// 감시 작업이 살아 있나: 10분 주기라 25분 안에 다녀갔으면 산 것으로 본다.
function watcherAlive(now = Date.now()) { try { return now - fs.statSync(HEARTBEAT).mtimeMs < 25 * 60e3; } catch { return false; } }
// 감시가 없을 때 관문이 직접 기다릴 끝 시각.
function waitUntil({ publishAt }, now = Date.now()) { const cap = now + GATE_WAIT_MS; return publishAt ? Math.min(cap, Date.parse(publishAt) - CANCEL_BEFORE_MS) : cap; }

// 다시 읽은 결과로 다음 할 일을 정한다(순수 함수).
function decide(item, read, now = Date.now()) {
  if (!read) return { act: 'gone' };
  const n = read.tags;
  if (n === item.expected) return { act: 'confirmed', n };
  if (n > 0 && n !== item.before) return { act: 'partial', n };
  if (read.privacyStatus !== 'private') return { act: 'public_zero', n };
  if (read.publishAt) return Date.parse(read.publishAt) - now <= CANCEL_BEFORE_MS ? { act: 'cancel', n } : { act: 'wait', n };
  return now - Date.parse(item.added_at) >= NO_SCHEDULE_GIVE_UP_MS ? { act: 'give_up', n } : { act: 'wait', n };
}

const readAll = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } };
function writeAll(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, FILE);
}
function add({ videoId, purpose, expected, before = 0, title = '', tool = '' }) {
  const list = readAll().filter((x) => x.videoId !== videoId);
  list.push({ videoId, purpose, expected, before, title: String(title).slice(0, 80), tool, added_at: new Date().toISOString() });
  writeAll(list);
}
function remove(videoId) { writeAll(readAll().filter((x) => x.videoId !== videoId)); }
function report(line) {
  const t = new Date(Date.now() + 9 * 3600e3).toISOString();
  try { fs.appendFileSync(HANDOFF, `- 태그 감시(${t.slice(5, 10)} ${t.slice(11, 16)}): ${line}\n`, 'utf8'); } catch (e) { console.error('[tags-watch] 기록 실패', e.message); }
}

// 예약 취소. publishAt:null 을 안 보내면 예약이 그대로 남는다(팬튜브 10-20). 다시 읽어 확인한다.
async function cancelSchedule(videoId, H) {
  const url = 'https://www.googleapis.com/youtube/v3/videos';
  const st = (await (await fetch(`${url}?part=status&id=${videoId}`, { headers: H })).json()).items?.[0]?.status;
  if (!st) return { ok: false, why: '영상을 못 읽음' };
  const status = { privacyStatus: 'private', publishAt: null, embeddable: st.embeddable, license: st.license, publicStatsViewable: st.publicStatsViewable, selfDeclaredMadeForKids: st.madeForKids };
  const g = await (await fetch(`${url}?part=status`, { method: 'PUT', headers: H, body: JSON.stringify({ id: videoId, status }) })).json();
  if (g.error) return { ok: false, why: JSON.stringify(g.error).slice(0, 200), was: st.publishAt };
  const after = (await (await fetch(`${url}?part=status&id=${videoId}`, { headers: H })).json()).items?.[0]?.status;
  return { ok: !after?.publishAt, was: st.publishAt, why: after?.publishAt ? '다시 읽어도 예약이 남음' : '' };
}

async function headersFor(purpose) {
  const { OAuth2Client } = require(path.join(ROOT, 'node_modules', 'google-auth-library'));
  const store = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/data/youtube_upload_profiles.json'), 'utf8'));
  const p = store.profiles.find((x) => x.purpose === purpose);
  if (!p) throw new Error(`업로드 프로필 없음: ${purpose}`);
  const c = new OAuth2Client(p.oauthClientId, p.oauthClientSecret, p.oauthRedirectUri);
  c.setCredentials({ refresh_token: p.refreshToken });
  return { Authorization: `Bearer ${(await c.getAccessToken()).token}`, 'Content-Type': 'application/json' };
}
const realApi = {
  async read(item) {
    const H = await headersFor(item.purpose);
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${item.videoId}`, { headers: H });
    if (!r.ok) throw new Error(`읽기 ${r.status}`);
    const v = (await r.json()).items?.[0];
    return v ? { tags: (v.snippet.tags || []).length, privacyStatus: v.status.privacyStatus, publishAt: v.status.publishAt || null } : null;
  },
  async cancel(item) { return cancelSchedule(item.videoId, await headersFor(item.purpose)); },
};

// 한 바퀴. 읽기 실패(429·403 포함)는 다시 시도하지 않고 다음 주기로 넘긴다.
async function tick({ api = realApi, now = Date.now(), log = console.log } = {}) {
  const list = readAll();
  if (!list.length) return { done: 0, left: 0 };
  const finished = new Set();
  for (const item of list) {
    const name = `${item.videoId} ${item.title} (${item.purpose})`;
    let read;
    try { read = await api.read(item); } catch (e) { log(`[tags-watch] 읽기 실패 ${item.videoId}: ${e.message}`); continue; }
    const d = decide(item, read, now);
    const mins = Math.round((now - Date.parse(item.added_at)) / 60e3);
    log(`[tags-watch] ${item.videoId} ${d.act} ${d.n ?? ''}/${item.expected}`);
    if (d.act === 'wait') continue;
    if (d.act === 'confirmed') report(`${name} 태그 ${d.n}개 확인(쓰기 뒤 약 ${mins}분), 예약 유지.`);
    else if (d.act === 'partial') report(`△ ${name} 태그 ${d.n}/${item.expected}개만 보임, 0개가 아니라 예약 유지. 담당 세션 확인.`);
    else if (d.act === 'gone') report(`△ ${name} 영상을 못 찾아 감시 끝냄.`);
    else if (d.act === 'give_up') report(`△ ${name} 예약 없는 영상, ${mins}분째 태그 0개라 감시 끝냄. 담당 세션 확인.`);
    else if (d.act === 'public_zero') report(`★사고 ${name} 이미 공개인데 태그 0개(PC가 꺼져 감시를 놓쳤을 수 있음). 담당 세션 확인.`);
    else if (d.act === 'cancel') {
      let c;
      try { c = await api.cancel(item); } catch (e) { c = { ok: false, why: e.message }; }
      if (!c.ok) { report(`★사고 ${name} 공개 임박·태그 0개인데 예약 취소 실패: ${c.why}. 다음 주기에 다시.`); continue; }
      report(`★${name} 쓰기 뒤 ${mins}분이 지나 공개 임박인데 태그 0개 → 예약 취소(비공개, 예약 ${c.was || '없음'} 삭제). 담당 세션 확인.`);
    }
    finished.add(item.videoId);
  }
  if (finished.size) writeAll(readAll().filter((x) => !finished.has(x.videoId)));   // 도는 사이 들어온 줄을 지우지 않게 다시 읽는다
  return { done: finished.size, left: list.length - finished.size };
}

module.exports = { isPropagating, canWait, watcherAlive, waitUntil, decide, add, remove, tick, readAll, cancelSchedule, CANCEL_BEFORE_MS };

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--list')) { console.log(JSON.stringify(readAll(), null, 2)); }
  else if (a.includes('--tick')) { fs.mkdirSync(path.dirname(HEARTBEAT), { recursive: true }); fs.writeFileSync(HEARTBEAT, new Date().toISOString() + '\n', 'utf8'); tick().then((r) => { if (r.done || r.left) console.log(`[tags-watch] 끝남 ${r.done} · 남음 ${r.left}`); }).catch((e) => { console.error('[tags-watch]', e.message); process.exit(1); }); }
  else { console.error('usage: node scripts/yt_tags_pending.js --tick | --list'); process.exit(2); }
}

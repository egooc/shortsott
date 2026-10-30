// AI 오피스 결과물 보관 — 세션이 올린 이미지·영상(검수용 샘플)과 소유주가 올린 스크린샷.
//
// 저장: <허브>/media/<id>.<확장자> + media/index.json(목록). 14일 지나면 지운다(원본은 각 기기에 남는다).
// 보기: 화면은 소유주 로그인 뒤 받은 «서명 주소»(/media/<id>?e=만료&s=서명)로만 연다 — <video>·<img> 는 헤더를 못 실어서.
//       서명은 OFFICE_MEDIA_SECRET 으로 만들고 6시간 뒤 끝난다. 영상은 Range 요청(앞으로 감기)을 받는다.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, 'media');
const INDEX = path.join(DIR, 'index.json');
const MAX_BYTES = 200 * 1024 * 1024;
const KEEP_MS = 14 * 864e5;
const SIGN_MS = 6 * 3600e3;
const TYPES = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.pdf': 'application/pdf',
};
const SECRET = process.env.OFFICE_MEDIA_SECRET || '';

fs.mkdirSync(DIR, { recursive: true });
const readIndex = () => { try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return []; } };
const writeIndex = (list) => fs.writeFileSync(INDEX, JSON.stringify(list, null, 2) + '\n', 'utf8');

const sign = (id, exp) => crypto.createHmac('sha256', SECRET).update(`${id}.${exp}`).digest('base64url');
function signedUrl(id) {
  const exp = Date.now() + SIGN_MS;
  return `/media/${id}?e=${exp}&s=${sign(id, exp)}`;
}

// 이미지·영상의 가로·세로를 받는 순간 잰다 — 화면이 로딩 전에 칸 모양(쇼츠 세로·롱폼 가로)을 잡게.
function probeSize(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_tags=rotate', '-of', 'json', file], { timeout: 15e3, stdio: ['ignore', 'pipe', 'ignore'] });
    const st = (JSON.parse(out).streams || [])[0];
    if (!st || !st.width) return {};
    const rot = Math.abs(Number(st.tags?.rotate || 0)) % 180 === 90;
    return rot ? { width: st.height, height: st.width } : { width: st.width, height: st.height };
  } catch { return {}; }
}

// 요청 본문을 파일로 흘려 쓴다(메모리에 안 올린다). 크기 넘으면 지우고 413.
async function save(req, meta) {
  const ext = path.extname(String(meta.name || '')).toLowerCase();
  if (!TYPES[ext]) throw Object.assign(new Error(`받지 않는 형식(${ext || '확장자 없음'})`), { code: 415 });
  if (!SECRET) throw Object.assign(new Error('OFFICE_MEDIA_SECRET 없음'), { code: 500 });
  const id = crypto.randomBytes(9).toString('base64url');
  const file = path.join(DIR, id + ext);
  let size = 0;
  const out = fs.createWriteStream(file);
  try {
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BYTES) throw Object.assign(new Error('200MB 넘음'), { code: 413 });
      if (!out.write(c)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  } catch (e) {
    out.destroy(); fs.rmSync(file, { force: true });
    throw e;
  }
  if (!size) { fs.rmSync(file, { force: true }); throw Object.assign(new Error('빈 파일'), { code: 400 }); }
  const item = {
    id, file: id + ext, mime: TYPES[ext], size, name: String(meta.name).slice(0, 200),
    title: String(meta.title || meta.name).slice(0, 200), lane: String(meta.lane || '').slice(0, 60),
    project: String(meta.project || '').slice(0, 60), device: meta.device || null, from: String(meta.from || '').slice(0, 120),
    note: String(meta.note || '').slice(0, 500), by_owner: !!meta.by_owner, at: new Date().toISOString(), decision_id: null,
    ...(/^(video|image)\//.test(TYPES[ext]) ? probeSize(file) : {}),
  };
  const list = readIndex(); list.push(item); writeIndex(list);
  return item;
}

function link(id, decisionId) {
  const list = readIndex();
  const it = list.find((x) => x.id === id);
  if (it) { it.decision_id = decisionId; writeIndex(list); }
}

// 화면에 줄 목록(서명 주소 포함). 소유주가 올린 스크린샷은 따로 거른다.
function listForOwner(n = 120) {
  return readIndex().slice(-n).reverse().map((x) => ({ ...x, url: signedUrl(x.id), file: undefined }));
}

function get(id) { return readIndex().find((x) => x.id === id) || null; }

// 서명 확인 후 파일을 보낸다. Range 지원(영상 탐색).
function serve(req, res, id, q) {
  const exp = Number(q.get('e')); const s = q.get('s') || '';
  const okSig = SECRET && exp > Date.now() && s.length === 43 && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(sign(id, exp)));
  const it = okSig && get(id);
  if (!it) { res.writeHead(403); return res.end(); }
  const file = path.join(DIR, it.file);
  let stat; try { stat = fs.statSync(file); } catch { res.writeHead(404); return res.end(); }
  const head = { 'content-type': it.mime, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const start = m[1] ? Number(m[1]) : Math.max(0, stat.size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
    if (start >= stat.size || start > end) { res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...head, 'content-length': stat.size });
  fs.createReadStream(file).pipe(res);
}

function cleanup() {
  const now = Date.now();
  const keep = [];
  for (const x of readIndex()) {
    if (now - Date.parse(x.at) > KEEP_MS) fs.rmSync(path.join(DIR, x.file), { force: true });
    else keep.push(x);
  }
  writeIndex(keep);
}

// 크기를 안 잰 옛 항목을 채운다(시작할 때 한 번).
function backfillSizes() {
  const list = readIndex(); let n = 0;
  for (const x of list) if (x.width == null && /^(video|image)\//.test(x.mime)) { Object.assign(x, probeSize(path.join(DIR, x.file))); if (x.width) n++; }
  if (n) writeIndex(list);
  return n;
}
backfillSizes();

module.exports = { save, link, listForOwner, get, serve, cleanup, signedUrl };

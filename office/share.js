// AI 오피스 결과물 올리기 — 세션이 만든 이미지·영상(검수용 샘플)을 소유주 폰·PC 오피스에 보낸다.
//
//   node office/share.js 최종본.mp4 --lane 롱투숏 --title "kp05 인도 가족 라면" --from "YTHOME-SF-KO 롱투숏 A"
//   node office/share.js a.png b.png --lane 쇼핑 --title "썸네일 A/B" --ask "어느 썸네일로 갈까요?" --options "A|B" --rec A
//
// --ask 를 붙이면 결과물이 붙은 결정 카드가 올라간다. 소유주가 영상을 보고 버튼으로 답하면
// 이 터미널에 «[오피스 결정 답] #번호 … → 답» 한 줄이 들어온다(ask.js 와 같다).
// 받는 형식: mp4·webm·mov·png·jpg·webp·gif·mp3·m4a·wav·pdf, 파일당 200MB. 오피스에는 14일 보관.
// 인증: 이 기기의 .env.office (OFFICE_DEVICE_TOKEN) — 토큰 값은 찍지 않는다.

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const ROOT = path.resolve(__dirname, '..');
const env = Object.fromEntries((() => { try { return fs.readFileSync(path.join(ROOT, '.env.office'), 'utf8'); } catch { return ''; } })()
  .split('\n').map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const TOKEN = env.OFFICE_DEVICE_TOKEN;
const BASE = (process.env.OFFICE_URL || env.OFFICE_URL || 'https://office.grow-up.kr').replace(/\/$/, '');

const argv = process.argv.slice(2);
const FLAGS = new Set(['--lane', '--title', '--project', '--from', '--note', '--ask', '--options', '--rec']);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && FLAGS.has(argv[i - 1])));

async function upload(file, n) {
  const st = fs.statSync(file);
  if (st.size > 200 * 1024 * 1024) throw new Error(`${path.basename(file)}: 200MB 넘음 — 줄이거나 쇼츠 길이 샘플만`);
  const title = opt('--title') ? (files.length > 1 ? `${opt('--title')} (${n + 1}/${files.length})` : opt('--title')) : path.basename(file);
  const q = new URLSearchParams({ name: path.basename(file), title, lane: opt('--lane') || '', project: opt('--project') || '', from: opt('--from') || '', note: opt('--note') || '' });
  if (opt('--ask')) q.set('notify', '0'); // 결정 카드가 따로 알린다
  const r = await fetch(`${BASE}/api/device/share?${q}`, {
    method: 'POST', headers: { 'x-office-token': TOKEN, 'content-type': 'application/octet-stream', 'content-length': String(st.size) },
    body: Readable.toWeb(fs.createReadStream(file)), duplex: 'half',
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path.basename(file)}: ${j.error || 'HTTP ' + r.status}`);
  return j.id;
}

async function main() {
  if (!TOKEN) throw new Error('.env.office 에 OFFICE_DEVICE_TOKEN 이 없다 — 이 기기는 오피스에 연결돼 있지 않다');
  if (!files.length) throw new Error('올릴 파일이 없다. 예: node office/share.js 최종본.mp4 --lane 롱투숏 --title "제목"');
  for (const f of files) if (!fs.existsSync(f)) throw new Error(`파일 없음: ${f}`);
  const ids = [];
  for (let i = 0; i < files.length; i++) ids.push(await upload(files[i], i));
  console.log(`결과물 ${ids.length}개 올림 — 오피스 «결과물»에서 보인다.`);

  const ask = opt('--ask');
  if (!ask) return;
  const options = (opt('--options') || '').split('|').map((s) => s.trim()).filter(Boolean);
  const recommended = opt('--rec');
  if (recommended && !options.includes(recommended)) throw new Error('--rec 는 --options 중 하나여야 한다');
  const r = await fetch(`${BASE}/api/device/decisions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-office-token': TOKEN },
    body: JSON.stringify({ lane: opt('--lane') || '결과물', question: ask, options, recommended: recommended || null,
      asked_by: opt('--from') || null, handle: process.env.ORCA_TERMINAL_HANDLE || null, media_ids: ids }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  console.log(`#${j.id} 검수 결정 올림 — 답이 오면 이 터미널에 «[오피스 결정 답] #${j.id}» 줄로 들어온다.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });

// AI 오피스 결정 요청 — 세션이 소유주에게 물을 일을 관리자 대신 오피스에 올린다.
//
//   node office/ask.js "질문" --lane 팬튜브 --options "공항 영상|직캠|보류" --rec "공항 영상" --from "YTHOME-SF-KO 팬튜브 B"
//   node office/ask.js --status 12          그 결정의 답 확인
//
// 후보가 여럿이면 «질문? 후보: ①이름(근거, 근거) ②…» 꼴로 — 오피스가 후보 카드로 나눠 보여 준다(docs/office-decisions.md).
// 소유주가 오피스(폰 알림 → 버튼)로 답하면, 허브가 이 세션 터미널에 바로 한 줄을 넣어 준다:
//   [오피스 결정 답] #12 질문 → 답
// 그래서 기다리며 폴링할 필요가 없다. 질문을 올린 뒤에는 다른 일을 하다가 그 줄이 오면 따른다.
// 터미널은 Orca 가 넣어 주는 ORCA_TERMINAL_HANDLE 로 찾는다(Orca 밖 세션이면 --status 로 확인).
// 인증: 이 기기의 .env.office (OFFICE_DEVICE_TOKEN) — 토큰 값은 찍지 않는다.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const env = Object.fromEntries((() => { try { return fs.readFileSync(path.join(ROOT, '.env.office'), 'utf8'); } catch { return ''; } })()
  .split('\n').map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const TOKEN = env.OFFICE_DEVICE_TOKEN;
const BASE = (process.env.OFFICE_URL || env.OFFICE_URL || 'https://office.grow-up.kr').replace(/\/$/, '');

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));

async function main() {
  if (!TOKEN) throw new Error('.env.office 에 OFFICE_DEVICE_TOKEN 이 없다 — 이 기기는 오피스에 연결돼 있지 않다');
  const headers = { 'content-type': 'application/json', 'x-office-token': TOKEN };

  const status = opt('--status');
  if (status) {
    const r = await fetch(`${BASE}/api/device/decisions/${encodeURIComponent(status)}`, { headers });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    console.log(j.status === 'open' ? `#${j.id} 아직 답 없음` : `#${j.id} ${j.status}: ${j.answer}`);
    return;
  }

  const question = positional.join(' ').trim();
  const lane = opt('--lane');
  if (!question || !lane) throw new Error('질문과 --lane 이 필요하다. 예: node office/ask.js "질문" --lane 팬튜브 --options "A|B" --rec A --from 세션이름');
  const options = (opt('--options') || '').split('|').map((s) => s.trim()).filter(Boolean);
  const recommended = opt('--rec');
  if (recommended && !options.includes(recommended)) throw new Error('--rec 는 --options 중 하나여야 한다');
  const body = {
    lane, question, options, recommended: recommended || null,
    asked_by: opt('--from') || null,
    handle: process.env.ORCA_TERMINAL_HANDLE || null,
  };
  const r = await fetch(`${BASE}/api/device/decisions`, { method: 'POST', headers, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  console.log(`#${j.id} 올림 — 소유주 폰에 알림이 갔다.${body.handle ? ' 답이 오면 이 터미널에 «[오피스 결정 답] #' + j.id + '» 줄로 들어온다.' : ' Orca 밖이라 답은 --status ' + j.id + ' 로 확인.'}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });

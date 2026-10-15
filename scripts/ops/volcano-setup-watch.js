// 볼케이노 서버 변동 감시 — 매일 06:30 세션이 volcano_video setup 을 1번만 부르고(비용 0, 제작 호출 금지),
//   받은 응답에서 서버가 정하는 값만 뽑아 이 스크립트에 넘긴다 (2026-10-15 소유주 승인 «결정 2», 관리자 경유).
//   node scripts/ops/volcano-setup-watch.js <응답요약.json>
//   요약 = setup 응답의 { rinbox_engine, channel_needs, traps, review, next_payload, carry, message } (do[] 의 환경 검사 스크립트는 뺀다)
//   → server/output/volcano-watch/<날짜>.json · 상태 server/data/volcano_setup_watch.json · stdout 한 줄 JSON(07:07 보고에 합친다)
// 왜 setup 인가: 옛 volcano-watch.js 는 회차 폴더로 내려온 runner/*.py 를 비교했는데, 10-08 자체 렌더 전환 뒤
//   assets 단계를 안 불러 새 러너가 안 내려온다 → 10-11 부터 사실상 멈췄다. setup 은 아무것도 받지 않고 서버 설정만 돌려준다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..', '..');
const STATE = path.join(ROOT, 'server', 'data', 'volcano_setup_watch.json');
const OUT = path.join(ROOT, 'server', 'output', 'volcano-watch');
const KST = 9 * 3600000;
const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 12);
const readJ = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

const src = process.argv[2];
const r = readJ(src, null);
if (!r) { console.error('응답 요약 JSON 을 줘라'); process.exit(2); }
const presets = Object.fromEntries((r.channel_needs || []).map((c) => [c.preset, {
  keys: (c.items || []).map((i) => i.need).sort(), optional: (c.optional || []).map((i) => i.need).sort(),
  langs: (c.languages || []).map((l) => l.code).sort(),
}]));
const parts = {
  engine: r.rinbox_engine || null,
  presets: sha(presets),
  traps: (r.traps || []).length,   // 문구는 세션이 옮겨 적으며 줄일 수 있어 개수만 본다
  review: sha({ review: r.review || null, carry: r.carry || [], next: r.next_payload || null }),
};
const prev = readJ(STATE, null);
const changed = [];
if (prev) {
  if (prev.parts.engine !== parts.engine) changed.push(`엔진 ${prev.parts.engine} → ${parts.engine}`);
  const a = prev.presets || {}, b = presets;
  for (const k of Object.keys(b)) if (!a[k]) changed.push(`채널 추가 ${k}`);
  for (const k of Object.keys(a)) if (!b[k]) changed.push(`채널 빠짐 ${k}`);
  for (const k of Object.keys(b)) if (a[k] && JSON.stringify(a[k]) !== JSON.stringify(b[k])) changed.push(`${k} 요구 변경 ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`);
  if (prev.parts.traps !== parts.traps) changed.push(`설치 주의(traps) ${prev.parts.traps}개 → ${parts.traps}개`);
  if (prev.parts.review !== parts.review) changed.push('검수 경로(review) 변경');
}
const date = new Date(Date.now() + KST).toISOString().slice(0, 10);
const out = { date, at: new Date().toISOString(), engine: parts.engine, presets: Object.keys(presets), changed: prev ? changed : null,
  verdict: !prev ? '기준 저장(첫 기록)' : changed.length ? `변동 ${changed.length}건` : '변동 없음', since: prev ? prev.date : null };
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, date + '.json'), JSON.stringify({ ...out, parts, presets_detail: presets }, null, 2) + '\n', 'utf8');
if (!prev || changed.length) fs.writeFileSync(STATE, JSON.stringify({ date, parts, presets }, null, 2) + '\n', 'utf8');
process.stdout.write(JSON.stringify(out) + '\n');

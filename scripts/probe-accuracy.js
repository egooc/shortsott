// 프로브가 실제로 맞히고 있는가. 방식(middle/edit)별로 따로 센다.
//
//   node scripts/probe-accuracy.js
//
// 왜 (2026-09-22)
//   프로브를 30분씩 돌리면서 **맞히는지 한 번도 안 세어 봤다.** 세어 보니
//   CLEAR 13건 중 5건이 나중에 차단됐다 — 37% 차단율과 같은 값, 즉 동전 던지기였다.
//   그래서 검사 대상을 «소스 한가운데»에서 «편집표가 고른 구간»으로 바꿨다(mode=edit).
//   바꾼 것이 실제로 나아졌는지는 **이 저울로만** 알 수 있다. 안 재면 두 주 뒤에 또 모른다.
//
// 판정 기준
//   프로브가 CLEAR 라고 한 영화가 지금 카탈로그에서 banned 면 → **놓친 것**(false clear).
//   BLOCKED 라고 한 영화는 그 자리에서 버렸으므로 맞은 것으로 본다(반증할 길이 없다).
//   ★표본이 적을 때는 수를 그대로 보여 준다. 비율만 보면 3건짜리가 100% 로 보인다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LEDGER = path.join(ROOT, 'server', 'data', 'claim_probes.json');
const CATALOG = path.join(ROOT, 'midform', 'config', 'movie_catalog.json');
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

const probes = (readJson(LEDGER, { probes: [] }).probes || []).filter((p) => p.movieKey);
const movies = (readJson(CATALOG, {}).movies) || {};

const byMode = {};
for (const p of probes) {
  const mode = p.mode || 'middle';           // 옛 기록에는 mode 가 없다 — 전부 middle 이었다
  const m = movies[p.movieKey];
  if (!m) continue;
  const saidClear = !String(p.verdict).startsWith('BLOCKED');
  const nowBanned = m.distributor_tier === 'banned';
  const b = (byMode[mode] = byMode[mode] || { clear: 0, missed: 0, blocked: 0, misses: [] });
  if (!saidClear) { b.blocked += 1; continue; }
  b.clear += 1;
  if (nowBanned) { b.missed += 1; b.misses.push(p.movieKey); }
}

// 방식 이름. ★plan 을 여기 빠뜨리면 «편집표 구간»으로 돌린 프로브가 옛 방식(middle) 이름으로 찍혀
// 다음 사람이 정반대로 읽는다 — 사례 96 과 같은 병이다.
const MODE_NAMES = {
  middle: 'middle(소스 한가운데 — 옛 방식)',
  plan:   'plan  (제출 전 편집안 = 올릴 그림)',
  edit:   'edit  (제출 뒤 편집표 = 올릴 그림)',
};
// plan 과 edit 은 «올릴 그림 그대로»를 검사한다는 점에서 같은 방식이다. 비교할 때는 합쳐서 센다.
const PICTURE_MODES = ['plan', 'edit'];

const lines = ['# 프로브 저울 ' + new Date().toLocaleString('ko-KR'), ''];
if (!Object.keys(byMode).length) lines.push('잴 기록이 없다.');
for (const [mode, b] of Object.entries(byMode)) {
  const name = MODE_NAMES[mode] || `${mode}(모르는 방식)`;
  lines.push(`## ${name}`);
  lines.push(`- BLOCKED 판정 ${b.blocked}건 (그 자리에서 버림)`);
  if (b.clear) {
    const rate = (100 * b.missed / b.clear).toFixed(0);
    lines.push(`- CLEAR 판정 ${b.clear}건 중 **${b.missed}건이 나중에 차단** = 놓침 ${rate}%`);
    if (b.misses.length) lines.push(`  - 놓친 영화: ${b.misses.join(', ')}`);
    if (b.clear < 8) lines.push('  - ★표본이 8건 미만이다. 비율은 아직 읽지 마라.');
  } else {
    lines.push('- CLEAR 판정이 아직 없다.');
  }
  lines.push('');
}
const mid = byMode.middle;
const ed = PICTURE_MODES.map((m) => byMode[m]).filter(Boolean).reduce((a, b) => ({
  clear: a.clear + b.clear, missed: a.missed + b.missed,
  blocked: a.blocked + b.blocked, misses: a.misses.concat(b.misses),
}), { clear: 0, missed: 0, blocked: 0, misses: [] });
if (mid && ed.clear >= 8) {
  const a = mid.missed / (mid.clear || 1); const b2 = ed.missed / (ed.clear || 1);
  lines.push(`**비교**: 한가운데 ${(100 * a).toFixed(0)}% → 편집표 ${(100 * b2).toFixed(0)}%`
    + (b2 < a ? ' — 나아졌다.' : ' — 나아지지 않았다. 프로브를 빼고 3층 방어만 남기는 편이 낫다.'));
} else if (ed.clear) {
  lines.push(`_편집표 구간(plan+edit) CLEAR 표본이 ${ed.clear}건이다. 8건은 모여야 비교가 된다._`);
} else {
  lines.push('_아직 편집표 구간으로 돌린 프로브가 없다. 다음 생산부터 쌓인다._');
}

console.log(lines.join('\n'));

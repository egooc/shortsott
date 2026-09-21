// 카탈로그 매칭이 «다른 영화»를 잡고 있지 않은지 감사한다. 생산·발행이 쉬는 시간에 돈다.
//
//   node scripts/catalog-audit.js [--report <scout json>] [--json]
//
// 왜 (2026-09-21 소유주 지시: "이런 확인 및 검증을 위해서 정찰을 돌려보면 좋겠다, 남는 시간에")
//   `hulk-2003` 의 매칭이 `\bhulk\b` 였다. 그래서 정찰 상위 후보 10건이 전부 **어벤져스·에이지 오브
//   울트론** 클립이었는데 유니버설 preflight 등급을 상속받아 «안전»해 보였다. 어벤져스는 디즈니/마블이다.
//   손으로 리포트를 읽다 우연히 걸렸다. 우연에 기대면 안 되니 규칙으로 만든다.
//
// 무엇을 잡나
//   1) 연도 충돌 — 제목의 (YYYY) 와 카탈로그 year 가 3년 넘게 벌어진다
//   2) 중복 매칭 — 한 제목이 두 개 이상의 카탈로그 항목에 걸린다
//   3) 과대 매칭 — 한 패턴이 후보의 너무 많은 몫을 혼자 가져간다
//   4) 약한 매칭 — 카탈로그 제목의 낱말이 후보 제목에 하나도 없다
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CATALOG = path.join(ROOT, 'midform', 'config', 'movie_catalog.json');
const REPORTS = path.join(ROOT, 'server', 'output', 'scout-reports');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

function latestReport() {
  const given = arg('--report');
  if (given) return given;
  const files = fs.existsSync(REPORTS)
    ? fs.readdirSync(REPORTS).filter((f) => /^scout-\d+\.json$/.test(f)).sort() : [];
  if (!files.length) return null;
  return path.join(REPORTS, files[files.length - 1]);
}

const catalog = readJson(CATALOG, {});
const movies = catalog.movies || catalog;
const entries = Object.entries(movies).filter(([, v]) => v && typeof v === 'object' && v.match);

const reportPath = latestReport();
if (!reportPath) { console.log('정찰 리포트가 없다. scout-sources.js 를 먼저 돌려라.'); process.exit(0); }
const report = readJson(reportPath, {});
// 후보와 미조사분을 함께 본다. 오진은 «이미 통과한» 후보 쪽이 위험하지만, 미조사분에서도
// 패턴이 남의 영화를 잡으려 하는지 미리 보인다.
const pool = [...(report.candidates || []), ...(report.needs_research || []).slice(0, 1500)];

const matchesFor = (title) => entries
  .filter(([, v]) => { try { return new RegExp(v.match, 'i').test(title); } catch { return false; } })
  .map(([k]) => k);

const titleWords = (v) => String(`${v.title_en || ''} ${v.title_ko || ''}`)
  .toLowerCase().split(/[^a-z0-9가-힣]+/).filter((w) => w.length >= 3);

const findings = [];
const hitCount = {};

for (const c of pool) {
  const title = String(c.title || '');
  if (!title) continue;
  const keys = matchesFor(title);
  for (const k of keys) hitCount[k] = (hitCount[k] || 0) + 1;
  if (!keys.length) continue;

  if (keys.length > 1) {
    findings.push({ kind: '중복 매칭', title, detail: keys.join(', '), url: c.url });
    continue;
  }
  const key = keys[0];
  const v = movies[key];

  const ym = /\((19|20)\d{2}\)/.exec(title);
  if (ym && v.year) {
    const y = Number(ym[0].replace(/[()]/g, ''));
    if (Math.abs(y - Number(v.year)) > 3) {
      findings.push({ kind: '연도 충돌', title, detail: `제목 ${y} vs 카탈로그 ${v.year} (${key})`, url: c.url });
      continue;
    }
  }

  const words = titleWords(v);
  if (words.length && !words.some((w) => title.toLowerCase().includes(w))) {
    findings.push({ kind: '약한 매칭', title, detail: `${key} 의 제목 낱말이 하나도 없다`, url: c.url });
  }
}

// 과대 매칭: 한 패턴이 후보의 8% 넘게 가져가면 패턴이 헐거운 것이다.
const total = pool.length || 1;
for (const [k, n] of Object.entries(hitCount)) {
  if (n / total > 0.08 && n >= 20) {
    findings.push({ kind: '과대 매칭', title: `(패턴)`, detail: `${k} 가 후보 ${total}건 중 ${n}건을 혼자 잡는다 — 패턴이 헐겁다`, url: '' });
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ reportPath, pool: pool.length, findings }, null, 2));
  process.exit(findings.length ? 1 : 0);
}

const lines = [`# 카탈로그 매칭 감사 ${new Date().toLocaleString('ko-KR')}`, '',
  `리포트: ${path.basename(reportPath)} · 검사한 제목 ${pool.length}건 · 카탈로그 ${entries.length}편`, ''];
if (!findings.length) {
  lines.push('오진 없음. 매칭 패턴이 전부 제 영화만 잡고 있다.');
} else {
  const byKind = {};
  for (const f of findings) (byKind[f.kind] = byKind[f.kind] || []).push(f);
  for (const [kind, fs2] of Object.entries(byKind)) {
    lines.push(`## ${kind} ${fs2.length}건`);
    for (const f of fs2.slice(0, 15)) {
      lines.push(`- ${f.detail}`);
      if (f.title !== '(패턴)') lines.push(`    ${f.title.slice(0, 80)}`);
      if (f.url) lines.push(`    ${f.url}`);
    }
    if (fs2.length > 15) lines.push(`  … 외 ${fs2.length - 15}건`);
    lines.push('');
  }
  lines.push('## 고치는 법',
    '- `midform/config/movie_catalog.json` 의 해당 `match` 를 좁힌다.',
    '- 부정 전방탐색을 쓴다: `^(?!.*\\b(빼고 싶은 말)\\b).*?(?:원래 패턴)`',
    '- 고친 뒤 이 감사를 다시 돌려 0건인지 확인한다.');
}

const text = lines.join('\n');
console.log(text);
fs.mkdirSync(REPORTS, { recursive: true });
const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
fs.writeFileSync(path.join(REPORTS, `${stamp}-audit.md`), `${text}\n`, 'utf8');
process.exit(findings.length ? 1 : 0);

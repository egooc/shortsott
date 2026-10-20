// 자료 반영 실측 — 레인 업로드 게이트가 공용 도구를 실제로 부르는지, 최신 제작물에 필수 필드가 있는지 코드·파일을 직접 본다
// (10-20 관리자: docs/materials-audit-20261020.md 의 ❌/⚠ 자동 갱신, 07:40 보고 «자료 반영 실측» 절).
//
//   node scripts/adoption_check.js [--md out.md] [--json out.json]
//
// 게이트: LANES[].gates 파일 + 그 파일이 부르는 같은 저장소의 .js/.py/.sh(한 단계)를 grep — 문서·프롬프트·주석만은 «있음»으로 안 친다
//        (주석 줄 //·# 은 빼고 센다).
// 필드: 레인 최신 제작물(spec/plan/meta/upload/keywords json, 수정 시각 최신 1개)에서 키를 깊이 찾는다. expected_comment 는 객체여야 ✅(문자열 메모 = ⚠).
// 판정: ✅ 있음 · ⚠ 일부(메모·일부 파일만) · ❌ 없음 · — 해당 없음. 파일을 못 찾으면 «⚠ 파일 없음»(통과로 안 친다).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RUNS = 'D:/volcano-runs';
const TOOLS = ['comment_hook', 'title_check', 'script_audit', 'tag_gate', 'ref_overlap', 'view_diag'];
const SHORTS_FIELDS = ['expected_comment', 'vicarious', 'title_pattern', 'hook'];
const LANES = [
  { lane: '팬튜브', gates: ['fantube/publish.js'], spec: [`${RUNS}/fantube/ep*/spec.json`], fields: SHORTS_FIELDS, tools: ['comment_hook', 'title_check', 'tag_gate'] },
  { lane: '롱투숏', gates: [`${RUNS}/ls_tools/publish_ko.sh`, `${RUNS}/ls_tools/plan_gate.py`, `${RUNS}/ls_tools/comment_gate.py`], spec: [`${RUNS}/l[sx]*/plan.json`], fields: SHORTS_FIELDS, tools: ['comment_hook', 'title_check', 'tag_gate'] },
  { lane: '린박스', gates: ['scripts/rinbox-publish.js'], spec: [`${RUNS}/rinbox*/plan_local.json`], fields: SHORTS_FIELDS, tools: ['comment_hook', 'title_check', 'tag_gate'] },
  { lane: '쇼핑', gates: ['scripts/shop_schedule.js', 'scripts/shop_comment_check.js', 'scripts/shop_keyword_check.js', 'scripts/shop_script_check.js'], spec: [`${RUNS}/_upload/ffref*.json`], fields: ['expected_comment', 'keywords', 'title_pattern'], tools: ['comment_hook', 'title_check', 'tag_gate', 'script_audit'],
    equiv: { script_audit: ['shop_script_check'] }, extra: ['shop_keyword_check'] },   // 관리자 10-20: 쇼핑 원고 검사는 shop_script_check 로 인정, 키워드 관문은 따로 필요
  { lane: '정치 ko 쇼츠', gates: ['politics-hour/upload_gate.py'], spec: ['politics-hour/shorts/*/*.upload.json'], fields: ['expected_comment', 'title_pattern'], tools: ['comment_hook', 'title_check', 'tag_gate'] },
  { lane: '정치 ko 롱폼', gates: ['politics-hour/upload_gate.py', 'politics-hour/candidate_gate.py'], spec: ['politics-hour/episodes/*/keywords.json'], fields: ['keywords', 'news_outlier', 'vicarious|emotion_now'], tools: ['title_check', 'script_audit', 'tag_gate', 'ref_overlap'] },
  { lane: '정치JA', gates: ['politics-hour-ja/upload_gate_ja.py', 'politics-hour-ja/script_gate.py'], spec: ['politics-hour-ja/episodes/*/keywords.json'], fields: ['keywords', 'news_outlier', 'vicarious|emotion_now'], tools: ['title_check', 'script_audit', 'tag_gate', 'ref_overlap', 'comment_hook'] },
  { lane: '기업', gates: ['ko-corp/render/corp_render.py', 'ko-corp/render/audit.py'], spec: ['ko-corp/ep*/packages.json'], fields: ['keywords|tags', 'desc_head'], tools: ['title_check', 'script_audit', 'tag_gate', 'ref_overlap'] },
  { lane: '연금', gates: ['ja-nenkin/render/nenkin_render.py', 'ja-nenkin/render/num_audit.py'], spec: ['ja-nenkin/ep*/packages.json'], fields: ['keywords|tags', 'desc_head'], tools: ['title_check', 'script_audit', 'tag_gate', 'ref_overlap'] },
];

const label = (f) => f.split('|')[0];
const rel = (f) => { const s = String(f).replace(/\\/g, '/'); return s.startsWith(RUNS) ? s : path.relative(ROOT, f).replace(/\\/g, '/'); };
const abs = (p) => (path.isAbsolute(p) || /^[A-Za-z]:/.test(p) ? p : path.join(ROOT, p));

function glob(pattern) {
  // 단순 글롭: 경로 조각마다 * · [..] 지원(디렉터리 한 단계씩)
  const parts = abs(pattern).replace(/\\/g, '/').split('/');
  let cur = [parts[0] + '/'];
  for (const part of parts.slice(1)) {
    if (!part) continue;
    const rx = /[*?[]/.test(part) ? new RegExp('^' + part.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : null;
    const next = [];
    for (const dir of cur) {
      if (!rx) { const p = path.join(dir, part); if (fs.existsSync(p)) next.push(p); continue; }
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) if (rx.test(n)) next.push(path.join(dir, n));
    }
    cur = next;
  }
  return cur;
}

function codeLines(file) {
  // 주석 줄과 파이썬 독스트링(따옴표 셋으로 감싼 설명) 안 줄은 코드로 안 친다 — 설명에만 이름이 있는 걸 «있음»으로 세지 않게
  const out = [];
  let inDoc = false;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((l, i) => {
    const q = (l.match(/"{3}/g) || []).length;
    if (file.endsWith('.py') && (inDoc || q)) { if (q % 2 === 1) inDoc = !inDoc; return; }
    if (!/^\s*(\/\/|#|\*|\/\*)/.test(l)) out.push([i + 1, l]);
  });
  return out;
}

function gateFiles(gates) {
  const seen = new Map();
  for (const g of gates) {
    const f = abs(g);
    if (!fs.existsSync(f)) { seen.set(f, false); continue; }
    seen.set(f, true);
    // 한 단계: 이 파일이 이름으로 부르는 같은 저장소 스크립트
    const t = fs.readFileSync(f, 'utf8');
    for (const m of t.matchAll(/([\w./-]+\.(?:js|py|sh))/g)) {
      const name = m[1];
      if (/node_modules|^https?:/.test(name)) continue;
      for (const base of [path.dirname(f), path.join(ROOT, 'scripts'), ROOT]) {
        const c = path.resolve(base, name);
        if (fs.existsSync(c) && fs.statSync(c).isFile() && !seen.has(c) && !TOOLS.some((x) => c.endsWith(`${x}.py`) || c.endsWith(`${x}.js`))) { seen.set(c, true); break; }
      }
    }
  }
  return seen;
}

function toolUse(files, tool) {
  const hits = [];
  for (const [f, ok] of files) {
    if (!ok) continue;
    for (const [n, l] of codeLines(f)) if (l.includes(tool)) { hits.push(`${rel(f)}:${n}`); break; }
  }
  return hits;
}

function newest(patterns) {
  const all = patterns.flatMap(glob).filter((f) => fs.statSync(f).isFile());
  return all.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

function findKey(node, keys) {
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (keys.includes(k) && v != null && v !== '' && !(Array.isArray(v) && !v.length)) return v;
      const r = findKey(v, keys);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

function check() {
  const rows = [];
  for (const L of LANES) {
    const files = gateFiles(L.gates);
    const missing = [...files].filter(([, ok]) => !ok).map(([f]) => path.basename(f));
    const tools = {};
    for (const t of TOOLS) {
      if (!L.tools.includes(t)) { tools[t] = { mark: '—' }; continue; }
      const h = toolUse(files, t);
      const eq = h.length ? [] : (L.equiv?.[t] || []).flatMap((e) => toolUse(new Map([...files].filter(([f]) => !path.basename(f).startsWith(e))), e));
      tools[t] = { mark: h.length ? '✅' : eq.length ? `✅(${L.equiv[t][0]})` : missing.length === L.gates.length ? '⚠ 파일 없음' : '❌', at: h[0] || eq[0] || null };
    }
    // 레인 전용 관문(부르는 쪽 파일에서만 찾는다 — 자기 파일 안 이름은 세지 않음)
    const extra = Object.fromEntries((L.extra || []).map((e) => {
      const h = toolUse(new Map([...files].filter(([f]) => !path.basename(f).startsWith(e))), e);
      return [e, { mark: h.length ? '✅' : '❌', at: h[0] || null }];
    }));
    const spec = newest(L.spec);
    const fields = {};
    let data = null;
    try { data = spec ? JSON.parse(fs.readFileSync(spec, 'utf8')) : null; } catch { data = null; }
    for (const fk of L.fields) {
      const keys = fk.split('|');
      if (!data) { fields[label(fk)] = { mark: '⚠ 파일 없음' }; continue; }
      const v = findKey(data, keys);
      fields[label(fk)] = { mark: v === undefined ? '❌' : (keys[0] === 'expected_comment' && typeof v !== 'object') ? '⚠ 메모' : '✅' };
    }
    rows.push({ lane: L.lane, gate_files: [...files.keys()].map(rel), gate_missing: missing,
      spec: spec ? rel(spec) : null, spec_mtime: spec ? new Date(fs.statSync(spec).mtimeMs).toISOString() : null, tools, extra, fields });
  }
  return { at: new Date().toISOString(), rows };
}

function md(res) {
  const allFields = [...new Set(LANES.flatMap((l) => l.fields.map(label)))];
  const L = [`## 자료 반영 실측 (자동, ${res.at.slice(0, 16).replace('T', ' ')}Z · scripts/adoption_check.js)`, '',
    '게이트 = 레인 업로드 게이트와 그 게이트가 부르는 스크립트(한 단계)의 코드 줄(주석 제외)에서 공용 도구 이름을 찾음. 필드 = 레인 최신 제작물 json.', '',
    `| 레인 | ${TOOLS.join(' | ')} | 레인 전용 관문 | ${allFields.join(' | ')} | 최신 제작물 |`, `|---|${TOOLS.map(() => '---').join('|')}|---|${allFields.map(() => '---').join('|')}|---|`];
  for (const r of res.rows) {
    L.push(`| ${r.lane} | ${TOOLS.map((t) => r.tools[t].mark).join(' | ')} | ${Object.entries(r.extra).map(([e, v]) => `${e} ${v.mark}`).join(', ') || '—'} | ${allFields.map((f) => (r.fields[f] ? r.fields[f].mark : '—')).join(' | ')} | ${r.spec ? `${r.spec} (${r.spec_mtime.slice(5, 16).replace('T', ' ')})` : '없음'} |`);
  }
  const miss = res.rows.filter((r) => r.gate_missing.length);
  if (miss.length) L.push('', ...miss.map((r) => `- ⚠ ${r.lane}: 게이트 파일 없음 ${r.gate_missing.join(', ')}`));
  L.push('', '근거(도구 첫 호출 줄): ' + res.rows.flatMap((r) => TOOLS.filter((t) => r.tools[t].at).map((t) => `${r.lane}·${t}=${r.tools[t].at}`)).join(' · '), '');
  return L.join('\n');
}

module.exports = { check, md, LANES, TOOLS };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  const res = check();
  const text = md(res);
  const day = new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10).replace(/-/g, '');
  const dir = path.join(ROOT, 'server', 'data', 'adoption');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(opt('--md') || path.join(dir, `adoption_${day}.md`), text, 'utf8');
  fs.writeFileSync(opt('--json') || path.join(dir, `adoption_${day}.json`), JSON.stringify(res, null, 2) + '\n', 'utf8');
  console.log(text);
}

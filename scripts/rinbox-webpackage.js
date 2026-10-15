// 린박스 완성본 옆에 «플랫폼 본문 패키지»(<mp4>.social.<locale>.txt)를 만든다.
//
//   node scripts/rinbox-webpackage.js              발행 이력 전체에 대해 없는 것만 만든다
//   node scripts/rinbox-webpackage.js --only final-xxx.mp4
//   node scripts/rinbox-webpackage.js --force      이미 있어도 다시 만든다
//
// 왜 필요한가 (2026-10-01)
//   `web-publish.js` 는 네이버 클립·페이스북 개인 프로필로 브라우저 발행을 한다. 린박스를 받을
//   `--rinbox <mp4>` 경로와 `rinboxJob()` 이 **이미 들어 있는데**, 그게 `<mp4>.social.<locale>.txt`
//   를 요구한다. 명화관은 volcano_to_publish.py 가 그 파일을 만들어 주지만 린박스는 안 만든다.
//   그래서 린박스 편은 네이버 클립·페이스북에 **한 번도 자동으로 나간 적이 없다**(rinbox04 한 건은
//   손으로 만든 일회성 작업이었다). 이 스크립트가 그 빠진 조각이다.
//
// ★공개 본문에 소스 영상 URL 을 넣지 않는다(소유주 지시 2026-10-01) — 어느 작품의 어느 편을
//   쓰는지 경쟁자에게 넘기는 짓이다. 출처는 배급사로만 적는다.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RINBOX_STATE = path.join(ROOT, 'server', 'data', 'rinbox_publish_state.json');
const SPECS = path.join(ROOT, 'midform', 'config', 'platform_post_specs.json');
const RUNS_ROOT = 'D:/volcano-runs';

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

// 같은 찾기 규칙을 rinbox-social.js 와 공유한다 — 완성본은 <workdir>/edits/<해시>/final-*.mp4 다.
function findMp4(filename) {
  let runs = [];
  try { runs = fs.readdirSync(RUNS_ROOT); } catch { return ''; }
  for (const run of runs) {
    // 자체 렌더러(rinbox_render.py) 완성본은 <런>/_render/ 에 바로 놓인다(2026-10-08 볼케이노 자립).
    const own = path.join(RUNS_ROOT, run, '_render', filename);
    if (fs.existsSync(own)) return own;
    let hashes = [];
    try { hashes = fs.readdirSync(path.join(RUNS_ROOT, run, 'edits')); } catch { continue; }
    for (const h of hashes) {
      const c = path.join(RUNS_ROOT, run, 'edits', h, filename);
      if (fs.existsSync(c)) return c;
    }
  }
  return '';
}

// 설명문은 빈 줄로 갈린 토막이다: 원작 유도 / 줄거리 / 삭제 고지 / 출처 블록.
function splitDescription(description) {
  const parts = String(description || '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const out = { pitch: '', summary: '', notice: '', source: '' };
  for (const p of parts) {
    if (/풀버전|フルバージョン/.test(p) && !out.pitch) out.pitch = p;
    else if (/^★/.test(p)) out.notice = p;
    else if (/^[─-]{5,}|출처|出典|제작|制作|放送/.test(p)) out.source = p.replace(/^[─-]{5,}\s*/, '');
    else if (!out.summary) out.summary = p;
  }
  return out;
}

// 한국어는 강제 개행 자리가 곧 공백이고, 일본어는 공백을 쓰지 않는다.
function unwrap(block) {
  const raw = String(block || '');
  const ja = /[\u3040-\u30ff]/.test(raw);
  const rows = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  let out = '';
  for (const r of rows) {
    if (!out) { out = r; continue; }
    if (/https?:\/\//.test(r)) continue;          // ★URL 줄은 버린다
    out += ja ? r : ` ${r}`;
  }
  return out;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function build(meta, mp4) {
  const specs = readJson(SPECS, { platforms: {} }).platforms || {};
  const d = splitDescription(meta.description);
  const tags = (meta.tags || []).map((t) => `#${String(t).replace(/\s+/g, '')}`);
  const title = meta.title || '';
  const lead = [d.summary, d.pitch].filter(Boolean).join(' ');
  const cap = (n) => clip(lead, n);
  const take = (n) => tags.slice(0, n).join(' ');
  const L = [];
  const head = (name) => L.push('', '='.repeat(46), `[${name}]`, '='.repeat(46));

  L.push(`# ${meta.locale.toUpperCase()} 발행 패키지 — ${title}`,
    '# 생성: rinbox-webpackage.js (린박스 → 브라우저 발행)',
    '', '='.repeat(46), '[영상 드래프트]', '='.repeat(46),
    `FILE       : ${path.basename(mp4)}`,
    'RATIO      : 9:16 / 1080x1920');

  head('YouTube Shorts');
  L.push('(제목)', title, '', '(캡션)', cap(Number(specs.youtube?.caption_max || 5000)), '', '(해시태그)', take(3));

  head('TikTok');
  L.push('(캡션)', cap(Number(specs.tiktok?.caption_max || 4000)), '', '(해시태그)', take(5));

  head('Instagram Reels');
  L.push('(캡션)', cap(Number(specs.instagram?.caption_max || 2200)), '', '(해시태그)', take(5));

  head('Facebook Reels');
  L.push('(캡션)', cap(Number(specs.facebook?.caption_max || 2200)), '', '(해시태그)', take(3));

  head('Threads');
  L.push('(캡션)', clip([title, d.pitch].filter(Boolean).join('\n'), Number(specs.threads?.caption_max || 500)),
    '', '(해시태그)', take(1));

  if (meta.locale === 'ko') {
    head('네이버 클립');
    // 네이버는 제목 50자·캡션 300자. 정보태그는 «작품 제목» 한 줄이 필수다.
    L.push('(제목)', clip(title, 50), '', '(캡션)', cap(Number(specs.naver_clip?.caption_max || 300)),
      '', '(해시태그)', take(10),
      '', '(정보태그 — 필수, 작품 태그)', (meta.tags || [])[0] || title);
  }
  return `${L.join('\n')}\n`;
}

function main() {
  const only = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? process.argv[i + 1] : ''; })();
  const force = process.argv.includes('--force');
  const hist = (readJson(RINBOX_STATE, { history: [] }).history || []).filter((e) => e.file);
  const rows = only ? hist.filter((e) => e.file === only) : hist;
  if (!rows.length) { console.log('대상 없음'); return; }

  let made = 0;
  for (const e of rows) {
    const mp4 = findMp4(e.file);
    if (!mp4) { console.log(`건너뜀 mp4 없음  ${e.file}`); continue; }
    const meta = readJson(`${mp4}.rinbox.json`, null);
    if (!meta) { console.log(`건너뜀 메타 없음 ${e.file}`); continue; }
    const out = `${mp4}.social.${meta.locale}.txt`;
    if (fs.existsSync(out) && !force) { console.log(`이미 있음      ${e.file}`); continue; }
    const text = build(meta, mp4);
    if (/https?:\/\//.test(text)) { console.log(`★URL 남음 — 건너뜀 ${e.file}`); continue; }
    fs.writeFileSync(out, text, 'utf8');
    made += 1;
    console.log(`만듦 ${meta.locale}  ${e.file}  (${text.length}자)`);
  }
  console.log(`\n새로 만든 패키지 ${made}건`);
}

main();

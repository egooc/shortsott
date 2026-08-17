// Audit finished drafts against the things that have actually gone wrong on this
// channel: a Full that is far short of the format, a title still carrying the
// deterministic template, a manuscript that circles one arc step, and several
// videos cut from one source.
//
//   node scripts/ops/draft-audit.js [--prefix 20260816] [--json]
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DRAFTS = path.join(os.homedir(), 'Desktop', '캡컷아웃풋', 'CapCut Drafts');

const FULL_MIN_SEC = 38;

const TEMPLATE_TITLE_SHAPES = [
  /의 결정적 순간$/u, /(?:이|가) 만들어지는 과정$/u, /(?:이|가) 완성되는 순간$/u,
  /^작업 흐름으로 보는 /u, / 제작 과정 관찰$/u,
  /の決定的瞬間$/u, /ができるまで$/u, /が形になる瞬間$/u, /^作業の流れで見る/u, /づくりを観察$/u
];

const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : '';
};
const prefix = argOf('--prefix');
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// Kept in step with processQueueService's isTemplate: the shapes alone flag real
// titles that happen to end the same way, so a template also has to be short and
// free of the punctuation a written hook uses.
const TEMPLATE_MAX_BARE_LENGTH = 16;
const isTemplateTitle = (t) => {
  const bare = String(t || '').replace(/[#＃][^\s#＃]+/gu, '').trim();
  if (!bare || bare.length > TEMPLATE_MAX_BARE_LENGTH) return false;
  if (/[!！?？:：、,]/u.test(bare)) return false;
  return TEMPLATE_TITLE_SHAPES.some((s) => s.test(bare));
};

function itemOf(manifest) {
  return String(manifest?.source_video_path || '').split(path.sep).find((p) => /^item_\d+$/.test(p)) || '';
}

// Same rule the generation gate applies, so an audit and the gate agree on what
// "circles one step" means.
function arcCoverageIssues(script) {
  const items = Array.isArray(script) ? script : [];
  if (items.length < 2) return [];
  const steps = items.map((i) => Number(i?.arc_step)).filter((n) => Number.isFinite(n) && n > 0);
  if (steps.length !== items.length) return [];
  const issues = [];
  for (let i = 1; i < steps.length; i += 1) {
    if (steps[i] < steps[i - 1]) { issues.push('arc_step 역행'); break; }
  }
  const per = new Map();
  for (const s of steps) per.set(s, (per.get(s) || 0) + 1);
  const worst = [...per.entries()].sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[1] > 2) issues.push(`한 단계에 ${worst[1]}문장`);
  if (per.size < Math.max(3, Math.ceil(items.length * 0.5))) issues.push(`서로 다른 단계 ${per.size}개뿐`);
  return issues;
}

const rows = [];
const bySource = new Map();

for (const name of fs.readdirSync(DRAFTS).sort()) {
  if (prefix && !name.startsWith(prefix)) continue;
  const manifestPath = path.join(DRAFTS, name, 'edit_manifest.json');
  if (!fs.existsSync(manifestPath)) continue;
  const m = readJson(manifestPath);
  if (!m) continue;

  const isFull = /-F-/.test(name);
  const item = itemOf(m);
  const duration = Number(m.actual_timeline_duration_sec || 0);
  const problems = [];

  if (isFull && duration && duration < FULL_MIN_SEC) problems.push(`${duration.toFixed(1)}초 (기준 ${FULL_MIN_SEC}초)`);
  if (isTemplateTitle(m.upload_title)) problems.push('제목이 템플릿');

  if (item) {
    const cfg = readJson(path.join(ROOT, 'queue', 'process', item, 'item_config.json'));
    const guide = (cfg && cfg.ottogi_guide_output) || {};
    const script = guide.full_caption_script_ko || guide.full_caption_script_ja || [];
    if (isFull) arcCoverageIssues(script).forEach((i) => problems.push(i));
    if (isFull) {
      if (!bySource.has(item)) bySource.set(item, []);
      bySource.get(item).push(name);
    }
  }

  rows.push({ name, item, is_full: isFull, duration_sec: duration, title: m.upload_title || '', problems });
}

// Two Fulls from one source sitting in the buffer is the shape that reaches the
// channel as a duplicate: the uploader only knows a source is spent once one of
// them has been published, so the pair looks like two ordinary videos waiting
// their turn (2026-08-17, item_067 - two Fulls built 28 minutes apart before the
// producer learned not to build while a batch is running).
const dupSources = [...bySource.entries()].filter(([, list]) => list.length > 1);
const flagged = rows.filter((r) => r.problems.length);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rows, flagged, duplicate_full_sources: dupSources }, null, 2));
} else {
  console.log(`검사 ${rows.length}편 | 문제 ${flagged.length}편`);
  for (const r of flagged) {
    console.log(`  ${r.is_full ? 'FULL' : 'HL  '} ${r.name.slice(0, 44)}`);
    console.log(`       ${r.problems.join(' / ')}`);
    console.log(`       제목: ${String(r.title).slice(0, 60)}`);
  }
  if (dupSources.length) {
    console.log(`같은 소스에서 Full 여러 편 (${dupSources.length}건)`);
    for (const [item, list] of dupSources) console.log(`  ${item}: ${list.length}편`);
  }
}

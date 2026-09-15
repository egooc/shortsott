'use strict';

// Where a run's wall clock actually went.
//
// Nothing in the pipeline records stage timings, so "which part is the bottleneck" could only be
// answered by hand-diffing artifact mtimes. The first measured run said the vision scene map cost
// 14 of its first 28 minutes - half the run before a single sentence was written - and that was
// invisible until someone ran `ls`.
//
// Each artifact is written once, when its stage finishes, so the gap between consecutive artifacts
// is that stage's cost. Deleted or reused artifacts simply do not appear; a reused transcript
// shows as a near-zero gap, which is the truth.
//
//   node scripts/run-timeline.js <compress_run_dir> [template_run_dir]

const fs = require('fs');
const path = require('path');

// Written at the END of the stage named. Order matters more than completeness: an artifact that
// does not exist is skipped rather than guessed at.
const STAGES = [
  ['source_info.json', '소스 메타'],
  ['source.mp4', '다운로드'],
  ['subtitles_raw', '자막 수집'],
  ['transcript_timed.raw.json', '전사(원시)'],
  ['source.mp4.shot_boundaries.json', '컷 경계 검출'],
  ['heatmap.json', '히트맵'],
  ['vision_scene_map.json', '비전 지도 (멀티모달)'],
  ['source_case.json', '소스 판정'],
  ['source_evidence_map.json', '증거 지도'],
  ['transcript_timed.json', '전사 정화'],
  ['narrative_beats.json', '비트 추출'],
  ['narrative_beats.md', '비트 리포트'],
  ['edit_plan.json', '편집 플랜'],
  ['selected_arc_map.json', '사건 선정'],
  ['compression_slot_fills.json', '작문 (fills)'],
  ['compression_slot_fills.ja.json', '작문 (ja)'],
  ['slot_qc_report.json', '슬롯 QC'],
  ['compression_manifest.json', '압축 매니페스트'],
  ['bootstrap_script.json', '부트스트랩'],
  ['upload_text.md', '업로드 텍스트']
];

const TEMPLATE_STAGES = [
  ['template_body.ko.md', '템플릿 본문'],
  ['draft_ko/edit_manifest.json', 'ko 초안 조립'],
  ['draft_ja/edit_manifest.json', 'ja 초안 조립'],
  ['acceptance_gates.json', '수용 게이트'],
  ['.judge_verdict_cache.json', '프레임 판정'],
  ['run_summary.json', '런 종료']
];

// The one artifact that is restored rather than produced: ensureVisionSceneMap copyFileSync's
// the scene map out of the shared cache, and the copy keeps the CACHE's mtime. Billed as a stage
// that read as 140 minutes on the first run measured this way. Proven, not guessed: the file is
// restored exactly when it is byte-identical to its cache entry.
function restoredFromVisionCache(dir, file) {
  if (file !== 'vision_scene_map.json') return false;
  const map = path.join(dir, file);
  if (!fs.existsSync(map)) return false;
  try {
    const sourceId = String(JSON.parse(fs.readFileSync(map, 'utf8')).source_id || '').trim();
    if (!sourceId) return false;
    const cached = path.join(dir, '..', '.vision_scene_cache', `${sourceId}.json`);
    if (!fs.existsSync(cached)) return false;
    return fs.readFileSync(map, 'utf8') === fs.readFileSync(cached, 'utf8');
  } catch {
    return false;
  }
}

function collect(dir, stages, floor) {
  const rows = [];
  for (const [file, label] of stages) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) continue;
    const at = fs.statSync(full).mtime;
    rows.push({ label, file, at, reused: restoredFromVisionCache(dir, file) });
  }
  // A stage cannot predate the phase it belongs to: the template workspace is opened before the
  // compress phase runs, so anchoring on its first artifact billed all of compress to "ko draft
  // assembly" - 1762s for work that took 124s.
  const earliest = floor || rows.filter((row) => !row.reused)
    .reduce((min, row) => (min === null || row.at < min ? row.at : min), null);
  for (const row of rows) if (earliest && row.at < earliest) { row.at = earliest; row.reused = true; }
  return rows;
}

function render(rows) {
  rows.sort((a, b) => a.at - b.at);
  if (!rows.length) return;
  const start = rows[0].at;
  let previous = start;
  let widest = 0;
  for (const row of rows) widest = Math.max(widest, row.label.length);
  for (const row of rows) {
    const stageSec = (row.at - previous) / 1000;
    const sinceStart = (row.at - start) / 1000;
    const bar = '#'.repeat(Math.min(40, Math.round(stageSec / 20)));
    console.log('%s  %s  %s  %s %s',
      row.at.toTimeString().slice(0, 8),
      row.label.padEnd(widest),
      row.reused ? ' 재사용' : `+${Math.round(stageSec)}s`.padStart(7),
      `(누적 ${Math.round(sinceStart / 60)}분)`.padEnd(12),
      row.reused ? '' : bar);
    previous = row.at;
  }
  return { start, end: rows[rows.length - 1].at };
}

const [compressDir, templateDir] = process.argv.slice(2);
if (!compressDir) {
  console.log('usage: node scripts/run-timeline.js <compress_run_dir> [template_run_dir]');
  process.exit(1);
}

console.log(`\n== 압축 런 ==  ${path.basename(compressDir)}`);
const compress = render(collect(compressDir, STAGES));

let template = null;
if (templateDir && fs.existsSync(templateDir)) {
  console.log(`\n== 템플릿 런 ==  ${path.basename(templateDir)}`);
  // The template workspace is opened before the compress phase runs, so its first artifact is
  // minutes older than the drafting it belongs to. Anchor its stages at the end of compress -
  // otherwise the whole compress phase is billed to "ko draft assembly", which is how a 124s
  // assembly first read as 1762s.
  template = render(collect(templateDir, TEMPLATE_STAGES, compress ? compress.end : null));
}

const first = compress?.start;
const last = template?.end || compress?.end;
if (first && last) {
  console.log(`\n전체 ${Math.round((last - first) / 60000)}분  (${first.toTimeString().slice(0, 8)} -> ${last.toTimeString().slice(0, 8)})`);
}

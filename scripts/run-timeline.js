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

function collect(dir, stages) {
  const rows = [];
  for (const [file, label] of stages) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) continue;
    rows.push({ label, file, at: fs.statSync(full).mtime });
  }
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
    console.log('%s  %s  +%s  %s %s',
      row.at.toTimeString().slice(0, 8),
      row.label.padEnd(widest),
      `${Math.round(stageSec)}s`.padStart(6),
      `(누적 ${Math.round(sinceStart / 60)}분)`.padEnd(12),
      bar);
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
  template = render(collect(templateDir, TEMPLATE_STAGES));
}

const first = compress?.start;
const last = template?.end || compress?.end;
if (first && last) {
  console.log(`\n전체 ${Math.round((last - first) / 60000)}분  (${first.toTimeString().slice(0, 8)} -> ${last.toTimeString().slice(0, 8)})`);
}

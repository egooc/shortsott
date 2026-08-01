const fs = require('node:fs');
const path = require('node:path');
const { PROJECT_ROOT } = require('../server/services/pipelinePaths');
const { generateLocaleDraftArtifacts } = require('../server/services/midformLocaleDraftService');
const { writeJson } = require('../server/services/midformRunArtifactsService');

const QA_ROOT = path.join(PROJECT_ROOT, 'midform', 'test_runs', 'locale_manual_qa_20260729');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function parseTimecode(value) {
  if (typeof value === 'number') return value;
  const parts = String(value || '').split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(value || 0);
}

function sourceRange(segment) {
  const scene = (segment.source_scenes || segment.source_clips || [])[0] || {};
  const start = parseTimecode(scene.start);
  const end = parseTimecode(scene.end);
  return end > start ? [Number(start.toFixed(3)), Number(end.toFixed(3))] : [0, 0];
}

function clipDuration(range) {
  return Number(Math.max(0, Number(range[1] || 0) - Number(range[0] || 0)).toFixed(3));
}

function shiftRange(range, shift, maxSec) {
  const duration = clipDuration(range);
  const start = Math.min(Math.max(0, maxSec - duration), Math.max(0, Number(range[0] || 0) + shift));
  return [Number(start.toFixed(3)), Number((start + duration).toFixed(3))];
}

function roleFor(segment, index) {
  if (index === 0) return 'cold_open';
  if (index >= 3 && index <= 5) return 'reaction_support';
  if (index >= 6) return 'payoff';
  return String(segment.segment_type || '').includes('dialogue') ? 'dialogue_anchor' : 'bridge';
}

function buildSpec(locale, baseInput) {
  const segments = Array.isArray(baseInput.segments) ? baseInput.segments : [];
  const sourceDuration = Number(baseInput.sourceDurationSec || baseInput.source_duration_sec || baseInput.claudeScript?.source_reference?.duration_sec || 220) || 220;
  const order = locale === 'ja'
    ? [...segments.slice(1, 4), segments[0], ...segments.slice(4)].filter(Boolean)
    : segments;
  let cursor = 0;
  const clipPlacement = order.map((segment, index) => {
    const baseRange = sourceRange(segment);
    const shifted = locale === 'ja' ? shiftRange(baseRange, 5 + index * 0.7, sourceDuration) : baseRange;
    const duration = clipDuration(shifted);
    const clip = {
      clip_id: `${locale}_${segment.segment_id || `slot_${index + 1}`}`,
      source_range: shifted,
      timeline_range: [Number(cursor.toFixed(3)), Number((cursor + duration).toFixed(3))],
      visual_role: roleFor(segment, index),
      transition: 'cut'
    };
    cursor += duration;
    return clip;
  });
  return {
    artifact_type: 'midform_locale_draft_spec',
    locale,
    source_edit_plan_artifact: `manual_qa.${locale}`,
    clip_placement: clipPlacement,
    shot_duration: clipPlacement.map((clip) => ({ clip_id: clip.clip_id, duration_sec: clipDuration(clip.source_range) })),
    reaction_insert: clipPlacement.filter((clip) => clip.visual_role === 'reaction_support'),
    visual_pacing: locale === 'ja' ? 'measured_escalation' : 'fast_compressed',
    subtitle_layout: locale === 'ja' ? 'measured_two_line_bottom_safe' : 'fast_compact_center_bottom',
    tts_voice_timing: locale === 'ja' ? 'measured_pause_forward' : 'fast_direct'
  };
}

async function runSample(sample) {
  const workspaceDir = path.join(QA_ROOT, sample.id);
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  const baseInput = readJson(sample.draftInputPath);
  const localInput = {
    ...baseInput,
    source_video_path: sample.sourceVideoPath,
    sourceVideoPath: sample.sourceVideoPath,
    source_transcript_path: sample.transcriptPath,
    sourceTranscriptPath: sample.transcriptPath,
    draft_output_mode: 'folder_only',
    package_zip: false
  };
  writeJson(path.join(workspaceDir, 'draft_input.json'), localInput);
  writeJson(path.join(workspaceDir, 'draft_spec.ko.json'), buildSpec('ko', localInput));
  writeJson(path.join(workspaceDir, 'draft_spec.ja.json'), buildSpec('ja', localInput));
  const result = await generateLocaleDraftArtifacts({
    workspaceDir,
    baseDraftInputPath: path.join(workspaceDir, 'draft_input.json'),
    sourceVideoPath: sample.sourceVideoPath,
    transcriptPath: sample.transcriptPath
  });
  return { sample: sample.id, label: sample.label, workspaceDir, result };
}

async function main() {
  fs.mkdirSync(QA_ROOT, { recursive: true });
  const samples = [
    {
      id: 'emotional_dialogue_fences',
      label: 'emotional dialogue — Fences father/son',
      draftInputPath: path.join(PROJECT_ROOT, 'midform/test_runs/run_013_tVxYCeRXzGo_e2e/draft_input_signature_quotes.json'),
      sourceVideoPath: path.join(PROJECT_ROOT, 'midform/test_runs/run_013_tVxYCeRXzGo_e2e/source.mp4'),
      transcriptPath: path.join(PROJECT_ROOT, 'midform/test_runs/run_013_tVxYCeRXzGo_e2e/source_transcript.json')
    },
    {
      id: 'reveal_reversal_bucky_wakanda',
      label: 'reveal/reversal — Bucky Wakanda deprogramming',
      draftInputPath: path.join(PROJECT_ROOT, 'midform/test_runs/run_010_H9GPm8uG8Es_bucky_wakanda_raw/draft_input_slotfill_rerun_20260714.json'),
      sourceVideoPath: path.join(PROJECT_ROOT, 'midform/test_runs/run_010_H9GPm8uG8Es_bucky_wakanda_raw/source.mp4'),
      transcriptPath: path.join(PROJECT_ROOT, 'midform/test_runs/run_010_H9GPm8uG8Es_bucky_wakanda_raw/source_transcript_rerun_20260714.json')
    }
  ];
  const outputs = [];
  for (const sample of samples) outputs.push(await runSample(sample));
  writeJson(path.join(QA_ROOT, 'manual_qa_generation_summary.json'), outputs.map((item) => ({ sample: item.sample, label: item.label, workspaceDir: item.workspaceDir, outputPaths: item.result.outputPaths, finalOverlapReport: item.result.finalOverlapReport })));
  process.stdout.write(JSON.stringify(outputs.map((item) => ({ sample: item.sample, workspaceDir: item.workspaceDir, finalStatus: item.result.finalOverlapReport.final_status, outputPaths: item.result.outputPaths })), null, 2));
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { PROJECT_ROOT } = require('./pipelinePaths');
const { evaluateEditorialAcceptance } = require('./midformEditorialAcceptanceService');
const {
  readJson,
  activeSegmentsFromManifest,
  colorEvidenceBySpeaker,
  firstDialogueStartSec,
  callbackDialogueStartSec,
  maxContinuousNarrationRunSec,
  validateManifestMaterialColors,
  validateSpeakerColorMetadata
} = require('../../tests/artifactQaHelpers');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(text), 'utf8');
}

function rel(filePath) {
  return path.relative(PROJECT_ROOT, filePath).replace(/\\/g, '/');
}

function copyIfExists(sourcePath, destinationPath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return '';
  ensureDir(path.dirname(destinationPath));
  fs.copyFileSync(sourcePath, destinationPath);
  return destinationPath;
}

function buildAcceptanceSegments(editManifest) {
  return activeSegmentsFromManifest(editManifest).map((segment) => ({
    segment_id: segment.segment_id,
    parent_slot_id: String(segment.segment_id || '').replace(/_L\d+.*$/, ''),
    segment_type: segment.segment_type,
    caption_kind: segment.caption_kind,
    speaker_id: segment.speaker_id,
    speaker_alias: segment.speaker_alias,
    speaker_color_key: segment.speaker_color_key,
    source_utterance_id: segment.source_utterance_id,
    caption_color: segment.caption_color,
    caption_text: segment.text,
    narration: segment.text,
    timeline_start_sec: segment.timeline_start_sec,
    timeline_end_sec: segment.timeline_end_sec
  }));
}

function buildTimingSummary(editManifest) {
  const segments = activeSegmentsFromManifest(editManifest);
  return {
    first_dialogue_start_sec: firstDialogueStartSec(segments),
    callback_dialogue_start_sec: callbackDialogueStartSec(segments),
    max_continuous_narration_run_sec: maxContinuousNarrationRunSec(segments),
    total_duration_sec: Number(
      segments.reduce((max, segment) => Math.max(max, Number(segment.timeline_end_sec || 0)), 0).toFixed(3)
    )
  };
}

function generatePreviewFrameProof({ draftInputPath, workspaceDir, enabled = true, profile = 'production', limit = 8 }) {
  const proofPath = path.join(workspaceDir, 'preview_frame_proof.json');
  if (!draftInputPath || !fs.existsSync(draftInputPath)) {
    const skipped = {
      artifact_type: 'midform_preview_frame_proof',
      status: 'skipped',
      reason: 'draft_input_missing',
      checked: 0,
      passed: 0,
      results: []
    };
    writeJson(proofPath, skipped);
    return skipped;
  }
  if (enabled !== true) {
    const skipped = {
      artifact_type: 'midform_preview_frame_proof',
      status: 'skipped',
      reason: `preview_proof_disabled_for_profile_${profile}`,
      checked: 0,
      passed: 0,
      results: []
    };
    writeJson(proofPath, skipped);
    return skipped;
  }
  const outDir = path.join(workspaceDir, 'preview_frames');
  ensureDir(outDir);
  execFileSync('python', [
    path.join(PROJECT_ROOT, 'scripts', 'wave4_visual_preview.py'),
    '--draft-input', draftInputPath,
    '--proof', proofPath,
    '--out-dir', outDir,
    '--limit', String(limit)
  ], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 100 * 1024 * 1024
  });
  return readJson(proofPath);
}

function buildHumanQaReview({ normalizedRequest, gateResults, timing, colorEvidence, materialValidation, previewProof, outputPaths }) {
  const failed = Array.isArray(gateResults?.failed) ? gateResults.failed : [];
  const warnings = Array.isArray(gateResults?.warnings) ? gateResults.warnings : [];
  const results = Array.isArray(gateResults?.results) ? gateResults.results : [];
  return [
    '# Midform Run QA Review',
    '',
    `- status: ${gateResults?.status || 'unknown'}`,
    `- profile: ${normalizedRequest.profile}`,
    `- source_url: ${normalizedRequest.source.url}`,
    `- target_length_sec: ${normalizedRequest.output.target_length_sec}`,
    '',
    '## Timing summary',
    '',
    `- first dialogue: ${timing.first_dialogue_start_sec}`,
    `- callback dialogue: ${timing.callback_dialogue_start_sec}`,
    `- max narration run: ${timing.max_continuous_narration_run_sec}`,
    `- total duration: ${timing.total_duration_sec}`,
    '',
    '## Acceptance gates',
    '',
    `- failed: ${failed.join(', ') || '(none)'}`,
    `- warnings: ${warnings.join(', ') || '(none)'}`,
    '',
    ...results.map((result) => `- ${result.id}: ${result.status}`),
    '',
    '## Speaker color evidence',
    '',
    ...Object.entries(colorEvidence).map(([speaker, colors]) => `- ${speaker}: ${colors.join(', ')}`),
    ...(Object.keys(colorEvidence).length ? [''] : ['- none', '']),
    '## Material validation',
    '',
    `- checked: ${materialValidation.checked}`,
    `- passed: ${materialValidation.passed}`,
    `- failed: ${materialValidation.failed.length}`,
    '',
    '## Preview proof',
    '',
    `- status: ${previewProof.status || 'generated'}`,
    `- checked: ${previewProof.checked || 0}`,
    `- passed: ${previewProof.passed || 0}`,
    '',
    '## Outputs',
    '',
    ...Object.entries(outputPaths).map(([key, value]) => `- ${key}: ${value || ''}`),
    ''
  ].join('\n');
}

function parseTimecodeSec(value) {
  const text = String(value || '').trim();
  const parts = text.split(':');
  if (parts.length === 3) return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  return Number(text) || 0;
}

function measureIntegratedLufsLoose(ffmpeg, inputArgs) {
  // ebur128 prints its summary on stderr and ffmpeg exits 0, so spawnSync + stderr parse is
  // the only reliable read (execFileSync hides stderr unless the process throws).
  const { spawnSync } = require('child_process');
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-nostats', ...inputArgs, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  const match = String(probe.stderr || '').match(/I:\s*(-?[\d.]+)\s*LUFS/);
  return match ? Number(match[1]) : null;
}

// Loudness gate (OpenShorts, MIT - measured rationale: platforms normalize playback to about
// -14 LUFS, so a narration mixed quieter than the film dialogue plays THIN in the feed; the
// quiet track gets punished, not compensated. Measure both sides and flag the mismatch before
// install instead of hearing it after upload.
function measureNarrationDialogueLoudness(pipelineRunDir, editManifest) {
  try {
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const ttsDir = path.join(pipelineRunDir, 'tts');
    const ttsFiles = fs.existsSync(ttsDir)
      ? fs.readdirSync(ttsDir).filter((name) => /\.(wav|mp3)$/i.test(name)).slice(0, 4).map((name) => path.join(ttsDir, name))
      : [];
    const sourceVideo = ['source.mp4', 'source.webm', 'source.mkv'].map((name) => path.join(pipelineRunDir, name)).find((candidate) => fs.existsSync(candidate));
    const narrationValues = ttsFiles
      .map((file) => measureIntegratedLufsLoose(ffmpeg, ['-i', file]))
      .filter((value) => Number.isFinite(value));
    const dialogueWindows = [];
    const seen = new Set();
    for (const segment of (Array.isArray(editManifest?.segments) ? editManifest.segments : [])) {
      if (!/dialogue/.test(String(segment?.segment_type || ''))) continue;
      const clip = (segment.source_clips || [])[0];
      if (!clip) continue;
      const start = parseTimecodeSec(clip.start);
      const end = parseTimecodeSec(clip.end);
      const key = `${start}-${end}`;
      if (!(end > start + 0.5) || seen.has(key)) continue;
      seen.add(key);
      dialogueWindows.push([start, end]);
      if (dialogueWindows.length >= 4) break;
    }
    const dialogueValues = sourceVideo
      ? dialogueWindows
        .map(([start, end]) => measureIntegratedLufsLoose(ffmpeg, ['-ss', start.toFixed(3), '-t', (end - start).toFixed(3), '-i', sourceVideo, '-vn']))
        .filter((value) => Number.isFinite(value))
      : [];
    if (!narrationValues.length || !dialogueValues.length) {
      return { status: 'not_measured', narration_samples: narrationValues.length, dialogue_samples: dialogueValues.length };
    }
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const narrationI = Number(mean(narrationValues).toFixed(1));
    const dialogueI = Number(mean(dialogueValues).toFixed(1));
    return {
      status: 'measured',
      narration_lufs: narrationI,
      dialogue_lufs: dialogueI,
      delta_lu: Number(Math.abs(narrationI - dialogueI).toFixed(1)),
      narration_samples: narrationValues.length,
      dialogue_samples: dialogueValues.length
    };
  } catch (error) {
    return { status: 'error', message: String(error?.message || error) };
  }
}

function collectRunArtifacts({
  workspaceDir,
  normalizedRequest,
  profile,
  pipelineRunDir,
  draftRoot,
  enablePreviewFrameProof,
  readability,
  sceneType,
  editorialPattern,
  previewLimit
}) {
  const rootDraftInputPath = copyIfExists(path.join(pipelineRunDir, 'draft_input.json'), path.join(workspaceDir, 'draft_input.json'));
  copyIfExists(path.join(pipelineRunDir, 'slot_map.json'), path.join(workspaceDir, 'slot_map.json'));
  copyIfExists(path.join(pipelineRunDir, 'script.json'), path.join(workspaceDir, 'script.json'));
  copyIfExists(path.join(draftRoot, 'edit_manifest.json'), path.join(workspaceDir, 'edit_manifest.json'));
  copyIfExists(path.join(draftRoot, 'draft_content.json'), path.join(workspaceDir, 'draft_content.json'));

  const editManifest = readJson(path.join(workspaceDir, 'edit_manifest.json'));
  const draftContent = readJson(path.join(workspaceDir, 'draft_content.json'));
  const materialValidation = validateManifestMaterialColors(editManifest, draftContent);
  const speakerColorValidation = validateSpeakerColorMetadata(editManifest);
  const timing = buildTimingSummary(editManifest);
  const colorEvidence = colorEvidenceBySpeaker(editManifest);
  const gateResults = evaluateEditorialAcceptance({
    scene_type: sceneType,
    editorial_pattern: editorialPattern,
    segments: buildAcceptanceSegments(editManifest),
    caption_units: editManifest.caption_units || [],
    material_validation: materialValidation,
    speaker_color_validation: speakerColorValidation
  }, {
    readability: readability || {}
  });
  // Structural guard (owner directive 2026-08-08): a later caption chunk of the SAME dialogue
  // line must appear at reading pace after the previous one - never seconds late. This caught
  // two separate mechanisms already (window-proportional spreading, and the hold-extended
  // previous chunk pushing the chained start); the gate keeps any future mechanism from
  // shipping unnoticed on any source.
  function measureCaptionChunkLateness(draftContent) {
    const issues = [];
    try {
      const texts = new Map(((draftContent?.materials || {}).texts || []).map((material) => {
        let text = '';
        const content = material?.content;
        try { text = typeof content === 'string' && content.startsWith('{') ? (JSON.parse(content).text || '') : String(content || ''); } catch { text = String(content || ''); }
        return [material.id, text];
      }));
      for (const track of (draftContent?.tracks || [])) {
        if (track?.type !== 'text' || !/^subtitle/.test(String(track?.name || ''))) continue;
        const segments = (track.segments || []).slice().sort((left, right) => Number(left?.target_timerange?.start || 0) - Number(right?.target_timerange?.start || 0));
        for (let index = 1; index < segments.length; index += 1) {
          const prev = segments[index - 1];
          const curr = segments[index];
          const prevText = texts.get(prev?.material_id) || '';
          const gapSec = (Number(curr?.target_timerange?.start || 0) - Number(prev?.target_timerange?.start || 0)) / 1_000_000;
          const readingSec = Math.max(0.6, prevText.length / 8);
          if (prevText && gapSec > readingSec * 2 + 1.5 && gapSec < 30) {
            // Same visual line-group heuristic: only flag when the previous chunk text does
            // not end a sentence (a fragment whose continuation is late).
            if (!/[.?!…]$/.test(prevText.trim())) {
              issues.push({ prev_text: prevText.slice(0, 20), gap_sec: Number(gapSec.toFixed(2)), reading_sec: Number(readingSec.toFixed(2)) });
            }
          }
        }
      }
    } catch { /* measurement is best-effort */ }
    return issues;
  }
  const chunkLateness = measureCaptionChunkLateness(draftContent);
  const loudness = measureNarrationDialogueLoudness(pipelineRunDir, editManifest);
  // Draft-level volume gains (loudness auto-alignment) change what the viewer hears without
  // changing the files this measurement reads, so judge the ALIGNED delta when gains exist.
  const alignmentPath = path.join(workspaceDir, 'loudness_alignment.ko.json');
  if (loudness.status === 'measured' && fs.existsSync(alignmentPath)) {
    try {
      const alignment = readJson(alignmentPath);
      if (alignment && alignment.applied) {
        loudness.raw_delta_lu = loudness.delta_lu;
        loudness.video_gain_db = alignment.video_gain_db;
        loudness.tts_cut_db = alignment.tts_cut_db;
        loudness.delta_lu = Number(Math.abs(
          (loudness.narration_lufs - Number(alignment.tts_cut_db || 0))
          - (loudness.dialogue_lufs + Number(alignment.video_gain_db || 0))
        ).toFixed(1));
      }
    } catch { /* unaligned measurement stands */ }
  }
  if (loudness.status === 'measured') {
    const status = loudness.delta_lu > 6 ? 'fail' : (loudness.delta_lu > 3 ? 'warning' : 'pass');
    gateResults.results.push({ id: 'narration_dialogue_loudness_delta', status, ...loudness });
    if (status === 'fail' && !gateResults.failed.includes('narration_dialogue_loudness_delta')) {
      gateResults.failed.push('narration_dialogue_loudness_delta');
      gateResults.status = 'failed';
    } else if (status === 'warning' && !gateResults.warnings.includes('narration_dialogue_loudness_delta')) {
      gateResults.warnings.push('narration_dialogue_loudness_delta');
      if (gateResults.status === 'passed') gateResults.status = 'passed_with_warnings';
    }
  } else {
    gateResults.results.push({ id: 'narration_dialogue_loudness_delta', status: 'not_applicable', ...loudness });
  }
  {
    const status = chunkLateness.length ? 'warning' : 'pass';
    gateResults.results.push({ id: 'dialogue_caption_chunk_lateness', status, issue_count: chunkLateness.length, issues: chunkLateness.slice(0, 8) });
    if (status === 'warning' && !gateResults.warnings.includes('dialogue_caption_chunk_lateness')) {
      gateResults.warnings.push('dialogue_caption_chunk_lateness');
      if (gateResults.status === 'passed') gateResults.status = 'passed_with_warnings';
    }
  }
  // Energy-peak coverage (owner directive 2026-08-10): beats are FORCED to cover the measured
  // top-2 energy peaks, but nothing below them was — on Shelter the final cut shipped with the
  // fight's rank-1/2 peaks at 0.0s because narration b-roll picked the largest (quietest) gap.
  // The draft is the truth after every clamp, so the gate measures here.
  {
    const energyProfilePath = path.join(workspaceDir, 'energy_profile.json');
    const sourceCasePath = path.join(workspaceDir, 'source_case.json');
    const energyProfile = fs.existsSync(energyProfilePath) ? readJson(energyProfilePath) : null;
    const sourceCase = fs.existsSync(sourceCasePath) ? readJson(sourceCasePath) : null;
    const peaks = (energyProfile?.peaks || []).slice(0, 2);
    if (peaks.length) {
      const clips = [];
      for (const segment of editManifest?.segments || []) {
        for (const clip of segment.source_clips || []) {
          const start = parseTimecodeSec(clip.start);
          const end = parseTimecodeSec(clip.end);
          if (Number.isFinite(start) && Number.isFinite(end) && end > start) clips.push([start, end]);
        }
      }
      const coverage = peaks.map((peak) => ({
        rank: peak.rank,
        start_sec: peak.start_sec,
        end_sec: peak.end_sec,
        covered_sec: Number(clips.reduce((sum, [clipStart, clipEnd]) => sum
          + Math.max(0, Math.min(clipEnd, peak.end_sec) - Math.max(clipStart, peak.start_sec)), 0).toFixed(3))
      }));
      const uncovered = coverage.filter((peak) => peak.covered_sec < 0.5);
      const actionSource = String(sourceCase?.case_type || '').includes('action_peak');
      const status = uncovered.length === 0 ? 'pass'
        : (actionSource && uncovered.length === coverage.length ? 'fail' : 'warning');
      gateResults.results.push({ id: 'energy_peak_coverage', status, coverage, case_type: sourceCase?.case_type || '' });
      if (status === 'fail') {
        gateResults.failed.push('energy_peak_coverage');
        gateResults.status = 'failed';
      } else if (status === 'warning' && !gateResults.warnings.includes('energy_peak_coverage')) {
        gateResults.warnings.push('energy_peak_coverage');
        if (gateResults.status === 'passed') gateResults.status = 'passed_with_warnings';
      }
    }
  }
  const acceptancePath = path.join(workspaceDir, 'acceptance_gates.json');
  writeJson(acceptancePath, gateResults);
  const previewProof = generatePreviewFrameProof({
    draftInputPath: rootDraftInputPath,
    workspaceDir,
    enabled: enablePreviewFrameProof,
    profile,
    limit: previewLimit
  });
  const outputPaths = {
    normalized_request: rel(path.join(workspaceDir, 'normalized_request.json')),
    narrative_beats: rel(path.join(workspaceDir, 'narrative_beats.json')),
    story_beatmap: rel(path.join(workspaceDir, 'story_beatmap.json')),
    edit_plan: rel(path.join(workspaceDir, 'edit_plan.json')),
    slot_map: rel(path.join(workspaceDir, 'slot_map.json')),
    script: rel(path.join(workspaceDir, 'script.json')),
    draft_input: rel(path.join(workspaceDir, 'draft_input.json')),
    draft_folder: rel(draftRoot),
    edit_manifest: rel(path.join(workspaceDir, 'edit_manifest.json')),
    draft_content: rel(path.join(workspaceDir, 'draft_content.json')),
    acceptance_gates: rel(acceptancePath),
    human_qa_review: rel(path.join(workspaceDir, 'human_qa_review.md')),
    preview_frame_proof: rel(path.join(workspaceDir, 'preview_frame_proof.json')),
    run_summary: rel(path.join(workspaceDir, 'run_summary.json'))
  };
  writeText(
    path.join(workspaceDir, 'human_qa_review.md'),
    `${buildHumanQaReview({ normalizedRequest, gateResults, timing, colorEvidence, materialValidation, previewProof, outputPaths })}\n`
  );
  return {
    gateResults,
    previewProof,
    timing,
    colorEvidence,
    materialValidation,
    speakerColorValidation,
    outputPaths
  };
}

module.exports = {
  collectRunArtifacts,
  copyIfExists,
  ensureDir,
  rel,
  writeJson,
  writeText
};

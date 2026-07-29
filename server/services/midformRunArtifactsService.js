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

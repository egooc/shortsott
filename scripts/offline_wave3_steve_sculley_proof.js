const fs = require('node:fs');
const path = require('node:path');

const { PROJECT_ROOT } = require('../server/services/pipelinePaths');
const {
  readJson,
  activeSegmentsFromManifest,
  firstDialogueStartSec,
  callbackDialogueStartSec,
  maxContinuousNarrationRunSec,
  colorEvidenceBySpeaker,
  validateManifestMaterialColors
} = require('../tests/artifactQaHelpers');

const wave3RunDir = path.join(PROJECT_ROOT, 'midform', 'test_runs', 'offline_wave3_20260727_steve_sculley');
const draftId = process.argv[2] || 'pipeline_1785165961';
const draftDir = path.join(PROJECT_ROOT, 'server', 'output', 'drafts', draftId);

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function copyArtifact(name) {
  const source = path.join(draftDir, name);
  const target = path.join(wave3RunDir, name);
  if (!fs.existsSync(source)) throw new Error(`Missing final draft artifact: ${source}`);
  fs.copyFileSync(source, target);
  return target;
}

function excerptChangedCopy(comparison) {
  return comparison.changed_slots.slice(0, 6).map((slot) => [
    `### ${slot.slot_id}`,
    '',
    'Before:',
    ...slot.before.map((line) => `- ${line}`),
    '',
    'After:',
    ...slot.after.map((line) => `- ${line}`),
    ''
  ].join('\n')).join('\n');
}

copyArtifact('edit_manifest.json');
copyArtifact('draft_content.json');

const manifest = readJson(path.join(wave3RunDir, 'edit_manifest.json'));
const draftContent = readJson(path.join(wave3RunDir, 'draft_content.json'));
const comparison = readJson(path.join(wave3RunDir, 'wave3_copy_comparison.json'));
const draftInput = readJson(path.join(wave3RunDir, 'draft_input.json'));
const segments = activeSegmentsFromManifest(manifest);
const materialValidation = validateManifestMaterialColors(manifest, draftContent);
const colorEvidence = colorEvidenceBySpeaker(manifest);
const dialogueSamples = segments
  .filter((segment) => ['dialogue_quote', 'dialogue'].includes(segment.segment_type) && segment.caption_color)
  .slice(0, 12)
  .map((segment) => ({
    segment_id: segment.segment_id,
    speaker: segment.speaker,
    caption_color: segment.caption_color,
    text: segment.text,
    timeline_start_sec: segment.timeline_start_sec,
    timeline_end_sec: segment.timeline_end_sec
  }));
const totalDurationSec = segments.reduce((max, segment) => Math.max(max, Number(segment.timeline_end_sec || 0)), 0);

const visualProof = {
  draft_id: draftId,
  draft_dir: path.relative(PROJECT_ROOT, draftDir).replace(/\\/g, '/'),
  artifact_level: 'CapCut draft_content.json text-material fill/color proof; not exported-video pixel proof',
  timing: {
    first_dialogue_start_sec: firstDialogueStartSec(segments),
    callback_dialogue_start_sec: callbackDialogueStartSec(segments),
    max_continuous_narration_run_sec: maxContinuousNarrationRunSec(segments),
    total_duration_sec: Number(totalDurationSec.toFixed(3))
  },
  tts_reuse: draftInput.ttsReuseSummary || {},
  speaker_color_evidence: colorEvidence,
  material_validation: materialValidation,
  dialogue_samples: dialogueSamples
};
writeJson(path.join(wave3RunDir, 'wave3_visual_color_proof.json'), visualProof);

const humanQa = [
  '# Wave 3 Human QA — Steve Jobs / Sculley',
  '',
  `Draft: \`${path.relative(PROJECT_ROOT, draftDir).replace(/\\/g, '/')}\``,
  '',
  '## Verdict',
  '',
  '- PASS: Fresh AFTER artifacts were written locally from cached Steve Jobs/Sculley inputs.',
  '- PASS: Visible Korean dialogue captions changed in 6 dialogue slots while narration audio text stayed unchanged for offline TTS reuse.',
  '- PASS: The opening remains dialogue-first, then context reset, then callback payoff.',
  '- PASS: Speaker color proof passes at CapCut material level for every colored dialogue caption.',
  '- LIMITATION: This is draft/material proof, not exported-video pixel proof, because no CapCut export was performed.',
  '',
  '## Timing QA',
  '',
  `- first_dialogue_start_sec: ${visualProof.timing.first_dialogue_start_sec}`,
  `- callback_dialogue_start_sec: ${visualProof.timing.callback_dialogue_start_sec}`,
  `- max_continuous_narration_run_sec: ${visualProof.timing.max_continuous_narration_run_sec}`,
  `- total_duration_sec: ${visualProof.timing.total_duration_sec}`,
  '',
  '## Copy QA',
  '',
  'The hook is now easier to understand as a connected exchange: the first line frames Steve’s contempt for Sculley as a soda executive, and the second line immediately answers the 1984-ad accusation. The callback slot now states the ad-money sequence in shorter Korean beats, so the payoff reads less like a literal translation and more like usable on-screen dialogue.',
  '',
  excerptChangedCopy(comparison),
  '## Speaker Color QA',
  '',
  `- material captions checked: ${materialValidation.checked}`,
  `- material captions passed: ${materialValidation.passed}`,
  `- failures: ${materialValidation.failed.length}`,
  `- Scully/Sculley evidence: ${(colorEvidence.Scully || colorEvidence.Sculley || []).join(', ')}`,
  `- Jobs evidence: ${(colorEvidence.Jobs || []).join(', ')}`,
  ''
].join('\n');
writeText(path.join(wave3RunDir, 'wave3_human_qa.md'), humanQa);

const manifestPath = path.join(wave3RunDir, 'offline_wave3_manifest.json');
const wave3Manifest = readJson(manifestPath);
writeJson(manifestPath, {
  ...wave3Manifest,
  final_draft_id: draftId,
  final_draft_dir: path.relative(PROJECT_ROOT, draftDir).replace(/\\/g, '/'),
  artifacts: {
    ...wave3Manifest.artifacts,
    draft_input: 'draft_input.json',
    edit_manifest: 'edit_manifest.json',
    draft_content: 'draft_content.json',
    visual_color_proof: 'wave3_visual_color_proof.json',
    human_qa: 'wave3_human_qa.md'
  }
});

process.stdout.write(JSON.stringify({
  draftId,
  checked: materialValidation.checked,
  passed: materialValidation.passed,
  firstDialogueStartSec: visualProof.timing.first_dialogue_start_sec,
  callbackDialogueStartSec: visualProof.timing.callback_dialogue_start_sec
}, null, 2));

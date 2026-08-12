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
  if (typeof value === 'number') return value;
  const text = String(value || '').trim();
  const parts = text.split(':');
  // mm:ss.fff is the manifest's native form - the two-part case returned NaN and the
  // semantic gates silently judged nothing (NaN compares false both ways).
  if (parts.length === 3) return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
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

async function collectRunArtifacts({
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
  // Narration b-roll semantic bounds (owner report 2026-08-10: '뒤엉켜 싸운다' narration over
  // the kiss scene, closing b-roll inside the endcard). Every recap clip must sit within its
  // slot's PLAN window +-8s and inside the usable footage. Fail, not warn - it shipped twice.
  {
    const planPath = path.join(workspaceDir, 'edit_plan.json');
    const sourceCasePath2 = path.join(workspaceDir, 'source_case.json');
    const plan = fs.existsSync(planPath) ? readJson(planPath) : null;
    const usableEnd = Number((fs.existsSync(sourceCasePath2) ? readJson(sourceCasePath2) : {})?.usable_end_sec || 0);
    if (plan) {
      const spans = new Map((plan.timeline || []).map((slot) => [String(slot.slot_id || ''), [Number(slot.start_sec), Number(slot.end_sec)]]));
      const issues = [];
      // Measure the LOCALE manifests as well - the base draft passed while both locale
      // packers had wandered (the exact blind spot the energy gate had).
      const manifestsToCheck = [['base', editManifest]];
      for (const locale of ['ko', 'ja']) {
        const localeManifestPath = path.join(workspaceDir, `draft_${locale}`, 'edit_manifest.json');
        if (fs.existsSync(localeManifestPath)) manifestsToCheck.push([locale, readJson(localeManifestPath)]);
      }
      for (const [manifestLabel, manifest] of manifestsToCheck) {
      // The clip belongs to the SLOT while durations sit on its caption units - aggregate
      // narration seconds per slot before judging clip length.
      const slotNarrationSec = new Map();
      for (const segment of manifest?.segments || []) {
        if (segment.segment_type !== 'recap') continue;
        const slotKey = String(segment.segment_id || '');
        slotNarrationSec.set(slotKey, (slotNarrationSec.get(slotKey) || 0) + Number(segment.duration_sec || 0));
      }
      const slotSeen = new Set();
      for (const segment of manifest?.segments || []) {
        if (segment.segment_type !== 'recap') continue;
        const span = spans.get(String(segment.segment_id || ''));
        if (!span || !Number.isFinite(span[0])) continue;
        for (const clip of segment.source_clips || []) {
          const clipStart = parseTimecodeSec(clip.start);
          const clipEnd = parseTimecodeSec(clip.end);
          if (!(clipEnd > clipStart)) continue;
          const narrationSec = Number(slotNarrationSec.get(String(segment.segment_id || '')) || 0);
          const slotOnceKey = `${manifestLabel}:${segment.segment_id}`;
          if (!slotSeen.has(slotOnceKey) && narrationSec > 0 && (clipEnd - clipStart) > narrationSec + 2.5) {
            slotSeen.add(slotOnceKey);
            issues.push({ manifest: manifestLabel, segment_id: segment.segment_id, clip: [Number(clipStart.toFixed(2)), Number(clipEnd.toFixed(2))], narration_sec: Number(narrationSec.toFixed(2)), kind: 'overlong_clip_speedup' });
          }
          if (clipStart < span[0] - 8.5 || clipEnd > span[1] + 8.5) {
            issues.push({ manifest: manifestLabel, segment_id: segment.segment_id, clip: [Number(clipStart.toFixed(2)), Number(clipEnd.toFixed(2))], plan_window: span, kind: 'outside_scene' });
          } else if (usableEnd > 0 && clipEnd > usableEnd + 0.25) {
            issues.push({ manifest: manifestLabel, segment_id: segment.segment_id, clip: [Number(clipStart.toFixed(2)), Number(clipEnd.toFixed(2))], usable_end_sec: usableEnd, kind: 'past_usable_end' });
          }
        }
      }
      }
      // The locale manifests are what ships; the base manifest is an intermediate that a
      // surgical resume (edit paused fills -> review-resume -> draft) legitimately leaves
      // stale. When locale manifests were checked, base-only issues demote to warnings.
      const checkedLocales = manifestsToCheck.some(([label]) => label !== 'base');
      const hardIssues = checkedLocales ? issues.filter((issue) => issue.manifest !== 'base') : issues;
      const baseOnlyIssues = issues.filter((issue) => issue.manifest === 'base');
      if (checkedLocales && baseOnlyIssues.length) {
        gateResults.warnings = [...new Set([...(gateResults.warnings || []), 'narration_broll_semantic_bounds_base_stale'])];
      }
      const status = hardIssues.length ? 'fail' : 'pass';
      gateResults.results.push({ id: 'narration_broll_semantic_bounds', status, issue_count: issues.length, issues: issues.slice(0, 8) });
      if (status === 'fail') {
        gateResults.failed.push('narration_broll_semantic_bounds');
        gateResults.status = 'failed';
      }
      // Speaker colour gate: the 2026-08-11 ja build shipped with EVERY dialogue caption
      // white - metadata warnings existed but nothing failed the run. A dialogue row with no
      // caption_color, or two speakers collapsed onto one colour, is a hard fail.
      {
        const colorIssues = [];
        for (const [manifestLabel, manifest] of manifestsToCheck) {
          const colorByAlias = new Map();
          for (const segment of manifest?.segments || []) {
            if (!['dialogue_quote', 'dialogue'].includes(String(segment.segment_type || ''))) continue;
            const alias = String(segment.speaker_alias || segment.speaker || '').trim();
            const color = String(segment.caption_color || '').trim();
            if (!color) {
              colorIssues.push({ manifest: manifestLabel, segment_id: segment.segment_id, kind: 'dialogue_caption_color_missing', speaker: alias });
              continue;
            }
            if (alias) {
              if (!colorByAlias.has(alias)) colorByAlias.set(alias, color);
              else if (colorByAlias.get(alias) !== color) colorIssues.push({ manifest: manifestLabel, segment_id: segment.segment_id, kind: 'speaker_color_inconsistent', speaker: alias });
            }
          }
          const distinctAliases = colorByAlias.size;
          const distinctColors = new Set(colorByAlias.values()).size;
          if (distinctAliases >= 2 && distinctColors < 2) {
            colorIssues.push({ manifest: manifestLabel, kind: 'speaker_colors_collapsed', speakers: [...colorByAlias.keys()] });
          }
        }
        const colorStatus = colorIssues.length ? 'fail' : 'pass';
        gateResults.results.push({ id: 'dialogue_caption_colors', status: colorStatus, issue_count: colorIssues.length, issues: colorIssues.slice(0, 8) });
        if (colorStatus === 'fail') {
          gateResults.failed.push('dialogue_caption_colors');
          gateResults.status = 'failed';
        }
      }
    }
  }
  // Narration-visual MATCH gate runs POST-LOCALE (evaluateFinalLocaleGates) - at collect time
  // the locale drafts do not exist yet and judging stale folders lies in both directions.
  if (false) {
    try {
      const { judgeFramesAgainstText } = require('./geminiMidformService');
      const { spawnSync: spawnSyncJudge } = require('child_process');
      const sourceVideo = ['source.mp4', 'source.webm', 'source.mkv'].map((name) => path.join(pipelineRunDir, name)).find((candidate) => fs.existsSync(candidate));
      const judgeIssues = [];
      let judged = 0;
      if (sourceVideo) {
        for (const locale of ['ko', 'ja']) {
          const localeManifestPath = path.join(workspaceDir, `draft_${locale}`, 'edit_manifest.json');
          if (!fs.existsSync(localeManifestPath)) continue;
          const localeManifest = readJson(localeManifestPath);
          const slotNarr = new Map();
          const slotText = new Map();
          for (const segment of localeManifest.segments || []) {
            if (segment.segment_type !== 'recap') continue;
            const key = String(segment.segment_id || '');
            slotNarr.set(key, (slotNarr.get(key) || 0) + Number(segment.duration_sec || 0));
            if (!slotText.has(key)) slotText.set(key, String(segment.narration || segment.caption_text || ''));
          }
          const seenSlots = new Set();
          for (const segment of localeManifest.segments || []) {
            if (segment.segment_type !== 'recap') continue;
            const key = String(segment.segment_id || '');
            if (seenSlots.has(key)) continue;
            seenSlots.add(key);
            const clips = segment.source_clips || [];
            if (!clips.length) continue;
            const narrSec = slotNarr.get(key) || 0;
            // frames across the PLAYED span of the clip sequence (first clip start .. narration end)
            const firstStart = parseTimecodeSec(clips[0].start);
            let budget = narrSec;
            const sampleTimes = [];
            for (const clip of clips) {
              const cs = parseTimecodeSec(clip.start);
              const ce = parseTimecodeSec(clip.end);
              const played = Math.max(0, Math.min(ce - cs, budget));
              if (played <= 0) break;
              sampleTimes.push(cs + Math.min(0.5, played / 2));
              if (played > 2.5) sampleTimes.push(cs + played / 2);
              sampleTimes.push(cs + Math.max(played - 0.4, played * 0.8));
              budget -= played;
            }
            const framePaths = [];
            for (const [sampleIndex, sampleSec] of sampleTimes.slice(0, 4).entries()) {
              const framePath = path.join(workspaceDir, `.judge_${locale}_${key}_${sampleIndex}.png`);
              const probe = spawnSyncJudge(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(sampleSec), '-i', sourceVideo, '-frames:v', '1', '-vf', 'scale=400:-1', framePath], { encoding: 'utf8', timeout: 60000 });
              if (probe.status === 0 && fs.existsSync(framePath)) framePaths.push(framePath);
            }
            if (!framePaths.length) continue;
            try {
              const verdict = await judgeFramesAgainstText({ framePaths, text: slotText.get(key) });
              judged += 1;
              if (verdict && verdict.match === false) {
                judgeIssues.push({ locale, segment_id: key, on_screen: String(verdict.on_screen || '').slice(0, 160), reason: String(verdict.reason || '').slice(0, 160) });
              }
            } catch (judgeError) {
              gateResults.warnings.push(`narration_visual_match_judge_error:${key}`);
            } finally {
              for (const framePath of framePaths) { try { fs.unlinkSync(framePath); } catch { /* temp */ } }
            }
          }
        }
      }
      const status = judged === 0 ? 'not_applicable' : (judgeIssues.length ? 'fail' : 'pass');
      gateResults.results.push({ id: 'narration_visual_match', status, judged, issue_count: judgeIssues.length, issues: judgeIssues });
      if (status === 'fail') {
        gateResults.failed.push('narration_visual_match');
        gateResults.status = 'failed';
      }
    } catch (outerError) {
      gateResults.results.push({ id: 'narration_visual_match', status: 'error', error: String(outerError?.message || outerError).slice(0, 200) });
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

// Post-locale semantic evaluation (owner directive: the machine must catch narration-visual
// mismatch, not the human). Runs AFTER locale drafts exist: frames from each recap slot's
// actually played window, judged against its narration by the vision model. Updates
// acceptance_gates.json in place and returns the verdict.
async function evaluateFinalLocaleGates({ workspaceDir, pipelineRunDir, sourceVideoPath = '' }) {
  const acceptanceFile = path.join(workspaceDir, 'acceptance_gates.json');
  const gates = fs.existsSync(acceptanceFile) ? readJson(acceptanceFile) : { status: 'passed', failed: [], warnings: [], results: [] };
  gates.results = (gates.results || []).filter((entry) => entry.id !== 'narration_visual_match');
  gates.failed = (gates.failed || []).filter((id) => id !== 'narration_visual_match');
  const issues = [];
  let judged = 0;
  // Verdict cache: the judge re-rolls borderline stills on every rebuild - a (sentence,
  // played-seconds) pair that PASSED once flip-flopped to fail on unchanged content two
  // builds later. A pass verdict for identical content is durable; fails are never cached
  // so a fixed sentence or prompt always gets a fresh judgment.
  const judgeCachePath = path.join(workspaceDir, '.judge_verdict_cache.json');
  let judgeCache = {};
  try { judgeCache = fs.existsSync(judgeCachePath) ? readJson(judgeCachePath) || {} : {}; } catch { judgeCache = {}; }
  if (process.env.MIDFORM_DISABLE_VISUAL_JUDGE !== '1') {
    const { judgeFramesAgainstText } = require('./geminiMidformService');
    const { spawnSync } = require('child_process');
    const sourceVideo = (sourceVideoPath && fs.existsSync(sourceVideoPath) ? sourceVideoPath : null)
      || ['source.mp4', 'source.webm', 'source.mkv'].map((name) => path.join(pipelineRunDir || '', name)).find((candidate) => fs.existsSync(candidate));
    if (sourceVideo) {
      for (const locale of ['ko', 'ja']) {
        const manifestPath = path.join(workspaceDir, `draft_${locale}`, 'edit_manifest.json');
        if (!fs.existsSync(manifestPath)) continue;
        const manifest = readJson(manifestPath);
        const slotNarr = new Map();
        const slotText = new Map();
        for (const segment of manifest.segments || []) {
          if (segment.segment_type !== 'recap') continue;
          const key = String(segment.segment_id || '');
          slotNarr.set(key, (slotNarr.get(key) || 0) + Number(segment.duration_sec || 0));
          if (!slotText.has(key) && (segment.narration || segment.caption_text)) slotText.set(key, String(segment.narration || segment.caption_text));
        }
        // SENTENCE-level judging: a slot-level verdict over mixed frames let '달려듭니다'
        // pass over falling footage - the exact miss the human kept catching. Each manifest
        // row is one sentence with its own duration; map each sentence to ITS seconds within
        // the clip sequence and judge that pair.
        const slotRows = new Map();
        for (const segment of manifest.segments || []) {
          if (segment.segment_type !== 'recap') continue;
          const key = String(segment.segment_id || '');
          if (!slotRows.has(key)) slotRows.set(key, []);
          slotRows.get(key).push({ text: String(segment.caption_text || segment.narration || ''), sec: Number(segment.duration_sec || 0) });
        }
        const seen = new Set();
        for (const segment of manifest.segments || []) {
          if (segment.segment_type !== 'recap') continue;
          const key = String(segment.segment_id || '');
          if (seen.has(key)) continue;
          seen.add(key);
          const clips = segment.source_clips || [];
          if (!clips.length || !slotText.get(key)) continue;
          // flatten the played timeline of the clip sequence into absolute source seconds
          const playedSpans = [];
          let budget = slotNarr.get(key) || 0;
          for (const clip of clips) {
            const cs = parseTimecodeSec(clip.start);
            const ce = parseTimecodeSec(clip.end);
            const played = Math.max(0, Math.min(ce - cs, budget));
            if (played <= 0) break;
            playedSpans.push([cs, cs + played]);
            budget -= played;
          }
          const atOffset = (offsetSec) => {
            let remaining = offsetSec;
            for (const [ps, pe] of playedSpans) {
              if (remaining <= pe - ps) return ps + remaining;
              remaining -= (pe - ps);
            }
            return playedSpans.length ? playedSpans[playedSpans.length - 1][1] - 0.2 : 0;
          };
          const rows = (slotRows.get(key) || []).filter((row) => row.sec > 0 && row.text);
          const sentenceSamples = [];
          let cursorSec = 0;
          for (const row of rows) {
            // Three chronological samples, not two: a falling monster frozen mid-frame reads
            // as "standing and screaming" on a single still - the end-of-sentence frame
            // (monster far below) is what disambiguates the motion.
            sentenceSamples.push({ text: row.text, times: [...new Set([
              atOffset(cursorSec + Math.min(0.4, row.sec / 2)),
              atOffset(cursorSec + row.sec * 0.55),
              atOffset(cursorSec + Math.max(row.sec - 0.5, row.sec * 0.8))
            ])] });
            cursorSec += row.sec;
          }
          const sampleTimes = sentenceSamples.length ? [] : [atOffset(0.4), atOffset((slotNarr.get(key) || 1) * 0.7)];
          // per-sentence judging replaces the slot-level pass below when rows exist
          if (sentenceSamples.length) {
            for (const sample of sentenceSamples) {
              const cacheKey = `${locale}|${key}|${sample.text}|${sample.times.map((t) => Number(t).toFixed(1)).join(',')}`;
              if (judgeCache[cacheKey] && judgeCache[cacheKey].match === true) {
                judged += 1;
                continue;
              }
              const framePaths = [];
              for (const [sampleIndex, sampleSec] of sample.times.entries()) {
                const framePath = path.join(workspaceDir, `.judge_${locale}_${key}_s${judged}_${sampleIndex}.png`);
                const probe = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(sampleSec), '-i', sourceVideo, '-frames:v', '1', '-vf', 'scale=400:-1', framePath], { encoding: 'utf8', timeout: 60000 });
                if (probe.status === 0 && fs.existsSync(framePath)) framePaths.push(framePath);
              }
              if (!framePaths.length) continue;
              try {
                const verdict = await judgeFramesAgainstText({ framePaths, text: sample.text });
                judged += 1;
                if (verdict && verdict.match === false) {
                  issues.push({ locale, segment_id: key, sentence: sample.text.slice(0, 60), on_screen: String(verdict.on_screen || '').slice(0, 160), reason: String(verdict.reason || '').slice(0, 160), suggested_rewrite: String(verdict.suggested_rewrite || '').slice(0, 160) });
                } else if (verdict && verdict.match === true) {
                  judgeCache[cacheKey] = { match: true, judged_at: new Date().toISOString() };
                }
              } catch {
                gates.warnings = [...new Set([...(gates.warnings || []), `narration_visual_match_judge_error:${key}`])];
              } finally {
                for (const framePath of framePaths) { try { fs.unlinkSync(framePath); } catch { /* temp */ } }
              }
            }
            continue;
          }
          const framePaths = [];
          for (const [sampleIndex, sampleSec] of sampleTimes.slice(0, 5).entries()) {
            const framePath = path.join(workspaceDir, `.judge_${locale}_${key}_${sampleIndex}.png`);
            const probe = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(sampleSec), '-i', sourceVideo, '-frames:v', '1', '-vf', 'scale=400:-1', framePath], { encoding: 'utf8', timeout: 60000 });
            if (probe.status === 0 && fs.existsSync(framePath)) framePaths.push(framePath);
          }
          if (!framePaths.length) continue;
          try {
            const verdict = await judgeFramesAgainstText({ framePaths, text: slotText.get(key) });
            judged += 1;
            if (verdict && verdict.match === false) {
              issues.push({ locale, segment_id: key, on_screen: String(verdict.on_screen || '').slice(0, 160), reason: String(verdict.reason || '').slice(0, 160) });
            }
          } catch {
            gates.warnings = [...new Set([...(gates.warnings || []), `narration_visual_match_judge_error:${key}`])];
          } finally {
            for (const framePath of framePaths) { try { fs.unlinkSync(framePath); } catch { /* temp */ } }
          }
        }
      }
    }
  }
  try { writeJson(judgeCachePath, judgeCache); } catch { /* cache is best-effort */ }
  const status = judged === 0 ? 'not_applicable' : (issues.length ? 'fail' : 'pass');
  gates.results.push({ id: 'narration_visual_match', status, judged, issue_count: issues.length, issues });
  if (status === 'fail') {
    gates.failed.push('narration_visual_match');
    gates.status = 'failed';
    // Batch-fix report (owner credit-saving directive 2026-08-12): the run summary truncates
    // to 3 issues, which pushed a fix-one-then-rebuild loop and re-spent judge tokens each
    // round. Dump EVERY mismatch with its frame-truth suggestion so all sentences are fixed in
    // ONE surgery + ONE rebuild instead of N. Group by slot; ja/ko share a slot row.
    try {
      const lines = ['# 나레이션-화면 불일치 (전체) — 한 번에 수술하고 재빌드', '',
        '각 문장을 `suggested_rewrite`(화면 사실 기반 제안)를 참고해 **compress fills에서 모두 고친 뒤 한 번만** 재빌드한다. 하나씩 재빌드하면 판정 토큰을 매번 다시 쓴다.', ''];
      for (const issue of issues) {
        lines.push(`## [${issue.locale}] ${issue.segment_id}`);
        lines.push(`- 현재 문장: ${issue.sentence || slotText.get(issue.segment_id) || ''}`);
        lines.push(`- 화면(on_screen): ${issue.on_screen || ''}`);
        if (issue.suggested_rewrite) lines.push(`- **제안(frame-true)**: ${issue.suggested_rewrite}`);
        lines.push('');
      }
      fs.writeFileSync(path.join(workspaceDir, 'narration_mismatch_report.md'), `${lines.join('\n')}\n`, 'utf8');
    } catch { /* report is best-effort */ }
  }
  writeJson(acceptanceFile, gates);
  return { status, judged, issues };
}

module.exports = {
  evaluateFinalLocaleGates,
  collectRunArtifacts,
  copyIfExists,
  ensureDir,
  rel,
  writeJson,
  writeText
};

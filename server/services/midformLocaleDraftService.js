const fs = require('fs');
const path = require('path');

const { generateDraft } = require('./capcutService');
const { compareFinalDraftFiles } = require('./midformFinalDraftOverlapService');
const { ensureDir, rel, writeJson } = require('./midformRunArtifactsService');
const { buildSpeakerMetadata, resolveCaptionColor } = require('../utils/captionColorConfig');

const LOCALES = ['ko', 'ja'];
const MAX_FINAL_DRAFT_REPLAN_ATTEMPTS = 4;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function copyIfExists(sourcePath, destinationPath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return '';
  ensureDir(path.dirname(destinationPath));
  fs.copyFileSync(sourcePath, destinationPath);
  return destinationPath;
}

function removeIfExists(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function secondsToTimecode(value) {
  const total = Math.max(0, Number(value || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const secText = seconds.toFixed(3).padStart(6, '0');
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secText}`
    : `${String(minutes).padStart(2, '0')}:${secText}`;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || null));
}

function rangeDuration(range) {
  return Math.max(0, Number(range?.[1] || 0) - Number(range?.[0] || 0));
}

function shiftedSourceRange(range, shiftSec, sourceDurationSec = 0) {
  const duration = rangeDuration(range);
  if (!(duration > 0)) return [0, 0];
  const currentStart = Number(range[0] || 0);
  const maxStart = sourceDurationSec > duration ? Math.max(0, sourceDurationSec - duration) : Math.max(0, currentStart + shiftSec);
  const start = Math.min(maxStart, Math.max(0, currentStart + shiftSec));
  return [Number(start.toFixed(3)), Number((start + duration).toFixed(3))];
}

function inferSourceDurationSec(baseDraftInput, draftSpec) {
  const candidates = [
    baseDraftInput?.sourceDurationSec,
    baseDraftInput?.source_duration_sec,
    baseDraftInput?.sourceReference?.duration_sec,
    baseDraftInput?.source_reference?.duration_sec,
    baseDraftInput?.gptScript?.source_reference?.duration_sec,
    baseDraftInput?.claudeScript?.source_reference?.duration_sec,
    baseDraftInput?.movieResearch?.source_reference?.duration_sec,
    ...(Array.isArray(draftSpec?.clip_placement) ? draftSpec.clip_placement.flatMap((placement) => placement?.source_range || []) : [])
  ].map(Number).filter(Number.isFinite);
  return Math.max(0, ...candidates);
}

function replanJaDraftSpecForFinalOverlap(draftSpec, finalOverlapReport, attempt, baseDraftInput = {}) {
  const next = cloneJson(draftSpec);
  const placements = Array.isArray(next?.clip_placement) ? next.clip_placement : [];
  const sourceDurationSec = inferSourceDurationSec(baseDraftInput, next);
  const overlappingClipIds = new Set((finalOverlapReport?.shared_contiguous_blocks || [])
    .flatMap((block) => Array.isArray(block.clips) ? block.clips : [])
    .map((clip) => String(clip.ja_clip_id || '').trim())
    .filter(Boolean));
  const overlappingIndexes = new Set((finalOverlapReport?.shared_contiguous_blocks || [])
    .flatMap((block) => Array.from({ length: Number(block.length || 0) }, (_, offset) => Number(block.ja_start_index || 0) + offset))
    .filter(Number.isFinite));
  const shiftBase = 4 + (attempt * 3);
  next.clip_placement = placements.map((placement, index) => {
    const shouldShift = (overlappingClipIds.size === 0 && overlappingIndexes.size === 0)
      || overlappingClipIds.has(String(placement?.clip_id || '').trim())
      || overlappingIndexes.has(index)
      || index < 3;
    const sourceRange = Array.isArray(placement?.source_range) ? placement.source_range : [];
    if (!shouldShift || !(Number(sourceRange[1]) > Number(sourceRange[0]))) return placement;
    const role = String(placement?.visual_role || '').toLowerCase();
    const roleBonus = role === 'cold_open' ? 2.5 : (role === 'payoff' ? 1.5 : 0);
    return {
      ...placement,
      source_range: shiftedSourceRange(sourceRange, shiftBase + roleBonus + (index * 0.35), sourceDurationSec),
      final_draft_replan_reason: overlappingClipIds.size ? 'shared_contiguous_overlap' : 'final_overlap_threshold',
      final_draft_replan_attempt: attempt
    };
  });
  next.shot_duration = next.clip_placement.map((placement) => ({
    clip_id: placement.clip_id,
    duration_sec: Number(rangeDuration(placement.source_range).toFixed(3))
  }));
  next.final_draft_replan = {
    attempt,
    strategy: 'ja_video_chain_reselection',
    priority_order: [
      'JA opening chain reselection',
      'JA reaction support shot reselection',
      'JA payoff lead-in restructuring',
      'JA highlight ordering redistribution',
      'shared contiguous block partial replan',
      'alternate candidate pool expansion'
    ],
    previous_failed_gates: finalOverlapReport?.failed_gates || []
  };
  return next;
}

function placementBySlot(draftSpec) {
  const map = new Map();
  const placements = Array.isArray(draftSpec?.clip_placement) ? draftSpec.clip_placement : [];
  for (const placement of placements) {
    const slotId = String(placement?.clip_id || '').replace(/^(ko|ja)_/, '') || String(placement?.slot_id || '');
    const sourceRange = Array.isArray(placement?.source_range) ? placement.source_range : [];
    if (!slotId || !(Number(sourceRange[1]) > Number(sourceRange[0]))) continue;
    map.set(slotId, { ...placement, slot_id: slotId, source_range: [Number(sourceRange[0]), Number(sourceRange[1])] });
  }
  return map;
}

function applyDraftSpecToSegment(segment, placement) {
  const sourceRange = placement.source_range;
  const sourceScene = {
    clip_id: `${placement.clip_id || segment.segment_id}_locale_clip`,
    scene_id: `${placement.visual_role || 'locale'}_${placement.clip_id || segment.segment_id}`,
    start: secondsToTimecode(sourceRange[0]),
    end: secondsToTimecode(sourceRange[1]),
    speed_multiplier: 1
  };
  return {
    ...segment,
    locale_source_override: true,
    locale_clip_id: placement.clip_id || '',
    source_scenes: [sourceScene],
    source_clips: [
      {
        ...sourceScene,
        source: 'locale_draft_spec'
      }
    ],
    story_anchor: {
      ...(segment.story_anchor || {}),
      source_range_hint: [sourceRange[0], sourceRange[1]]
    }
  };
}

function buildLocaleDraftInput(baseDraftInput, draftSpec, locale) {
  const bySlot = placementBySlot(draftSpec);
  const segments = (Array.isArray(baseDraftInput?.segments) ? baseDraftInput.segments : []).map((segment) => {
    const segmentId = String(segment?.segment_id || '');
    const parentSlotId = String(segment?.parent_slot_id || '').trim();
    const placement = bySlot.get(segmentId) || (parentSlotId ? bySlot.get(parentSlotId) : null);
    return placement ? applyDraftSpecToSegment(segment, placement) : { ...segment };
  });
  const segmentById = new Map(segments.map((segment) => [String(segment?.segment_id || ''), segment]));
  const captionUnits = (Array.isArray(baseDraftInput?.captionUnits) ? baseDraftInput.captionUnits : []).map((unit) => {
    const segment = segmentById.get(String(unit?.segment_id || '')) || {};
    const metadata = buildSpeakerMetadata(unit, segment);
    const next = { ...unit, ...metadata };
    if (metadata.caption_kind === 'dialogue') {
      if (metadata.speaker_alias) next.speaker = metadata.speaker_alias;
      const color = resolveCaptionColor({ speakerAlias: next.speaker_alias || next.speaker, speakerColorKey: next.speaker_color_key });
      if (color) next.caption_color = color;
    }
    return next;
  });
  return {
    ...baseDraftInput,
    locale,
    draftName: `draft_${locale}`,
    draft_output_mode: 'folder_only',
    draftOutputMode: 'folder_only',
    package_zip: false,
    packageZip: false,
    segments,
    captionUnits,
    gptScript: {
      ...(baseDraftInput.gptScript || {}),
      locale,
      locale_draft_spec: draftSpec
    },
    claudeScript: {
      ...(baseDraftInput.claudeScript || baseDraftInput.gptScript || {}),
      locale,
      locale_draft_spec: draftSpec,
      segments
    }
  };
}

async function generateLocaleDraftFromInput(locale, localeDraftInput, workspaceDir, sourceVideoPath, transcriptPath) {
  const draftName = `draft_${locale}`;
  const outputBasePath = workspaceDir;
  removeIfExists(path.join(outputBasePath, draftName));
  const result = await generateDraft(
    localeDraftInput.segments || [],
    localeDraftInput.ttsFiles || [],
    localeDraftInput.captionUnits || [],
    localeDraftInput.captionWarnings || [],
    localeDraftInput.srtFile || '',
    localeDraftInput.resolution || { width: 1080, height: 1920 },
    localeDraftInput.fps || 30,
    localeDraftInput.audioPathMode || 'absolute',
    localeDraftInput.videoPlacementMode || 'source_clips',
    localeDraftInput.useCapcutTemplate !== false,
    localeDraftInput.gptScript || localeDraftInput.claudeScript || {},
    {
      draftName,
      output_base_path: outputBasePath,
      outputBasePath,
      draft_output_mode: 'folder_only',
      draftOutputMode: 'folder_only',
      package_zip: false,
      packageZip: false,
      source_video_path: sourceVideoPath || localeDraftInput.source_video_path || localeDraftInput.sourceVideoPath || '',
      sourceTranscriptPath: transcriptPath || localeDraftInput.sourceTranscriptPath || localeDraftInput.source_transcript_path || '',
      source_transcript_path: transcriptPath || localeDraftInput.sourceTranscriptPath || localeDraftInput.source_transcript_path || '',
      slotMap: localeDraftInput.slotMap || {},
      movieResearch: localeDraftInput.movieResearch || {},
      geminiAnalysis: localeDraftInput.geminiAnalysis || {}
    }
  );
  const draftContentPath = path.join(result.draftPath || '', 'draft_content.json');
  const workspaceDraftContent = path.join(workspaceDir, `draft_content.${locale}.json`);
  copyIfExists(draftContentPath, workspaceDraftContent);
  return {
    locale,
    result,
    draft_folder_path: result.draftPath || '',
    draft_content_path: workspaceDraftContent,
    source_draft_content_path: draftContentPath,
    replan_attempt: Number(localeDraftInput.finalDraftReplanAttempt || 0)
  };
}

async function generateLocaleDraftArtifacts({ workspaceDir, baseDraftInputPath, sourceVideoPath, transcriptPath, draftGenerator = generateLocaleDraftFromInput }) {
  const baseDraftInput = readJson(baseDraftInputPath);
  const localeResults = {};
  const outputPaths = {};
  const draftSpecs = Object.fromEntries(LOCALES.map((locale) => [locale, readJson(path.join(workspaceDir, `draft_spec.${locale}.json`))]));
  const renderLocale = async (locale, draftSpec, attempt = 0) => {
    const localeDraftInput = buildLocaleDraftInput(baseDraftInput, draftSpec, locale);
    localeDraftInput.finalDraftReplanAttempt = attempt;
    const draftInputPath = path.join(workspaceDir, `draft_input.${locale}.json`);
    writeJson(draftInputPath, localeDraftInput);
    const generated = await draftGenerator(locale, localeDraftInput, workspaceDir, sourceVideoPath, transcriptPath);
    localeResults[locale] = generated;
    outputPaths[`draft_input_${locale}`] = rel(draftInputPath);
    outputPaths[`draft_content_${locale}`] = rel(generated.draft_content_path);
    outputPaths[`draft_folder_${locale}`] = rel(generated.draft_folder_path);
    return generated;
  };
  await renderLocale('ko', draftSpecs.ko, 0);
  await renderLocale('ja', draftSpecs.ja, 0);
  let finalOverlapReport = compareFinalDraftFiles(localeResults.ko.draft_content_path, localeResults.ja.draft_content_path);
  let replanAttempts = 0;
  while (finalOverlapReport.final_status !== 'pass' && replanAttempts < MAX_FINAL_DRAFT_REPLAN_ATTEMPTS) {
    replanAttempts += 1;
    draftSpecs.ja = replanJaDraftSpecForFinalOverlap(draftSpecs.ja, finalOverlapReport, replanAttempts, baseDraftInput);
    writeJson(path.join(workspaceDir, 'draft_spec.ja.json'), draftSpecs.ja);
    await renderLocale('ja', draftSpecs.ja, replanAttempts);
    finalOverlapReport = compareFinalDraftFiles(localeResults.ko.draft_content_path, localeResults.ja.draft_content_path);
  }
  finalOverlapReport = {
    ...finalOverlapReport,
    regeneration_attempts: replanAttempts,
    replan_applied: replanAttempts > 0,
    replan_policy: replanAttempts > 0 ? 'ja_video_clip_chain_replan' : 'not_needed'
  };
  const finalOverlapPath = path.join(workspaceDir, 'overlap_report_final_draft.ko_vs_ja.json');
  writeJson(finalOverlapPath, finalOverlapReport);
  outputPaths.overlap_report_final_draft_ko_vs_ja = rel(finalOverlapPath);
  return {
    localeResults,
    finalOverlapReport,
    outputPaths
  };
}

module.exports = {
  applyDraftSpecToSegment,
  buildLocaleDraftInput,
  generateLocaleDraftFromInput,
  generateLocaleDraftArtifacts,
  placementBySlot,
  replanJaDraftSpecForFinalOverlap,
  secondsToTimecode,
  _test: {
    cloneJson,
    shiftedSourceRange
  }
};

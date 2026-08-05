const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { generateDraft } = require('./capcutService');
const { PROJECT_ROOT } = require('./pipelinePaths');
const { resolveTool, getToolEnv } = require('../utils/toolPaths');
const { compareFinalDraftFiles } = require('./midformFinalDraftOverlapService');
const { ensureDir, rel, writeJson } = require('./midformRunArtifactsService');
const { buildSpeakerMetadata, resolveCaptionColor } = require('../utils/captionColorConfig');

const LOCALES = ['ko', 'ja'];
const MAX_FINAL_DRAFT_REPLAN_ATTEMPTS = 4;
// A clip shorter than its narration forces CapCut to repeat-pad it: the shot visibly
// jumps back to its own start mid-slot. Size every clip to cover its timeline need plus
// editing headroom instead, and keep the ceiling high enough that real slots never hit it.
const MAX_PHYSICAL_SOURCE_CLIP_SEC = 30;
const CUT_HEADROOM_SEC = 3;
const PHYSICAL_SOURCE_GAP_SEC = 0.3;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function copyIfExists(sourcePath, destinationPath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return '';
  ensureDir(path.dirname(destinationPath));
  fs.copyFileSync(sourcePath, destinationPath);
  return destinationPath;
}

// Returns where the draft should actually be written. CapCut holds the media of any draft the
// user has open, and on Windows that blocks BOTH deleting and renaming the folder. When neither
// works, build alongside it under a suffixed name rather than failing the run.
function prepareDraftOutputPath(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return targetPath;
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return targetPath;
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EBUSY') throw error;
  }
  try {
    fs.renameSync(targetPath, `${targetPath}.locked_${Date.now()}`);
    return targetPath;
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EBUSY') throw error;
  }
  return `${targetPath}_new`;
}

function removeIfExists(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return;
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EBUSY') throw error;
    const stale = `${targetPath}.locked_${Date.now()}`;
    fs.renameSync(targetPath, stale);
  }
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

function secondsFromTimecode(value) {
  if (typeof value === 'number') return value;
  const parts = String(value || '').split(':').map(Number);
  if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  if (parts.length === 2) return (parts[0] * 60) + parts[1];
  return Number(value || 0);
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
  const baseClipEnds = (Array.isArray(baseDraftInput?.segments) ? baseDraftInput.segments : [])
    .flatMap((segment) => [...(Array.isArray(segment?.source_scenes) ? segment.source_scenes : []), ...(Array.isArray(segment?.source_clips) ? segment.source_clips : [])])
    .map((clip) => secondsFromTimecode(clip?.end ?? clip?.end_sec ?? clip?.end_time))
    .filter(Number.isFinite);
  const candidates = [
    baseDraftInput?.sourceDurationSec,
    baseDraftInput?.source_duration_sec,
    baseDraftInput?.sourceReference?.duration_sec,
    baseDraftInput?.source_reference?.duration_sec,
    baseDraftInput?.gptScript?.source_reference?.duration_sec,
    baseDraftInput?.claudeScript?.source_reference?.duration_sec,
    baseDraftInput?.movieResearch?.source_reference?.duration_sec,
    ...baseClipEnds
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

// Slots whose segments play fixed source footage (dialogue utterance windows, scene hooks)
// keyed by base slot id -> [[start_sec, end_sec], ...].
function collectFixedSourceWindowsBySlot(baseDraftInput) {
  const bySlot = new Map();
  for (const segment of Array.isArray(baseDraftInput?.segments) ? baseDraftInput.segments : []) {
    const segmentType = String(segment?.segment_type || '').trim();
    const isFixed = ['dialogue_quote', 'dialogue', 'scene_hook'].includes(segmentType)
      || String(segment?.caption_kind || '').trim() === 'dialogue'
      || Boolean(String(segment?.utt_id || segment?.source_utterance_id || '').trim());
    if (!isFixed) continue;
    const slotKey = String(segment?.parent_slot_id || segment?.segment_id || '').trim();
    if (!slotKey) continue;
    const clips = [
      ...(Array.isArray(segment?.source_scenes) ? segment.source_scenes : []),
      ...(Array.isArray(segment?.source_clips) ? segment.source_clips : [])
    ];
    for (const clip of clips) {
      const start = secondsFromTimecode(clip?.start ?? clip?.start_sec);
      const end = secondsFromTimecode(clip?.end ?? clip?.end_sec);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const existing = bySlot.get(slotKey) || [];
      existing.push([start, end]);
      bySlot.set(slotKey, existing);
    }
  }
  return bySlot;
}

function normalizeDraftSpecSourceRanges(draftSpec, baseDraftInput = {}) {
  const next = cloneJson(draftSpec);
  const placements = Array.isArray(next?.clip_placement) ? next.clip_placement : [];
  const sourceDurationSec = inferSourceDurationSec(baseDraftInput, next);
  const fixedWindowsBySlot = collectFixedSourceWindowsBySlot(baseDraftInput);
  const reservedWindows = [...fixedWindowsBySlot.values()].flat().sort((left, right) => left[0] - right[0]);
  const overlapsReserved = (start, end) => reservedWindows.find(([ws, we]) => start < we - 0.001 && end > ws + 0.001);
  const cappedDurations = placements.map((placement) => {
    const sourceRange = Array.isArray(placement?.source_range) ? placement.source_range.map(Number) : [];
    if (!(Number(sourceRange[1]) > Number(sourceRange[0]))) return 0;
    // timeline_range is how long this clip actually plays (narration length). The source
    // clip must cover at least that, or the draft repeat-pads it into a visible jump cut.
    const timelineNeed = rangeDuration(Array.isArray(placement?.timeline_range) ? placement.timeline_range.map(Number) : []);
    const wanted = timelineNeed > 0 ? timelineNeed + CUT_HEADROOM_SEC : rangeDuration(sourceRange);
    return Math.max(timelineNeed, Math.min(wanted, MAX_PHYSICAL_SOURCE_CLIP_SEC));
  });
  const remainingPackedDuration = (index) => cappedDurations
    .slice(index + 1)
    .filter((duration) => duration > 0)
    .reduce((sum, duration, remainingIndex) => sum + duration + (remainingIndex >= 0 ? PHYSICAL_SOURCE_GAP_SEC : 0), 0);
  let lastEnd = 0;
  next.clip_placement = placements.map((placement, index) => {
    const sourceRange = Array.isArray(placement?.source_range) ? placement.source_range.map(Number) : [];
    if (!(Number(sourceRange[1]) > Number(sourceRange[0]))) return placement;
    const slotKey = String(placement?.clip_id || '').replace(/^(ko|ja)_/, '') || String(placement?.slot_id || '');
    const fixedWindows = fixedWindowsBySlot.get(slotKey);
    if (fixedWindows && fixedWindows.length) {
      // Dialogue/scene-hook slots play their true source windows; pin the placement to
      // that span instead of packing it. It does not advance lastEnd — the windows act as
      // reserved obstacles for the b-roll packing below.
      const start = Math.min(...fixedWindows.map((window) => window[0]));
      const end = Math.max(...fixedWindows.map((window) => window[1]));
      return {
        ...placement,
        source_range: [Number(start.toFixed(3)), Number(end.toFixed(3))],
        source_range_pinned_to_fixed_windows: true
      };
    }
    const originalDuration = rangeDuration(sourceRange);
    const duration = cappedDurations[index];
    const minStart = lastEnd > 0 ? lastEnd + PHYSICAL_SOURCE_GAP_SEC : 0;
    let start = Math.max(Number(sourceRange[0]), minStart);
    if (sourceDurationSec > 0) {
      const latestStartToFitRest = sourceDurationSec - duration - remainingPackedDuration(index);
      if (start > latestStartToFitRest) start = Math.max(minStart, latestStartToFitRest);
    }
    // B-roll must not sit on top of reserved dialogue/scene-hook footage: those segments
    // keep their true source windows, so nudge the packed range forward past any overlap.
    for (let guard = 0; guard < 32; guard += 1) {
      const blocking = overlapsReserved(start, start + duration);
      if (!blocking) break;
      start = blocking[1] + PHYSICAL_SOURCE_GAP_SEC;
    }
    let end = start + duration;
    let adjusted = start !== Number(sourceRange[0]) || duration !== originalDuration;
    if (sourceDurationSec > 0 && end > sourceDurationSec) {
      end = sourceDurationSec;
      if (end <= start) end = Math.min(sourceDurationSec, start + 0.5);
      adjusted = true;
    }
    const normalized = [Number(start.toFixed(3)), Number(end.toFixed(3))];
    lastEnd = Math.max(lastEnd, normalized[1]);
    return adjusted
      ? {
          ...placement,
          source_range: normalized,
          source_range_normalized_for_physical_draft: true
        }
      : placement;
  });
  next.shot_duration = next.clip_placement.map((placement) => ({
    clip_id: placement.clip_id,
    duration_sec: Number(rangeDuration(placement.source_range).toFixed(3))
  }));
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

function placementOrderBySlot(draftSpec) {
  const map = new Map();
  const placements = Array.isArray(draftSpec?.clip_placement) ? draftSpec.clip_placement : [];
  placements.forEach((placement, index) => {
    const slotId = String(placement?.clip_id || '').replace(/^(ko|ja)_/, '') || String(placement?.slot_id || '');
    if (slotId && !map.has(slotId)) map.set(slotId, index);
  });
  return map;
}

function slotKeyForSegment(segment) {
  const segmentId = String(segment?.segment_id || '').trim();
  const parentSlotId = String(segment?.parent_slot_id || '').trim();
  return parentSlotId || segmentId;
}

function applyDraftSpecToSegment(segment, placement) {
  const sourceRange = placement.source_range;
  const segmentType = String(segment?.segment_type || '').trim();
  const isDialogue = ['dialogue_quote', 'dialogue'].includes(segmentType)
    || String(segment?.caption_kind || '').trim() === 'dialogue'
    || Boolean(String(segment?.utt_id || segment?.source_utterance_id || '').trim());
  if (isDialogue || segmentType === 'scene_hook') {
    // Dialogue lines are locked to their source utterance windows. A slot-level locale
    // placement covers the whole parent slot, so applying it to each sibling line would
    // duplicate the same source range (hybrid overlap) and can cut into speech. The same
    // holds for a scene_hook: its heatmap-peak window plays original audio and must not be
    // remapped. Keep the original clips; the locale spec still controls ordering.
    return {
      ...segment,
      locale_clip_id: placement.clip_id || ''
    };
  }
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
    ...(isDialogue ? {} : { narration_background: true, source_audio_ducking: 0 }),
    source_scenes: [sourceScene],
    source_clips: [
      {
        ...sourceScene,
        source: 'locale_draft_spec'
      }
    ],
    story_anchor: {
      ...(segment.story_anchor || {}),
      // Degenerate hint (end==start): the locale placement already provides explicit
      // source_scenes, and a real range would arm CapCut's story-sync monotonic checks,
      // which a reordered recap (cold open, locale divergence) can never satisfy.
      source_range_hint: [sourceRange[0], sourceRange[0]]
    }
  };
}

function buildLocaleDraftInput(baseDraftInput, draftSpec, locale) {
  const bySlot = placementBySlot(draftSpec);
  const orderBySlot = placementOrderBySlot(draftSpec);
  const segments = (Array.isArray(baseDraftInput?.segments) ? baseDraftInput.segments : []).map((segment, originalIndex) => {
    const segmentId = String(segment?.segment_id || '');
    const parentSlotId = String(segment?.parent_slot_id || '').trim();
    const placement = bySlot.get(segmentId) || (parentSlotId ? bySlot.get(parentSlotId) : null);
    return {
      ...(placement ? applyDraftSpecToSegment(segment, placement) : { ...segment }),
      locale_original_order: originalIndex,
      locale_draft_order: orderBySlot.has(slotKeyForSegment(segment)) ? orderBySlot.get(slotKeyForSegment(segment)) : originalIndex + 10_000
    };
  }).sort((left, right) => Number(left.locale_draft_order || 0) - Number(right.locale_draft_order || 0) || Number(left.locale_original_order || 0) - Number(right.locale_original_order || 0));
  const segmentById = new Map(segments.map((segment) => [String(segment?.segment_id || ''), segment]));
  const segmentOrder = new Map(segments.map((segment, index) => [String(segment?.segment_id || ''), index]));
  const captionUnits = (Array.isArray(baseDraftInput?.captionUnits) ? baseDraftInput.captionUnits : []).map((unit, originalIndex) => {
    const segment = segmentById.get(String(unit?.segment_id || '')) || {};
    const metadata = buildSpeakerMetadata(unit, segment);
    const next = { ...unit, ...metadata, locale_original_order: originalIndex, locale_draft_order: segmentOrder.get(String(unit?.segment_id || '')) ?? originalIndex + 10_000 };
    if (metadata.caption_kind === 'dialogue') {
      if (metadata.speaker_alias) next.speaker = metadata.speaker_alias;
      const color = resolveCaptionColor({ speakerAlias: next.speaker_alias || next.speaker, speakerColorKey: next.speaker_color_key });
      if (color) next.caption_color = color;
    }
    return next;
  }).sort((left, right) => Number(left.locale_draft_order || 0) - Number(right.locale_draft_order || 0) || Number(left.locale_original_order || 0) - Number(right.locale_original_order || 0));
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
  const outputBasePath = workspaceDir;
  const resolvedDraftPath = prepareDraftOutputPath(path.join(outputBasePath, `draft_${locale}`));
  const draftName = path.basename(resolvedDraftPath);
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

const execFileAsync = promisify(execFile);

function parentSlotIdForSegment(segment) {
  const segmentId = String(segment?.segment_id || '').trim();
  const parent = String(segment?.parent_slot_id || '').trim();
  if (parent) return parent;
  const match = segmentId.match(/^(.*)_L\d+$/);
  return match ? match[1] : segmentId;
}

function dialogueLineIndexForSegment(segment) {
  const match = String(segment?.segment_id || '').match(/_L(\d+)$/);
  return match ? Number(match[1]) - 1 : 0;
}

// Rewrites the pipeline's script into the Japanese script: same slots, same cuts, same
// dialogue windows, but every viewer-facing string replaced with the Japanese pass.
function buildJapaneseScript(baseScript, japaneseSlotFills) {
  const fillsBySlot = new Map((Array.isArray(japaneseSlotFills?.slot_fills) ? japaneseSlotFills.slot_fills : [])
    .map((fill) => [String(fill?.slot_id || '').trim(), fill]));
  const missing = [];
  const segments = (Array.isArray(baseScript?.segments) ? baseScript.segments : []).map((segment) => {
    const fill = fillsBySlot.get(parentSlotIdForSegment(segment));
    const segmentType = String(segment?.segment_type || '').trim();
    if (!fill) {
      if (segmentType !== 'scene_hook') missing.push(String(segment?.segment_id || ''));
      return { ...segment };
    }
    if (['dialogue_quote', 'dialogue'].includes(segmentType)) {
      const lines = Array.isArray(fill.caption_kr_dialogue) ? fill.caption_kr_dialogue : [];
      const text = String(lines[dialogueLineIndexForSegment(segment)] || '').trim();
      if (!text) missing.push(String(segment?.segment_id || ''));
      return { ...segment, translated_caption_ko: text, caption_text: text };
    }
    if (segmentType === 'scene_hook') return { ...segment };
    const narration = String(fill.narration || '').trim();
    const caption = String(fill.caption_kr || '').trim() || narration;
    if (!narration) missing.push(String(segment?.segment_id || ''));
    return { ...segment, narration, caption_text: caption, translated_caption_ko: '' };
  });
  if (missing.length) {
    throw new Error(`Japanese script is missing text for segments: ${missing.slice(0, 10).join(', ')}`);
  }
  const uploadText = japaneseSlotFills?.upload_text || {};
  const overlay = uploadText.overlay_title && typeof uploadText.overlay_title === 'object' ? uploadText.overlay_title : {};
  const titles = Array.isArray(uploadText.title_candidates) ? uploadText.title_candidates : [];
  const top = String(overlay.top || '').trim();
  const bottom = String(overlay.bottom || '').trim();
  return {
    ...baseScript,
    locale: 'ja',
    title_block: {
      ...(baseScript?.title_block || {}),
      full_title: String(titles[0] || '').trim() || (baseScript?.title_block || {}).full_title || '',
      overlay_title: { top, bottom },
      top_title: top,
      top_subtitle: bottom
    },
    metadata: { ...(baseScript?.metadata || {}), title_candidates: titles },
    segments
  };
}

// Runs the shared assembler over the Japanese script so the ja cut gets its own TTS audio
// and its own caption timing instead of inheriting the Korean voice track.
async function buildJapaneseBaseDraftInput({ workspaceDir, baseScriptPath, japaneseSlotFillsPath, sourceVideoPath, transcriptPath }) {
  if (!baseScriptPath || !fs.existsSync(baseScriptPath)) throw new Error(`Japanese locale needs the base script: ${baseScriptPath}`);
  if (!japaneseSlotFillsPath || !fs.existsSync(japaneseSlotFillsPath)) {
    throw new Error(`Japanese locale needs generated Japanese slot fills: ${japaneseSlotFillsPath}`);
  }
  const japaneseScript = buildJapaneseScript(readJson(baseScriptPath), readJson(japaneseSlotFillsPath));
  const japaneseScriptPath = path.join(workspaceDir, 'script.ja.json');
  writeJson(japaneseScriptPath, japaneseScript);

  const outputPath = path.join(workspaceDir, 'draft_input.ja.base.json');
  const ttsDir = path.join(workspaceDir, 'tts_ja');
  ensureDir(ttsDir);
  const python = resolveTool('python', { envKey: 'PYTHON_PATH' });
  const scriptPath = path.join(PROJECT_ROOT, 'midform', 'scripts', 'assemble_slot_draft_input.py');
  await execFileAsync(python, [
    scriptPath,
    '--script', japaneseScriptPath,
    '--source-video', sourceVideoPath || '',
    '--transcript', transcriptPath || '',
    '--output', outputPath,
    '--tts-dir', ttsDir,
    '--movie-research', '',
    '--gemini-analysis', ''
  ], { cwd: PROJECT_ROOT, env: getToolEnv(), maxBuffer: 50 * 1024 * 1024 });
  if (!fs.existsSync(outputPath)) throw new Error('Japanese draft input assembly produced no output');
  return { draftInputPath: outputPath, scriptPath: japaneseScriptPath, ttsDir };
}

async function generateLocaleDraftArtifacts({ workspaceDir, baseDraftInputPath, sourceVideoPath, transcriptPath, baseScriptPath, japaneseSlotFillsPath, draftGenerator = generateLocaleDraftFromInput }) {
  const baseDraftInput = readJson(baseDraftInputPath);
  const localeResults = {};
  const outputPaths = {};
  // ja renders from its own assembled draft input (Japanese script + Japanese TTS); every
  // other locale renders from the pipeline's base input.
  let japaneseBase = null;
  let japaneseSkippedReason = '';
  if (japaneseSlotFillsPath && fs.existsSync(japaneseSlotFillsPath)) {
    try {
      const built = await buildJapaneseBaseDraftInput({
        workspaceDir, baseScriptPath, japaneseSlotFillsPath, sourceVideoPath, transcriptPath
      });
      japaneseBase = readJson(built.draftInputPath);
      outputPaths.script_ja = rel(built.scriptPath);
      outputPaths.draft_input_ja_base = rel(built.draftInputPath);
    } catch (error) {
      japaneseSkippedReason = String(error?.message || error);
    }
  } else {
    japaneseSkippedReason = 'no Japanese slot fills were generated for this run';
  }
  // Without a Japanese script the ja locale would render the Korean voice and subtitles
  // under a ja label, which is the exact defect this locale used to ship. Drop the locale
  // instead and say why, rather than deliver a mislabelled cut or lose the Korean one.
  const locales = japaneseBase ? LOCALES : LOCALES.filter((locale) => locale !== 'ja');
  const baseInputForLocale = (locale) => (locale === 'ja' && japaneseBase ? japaneseBase : baseDraftInput);
  const draftSpecs = Object.fromEntries(locales.map((locale) => [locale, readJson(path.join(workspaceDir, `draft_spec.${locale}.json`))]));
  const renderLocale = async (locale, draftSpec, attempt = 0) => {
    const localeBaseInput = baseInputForLocale(locale);
    const normalizedDraftSpec = normalizeDraftSpecSourceRanges(draftSpec, localeBaseInput);
    draftSpecs[locale] = normalizedDraftSpec;
    writeJson(path.join(workspaceDir, `draft_spec.${locale}.json`), normalizedDraftSpec);
    const localeDraftInput = buildLocaleDraftInput(localeBaseInput, normalizedDraftSpec, locale);
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
  if (!japaneseBase) {
    const skippedReport = {
      pair: 'ko_vs_ja',
      comparison_level: 'final_draft_video_track',
      final_status: 'not_applicable',
      failed_gates: [],
      japanese_locale_skipped: true,
      japanese_locale_skipped_reason: japaneseSkippedReason
    };
    const skippedPath = path.join(workspaceDir, 'overlap_report_final_draft.ko_vs_ja.json');
    writeJson(skippedPath, skippedReport);
    outputPaths.overlap_report_final_draft_ko_vs_ja = rel(skippedPath);
    return { localeResults, finalOverlapReport: skippedReport, outputPaths };
  }
  await renderLocale('ja', draftSpecs.ja, 0);
  // Dialogue/scene-hook footage is pinned to identical true source windows in every
  // locale, so exclude those windows from the KO/JA duplicate-output comparison.
  const fixedSourceWindows = [...collectFixedSourceWindowsBySlot(baseDraftInput).values()].flat();
  let finalOverlapReport = compareFinalDraftFiles(localeResults.ko.draft_content_path, localeResults.ja.draft_content_path, undefined, fixedSourceWindows);
  let replanAttempts = 0;
  while (finalOverlapReport.final_status !== 'pass' && replanAttempts < MAX_FINAL_DRAFT_REPLAN_ATTEMPTS) {
    replanAttempts += 1;
    draftSpecs.ja = replanJaDraftSpecForFinalOverlap(draftSpecs.ja, finalOverlapReport, replanAttempts, baseInputForLocale('ja'));
    writeJson(path.join(workspaceDir, 'draft_spec.ja.json'), draftSpecs.ja);
    await renderLocale('ja', draftSpecs.ja, replanAttempts);
    finalOverlapReport = compareFinalDraftFiles(localeResults.ko.draft_content_path, localeResults.ja.draft_content_path, undefined, fixedSourceWindows);
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
  normalizeDraftSpecSourceRanges,
  placementBySlot,
  placementOrderBySlot,
  replanJaDraftSpecForFinalOverlap,
  secondsToTimecode,
  buildJapaneseScript,
  buildJapaneseBaseDraftInput,
  _test: {
    cloneJson,
    normalizeDraftSpecSourceRanges,
    shiftedSourceRange,
    buildJapaneseScript
  }
};

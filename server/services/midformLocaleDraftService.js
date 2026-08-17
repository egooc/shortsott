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

// The gate allows a reframe within the planned scene (its window plus 8s of tolerance) but not a
// move to another one. Slide the range back inside rather than truncating it, so the clip keeps the
// length the packer gave it.
// 4s, not 8: the gate measures against the PLAN window with 8.5s of tolerance, and the origin this
// clamps to is the packer's clip - already sitting some way into that window. Anchored at 8 the
// result still landed 10.5s past the window end on Draft Day's ja slot_006.
function clampToSemanticScene(range, originRange, toleranceSec = 4) {
  const start = Number(range?.[0]);
  const end = Number(range?.[1]);
  const originStart = Number(originRange?.[0]);
  const originEnd = Number(originRange?.[1]);
  if (![start, end, originStart, originEnd].every(Number.isFinite) || end <= start) return range;
  const lo = Math.max(0, originStart - toleranceSec);
  const hi = originEnd + toleranceSec;
  const duration = end - start;
  if (start >= lo && end <= hi) return range;
  const nextStart = Math.max(lo, Math.min(start, hi - duration));
  return [Number(nextStart.toFixed(3)), Number((nextStart + duration).toFixed(3))];
}

function shiftedSourceRange(range, shiftSec, sourceDurationSec = 0) {
  const duration = rangeDuration(range);
  if (!(duration > 0)) return [0, 0];
  const currentStart = Number(range[0] || 0);
  const maxStart = sourceDurationSec > duration ? Math.max(0, sourceDurationSec - duration) : Math.max(0, currentStart + shiftSec);
  const start = Math.min(maxStart, Math.max(0, currentStart + shiftSec));
  return [Number(start.toFixed(3)), Number((start + duration).toFixed(3))];
}

// The usable end of the FOOTAGE, not the file: the last ~10s of a clip-channel upload is the
// channel's own promo reel. Locale packing used the full duration and pushed a closing b-roll
// straight into the endcard. source_case.json carries the measured boundary.
function readUsableEndSec(baseDraftInput) {
  const candidates = [baseDraftInput?.usableEndSec, baseDraftInput?.usable_end_sec,
    baseDraftInput?.sourceCase?.usable_end_sec, baseDraftInput?.source_case?.usable_end_sec]
    .map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return candidates.length ? Math.min(...candidates) : 0;
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
  const usableEndSec = readUsableEndSec(baseDraftInput);
  const sourceDurationSec = usableEndSec > 0
    ? Math.min(usableEndSec, inferSourceDurationSec(baseDraftInput, next) || usableEndSec)
    : inferSourceDurationSec(baseDraftInput, next);
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
    // Semantic cap: replan differentiation may reframe a clip, never move it to another
    // scene — the escalating shift (4 + attempt*3) walked ja slot_07 from its charge scene
    // onto the kiss scene while the narration still described the charge. 8s matches the
    // packer's scene tolerance.
    const replanShift = Math.min(8, shiftBase + roleBonus + (index * 0.35));
    return {
      ...placement,
      // The packer's scene bounds must anchor to the ORIGINAL window: re-basing them on the
      // replanned range let +8 replan and +8 packer tolerance compound into 25s of drift.
      semantic_origin_range: Array.isArray(placement.semantic_origin_range) ? placement.semantic_origin_range : sourceRange,
      // ...and the cap alone was not enough: a shift applied to an already-shifted range walked ja
      // slot_006 to 367.0-370.5 against a plan window of 351.7-360.1, which the b-roll bounds gate
      // rejects as another scene. Hold the result inside the ORIGINAL window's tolerance.
      source_range: clampToSemanticScene(
        shiftedSourceRange(sourceRange, replanShift, sourceDurationSec),
        Array.isArray(placement.semantic_origin_range) ? placement.semantic_origin_range : sourceRange
      ),
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

// CapCut's "scene split" cuts at visual transitions instead of arbitrary timestamps (user
// direction, 2026-08-07). Same principle here: detect shot boundaries once per source with
// ffmpeg's scene filter and snap free b-roll edges to them, so packed clips start and end on
// natural cuts instead of mid-shot. Dialogue windows stay pinned to speech and never snap.
const SHOT_SNAP_MAX_SHIFT_SEC = 0.7;
const SHOT_SCENE_THRESHOLD = 0.3;

async function detectShotBoundaries(sourceVideoPath) {
  if (!sourceVideoPath || !fs.existsSync(sourceVideoPath)) return [];
  const cachePath = `${sourceVideoPath}.shot_boundaries.json`;
  if (fs.existsSync(cachePath)) {
    try {
      const cached = readJson(cachePath);
      if (Array.isArray(cached?.boundaries)) return cached.boundaries;
    } catch { /* recompute */ }
  }
  try {
    const stderr = await new Promise((resolve, reject) => {
      execFile('ffmpeg', [
        '-i', sourceVideoPath,
        '-vf', `select='gt(scene,${SHOT_SCENE_THRESHOLD})',showinfo`,
        '-an', '-f', 'null', '-'
      ], { maxBuffer: 64 * 1024 * 1024 }, (error, _stdout, stderrText) => {
        // ffmpeg exits 0 here; on error still try to parse what it printed.
        if (error && !stderrText) reject(error);
        else resolve(String(stderrText || ''));
      });
    });
    const rawBoundaries = [...stderr.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((left, right) => left - right);
    // Merge micro-shots: two boundaries under 0.4s apart describe a flash cut no snap target
    // should land between - snapping onto either edge of a 0.25s sliver is what shipped the
    // frozen 0.25s closing clip. Keep the FIRST boundary of each cluster.
    const boundaries = rawBoundaries.filter((value, index) => index === 0 || value - rawBoundaries[index - 1] >= 0.4);
    fs.writeFileSync(cachePath, `${JSON.stringify({ threshold: SHOT_SCENE_THRESHOLD, boundaries }, null, 2)}\n`, 'utf8');
    return boundaries;
  } catch {
    return [];
  }
}

function snapEdgeToShotBoundary(value, boundaries) {
  let best = null;
  for (const boundary of boundaries) {
    const shift = Math.abs(boundary - value);
    if (shift <= SHOT_SNAP_MAX_SHIFT_SEC && (!best || shift < Math.abs(best - value))) best = boundary;
    if (boundary - value > SHOT_SNAP_MAX_SHIFT_SEC) break;
  }
  return best;
}

function snapRangeToShotBoundaries(start, end, boundaries, { minKeepSec, limitEndSec, overlapsReserved }) {
  if (!Array.isArray(boundaries) || !boundaries.length) return [start, end];
  const minLen = Math.max(1.0, Number(minKeepSec) || 0);
  let nextStart = start;
  let nextEnd = end;
  const snappedStart = snapEdgeToShotBoundary(start, boundaries);
  if (snappedStart != null && snappedStart >= 0 && nextEnd - snappedStart >= minLen
    && !(overlapsReserved && overlapsReserved(snappedStart, nextEnd))) {
    nextStart = snappedStart;
  }
  const snappedEnd = snapEdgeToShotBoundary(end, boundaries);
  if (snappedEnd != null && (!(limitEndSec > 0) || snappedEnd <= limitEndSec) && snappedEnd - nextStart >= minLen
    && !(overlapsReserved && overlapsReserved(nextStart, snappedEnd))) {
    nextEnd = snappedEnd;
  }
  return [nextStart, nextEnd];
}

function normalizeDraftSpecSourceRanges(draftSpec, baseDraftInput = {}) {
  // REAL TTS seconds per slot (ttsFiles carry measured duration_sec): the spec's estimate ran
  // 9.1s where the synthesized narration was 7.2s, and the estimate-capped clip still put 2s
  // of the wrong scene on screen.
  const realTtsSecBySlot = new Map();
  // Cumulative per-sentence offsets (ttsFiles are one file per sentence, in order): montage
  // part cuts snap to these so a sentence never straddles a part boundary.
  const sentenceCumSecBySlot = new Map();
  for (const file of Array.isArray(baseDraftInput?.ttsFiles) ? baseDraftInput.ttsFiles : []) {
    const slotKey = String(file?.segment_id || '').trim();
    const sec = Number(file?.duration_sec || 0);
    if (slotKey && sec > 0) {
      realTtsSecBySlot.set(slotKey, (realTtsSecBySlot.get(slotKey) || 0) + sec);
      if (!sentenceCumSecBySlot.has(slotKey)) sentenceCumSecBySlot.set(slotKey, []);
      sentenceCumSecBySlot.get(slotKey).push(realTtsSecBySlot.get(slotKey));
    }
  }
  const next = cloneJson(draftSpec);
  const placements = Array.isArray(next?.clip_placement) ? next.clip_placement : [];
  const usableEndSec = readUsableEndSec(baseDraftInput);
  const sourceDurationSec = usableEndSec > 0
    ? Math.min(usableEndSec, inferSourceDurationSec(baseDraftInput, next) || usableEndSec)
    : inferSourceDurationSec(baseDraftInput, next);
  const fixedWindowsBySlot = collectFixedSourceWindowsBySlot(baseDraftInput);
  // Action beats are locale-shiftable (ko wind-up / ja follow-through, owner directive
  // 2026-08-11). Dialogue windows stay pinned to speech forever, but a scene_hook's window
  // comes from the LOCALE plan when it provides one - both for the pinned playback range
  // and for the reserved-obstacle map the b-roll packs around.
  const actionSlotKeys = new Set((Array.isArray(baseDraftInput?.segments) ? baseDraftInput.segments : [])
    .filter((segment) => String(segment?.segment_type || '').trim() === 'scene_hook')
    .map((segment) => String(segment?.parent_slot_id || segment?.segment_id || '').trim())
    .filter(Boolean));
  for (const placement of placements) {
    const placementKey = String(placement?.clip_id || '').replace(/^(ko|ja)_/, '') || String(placement?.slot_id || '');
    const placementRange = Array.isArray(placement?.source_range) ? placement.source_range.map(Number) : [];
    if (actionSlotKeys.has(placementKey) && fixedWindowsBySlot.has(placementKey) && Number(placementRange[1]) > Number(placementRange[0])) {
      fixedWindowsBySlot.set(placementKey, [[Number(placementRange[0]), Number(placementRange[1])]]);
    }
  }
  const reservedWindows = [...fixedWindowsBySlot.values()].flat().sort((left, right) => left[0] - right[0]);
  // Reserved dialogue windows AND already-packed b-roll: the nudge/end-align paths consulted
  // only the former, so a later slot (closing) sat straight on an earlier slot's multi-part
  // clip and the hybrid gate killed the draft.
  const overlapsReserved = (start, end) => reservedWindows.find(([ws, we]) => start < we - 0.001 && end > ws + 0.001)
    || packedRanges.find(([ws, we]) => start < we - 0.001 && end > ws + 0.001);
  const cappedDurations = placements.map((placement) => {
    const sourceRange = Array.isArray(placement?.source_range) ? placement.source_range.map(Number) : [];
    if (!(Number(sourceRange[1]) > Number(sourceRange[0]))) return 0;
    // timeline_range is how long this clip actually plays (narration length). The source
    // clip must cover at least that, or the draft repeat-pads it into a visible jump cut.
    const timelineNeed = rangeDuration(Array.isArray(placement?.timeline_range) ? placement.timeline_range.map(Number) : []);
    // A placement pinned to fixed dialogue windows sits at its own source position and
    // consumes NO forward packing space. Counting it here made remainingPackedDuration
    // demand contiguous room for every dialogue slot after each b-roll, which back-shifted
    // the b-roll off its scene (the spider reveal slid from 88.8s to 81.4s this way).
    const slotKey = String(placement?.clip_id || '').replace(/^(ko|ja)_/, '') || String(placement?.slot_id || '');
    if (fixedWindowsBySlot.has(slotKey)) return 0;
    const wanted = timelineNeed > 0 ? timelineNeed + CUT_HEADROOM_SEC : rangeDuration(sourceRange);
    return Math.max(timelineNeed, Math.min(wanted, MAX_PHYSICAL_SOURCE_CLIP_SEC));
  });
  const remainingPackedDuration = (index) => cappedDurations
    .slice(index + 1)
    .filter((duration) => duration > 0)
    .reduce((sum, duration, remainingIndex) => sum + duration + (remainingIndex >= 0 ? PHYSICAL_SOURCE_GAP_SEC : 0), 0);
  let lastEnd = 0;
  const packedRanges = [];
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
    // THE invariant this whole defect class reduces to: a narration clip may not be LONGER
    // than the narration that plays over it. CapCut fits the whole clip into the slot, so a
    // 12.1s clip under 7.2s of narration played EVERYTHING at 1.7x - charge, fall AND
    // explosion under '다시 달려듭니다', three user reports in a row. Cut the excess at the
    // source instead of trusting any later stage to trim it.
    const placementSlotKey = String(placement?.clip_id || '').replace(/^(ko|ja)_/, '') || String(placement?.slot_id || '');
    const estimatedNeedSec = rangeDuration(Array.isArray(placement?.timeline_range) ? placement.timeline_range.map(Number) : []);
    const narrationNeedSec = realTtsSecBySlot.get(placementSlotKey) || estimatedNeedSec;
    const duration = narrationNeedSec > 0
      ? Math.min(cappedDurations[index], narrationNeedSec + 0.5)
      : cappedDurations[index];
    const minStart = lastEnd > 0 ? lastEnd + PHYSICAL_SOURCE_GAP_SEC : 0;
    let start = Math.max(Number(sourceRange[0]), minStart);
    // The reveal lives at the END of a narration window that leads into dialogue: the boot slam
    // and the spider crawling out sat at 96.8-98.8 of an 88.8-102 window, and start-aligned
    // packing cut away the very moment the narration set up. Align to the window END when the
    // NEXT PLACEMENT IN PLAYBACK ORDER is a pinned dialogue starting right after this window
    // (source-order proximity alone misfired on the bridge, whose window merely ends near the
    // reordered cold open). Align by the PLAYED length, not the padded one - the assembler
    // keeps the clip head, so padding at the tail is what got the reveal cut off.
    const windowEndSec = Number(sourceRange[1]);
    const playedSec = (() => {
      const need = rangeDuration(Array.isArray(placement?.timeline_range) ? placement.timeline_range.map(Number) : []);
      return need > 0 ? need : duration;
    })();
    const nextPlacement = placements[index + 1];
    const nextKey = nextPlacement ? (String(nextPlacement?.clip_id || '').replace(/^(ko|ja)_/, '') || String(nextPlacement?.slot_id || '')) : '';
    const nextFixed = nextKey ? fixedWindowsBySlot.get(nextKey) : null;
    const nextDialogueStart = nextFixed && nextFixed.length ? Math.min(...nextFixed.map((window) => window[0])) : null;
    const leadsIntoDialogue = nextDialogueStart != null && nextDialogueStart >= windowEndSec - 0.5 && nextDialogueStart - windowEndSec <= 4;
    let alignedEndSec = null;
    if (leadsIntoDialogue && playedSec > 0 && windowEndSec - playedSec > start) {
      // The clip ends where the window does (bounded away from the dialogue it leads into);
      // every later stage must reason with THIS end, not start+paddedDuration - the padded
      // probe made the nudge loop shove an aligned clip past every reserved window.
      alignedEndSec = Math.min(windowEndSec, nextDialogueStart - 0.1);
      start = Math.max(minStart, alignedEndSec - playedSec);
    }
    if (process.env.MIDFORM_PACK_DEBUG) {
      console.error(`[pack] ${placement.clip_id} win=[${sourceRange[0]},${sourceRange[1]}] dur=${duration} played=${playedSec} nextKey=${nextKey} nextFixed=${JSON.stringify(nextFixed)} leads=${leadsIntoDialogue} start=${start}`);
    }
    if (sourceDurationSec > 0) {
      const latestStartToFitRest = sourceDurationSec - duration - remainingPackedDuration(index);
      if (start > latestStartToFitRest) start = Math.max(minStart, latestStartToFitRest);
    }
    // B-roll must not sit on top of reserved dialogue/scene-hook footage: those segments
    // keep their true source windows, so nudge the packed range forward past any overlap.
    // A closing slot narrates the beat's OUTCOME ("괴물은 사라졌습니다"), so its b-roll
    // end-aligns to the window instead of starting at the front (which shows the outcome's
    // build-up under a result sentence).
    if (String(placement.role || placement.slot_id || '').includes('closing')) {
      const endAlignedStart = Math.min(semanticEnd - Math.max(duration, 1.0), Number(sourceRange[1]) - Math.max(duration, 1.0));
      if (Number.isFinite(endAlignedStart) && endAlignedStart > start) start = Math.max(Number(sourceRange[0]), endAlignedStart);
    }
    if (process.env.MIDFORM_PACK_DEBUG) console.error(`[pack:preNudge] ${placement.clip_id} start=${start}`);
    // SEMANTIC BOUNDS: a narration clip must show its own scene. The nudge loop and the
    // relocation below used to wander the whole footage - "뒤엉켜 싸운다" narration shipped
    // over the kiss scene 50s away. B-roll may drift at most ~8s around its slot's window.
    const semanticOrigin = Array.isArray(placement?.semantic_origin_range) && placement.semantic_origin_range.length >= 2
      ? placement.semantic_origin_range
      : sourceRange;
    const semanticStart = Math.max(0, Number(semanticOrigin[0]) - 8);
    const semanticEnd = sourceDurationSec > 0
      ? Math.min(sourceDurationSec, Number(semanticOrigin[1]) + 8)
      : Number(semanticOrigin[1]) + 8;
    // A locale reframe shift is only a REFRAME while it stays in the SAME vision scene as
    // its plan origin: a 3.5s shift off a 3.2s grab scene put the fall under '掴もうとした'
    // (machine-eye catch, 2026-08-11). Scene boundaries are only known here at pack time -
    // if a scene cut sits between the origin start and the shifted start, revert to the
    // origin start (unless packing itself pushed the start, which minStart preserves).
    {
      const sceneBoundariesEarly = Array.isArray(baseDraftInput?.sceneBoundaries) ? baseDraftInput.sceneBoundaries : [];
      const originStart = Number(semanticOrigin[0]);
      if (sceneBoundariesEarly.length && Number.isFinite(originStart) && start > originStart + 0.05) {
        const crossed = sceneBoundariesEarly.some((boundary) => boundary > originStart + 0.05 && boundary <= start + 0.05);
        const reverted = Math.max(originStart, minStart);
        const revertCrossed = sceneBoundariesEarly.some((boundary) => boundary > originStart + 0.05 && boundary <= reverted + 0.05);
        if (crossed && !revertCrossed) start = reverted;
      }
    }
    let forceRelocate = false;
    let frontTrimmedEnd = null;
    for (let guard = 0; guard < 32; guard += 1) {
      const blocking = overlapsReserved(start, alignedEndSec != null ? alignedEndSec : start + duration);
      if (!blocking) break;
      // Narration describes the FRONT of its window (story order). When a reserved range sits
      // mid-window, keep the front and trim at the blocker instead of nudging forward onto the
      // tail scene - the nudge put ja's charge narration over the rescue shot at the window
      // tail. The freeze-frame path covers the shortfall.
      const placementNeedEarly = rangeDuration(Array.isArray(placement?.timeline_range) ? placement.timeline_range.map(Number) : []);
      const frontSpan = Number(blocking[0]) - PHYSICAL_SOURCE_GAP_SEC - start;
      if (alignedEndSec == null && frontSpan >= Math.max(3.0, placementNeedEarly * 0.5)) {
        frontTrimmedEnd = Number(blocking[0]) - PHYSICAL_SOURCE_GAP_SEC;
        break;
      }
      start = blocking[1] + PHYSICAL_SOURCE_GAP_SEC;
      if (start > semanticEnd - 1.0) { forceRelocate = true; break; }
    }
    let end = alignedEndSec != null ? alignedEndSec : (frontTrimmedEnd != null ? Math.min(frontTrimmedEnd, start + duration) : (start + duration));
    // The END must respect the scene bounds too: a nudge chain left the start just inside
    // the boundary while the clip ran 9s past it into the next scene (slot_07 135.5-147.1
    // against a 138.1 bound - the kiss played under '재돌진' narration).
    let endClampedToScene = false;
    if (end > semanticEnd) {
      end = semanticEnd;
      endClampedToScene = true;
      if (end - start < 1.0) forceRelocate = true;
    }
    if (process.env.MIDFORM_PACK_DEBUG) console.error(`[pack:postEndCap] ${placement.clip_id} start=${start} end=${typeof end!=='undefined'?end:'-'}`);

    let adjusted = start !== Number(sourceRange[0]) || duration !== originalDuration || endClampedToScene;
    if (sourceDurationSec > 0 && end > sourceDurationSec) {
      end = sourceDurationSec;
      if (end <= start) end = Math.min(sourceDurationSec, start + 0.5);
      adjusted = true;
    }
    // Nudged past every reserved window and clamped at the source end, a closing slot can be
    // left a 0.25s scrap stretched under seconds of narration. A sliver is the same as nothing.
    // Replaying the hook fails the hybrid gate (b-roll may not sit on reserved dialogue), so
    // take the LARGEST free gap between reserved windows instead - real footage, gate-safe.
    // Not just slivers: a 1.8s scrap under 11s of narration loops SEVEN times on screen - the
    // same tail replaying with its leftover audio. Relocate whenever the clip covers well under
    // the time it has to fill.
    const placementNeed = rangeDuration(Array.isArray(placement?.timeline_range) ? placement.timeline_range.map(Number) : []);
    if ((forceRelocate || end - start < 1.0 || (placementNeed > 0 && end - start < placementNeed * 0.6)) && sourceDurationSec > 0) {
      const gaps = [];
      let cursor = 0;
      // Blockers are BOTH the reserved dialogue windows and every b-roll clip already packed:
      // centring on a dialogue-free gap still collided with slot 2's packed clip by 0.272s.
      const blockers = [...reservedWindows, ...packedRanges].sort((l, r) => l[0] - r[0]);
      for (const [ws, we] of [...blockers, [sourceDurationSec, sourceDurationSec]]) {
        if (ws - cursor >= 1.0) gaps.push([cursor, ws]);
        cursor = Math.max(cursor, we);
      }
      // Prefer the sufficient gap NEAREST to the slot's own window over the largest one:
      // the largest gap sent a closing narration's b-roll into act-one removal footage, a
      // scene mismatch. Distance to the intended scene beats raw size; largest is the
      // fallback when nothing nearby can carry the clip.
      const wantSec = Math.max(1.0, Math.min(duration, placementNeed > 0 ? placementNeed : duration));
      const intendedStart = Number(sourceRange[0]);
      // Only gaps that intersect the slot's semantic neighbourhood may carry its b-roll;
      // a too-short in-scene clip (the freeze-frame path covers the shortfall) beats a
      // full-length clip of the WRONG scene.
      const inBounds = gaps
        .map(([gs, ge]) => [Math.max(gs, semanticStart), Math.min(ge, semanticEnd)])
        .filter(([gs, ge]) => ge - gs >= 1.0);
      const sufficient = inBounds.filter(([gs, ge]) => ge - gs >= wantSec);
      const byDistance = (gs, ge) => Math.min(Math.abs(gs - intendedStart), Math.abs(ge - intendedStart));
      const pool = sufficient.length ? sufficient : inBounds;
      const best = pool.sort((l, r) => (sufficient.length
        ? byDistance(l[0], l[1]) - byDistance(r[0], r[1])
        : (r[1] - r[0]) - (l[1] - l[0])))[0] || null;
      if (best && best[1] - best[0] >= 1.0) {
        start = best[0] + Math.max(0, (best[1] - best[0] - duration) / 2);
        end = Math.min(best[1], start + Math.max(duration, 1.0));
        adjusted = true;
      } else if (forceRelocate) {
        // Nothing free inside the scene: fall back to the slot's own window and let the
        // overlap gate judge it - a visible failure beats a silent scene mismatch.
        start = Math.max(semanticStart, Number(sourceRange[0]));
        end = Math.min(semanticEnd, start + Math.max(duration, 1.0));
        adjusted = true;
      }
    }
    // Land the cut on natural shot boundaries when they are within reach: a clip that starts
    // or ends mid-shot reads as a mistake, one that starts on a transition reads as editing.
    const shotBoundaries = Array.isArray(baseDraftInput?.shotBoundaries) ? baseDraftInput.shotBoundaries : [];
    if (shotBoundaries.length) {
      const [snappedStart, snappedEnd] = snapRangeToShotBoundaries(start, end, shotBoundaries, {
        minKeepSec: placementNeed,
        limitEndSec: sourceDurationSec,
        overlapsReserved
      });
      if (snappedStart !== start || snappedEnd !== end) {
        start = snappedStart;
        end = snappedEnd;
        adjusted = true;
      }
    }
    // The shot snap may stretch the end back out; the narration-length invariant wins over
    // a prettier cut point (slot_07 came back 9.6s under 7.2s of narration - 2s of the fall
    // returned to the screen).
    if (narrationNeedSec > 0 && end - start > narrationNeedSec + 0.5) {
      end = start + narrationNeedSec + 0.5;
      adjusted = true;
    }
    // And the end must land ON a cut, downward: a differentiated (later) start left the played
    // window crossing the scene boundary mid-shot - ja's 7.7s from 110.6 ran 3s into the fall.
    // Ending at the last shot cut inside the window keeps the clip on ONE scene; the freeze
    // path covers the shortfall, which beats seconds of the wrong scene.
    const sceneBoundaries = Array.isArray(baseDraftInput?.sceneBoundaries) ? baseDraftInput.sceneBoundaries : [];
    const cutBoundaries = [...shotBoundaries, ...sceneBoundaries].sort((l, r) => l - r);
    if (narrationNeedSec > 0 && cutBoundaries.length) {
      // 0.3, not 0.55: multi-part continuation fills what the scene cut removes, so cutting
      // at the TRUE scene boundary (110.8, 3.2s into a 7.2s narration) must be allowed.
      const floor = start + Math.max(2.0, narrationNeedSec * 0.3);
      let snapDown = null;
      for (const boundary of cutBoundaries) {
        if (boundary > end + 0.05) break;
        if (boundary >= floor) snapDown = boundary;
      }
      if (snapDown != null && snapDown < end - 0.3) {
        end = snapDown;
        adjusted = true;
      }
    }
    // Scene-following montage (owner direction: the SENTENCE was right, the SCENE was wrong):
    // when the scene cut leaves the clip shorter than the narration, CONTINUE with the next
    // free scene-snapped chunk inside the window instead of freezing - the narration's later
    // sentences get the later scene ('사투가 이어집니다' gets the struggle at 127.6-130.1).
    // A montage cut must also land on a SENTENCE boundary: the ja closing's first part ran
    // 1s past its first sentence, so '互いを抱きしめたまま' opened on aftermath footage
    // before the jump to the embrace. Trim small overhangs down to the nearest cumulative
    // sentence offset so each sentence opens on its own part.
    if (narrationNeedSec > 0 && (end - start) < narrationNeedSec - 0.4) {
      const cums = sentenceCumSecBySlot.get(placementSlotKey) || [];
      let snapCum = null;
      for (const cum of cums) {
        if (cum >= 1.0 && cum <= (end - start) && (end - start) - cum <= 1.5) snapCum = cum;
      }
      if (snapCum != null && snapCum < (end - start) - 0.05) {
        end = start + Number(snapCum.toFixed(3));
        adjusted = true;
      }
    }
    const extraRanges = [];
    if (narrationNeedSec > 0 && (end - start) < narrationNeedSec - 0.4) {
      let remainingSec = narrationNeedSec - (end - start);
      let cursor = end + PHYSICAL_SOURCE_GAP_SEC;
      // Continuation FIRST: the free footage right across the scene cut is the same action
      // continuing (grab attempt at 107.6-110.8 → the fall at 110.8+), which is exactly what
      // a frame-true sentence describes. Jumping ahead is only right when that continuation
      // is itself reserved beat footage ('사투' previewing the beat's fall) - so jump past
      // the reserved beats ONLY when the immediate continuation is blocked.
      const continuationBlocked = Boolean(overlapsReserved(cursor, cursor + Math.min(Math.max(remainingSec, 1.0), 1.5)));
      const reservedInside = reservedWindows
        .filter(([rs, re]) => rs >= cursor - 0.5 && rs < semanticEnd)
        .sort((l, r) => r[1] - l[1]);
      if (continuationBlocked && reservedInside.length) {
        const postReservedStart = reservedInside[0][1] + PHYSICAL_SOURCE_GAP_SEC;
        if (semanticEnd - postReservedStart >= 1.5) cursor = postReservedStart;
      }
      for (let part = 0; part < 2 && remainingSec > 0.6; part += 1) {
        for (let guard = 0; guard < 16; guard += 1) {
          const blocking = overlapsReserved(cursor, cursor + Math.min(remainingSec, 2.0));
          if (!blocking) break;
          cursor = blocking[1] + PHYSICAL_SOURCE_GAP_SEC;
        }
        if (cursor >= semanticEnd - 0.8) break;
        let partEnd = Math.min(semanticEnd, cursor + remainingSec + 0.3);
        const partBlock = overlapsReserved(cursor, partEnd);
        if (partBlock) partEnd = Math.min(partEnd, partBlock[0] - PHYSICAL_SOURCE_GAP_SEC);
        for (const boundary of cutBoundaries) {
          if (boundary > partEnd + 0.05) break;
          if (boundary >= cursor + 1.0 && boundary < partEnd - 0.3) partEnd = boundary;
        }
        if (partEnd - cursor >= 1.0) {
          extraRanges.push([Number(cursor.toFixed(3)), Number(partEnd.toFixed(3))]);
          remainingSec -= (partEnd - cursor);
          cursor = partEnd + PHYSICAL_SOURCE_GAP_SEC;
        } else {
          cursor += 1.0;
        }
      }
    }
    // UNIVERSAL invariant, last line of defense: no clip may cross the usable end (the
    // endcard). A ja closing spec carried a pre-correction window (132.93-135.44 vs usable
    // 132.4) and every upstream clamp missed it because the START itself sat past the
    // boundary. Shift the window back instead of truncating to a sliver.
    if (usableEndSec > 0 && end > usableEndSec + 0.05) {
      const overflow = end - usableEndSec;
      start = Math.max(0, start - overflow);
      end = usableEndSec;
      adjusted = true;
    }
    if (process.env.MIDFORM_PACK_DEBUG) console.error(`[pack:final] ${placement.clip_id} start=${start} end=${typeof end!=='undefined'?end:'-'}`);
    const normalized = [Number(start.toFixed(3)), Number(end.toFixed(3))];
    packedRanges.push(normalized);
    for (const range of extraRanges) packedRanges.push(range);
    lastEnd = Math.max(lastEnd, normalized[1]);
    if (extraRanges.length) placement.source_ranges = [normalized, ...extraRanges];
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
  if (isDialogue) {
    // Dialogue lines are locked to their source utterance windows. A slot-level locale
    // placement covers the whole parent slot, so applying it to each sibling line would
    // duplicate the same source range (hybrid overlap) and can cut into speech.
    // Keep the original clips; the locale spec still controls ordering.
    return {
      ...segment,
      locale_clip_id: placement.clip_id || ''
    };
  }
  if (segmentType === 'scene_hook') {
    // A beat window may be locale-shifted (ko keeps the wind-up, ja the follow-through -
    // owner directive 2026-08-11). Unlike dialogue there are no sibling lines and no speech
    // to cut, so the slot-level locale range replaces the window: original audio simply
    // plays the shifted seconds of the same fight. Audio policy fields stay untouched.
    if (Array.isArray(sourceRange) && Number(sourceRange[1]) > Number(sourceRange[0])) {
      const beatScene = {
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
        source_scenes: [beatScene],
        source_clips: [{ ...beatScene, source: 'locale_draft_spec' }],
        story_anchor: {
          ...(segment.story_anchor || {}),
          source_range_hint: [sourceRange[0], sourceRange[0]]
        }
      };
    }
    return {
      ...segment,
      locale_clip_id: placement.clip_id || ''
    };
  }
  // Scene-following montage: a narration slot may carry SEVERAL scene-snapped parts so its
  // later sentences play over their own scene instead of freezing on the first one.
  const ranges = Array.isArray(placement.source_ranges) && placement.source_ranges.length
    ? placement.source_ranges
    : [sourceRange];
  const sourceScenes = ranges.map((range, partIndex) => ({
    clip_id: `${placement.clip_id || segment.segment_id}_locale_clip${partIndex ? `_p${partIndex + 1}` : ''}`,
    scene_id: `${placement.visual_role || 'locale'}_${placement.clip_id || segment.segment_id}${partIndex ? `_p${partIndex + 1}` : ''}`,
    start: secondsToTimecode(range[0]),
    end: secondsToTimecode(range[1]),
    speed_multiplier: 1
  }));
  const sourceScene = sourceScenes[0];
  return {
    ...segment,
    locale_source_override: true,
    locale_clip_id: placement.clip_id || '',
    ...(isDialogue ? {} : { narration_background: true, source_audio_ducking: 0 }),
    source_scenes: sourceScenes,
    source_clips: sourceScenes.map((scene) => ({ ...scene, source: 'locale_draft_spec' })),
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
      frameLocale: locale,
      frame_locale: locale,
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
  // The _L number in a segment id is the line's position in dialogue_line_windows, which counts the
  // planned lines that never matched a cue; the caption list holds one entry per line that DOES play.
  // Reading captions by the raw _L number therefore runs off the end of the list as soon as a slot
  // has an unmatched line: The Housemaid night's slot_06_L07 and slot_07_L07 came back blank and the
  // whole Japanese locale was skipped. Count the dialogue segments the slot actually emits instead -
  // that ordinal is what the caption list is indexed by.
  const dialogueOrdinal = new Map();
  const seenPerSlot = new Map();
  for (const segment of Array.isArray(baseScript?.segments) ? baseScript.segments : []) {
    if (!['dialogue_quote', 'dialogue'].includes(String(segment?.segment_type || '').trim())) continue;
    const slotId = parentSlotIdForSegment(segment);
    const segmentId = String(segment?.segment_id || '');
    if (dialogueOrdinal.has(segmentId)) continue;
    const next = seenPerSlot.get(slotId) || 0;
    dialogueOrdinal.set(segmentId, next);
    seenPerSlot.set(slotId, next + 1);
  }
  const segments = (Array.isArray(baseScript?.segments) ? baseScript.segments : []).map((segment) => {
    const fill = fillsBySlot.get(parentSlotIdForSegment(segment));
    const segmentType = String(segment?.segment_type || '').trim();
    if (!fill) {
      if (segmentType !== 'scene_hook') missing.push(String(segment?.segment_id || ''));
      return { ...segment };
    }
    if (['dialogue_quote', 'dialogue'].includes(segmentType)) {
      const lines = Array.isArray(fill.caption_kr_dialogue) ? fill.caption_kr_dialogue : [];
      const ordinal = dialogueOrdinal.get(String(segment?.segment_id || ''));
      const rawIndex = dialogueLineIndexForSegment(segment);
      const byOrdinal = Number.isInteger(ordinal) ? String(lines[ordinal] || '').trim() : '';
      const text = byOrdinal || String(lines[rawIndex] || '').trim();
      // The ko script itself can carry empty dialogue segments (the pipeline splits a slot
      // into L01..L0N but only fills the lines that have text; slot_10_L03..L05 shipped ko-
      // empty on Breaking Dawn). A ja blank is only MISSING when the ko line HAS text - then
      // an untranslated ja slot would leave Korean in the ja cut. When ko is empty too, ja
      // empty is correct and must not skip the whole locale.
      const koText = String(segment?.caption_text || segment?.translated_caption_ko || '').trim();
      if (!text && koText) missing.push(String(segment?.segment_id || ''));
      return { ...segment, translated_caption_ko: text, caption_text: text, tts_enabled: text ? segment?.tts_enabled : false };
    }
    if (segmentType === 'scene_hook') return { ...segment };
    const narration = String(fill.narration || '').trim();
    const caption = String(fill.caption_kr || '').trim() || narration;
    // Same rule the dialogue branch already uses: a ja blank is only MISSING when the ko segment has
    // text. A KEEP_DIALOGUE slot can still carry an empty narration segment in the ko script, and
    // treating that as untranslated skipped the whole Japanese locale over a segment with nothing in it.
    const koNarration = String(segment?.narration || segment?.caption_text || '').trim();
    if (!narration && koNarration) missing.push(String(segment?.segment_id || ''));
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

// Loudness auto-alignment (owner-approved fix for the "narration 14 LU louder than the film"
// defect on quietly-mastered sources): measure TTS vs source-dialogue integrated loudness and
// bake compensating volume gains into the draft - boost the source video (cap +10dB), shave
// the narration (cap -6dB), aiming for narration ~3 LU above dialogue.
function measureLufsSpawn(inputArgs) {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const { spawnSync } = require('child_process');
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-nostats', ...inputArgs, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  const match = String(probe.stderr || '').match(/I:\s*(-?[\d.]+)\s*LUFS/);
  return match ? Number(match[1]) : null;
}

function computeLoudnessAlignment(baseInput, sourceVideoPath) {
  try {
    const ttsPaths = (Array.isArray(baseInput?.ttsFiles) ? baseInput.ttsFiles : [])
      .map((file) => file && (file.filepath || file.path))
      .filter((filePath) => filePath && fs.existsSync(filePath))
      .slice(0, 4);
    const narrationValues = ttsPaths.map((filePath) => measureLufsSpawn(['-i', filePath])).filter(Number.isFinite);
    const dialogueWindows = [];
    for (const seg of (Array.isArray(baseInput?.segments) ? baseInput.segments : [])) {
      const range = seg?.dialogue_speech_range_sec;
      if (Array.isArray(range) && Number(range[1]) - Number(range[0]) > 0.8) dialogueWindows.push([Number(range[0]), Number(range[1])]);
      if (dialogueWindows.length >= 4) break;
    }
    const dialogueValues = (sourceVideoPath && fs.existsSync(sourceVideoPath))
      ? dialogueWindows.map(([start, end]) => measureLufsSpawn(['-ss', start.toFixed(3), '-t', (end - start).toFixed(3), '-i', sourceVideoPath, '-vn'])).filter(Number.isFinite)
      : [];
    if (!narrationValues.length || !dialogueValues.length) return null;
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const narrationLufs = Number(mean(narrationValues).toFixed(1));
    const dialogueLufs = Number(mean(dialogueValues).toFixed(1));
    const needed = (narrationLufs - dialogueLufs) - 3;
    // Caps default to +10/-6 (16 LU total). Extremely quietly-mastered dialogue (a psych-ward
    // whisper measured -41 LUFS, 20.7 LU of correction needed) leaves a residual delta at the
    // default cap; MIDFORM_MAX_VIDEO_GAIN_DB / MIDFORM_MAX_TTS_CUT_DB raise it per source
    // (owner-approved trade-off: background ambience rises with the dialogue).
    const maxVideoGain = Number(process.env.MIDFORM_MAX_VIDEO_GAIN_DB) > 0 ? Number(process.env.MIDFORM_MAX_VIDEO_GAIN_DB) : 10;
    const maxTtsCut = Number(process.env.MIDFORM_MAX_TTS_CUT_DB) > 0 ? Number(process.env.MIDFORM_MAX_TTS_CUT_DB) : 6;
    const videoGainDb = needed > 1 ? Number(Math.min(maxVideoGain, needed).toFixed(1)) : 0;
    const ttsCutDb = needed > 1 ? Number(Math.min(maxTtsCut, Math.max(0, needed - videoGainDb)).toFixed(1)) : 0;
    // The other direction was a blind spot: this only ever quietened a narration that was too LOUD, so
    // a narration mixed 6.3 LU under the dialogue (Housemaid night) stayed inaudible at the seams and
    // the loudness gate failed the render with nothing able to fix it. Correct it the same way, in
    // reverse: cut the source video first (no clipping risk), then lift the TTS a little if needed.
    const deficit = (dialogueLufs - narrationLufs) - 3;
    const maxVideoCut = Number(process.env.MIDFORM_MAX_VIDEO_CUT_DB) > 0 ? Number(process.env.MIDFORM_MAX_VIDEO_CUT_DB) : 6;
    const maxTtsGain = Number(process.env.MIDFORM_MAX_TTS_GAIN_DB) > 0 ? Number(process.env.MIDFORM_MAX_TTS_GAIN_DB) : 3;
    const videoCutDb = deficit > 1 ? Number(Math.min(maxVideoCut, deficit).toFixed(1)) : 0;
    const ttsGainDb = deficit > 1 ? Number(Math.min(maxTtsGain, Math.max(0, deficit - videoCutDb)).toFixed(1)) : 0;
    return {
      narration_lufs: narrationLufs,
      dialogue_lufs: dialogueLufs,
      delta_lu: Number((narrationLufs - dialogueLufs).toFixed(1)),
      video_gain_db: videoGainDb,
      tts_cut_db: ttsCutDb,
      video_cut_db: videoCutDb,
      tts_gain_db: ttsGainDb
    };
  } catch {
    return null;
  }
}

function applyLoudnessAlignment(draftContentPath, alignment) {
  const anyCorrection = alignment && (alignment.video_gain_db > 0 || alignment.tts_cut_db > 0
    || alignment.video_cut_db > 0 || alignment.tts_gain_db > 0);
  if (!anyCorrection) return false;
  if (!draftContentPath || !fs.existsSync(draftContentPath)) return false;
  const content = readJson(draftContentPath);
  // One factor per track, so a correction in either direction is the same operation.
  const videoDb = Number(alignment.video_gain_db || 0) - Number(alignment.video_cut_db || 0);
  const ttsDb = Number(alignment.tts_gain_db || 0) - Number(alignment.tts_cut_db || 0);
  const videoFactor = 10 ** (videoDb / 20);
  const ttsFactor = 10 ** (ttsDb / 20);
  let touched = 0;
  for (const track of (Array.isArray(content?.tracks) ? content.tracks : [])) {
    const name = String(track?.name || '');
    const isSourceVideo = track?.type === 'video' && name === 'source_video';
    const isTts = track?.type === 'audio' && name === 'tts';
    if (!isSourceVideo && !isTts) continue;
    for (const segment of (Array.isArray(track.segments) ? track.segments : [])) {
      const current = Number(segment?.volume);
      if (!Number.isFinite(current)) continue;
      segment.volume = Number((current * (isSourceVideo ? videoFactor : ttsFactor)).toFixed(4));
      touched += 1;
    }
  }
  if (touched) writeJson(draftContentPath, content);
  return touched > 0;
}

async function generateLocaleDraftArtifacts({ workspaceDir, baseDraftInputPath, sourceVideoPath, transcriptPath, baseScriptPath, japaneseSlotFillsPath, usableEndSec = 0, draftGenerator = generateLocaleDraftFromInput }) {
  const baseDraftInput = readJson(baseDraftInputPath);
  // Stamp the measured footage end onto the input so every packing helper sees it.
  if (Number(usableEndSec) > 0) baseDraftInput.usableEndSec = Number(usableEndSec);
  // Shot boundaries ride on the base input so the sync packing helpers can snap to them.
  const shotBoundaries = await detectShotBoundaries(sourceVideoPath);
  if (shotBoundaries.length) baseDraftInput.shotBoundaries = shotBoundaries;
  // Vision SCENE boundaries too: a fall is continuous motion with no hard cut, so shot
  // detection has no boundary at the semantic scene change - only the vision map knows
  // where '달려든다' ends and '떨어진다' begins.
  try {
    const visionPath = path.join(workspaceDir, 'vision_scene_map.json');
    if (fs.existsSync(visionPath)) {
      const scenes = (readJson(visionPath) || {}).scenes || [];
      const sceneBoundaries = [...new Set(scenes.flatMap((scene) => [Number(scene.start_sec), Number(scene.end_sec)])
        .filter((value) => Number.isFinite(value) && value > 0))].sort((left, right) => left - right);
      if (sceneBoundaries.length) baseDraftInput.sceneBoundaries = sceneBoundaries;
    }
  } catch { /* scene boundaries are an enhancement, not a dependency */ }
  const localeResults = {};
  const outputPaths = {};
  // ja renders from its own assembled draft input (Japanese script + Japanese TTS); every
  // other locale renders from the pipeline's base input.
  let japaneseBase = null;
  let japaneseSkippedReason = '';
  let lastAlignment = null;
  if (japaneseSlotFillsPath && fs.existsSync(japaneseSlotFillsPath)) {
    try {
      const built = await buildJapaneseBaseDraftInput({
        workspaceDir, baseScriptPath, japaneseSlotFillsPath, sourceVideoPath, transcriptPath
      });
      japaneseBase = readJson(built.draftInputPath);
      if (shotBoundaries.length) japaneseBase.shotBoundaries = shotBoundaries;
      if (Array.isArray(baseDraftInput.sceneBoundaries)) japaneseBase.sceneBoundaries = baseDraftInput.sceneBoundaries;
      // ja packs from its OWN base input; without the usable end it walked b-roll straight
      // into the Movieclips endcard (157.6-167 on a 159.1-usable source).
      if (Number(usableEndSec) > 0) japaneseBase.usableEndSec = Number(usableEndSec);
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
    // ja's own TTS set can fail to measure (different file layout); the source is the same
    // video, so ko's measured gains are the correct fallback rather than shipping ja unaligned.
    const alignment = computeLoudnessAlignment(localeBaseInput, sourceVideoPath)
      || (locale !== 'ko' && lastAlignment ? { ...lastAlignment, fallback_from: 'ko' } : null);
    if (alignment && locale === 'ko') lastAlignment = alignment;
    if (alignment) {
      const contentPaths = new Set([
        generated?.draft_content_path,
        generated?.draft_folder_path ? path.join(generated.draft_folder_path, 'draft_content.json') : ''
      ].filter(Boolean));
      let applied = false;
      for (const contentPath of contentPaths) applied = applyLoudnessAlignment(contentPath, alignment) || applied;
      writeJson(path.join(workspaceDir, `loudness_alignment.${locale}.json`), { ...alignment, applied });
      generated.loudness_alignment = { ...alignment, applied };
    }
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

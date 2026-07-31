const fs = require('fs');
const path = require('path');

const { generateDraft } = require('./capcutService');
const { compareFinalDraftFiles } = require('./midformFinalDraftOverlapService');
const { ensureDir, rel, writeJson } = require('./midformRunArtifactsService');
const { getVideoMetadata } = require('../utils/ffprobe');
const { buildSpeakerMetadata, resolveCaptionColor } = require('../utils/captionColorConfig');

const LOCALES = ['ko', 'ja'];
const MAX_FINAL_DRAFT_REPLAN_ATTEMPTS = 8;
const MAX_PHYSICAL_SOURCE_CLIP_SEC = 8;
const PHYSICAL_SOURCE_GAP_SEC = 0.3;
const SOURCE_DURATION_SAFETY_MARGIN_SEC = 0.25;

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

function rangeOverlap(a, b) {
  return Math.max(0, Math.min(Number(a?.[1] || 0), Number(b?.[1] || 0)) - Math.max(Number(a?.[0] || 0), Number(b?.[0] || 0)));
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
  const authoritativeDuration = Number(baseDraftInput?.localeActualSourceDurationSec || 0);
  if (authoritativeDuration > 0) return authoritativeDuration;
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

function baseDraftInputWithActualSourceDuration(baseDraftInput, sourceVideoPath) {
  if (!sourceVideoPath || !fs.existsSync(sourceVideoPath)) return baseDraftInput;
  const durationSec = Math.max(0, Number(getVideoMetadata(sourceVideoPath)?.duration_sec || 0) - SOURCE_DURATION_SAFETY_MARGIN_SEC);
  if (!(durationSec > 0)) return baseDraftInput;
  return {
    ...baseDraftInput,
    localeActualSourceDurationSec: durationSec,
    sourceDurationSec: durationSec,
    source_duration_sec: durationSec
  };
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
  const shiftDirection = attempt % 2 === 0 ? -1 : 1;
  const shiftBase = shiftDirection * (4 + (attempt * 5));
  const failedGates = new Set(finalOverlapReport?.failed_gates || []);
  const koTopRanges = Array.isArray(finalOverlapReport?.top_highlight_cluster_ordering?.ko)
    ? finalOverlapReport.top_highlight_cluster_ordering.ko.map((clip) => clip.source_range).filter(Array.isArray)
    : [];
  const jaTopRanges = Array.isArray(finalOverlapReport?.top_highlight_cluster_ordering?.ja)
    ? finalOverlapReport.top_highlight_cluster_ordering.ja.map((clip) => clip.source_range).filter(Array.isArray)
    : [];
  const targetJaRanges = jaTopRanges.filter((jaRange) => koTopRanges.some((koRange) => rangeOverlap(jaRange, koRange) > 6));
  next.clip_placement = placements.map((placement, index) => {
    const shouldShift = (overlappingClipIds.size === 0 && overlappingIndexes.size === 0)
      || overlappingClipIds.has(String(placement?.clip_id || '').trim())
      || overlappingIndexes.has(index)
      || index < 3;
    const sourceRange = Array.isArray(placement?.source_range) ? placement.source_range : [];
    if (!shouldShift || !(Number(sourceRange[1]) > Number(sourceRange[0]))) return placement;
    const role = String(placement?.visual_role || '').toLowerCase();
    const roleBonus = shiftDirection * (role === 'cold_open' ? 2.5 : (role === 'payoff' ? 1.5 : 0));
    return {
      ...placement,
      source_range: shiftedSourceRange(sourceRange, shiftBase + roleBonus + (shiftDirection * index * 0.65), sourceDurationSec),
      final_draft_replan_reason: overlappingClipIds.size ? 'shared_contiguous_overlap' : 'final_overlap_threshold',
      final_draft_replan_attempt: attempt
    };
  });
  if (attempt >= 3 && sourceDurationSec > 0 && failedGates.has('shared_contiguous_block_threshold') && next.clip_placement.length > 2) {
    let targetIndex = -1;
    let targetScore = 0;
    let latestIndex = -1;
    let latestEnd = -1;
    next.clip_placement.forEach((placement, index) => {
      const sourceRange = Array.isArray(placement?.source_range) ? placement.source_range.map(Number) : [];
      const overlapScore = targetJaRanges.reduce((maxScore, targetRange) => Math.max(maxScore, rangeOverlap(sourceRange, targetRange)), 0);
      if (overlapScore > targetScore) {
        targetScore = overlapScore;
        targetIndex = index;
      }
      if (Number(sourceRange[1]) > latestEnd) {
        latestEnd = Number(sourceRange[1]);
        latestIndex = index;
      }
    });
    if (targetIndex >= 0) latestIndex = targetIndex;
    if (latestIndex > 1) {
      const [latestPlacement] = next.clip_placement.splice(latestIndex, 1);
      const duration = rangeDuration(latestPlacement.source_range);
      const earliestKoTopStart = koTopRanges.reduce((minStart, range) => Math.min(minStart, Number(range?.[0] || minStart)), sourceDurationSec);
      const beforeKoTopStart = Math.max(0, earliestKoTopStart - PHYSICAL_SOURCE_GAP_SEC - duration);
      const genericEarlyStart = Math.max(0, (sourceDurationSec * 0.22) + attempt);
      const earlyStart = Math.min(Math.max(0, sourceDurationSec - duration), targetIndex >= 0 && beforeKoTopStart > 0 ? beforeKoTopStart : genericEarlyStart);
      next.clip_placement.splice(1, 0, {
        ...latestPlacement,
        source_range: [Number(earlyStart.toFixed(3)), Number((earlyStart + duration).toFixed(3))],
        final_draft_replan_reason: 'shared_contiguous_tail_reordered',
        final_draft_replan_attempt: attempt
      });
    }
  }
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

function normalizeDraftSpecSourceRanges(draftSpec, baseDraftInput = {}) {
  const next = cloneJson(draftSpec);
  const placements = Array.isArray(next?.clip_placement) ? next.clip_placement : [];
  const sourceDurationSec = inferSourceDurationSec(baseDraftInput, next);
  const requiredDurationBySlot = new Map();
  for (const segment of Array.isArray(baseDraftInput?.segments) ? baseDraftInput.segments : []) {
    const slotKey = slotKeyForSegment(segment);
    const duration = dialogueSourceDurationRequirement(segment);
    if (slotKey && duration > 0) requiredDurationBySlot.set(slotKey, (requiredDurationBySlot.get(slotKey) || 0) + duration);
  }
  const cappedDurations = placements.map((placement) => {
    const sourceRange = Array.isArray(placement?.source_range) ? placement.source_range.map(Number) : [];
    if (!(Number(sourceRange[1]) > Number(sourceRange[0]))) return 0;
    const slotId = String(placement?.clip_id || '').replace(/^(ko|ja)_/, '') || String(placement?.slot_id || '');
    const requiredDuration = Number(requiredDurationBySlot.get(slotId) || 0);
    const maxDuration = Math.max(MAX_PHYSICAL_SOURCE_CLIP_SEC, requiredDuration);
    return Math.max(requiredDuration, Math.min(rangeDuration(sourceRange), maxDuration));
  });
  const remainingPackedDuration = (index) => cappedDurations
    .slice(index + 1)
    .filter((duration) => duration > 0)
    .reduce((sum, duration, remainingIndex) => sum + duration + (remainingIndex >= 0 ? PHYSICAL_SOURCE_GAP_SEC : 0), 0);
  let lastEnd = 0;
  next.clip_placement = placements.map((placement, index) => {
    const sourceRange = Array.isArray(placement?.source_range) ? placement.source_range.map(Number) : [];
    if (!(Number(sourceRange[1]) > Number(sourceRange[0]))) return placement;
    const originalDuration = rangeDuration(sourceRange);
    const duration = cappedDurations[index];
    const minStart = lastEnd > 0 ? lastEnd + PHYSICAL_SOURCE_GAP_SEC : 0;
    let start = Math.max(Number(sourceRange[0]), minStart);
    if (sourceDurationSec > 0) {
      const latestStartToFitRest = sourceDurationSec - duration - remainingPackedDuration(index);
      if (start > latestStartToFitRest) start = Math.max(minStart, latestStartToFitRest);
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

function buildFallbackPlacementBySlot(baseSegments, placements) {
  const map = new Map();
  const seen = new Set();
  const orderedSlotKeys = [];
  for (const segment of baseSegments) {
    const key = slotKeyForSegment(segment);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    orderedSlotKeys.push(key);
  }
  orderedSlotKeys.forEach((slotKey, index) => {
    const placement = placements[index];
    const sourceRange = Array.isArray(placement?.source_range) ? placement.source_range : [];
    if (placement && Number(sourceRange[1]) > Number(sourceRange[0])) map.set(slotKey, { ...placement, slot_id: slotKey, source_range: [Number(sourceRange[0]), Number(sourceRange[1])] });
  });
  return map;
}

function slotKeyForSegment(segment) {
  const segmentId = String(segment?.segment_id || '').trim();
  const parentSlotId = String(segment?.parent_slot_id || '').trim();
  return parentSlotId || segmentId;
}

function splitSourceRangeForOccurrence(sourceRange, occurrenceIndex = 0, occurrenceCount = 1) {
  const range = Array.isArray(sourceRange) ? sourceRange.map(Number) : [];
  const duration = rangeDuration(range);
  if (!(duration > 0) || occurrenceCount <= 1) return range;
  const gap = Math.min(0.05, duration / Math.max(20, occurrenceCount * 10));
  const usable = Math.max(0.001, duration - (gap * (occurrenceCount - 1)));
  const sliceDuration = usable / occurrenceCount;
  const index = Math.max(0, Math.min(occurrenceCount - 1, Number(occurrenceIndex || 0)));
  const start = Number((range[0] + (index * (sliceDuration + gap))).toFixed(3));
  const end = Number((start + sliceDuration).toFixed(3));
  return [start, Math.min(Number(range[1].toFixed(3)), end)];
}

function splitSourceRangeForDuration(sourceRange, offsetSec = 0, durationSec = 0) {
  const range = Array.isArray(sourceRange) ? sourceRange.map(Number) : [];
  const sourceDuration = rangeDuration(range);
  const duration = Math.max(0, Number(durationSec || 0));
  if (!(sourceDuration > 0) || !(duration > 0)) return range;
  const boundedDuration = Math.min(sourceDuration, duration);
  const maxOffset = Math.max(0, sourceDuration - boundedDuration);
  const offset = Math.max(0, Math.min(maxOffset, Number(offsetSec || 0)));
  const start = Number((range[0] + offset).toFixed(3));
  return [start, Number((start + boundedDuration).toFixed(3))];
}

function dialogueSourceDurationRequirement(segment) {
  const segmentType = String(segment?.segment_type || '').trim();
  if (!['dialogue_quote', 'dialogue'].includes(segmentType)) return 0;
  const candidates = [segment?.duration_override_sec, segment?.caption_duration_sec, segment?.duration_sec, segment?.duration].map(Number).filter(Number.isFinite);
  return Math.max(0, ...candidates);
}

function isDialogueSegment(segment) {
  return ['dialogue_quote', 'dialogue'].includes(String(segment?.segment_type || '').trim());
}

function dialogueSpeakerProvenance(segment) {
  const metadata = buildSpeakerMetadata(segment, {
    segment_type: segment?.segment_type || 'dialogue_quote',
    utt_id: segment?.utt_id || segment?.source_utterance_id || segment?.segment_id || ''
  });
  const speakerAlias = String(metadata.speaker_alias || segment?.speaker_alias || segment?.speaker || '').trim();
  const speakerColorKey = String(metadata.speaker_color_key || segment?.speaker_color_key || '').trim();
  const captionColor = String(segment?.caption_color || resolveCaptionColor({ speakerAlias, speakerColorKey }) || '').trim();
  return {
    ...metadata,
    ...(speakerAlias ? { speaker: speakerAlias } : {}),
    ...(captionColor ? { caption_color: captionColor } : {})
  };
}

function firstSourceRange(segment) {
  const clip = Array.isArray(segment?.source_clips) && segment.source_clips[0]
    ? segment.source_clips[0]
    : (Array.isArray(segment?.source_scenes) ? segment.source_scenes[0] : null);
  const start = secondsFromTimecode(clip?.start ?? clip?.start_sec ?? clip?.start_time);
  const end = secondsFromTimecode(clip?.end ?? clip?.end_sec ?? clip?.end_time);
  return Number(end) > Number(start) ? [Number(start.toFixed(3)), Number(end.toFixed(3))] : [0, 0];
}

function buildDialogueParentAtomMap(baseSegments) {
  const groups = new Map();
  for (const segment of baseSegments) {
    if (!isDialogueSegment(segment)) continue;
    const parentSlotId = String(segment?.parent_slot_id || '').trim();
    if (!parentSlotId) continue;
    if (!groups.has(parentSlotId)) groups.set(parentSlotId, []);
    groups.get(parentSlotId).push(segment);
  }
  const atomMap = new Map();
  for (const [slotId, segments] of groups.entries()) {
    const atoms = segments.map((segment, index) => {
      const sourceRange = firstSourceRange(segment);
      const provenance = dialogueSpeakerProvenance(segment);
      const speakerId = String(provenance.speaker_id || segment?.speaker_id || segment?.speaker_alias || segment?.speaker || '').trim();
      const utteranceId = String(provenance.source_utterance_id || segment?.utt_id || segment?.source_utterance_id || segment?.segment_id || '').trim();
      const required = index === 0 || index === segments.length - 1 || segments.length <= 2;
      return {
        atomic_id: `${slotId}_atom_${String(index + 1).padStart(2, '0')}`,
        slot_id: slotId,
        segment_id: String(segment?.segment_id || ''),
        caption_kind: provenance.caption_kind || 'dialogue',
        source_range: sourceRange,
        duration_sec: Number((dialogueSourceDurationRequirement(segment) || rangeDuration(sourceRange)).toFixed(3)),
        utterance_ids: utteranceId ? [utteranceId] : [],
        speaker_id: speakerId,
        speaker_alias: provenance.speaker_alias || '',
        speaker_color_key: provenance.speaker_color_key || '',
        source_utterance_id: utteranceId,
        caption_color: provenance.caption_color || '',
        visual_role: 'speaker_delivery',
        dialogue_role: required ? (index === 0 ? 'lead_required_dialogue' : 'required_dialogue_anchor') : 'optional_dialogue_bridge',
        is_required: required,
        dependencies: index > 0 ? [{ before: segments[index - 1].segment_id, after: segment.segment_id, hard: true }] : []
      };
    });
    atomMap.set(slotId, atoms);
  }
  return atomMap;
}

function composeDialogueParentAtoms(atoms, locale) {
  if (!Array.isArray(atoms) || !atoms.length) return { atoms: [], removed: [], strategy: 'none' };
  if (locale === 'ja' && atoms.length >= 3) {
    const kept = atoms.filter((atom) => atom.is_required);
    const removed = atoms.filter((atom) => !atom.is_required);
    return {
      atoms: kept,
      removed,
      strategy: 'reaction_led_optional_dialogue_pruned'
    };
  }
  return {
    atoms,
    removed: [],
    strategy: locale === 'ja' ? 'reaction_led_required_dialogue_chain' : 'direct_dialogue_chain'
  };
}

function dialogueParentCompositionForSegment(segment, placement, locale, atomMap) {
  const slotKey = slotKeyForSegment(segment);
  const atoms = atomMap.get(slotKey) || [];
  if (!placement || !atoms.length || !isDialogueSegment(segment)) return null;
  const composition = composeDialogueParentAtoms(atoms, locale);
  const atom = composition.atoms.find((candidate) => candidate.segment_id === String(segment?.segment_id || ''));
  if (!atom) return { omit: true, atom: atoms.find((candidate) => candidate.segment_id === String(segment?.segment_id || '')) || null, composition };
  return { omit: false, atom, composition };
}

function avoidProtectedSourceRanges(range, protectedRanges = [], sourceDurationSec = 0) {
  let next = Array.isArray(range) ? range.map(Number) : [];
  const duration = rangeDuration(next);
  if (!(duration > 0)) return range;
  const sorted = protectedRanges
    .map((protectedRange) => protectedRange.map(Number))
    .filter((protectedRange) => rangeDuration(protectedRange) > 0)
    .sort((left, right) => left[0] - right[0]);
  if (!sorted.some((protectedRange) => rangeOverlap(next, protectedRange) > 0.001)) {
    return [Number(next[0].toFixed(3)), Number(next[1].toFixed(3))];
  }
  if (sourceDurationSec > 0) {
    const merged = [];
    for (const protectedRange of sorted) {
      const start = Math.max(0, Number(protectedRange[0] || 0));
      const end = Math.min(sourceDurationSec, Number(protectedRange[1] || 0));
      if (!(end > start)) continue;
      const previous = merged[merged.length - 1];
      if (previous && start <= previous[1] + PHYSICAL_SOURCE_GAP_SEC) {
        previous[1] = Math.max(previous[1], end);
      } else {
        merged.push([start, end]);
      }
    }
    const gaps = [];
    let cursor = 0;
    for (const protectedRange of merged) {
      const gapStart = cursor;
      const gapEnd = Math.max(0, protectedRange[0] - PHYSICAL_SOURCE_GAP_SEC);
      if (gapEnd - gapStart >= duration) gaps.push([gapStart, gapEnd]);
      cursor = Math.max(cursor, protectedRange[1] + PHYSICAL_SOURCE_GAP_SEC);
    }
    if (sourceDurationSec - cursor >= duration) gaps.push([cursor, sourceDurationSec]);
    if (gaps.length) {
      const originalStart = Math.max(0, Number(next[0] || 0));
      const candidates = gaps.map((gap) => {
        const start = Math.min(Math.max(originalStart, gap[0]), gap[1] - duration);
        return { start, forward: start >= originalStart - 0.001, score: Math.abs(start - originalStart) };
      });
      const forwardCandidate = candidates
        .filter((candidate) => candidate.forward)
        .sort((left, right) => left.start - right.start)[0];
      const candidate = forwardCandidate || candidates.sort((left, right) => right.start - left.start)[0];
      return [Number(candidate.start.toFixed(3)), Number((candidate.start + duration).toFixed(3))];
    }
  }
  for (let pass = 0; pass < sorted.length + 2; pass += 1) {
    let changed = false;
    for (const protectedRange of sorted) {
      if (rangeOverlap(next, protectedRange) <= 0.001) continue;
      const afterStart = protectedRange[1] + PHYSICAL_SOURCE_GAP_SEC;
      const after = [afterStart, afterStart + duration];
      if (!sourceDurationSec || after[1] <= sourceDurationSec) {
        next = after;
        changed = true;
        continue;
      }
      const beforeEnd = Math.max(0, protectedRange[0] - PHYSICAL_SOURCE_GAP_SEC);
      const before = [Math.max(0, beforeEnd - duration), beforeEnd];
      next = before;
      changed = true;
    }
    if (!changed) break;
  }
  return [Number(next[0].toFixed(3)), Number(next[1].toFixed(3))];
}

function bestNonOverlappingGap(durationSec, protectedRanges = [], sourceDurationSec = 0, preferredStart = 0) {
  const duration = Math.max(0, Number(durationSec || 0));
  const sourceDuration = Math.max(0, Number(sourceDurationSec || 0));
  if (!(duration > 0) || !(sourceDuration > 0)) return null;
  const merged = [];
  for (const protectedRange of protectedRanges
    .map((range) => Array.isArray(range) ? range.map(Number) : [])
    .filter((range) => rangeDuration(range) > 0)
    .sort((left, right) => left[0] - right[0])) {
    const start = Math.max(0, protectedRange[0]);
    const end = Math.min(sourceDuration, protectedRange[1]);
    const previous = merged[merged.length - 1];
    if (previous && start <= previous[1] + PHYSICAL_SOURCE_GAP_SEC) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  const gaps = [];
  let cursor = 0;
  for (const range of merged) {
    const gapEnd = Math.max(0, range[0] - PHYSICAL_SOURCE_GAP_SEC);
    if (gapEnd > cursor) gaps.push([cursor, gapEnd]);
    cursor = Math.max(cursor, range[1] + PHYSICAL_SOURCE_GAP_SEC);
  }
  if (sourceDuration > cursor) gaps.push([cursor, sourceDuration]);
  const preferred = Number(preferredStart || 0);
  return gaps
    .map((gap) => {
      const capacity = rangeDuration(gap);
      const playableDuration = Math.min(duration, capacity);
      if (!(playableDuration > 0)) return null;
      const start = Math.min(Math.max(preferred, gap[0]), Math.max(gap[0], gap[1] - playableDuration));
      return {
        range: [Number(start.toFixed(3)), Number((start + playableDuration).toFixed(3))],
        playableDuration,
        freezePaddingSec: Number(Math.max(0, duration - playableDuration).toFixed(3)),
        fullFit: playableDuration >= duration - 0.001,
        distance: Math.abs(start - preferred)
      };
    })
    .filter(Boolean)
    .sort((left, right) => Number(right.fullFit) - Number(left.fullFit) || left.distance - right.distance || right.playableDuration - left.playableDuration)[0] || null;
}

function failureRange(failure, key = 'rendered_source_range') {
  const value = failure?.[key];
  if (Array.isArray(value)) return value.map(Number);
  if (value && typeof value === 'object') return [Number(value.start_sec), Number(value.end_sec)];
  return [0, 0];
}

function failureCounterpartRange(failure) {
  const value = failure?.overlapping_counterpart_range || failure?.overlapping_counterpart?.rendered_source_range;
  if (Array.isArray(value)) return value.map(Number);
  if (value && typeof value === 'object') return [Number(value.start_sec), Number(value.end_sec)];
  return failureRange(failure?.overlapping_counterpart || {});
}

function idsForFailureSide(failure, side = 'primary') {
  const source = side === 'counterpart' ? (failure?.overlapping_counterpart || {}) : failure;
  const rawIds = side === 'counterpart'
    ? [failure?.overlapping_counterpart_id, source.physical_segment_id, source.slot_id]
    : [failure?.physical_segment_id, failure?.slot_id];
  return new Set(rawIds
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .flatMap((value) => [value, value.replace(/^(ko|ja)_/, ''), value.replace(/_L\d+.*$/, '')]));
}

function placementMatchesIds(placement, ids) {
  const placementIds = [placement?.clip_id, placement?.slot_id]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .flatMap((value) => [value, value.replace(/^(ko|ja)_/, ''), value.replace(/_L\d+.*$/, '')]);
  return placementIds.some((id) => ids.has(id));
}

function repairDraftSpecForHybridSourceValidation(draftSpec, hybridReport = {}, baseDraftInput = {}) {
  const next = cloneJson(draftSpec);
  const placements = Array.isArray(next?.clip_placement) ? next.clip_placement : [];
  const failures = Array.isArray(hybridReport?.failures)
    ? hybridReport.failures
    : [...(hybridReport?.rendered_failures || []), ...(hybridReport?.planned_failures || [])];
  const sourceDurationSec = inferSourceDurationSec(baseDraftInput, next);
  const protectedDialogueRanges = failures.flatMap((failure) => {
    const ranges = [];
    const primaryIsDialogue = ['dialogue', 'dialogue_quote'].includes(String(failure?.dialogue_or_narration || failure?.segment_kind || ''));
    const counterpart = failure?.overlapping_counterpart || {};
    const counterpartIsDialogue = ['dialogue', 'dialogue_quote'].includes(String(counterpart?.dialogue_or_narration || counterpart?.segment_kind || failure?.overlapping_counterpart_kind || ''));
    if (primaryIsDialogue) ranges.push(failureRange(failure));
    if (counterpartIsDialogue) ranges.push(failureCounterpartRange(failure));
    return ranges.filter((range) => rangeDuration(range) > 0);
  });
  const repairNotes = [];
  for (const failure of failures) {
    const primaryIds = idsForFailureSide(failure, 'primary');
    const counterpartIds = idsForFailureSide(failure, 'counterpart');
    const primaryIsNarration = String(failure?.dialogue_or_narration || '') === 'narration' || !['dialogue', 'dialogue_quote'].includes(String(failure?.segment_kind || ''));
    const counterpartKind = String(failure?.overlapping_counterpart?.dialogue_or_narration || failure?.overlapping_counterpart_kind || '');
    const counterpartIsDialogue = ['dialogue', 'dialogue_quote'].includes(counterpartKind);
    const primaryIndex = placements.findIndex((placement) => placementMatchesIds(placement, primaryIds));
    const counterpartIndex = placements.findIndex((placement) => placementMatchesIds(placement, counterpartIds));
    if (primaryIsNarration && counterpartIsDialogue && primaryIndex >= 0) {
      const placement = placements[primaryIndex];
      const sourceRange = Array.isArray(placement?.source_range) ? placement.source_range.map(Number) : failureRange(failure, 'planned_source_range');
      const duration = rangeDuration(sourceRange);
      const candidate = bestNonOverlappingGap(duration, protectedDialogueRanges, sourceDurationSec, sourceRange[0]);
      const repairedRange = candidate?.range || avoidProtectedSourceRanges(sourceRange, protectedDialogueRanges, sourceDurationSec);
      placements[primaryIndex] = {
        ...placement,
        source_range: repairedRange,
        hybrid_source_repair_reason: 'dialogue_protected_range_collision',
        hybrid_source_repair_strategy: candidate?.fullFit ? 'alternate_narration_gap' : 'alternate_gap_plus_freeze_frame',
        ...(candidate && candidate.freezePaddingSec > 0 ? { hybrid_source_repair_padding: { mode: 'freeze_frame', duration_sec: candidate.freezePaddingSec, source_advances: false } } : {})
      };
      repairNotes.push({ failure: failure.reason_code || 'HYBRID_DIALOGUE_PROTECTED_RANGE_COLLISION', target: placement.clip_id, strategy: placements[primaryIndex].hybrid_source_repair_strategy });
      continue;
    }
    if (primaryIndex >= 0 && counterpartIndex >= 0 && primaryIndex !== counterpartIndex) {
      const leftIndex = Math.min(primaryIndex, counterpartIndex);
      const rightIndex = Math.max(primaryIndex, counterpartIndex);
      const left = placements[leftIndex];
      const right = placements[rightIndex];
      const leftRange = Array.isArray(left?.source_range) ? left.source_range.map(Number) : [];
      const rightRange = Array.isArray(right?.source_range) ? right.source_range.map(Number) : [];
      const overlap = rangeOverlap(leftRange, rightRange);
      if (overlap > 0.001) {
        const nextEnd = Number((rightRange[0] - PHYSICAL_SOURCE_GAP_SEC).toFixed(3));
        if (nextEnd > leftRange[0] + 0.25) {
          const removed = Number((leftRange[1] - nextEnd).toFixed(3));
          placements[leftIndex] = {
            ...left,
            source_range: [Number(leftRange[0].toFixed(3)), nextEnd],
            hybrid_source_repair_reason: 'adjacent_source_overlap_trim_previous',
            hybrid_source_repair_padding: removed > 0 ? { mode: 'freeze_frame', duration_sec: removed, source_advances: false } : undefined
          };
          repairNotes.push({ failure: failure.reason_code || 'HYBRID_ACTUAL_SOURCE_OVERLAP', target: left.clip_id, strategy: 'trim_previous_and_freeze_padding' });
        }
      }
    }
  }
  next.clip_placement = placements;
  next.shot_duration = placements.map((placement) => ({
    clip_id: placement.clip_id,
    duration_sec: Number(rangeDuration(placement.source_range).toFixed(3))
  }));
  next.hybrid_source_repair = {
    applied: repairNotes.length > 0,
    notes: repairNotes
  };
  return next;
}

function isHybridSourceValidationError(error) {
  return String(error?.message || error || '').includes('MIDFORM_HYBRID_SOURCE_VALIDATION_FAILED');
}

function readHybridSourceFailureReport(workspaceDir, locale) {
  const reportPath = path.join(workspaceDir, `draft_${locale}`, 'hybrid_source_validation_failed.json');
  if (!fs.existsSync(reportPath)) return null;
  return { reportPath, report: readJson(reportPath) };
}

function effectiveDialogueProtectedRanges(baseSegments, bySlot, fallbackBySlot, occurrenceCounts, occurrenceDurations, dialogueParentAtoms, locale) {
  const ranges = [];
  const occurrenceIndexes = new Map();
  const occurrenceOffsets = new Map();
  for (const segment of baseSegments) {
    if (!isDialogueSegment(segment)) continue;
    const segmentId = String(segment?.segment_id || '');
    const parentSlotId = String(segment?.parent_slot_id || '').trim();
    const slotKey = slotKeyForSegment(segment);
    const placementKey = bySlot.has(segmentId) ? segmentId : (parentSlotId && bySlot.has(parentSlotId) ? parentSlotId : (fallbackBySlot.has(slotKey) ? slotKey : ''));
    const placement = placementKey ? (bySlot.get(placementKey) || fallbackBySlot.get(placementKey)) : null;
    const dialogueComposition = dialogueParentCompositionForSegment(segment, placement, locale, dialogueParentAtoms);
    if (!placement || dialogueComposition?.omit) continue;
    const occurrenceIndex = occurrenceIndexes.get(placementKey) || 0;
    occurrenceIndexes.set(placementKey, occurrenceIndex + 1);
    const durationSec = Number((occurrenceDurations.get(placementKey) || [])[occurrenceIndex] || 0);
    const offsetSec = Number(occurrenceOffsets.get(placementKey) || 0);
    if (durationSec > 0) occurrenceOffsets.set(placementKey, offsetSec + durationSec);
    const atomRange = dialogueComposition?.atom?.source_range;
    const effectiveRange = locale === 'ja' && rangeDuration(atomRange) > 0
      ? atomRange
      : durationSec > 0
      ? splitSourceRangeForDuration(placement.source_range, offsetSec, durationSec)
      : splitSourceRangeForOccurrence(placement.source_range, occurrenceIndex, occurrenceCounts.get(placementKey) || 1);
    if (rangeDuration(effectiveRange) > 0) ranges.push(effectiveRange);
  }
  return ranges;
}

function compareDialogueParentCompositions(koInput, jaInput) {
  const byLocale = { ko: koInput, ja: jaInput };
  const groups = {};
  for (const [locale, input] of Object.entries(byLocale)) {
    for (const segment of Array.isArray(input?.segments) ? input.segments : []) {
      if (!segment?.dialogue_parent_atom) continue;
      const slotId = String(segment.dialogue_parent_atom.slot_id || segment.parent_slot_id || '').trim();
      if (!slotId) continue;
      groups[slotId] ||= { ko: [], ja: [] };
      groups[slotId][locale].push(segment.dialogue_parent_atom);
    }
  }
  const reports = Object.entries(groups).map(([slotId, chains]) => {
    const koIds = chains.ko.map((atom) => atom.atomic_id);
    const jaIds = chains.ja.map((atom) => atom.atomic_id);
    const shared = koIds.filter((id) => jaIds.includes(id));
    let longestChain = 0;
    let sharedDuration = 0;
    for (let i = 0; i < chains.ko.length; i += 1) {
      for (let j = 0; j < chains.ja.length; j += 1) {
        let k = 0;
        let duration = 0;
        while (chains.ko[i + k] && chains.ja[j + k] && chains.ko[i + k].atomic_id === chains.ja[j + k].atomic_id) {
          duration += Number(chains.ko[i + k].duration_sec || 0);
          k += 1;
        }
        longestChain = Math.max(longestChain, k);
        sharedDuration = Math.max(sharedDuration, duration);
      }
    }
    const requiredSharedOrder = shared.filter((id) => chains.ko.find((atom) => atom.atomic_id === id)?.is_required);
    const failed = [];
    if (requiredSharedOrder.length >= 2 && longestChain >= 2) failed.push('identical_required_anchor_chain');
    if (sharedDuration > 6) failed.push('parent_shared_contiguous_duration');
    return {
      slot_id: slotId,
      slot_kind: 'dialogue_heavy',
      shared_atomic_ratio: Number((shared.length / Math.max(1, Math.max(koIds.length, jaIds.length))).toFixed(3)),
      longest_shared_atomic_chain: longestChain,
      shared_contiguous_duration_sec: Number(sharedDuration.toFixed(3)),
      identical_required_anchor_chain: requiredSharedOrder.length >= 2 && longestChain >= 2,
      child_order_similarity: Number((longestChain / Math.max(1, Math.max(koIds.length, jaIds.length))).toFixed(3)),
      failed,
      status: failed.length ? 'fail' : 'pass',
      ko_atomic_chain: koIds,
      ja_atomic_chain: jaIds
    };
  });
  return {
    status: reports.some((report) => report.status === 'fail') ? 'fail' : 'pass',
    reports
  };
}

function applyDraftSpecToSegment(segment, placement, occurrence = {}) {
  const sourceRange = Array.isArray(occurrence.atomicSourceRange) && rangeDuration(occurrence.atomicSourceRange) > 0
    ? occurrence.atomicSourceRange
    : Number(occurrence.durationSec || 0) > 0
    ? splitSourceRangeForDuration(placement.source_range, occurrence.offsetSec || 0, occurrence.durationSec)
    : splitSourceRangeForOccurrence(placement.source_range, occurrence.index || 0, occurrence.count || 1);
  const segmentType = String(segment?.segment_type || '').trim();
  const isDialogue = ['dialogue_quote', 'dialogue'].includes(segmentType);
  const dialogueProvenance = isDialogue ? dialogueSpeakerProvenance(segment) : {};
  const uniqueClipId = `${placement.clip_id || segment.segment_id}_${segment.segment_id || 'segment'}_locale_clip`;
  const sourceScene = {
    clip_id: uniqueClipId,
    scene_id: `${placement.visual_role || 'locale'}_${placement.clip_id || segment.segment_id}`,
    start: secondsToTimecode(sourceRange[0]),
    end: secondsToTimecode(sourceRange[1]),
    speed_multiplier: 1
  };
  return {
    ...segment,
    ...(isDialogue ? dialogueProvenance : {}),
    locale_source_override: true,
    locale_clip_id: placement.clip_id || '',
    locale_source_subrange_index: Number(occurrence.index || 0),
    locale_source_subrange_count: Number(occurrence.count || 1),
    ...(placement.dialogue_protected_range_avoidance ? { dialogue_protected_range_avoidance: true } : {}),
    ...(occurrence.dialogueParentAtom ? {
      dialogue_parent_atom: occurrence.dialogueParentAtom,
      dialogue_parent_recomposition: occurrence.dialogueParentRecomposition || null
    } : {}),
    combined_segment_ids: [],
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
      source_range_hint: [sourceRange[0], sourceRange[1]]
    }
  };
}

function buildLocaleDraftInput(baseDraftInput, draftSpec, locale) {
  const bySlot = placementBySlot(draftSpec);
  const orderBySlot = placementOrderBySlot(draftSpec);
  const baseSegments = Array.isArray(baseDraftInput?.segments) ? baseDraftInput.segments : [];
  const fallbackBySlot = buildFallbackPlacementBySlot(baseSegments, Array.isArray(draftSpec?.clip_placement) ? draftSpec.clip_placement : []);
  const fallbackOrderBySlot = new Map([...fallbackBySlot.keys()].map((slotKey, index) => [slotKey, index]));
  const dialogueParentAtoms = buildDialogueParentAtomMap(baseSegments);
  const sourceDurationSec = inferSourceDurationSec(baseDraftInput, draftSpec);
  const occurrenceCounts = new Map();
  const occurrenceDurations = new Map();
  for (const segment of baseSegments) {
    const segmentId = String(segment?.segment_id || '');
    const parentSlotId = String(segment?.parent_slot_id || '').trim();
    const slotKey = slotKeyForSegment(segment);
    const matchedKey = bySlot.has(segmentId) ? segmentId : (parentSlotId && bySlot.has(parentSlotId) ? parentSlotId : (fallbackBySlot.has(slotKey) ? slotKey : ''));
    if (matchedKey) {
      occurrenceCounts.set(matchedKey, (occurrenceCounts.get(matchedKey) || 0) + 1);
      const durations = occurrenceDurations.get(matchedKey) || [];
      durations.push(dialogueSourceDurationRequirement(segment));
      occurrenceDurations.set(matchedKey, durations);
    }
  }
  const canonicalDialogueRanges = [...dialogueParentAtoms.values()]
    .flatMap((atoms) => composeDialogueParentAtoms(atoms, locale).atoms)
    .map((atom) => atom.source_range)
    .filter((range) => rangeDuration(range) > 0);
  const protectedDialogueRanges = [
    ...effectiveDialogueProtectedRanges(baseSegments, bySlot, fallbackBySlot, occurrenceCounts, occurrenceDurations, dialogueParentAtoms, locale),
    ...canonicalDialogueRanges
  ];
  const occurrenceIndexes = new Map();
  const occurrenceOffsets = new Map();
  const assignedSourceRanges = [...protectedDialogueRanges];
  const segments = (Array.isArray(baseDraftInput?.segments) ? baseDraftInput.segments : []).map((segment, originalIndex) => {
    const segmentId = String(segment?.segment_id || '');
    const parentSlotId = String(segment?.parent_slot_id || '').trim();
    const slotKey = slotKeyForSegment(segment);
    const placementKey = bySlot.has(segmentId) ? segmentId : (parentSlotId && bySlot.has(parentSlotId) ? parentSlotId : (fallbackBySlot.has(slotKey) ? slotKey : ''));
    const rawPlacement = placementKey ? (bySlot.get(placementKey) || fallbackBySlot.get(placementKey)) : null;
    const placement = rawPlacement && !isDialogueSegment(segment)
      ? {
          ...rawPlacement,
          source_range: avoidProtectedSourceRanges(rawPlacement.source_range, assignedSourceRanges, sourceDurationSec),
          dialogue_protected_range_avoidance: true
        }
      : rawPlacement;
    if (placement && !isDialogueSegment(segment) && rangeDuration(placement.source_range) > 0) {
      assignedSourceRanges.push(placement.source_range);
      assignedSourceRanges.sort((left, right) => Number(left?.[0] || 0) - Number(right?.[0] || 0));
    }
    const dialogueComposition = dialogueParentCompositionForSegment(segment, placement, locale, dialogueParentAtoms);
    if (dialogueComposition?.omit) {
      return {
        ...segment,
        locale_original_order: originalIndex,
        locale_draft_order: 1_000_000 + originalIndex,
        locale_omitted_optional_dialogue_atom: true,
        dialogue_parent_atom: dialogueComposition.atom,
        dialogue_parent_recomposition: {
          slot_id: slotKey,
          locale,
          strategy: dialogueComposition.composition.strategy,
          removed_optional_atoms: dialogueComposition.composition.removed.map((atom) => atom.atomic_id)
        }
      };
    }
    const occurrenceIndex = placementKey ? (occurrenceIndexes.get(placementKey) || 0) : 0;
    if (placementKey) occurrenceIndexes.set(placementKey, occurrenceIndex + 1);
    const durationSec = placementKey ? Number((occurrenceDurations.get(placementKey) || [])[occurrenceIndex] || 0) : 0;
    const offsetSec = placementKey ? Number(occurrenceOffsets.get(placementKey) || 0) : 0;
    if (placementKey && durationSec > 0) occurrenceOffsets.set(placementKey, offsetSec + durationSec);
    const draftOrder = orderBySlot.has(slotKey) ? orderBySlot.get(slotKey) : (fallbackOrderBySlot.has(slotKey) ? fallbackOrderBySlot.get(slotKey) : originalIndex + 10_000);
    const atom = dialogueComposition?.atom || null;
    const atomOrderBonus = locale === 'ja' && atom ? (atom.is_required ? 0 : 100) : 0;
    return {
      ...(placement ? applyDraftSpecToSegment(segment, placement, {
        index: occurrenceIndex,
        count: occurrenceCounts.get(placementKey) || 1,
        durationSec,
        offsetSec,
        atomicSourceRange: locale === 'ja' ? atom?.source_range : null,
        dialogueParentAtom: atom,
        dialogueParentRecomposition: atom ? {
          slot_id: slotKey,
          locale,
          strategy: dialogueComposition.composition.strategy,
          retained_required_atoms: dialogueComposition.composition.atoms.filter((item) => item.is_required).map((item) => item.atomic_id),
          removed_optional_atoms: dialogueComposition.composition.removed.map((item) => item.atomic_id)
        } : null
      }) : { ...segment }),
      locale_original_order: originalIndex,
      locale_draft_order: draftOrder + atomOrderBonus
    };
  })
    .filter((segment) => !segment.locale_omitted_optional_dialogue_atom)
    .sort((left, right) => Number(left.locale_draft_order || 0) - Number(right.locale_draft_order || 0) || Number(left.locale_original_order || 0) - Number(right.locale_original_order || 0));
  const segmentById = new Map(segments.map((segment) => [String(segment?.segment_id || ''), segment]));
  const segmentOrder = new Map(segments.map((segment, index) => [String(segment?.segment_id || ''), index]));
  const captionUnits = (Array.isArray(baseDraftInput?.captionUnits) ? baseDraftInput.captionUnits : [])
    .filter((unit) => segmentById.has(String(unit?.segment_id || '')))
    .map((unit, originalIndex) => {
    const segment = segmentById.get(String(unit?.segment_id || '')) || {};
    const metadata = buildSpeakerMetadata(unit, segment);
    const next = { ...unit, ...metadata, locale_original_order: originalIndex, locale_draft_order: segmentOrder.get(String(unit?.segment_id || '')) ?? originalIndex + 10_000 };
    if (segment.locale_source_override) {
      next.locale_source_override = true;
      next.combined_segment_ids = [];
    }
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
  const baseDraftInput = baseDraftInputWithActualSourceDuration(readJson(baseDraftInputPath), sourceVideoPath);
  const localeResults = {};
  const localeDraftInputs = {};
  const outputPaths = {};
  const draftSpecs = Object.fromEntries(LOCALES.map((locale) => [locale, readJson(path.join(workspaceDir, `draft_spec.${locale}.json`))]));
  const renderLocale = async (locale, draftSpec, attempt = 0, options = {}) => {
    const normalizedDraftSpec = normalizeDraftSpecSourceRanges(draftSpec, baseDraftInput);
    draftSpecs[locale] = normalizedDraftSpec;
    writeJson(path.join(workspaceDir, `draft_spec.${locale}.json`), normalizedDraftSpec);
    const localeDraftInput = buildLocaleDraftInput(baseDraftInput, normalizedDraftSpec, locale);
    localeDraftInput.finalDraftReplanAttempt = attempt;
    localeDraftInputs[locale] = localeDraftInput;
    const draftInputPath = path.join(workspaceDir, `draft_input.${locale}.json`);
    writeJson(draftInputPath, localeDraftInput);
    let generated;
    try {
      generated = await draftGenerator(locale, localeDraftInput, workspaceDir, sourceVideoPath, transcriptPath);
    } catch (error) {
      const failure = readHybridSourceFailureReport(workspaceDir, locale);
      if (options.hybridSourceRepairAttempt || !isHybridSourceValidationError(error) || !failure?.report) throw error;
      const repairedDraftSpec = repairDraftSpecForHybridSourceValidation(normalizedDraftSpec, failure.report, baseDraftInput);
      if (!repairedDraftSpec?.hybrid_source_repair?.applied) throw error;
      outputPaths[`hybrid_source_validation_failed_${locale}`] = rel(failure.reportPath);
      outputPaths[`hybrid_source_repair_${locale}`] = 'applied';
      return renderLocale(locale, repairedDraftSpec, attempt, { hybridSourceRepairAttempt: true });
    }
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
  while (finalOverlapReport.final_status === 'failed' && replanAttempts < MAX_FINAL_DRAFT_REPLAN_ATTEMPTS) {
    replanAttempts += 1;
    draftSpecs.ja = replanJaDraftSpecForFinalOverlap(draftSpecs.ja, finalOverlapReport, replanAttempts, baseDraftInput);
    writeJson(path.join(workspaceDir, 'draft_spec.ja.json'), draftSpecs.ja);
    await renderLocale('ja', draftSpecs.ja, replanAttempts);
    finalOverlapReport = compareFinalDraftFiles(localeResults.ko.draft_content_path, localeResults.ja.draft_content_path);
  }
  finalOverlapReport = {
    ...finalOverlapReport,
    dialogue_parent_overlap: compareDialogueParentCompositions(localeDraftInputs.ko, localeDraftInputs.ja),
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
  compareDialogueParentCompositions,
  generateLocaleDraftFromInput,
  generateLocaleDraftArtifacts,
  normalizeDraftSpecSourceRanges,
  placementBySlot,
  placementOrderBySlot,
  repairDraftSpecForHybridSourceValidation,
  replanJaDraftSpecForFinalOverlap,
  secondsToTimecode,
  _test: {
    buildDialogueParentAtomMap,
    cloneJson,
    composeDialogueParentAtoms,
    repairDraftSpecForHybridSourceValidation,
    normalizeDraftSpecSourceRanges,
    shiftedSourceRange,
    splitSourceRangeForOccurrence
  }
};

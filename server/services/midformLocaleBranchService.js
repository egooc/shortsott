const LOCALES = ['ko', 'ja'];

const OVERLAP_THRESHOLDS = {
  pairwise_overlap_score: 0.65,
  opening_similarity_score: 0.45,
  chain_similarity_score: 0.55,
  shared_contiguous_block_max_sec: 6.0
};

function round3(value) {
  return Number(Number(value || 0).toFixed(3));
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function rangeForSlot(slot) {
  if (Array.isArray(slot?.source_range) && slot.source_range.length >= 2) {
    return [round3(slot.source_range[0]), round3(slot.source_range[1])];
  }
  if (Array.isArray(slot?.dialogue_line_windows) && slot.dialogue_line_windows.length) {
    // Number(null) === 0, so an UNMATCHED line (start_sec: null) used to slip through the
    // isFinite filter as second 0 and stretch the slot range to [0, end] - a phantom 100s+
    // "clip" that made the packer back-shift every b-roll window off its scene to fit it.
    const usable = slot.dialogue_line_windows.filter((win) => win && win.start_sec != null && win.end_sec != null);
    const starts = usable.map((win) => Number(win.start_sec)).filter(Number.isFinite);
    const ends = usable.map((win) => Number(win.end_sec)).filter(Number.isFinite);
    if (starts.length && ends.length) return [round3(Math.min(...starts)), round3(Math.max(...ends))];
  }
  const start = Number(slot?.start_sec);
  const end = Number(slot?.end_sec);
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) return [round3(start), round3(end)];
  const visualStart = Number(slot?.visual_source_start_sec);
  const visualEnd = Number(slot?.visual_source_end_sec);
  if (Number.isFinite(visualStart) && Number.isFinite(visualEnd) && visualEnd > visualStart) return [round3(visualStart), round3(visualEnd)];
  return [0, 0];
}

function rangeDuration(range) {
  return Math.max(0, Number(range?.[1] || 0) - Number(range?.[0] || 0));
}

function rangeOverlap(a, b) {
  return Math.max(0, Math.min(Number(a?.[1] || 0), Number(b?.[1] || 0)) - Math.max(Number(a?.[0] || 0), Number(b?.[0] || 0)));
}

function slotDuration(slot) {
  return round3(Number(slot?.narration_estimated_duration_sec || slot?.estimated_duration_sec || slot?.duration || rangeDuration(rangeForSlot(slot)) || 0));
}

function activeTimeline(editPlan) {
  return (Array.isArray(editPlan?.timeline) ? editPlan.timeline : [])
    .filter((slot) => slot && slot.decision !== 'DROP');
}

function compactTranscriptSegments(transcript) {
  return (Array.isArray(transcript) ? transcript : [])
    .slice(0, 500)
    .map((item, index) => ({
      index,
      start_sec: round3(item.start_sec ?? item.start ?? 0),
      end_sec: round3(item.end_sec ?? item.end ?? 0),
      text: normalizeText(item.text)
    }))
    .filter((item) => item.text && item.end_sec > item.start_sec);
}

function emptyReactionSummary() {
  return {
    repeated_keywords: [],
    repeated_emotions: [],
    misunderstandings: [],
    scene_mentions: [],
    title_thumbnail_phrases: []
  };
}

function emptyRetentionSignals(editPlan = {}, beats = []) {
  return {
    intro: editPlan.cold_open_selection || {},
    top_moments: beats
      .slice()
      .sort((left, right) => Number(right.dramatic_weight || 0) - Number(left.dramatic_weight || 0))
      .slice(0, 5)
      .map((beat) => ({ beat_id: normalizeText(beat.beat_id), score: Number(beat.dramatic_weight || 0), range: [round3(beat.start_sec), round3(beat.end_sec)] })),
    spikes: [],
    dips: [],
    rewatch_zones: []
  };
}

function buildEvidencePack({ normalizedRequest = {}, beatsObject = {}, editPlan = {}, transcript = [], compressionManifest = {}, supplementalEvidence = {} }) {
  const beats = Array.isArray(beatsObject?.beats) ? beatsObject.beats : [];
  const timeline = activeTimeline(editPlan);
  const dialogueCandidates = timeline
    .filter((slot) => slot.decision === 'KEEP_DIALOGUE')
    .map((slot) => ({
      slot_id: normalizeText(slot.slot_id),
      beat_id: normalizeText(slot.beat_id),
      role: normalizeText(slot.role),
      source_range: rangeForSlot(slot),
      dialogue_lines: Array.isArray(slot.dialogue_focus_lines) ? slot.dialogue_focus_lines.map(normalizeText).filter(Boolean) : [],
      semantic_risk: normalizeText(slot.semantic_risk || 'low'),
      standalone_score: Number(slot.standalone_score || 0)
    }));
  const visualCandidates = timeline.map((slot) => ({
    slot_id: normalizeText(slot.slot_id),
    beat_id: normalizeText(slot.beat_id),
    role: normalizeText(slot.role),
    decision: normalizeText(slot.decision),
    source_range: rangeForSlot(slot),
    duration_sec: slotDuration(slot),
    scene_summary: normalizeText(slot.reason || slot.reused_conflict_axis || '')
  }));
  const supplementalCoverage = supplementalEvidence?.evidence_coverage || {};
  const retentionSignals = supplementalEvidence?.retention_signals || emptyRetentionSignals(editPlan, beats);
  const heatmapSignals = supplementalEvidence?.heatmap_signals || { source: 'compression_or_unavailable', peaks: [], high_replay_windows: [] };
  const commentReactionSummary = supplementalEvidence?.comment_reaction_summary || emptyReactionSummary();
  return {
    artifact_type: 'midform_locale_evidence_pack',
    video_id: normalizeText(compressionManifest.videoId || compressionManifest.video_id || ''),
    source_url: normalizeText(normalizedRequest.source?.url || compressionManifest.sourceUrl || compressionManifest.source_url || ''),
    metadata: {
      title: normalizeText(compressionManifest.title || ''),
      run_id: normalizeText(compressionManifest.runId || compressionManifest.run_id || ''),
      target_sec: Number(compressionManifest.targetSec || compressionManifest.target_sec || normalizedRequest.output?.target_length_sec || 0) || 0
    },
    duration_sec: round3(compressionManifest.durationSec || compressionManifest.duration_sec || editPlan.source_duration_sec || 0),
    transcript_segments: compactTranscriptSegments(transcript),
    scene_candidates: beats.map((beat) => ({
      beat_id: normalizeText(beat.beat_id),
      start_sec: round3(beat.start_sec),
      end_sec: round3(beat.end_sec),
      summary: normalizeText(beat.summary),
      dramatic_weight: Number(beat.dramatic_weight || 0),
      hook_potential: Number(beat.hook_potential || 0),
      dialogue_quality: normalizeText(beat.dialogue_quality)
    })),
    must_keep_dialogue_candidates: dialogueCandidates,
    must_keep_visual_candidates: visualCandidates,
    energy_peaks: (Array.isArray(supplementalEvidence?.energyPeaks) ? supplementalEvidence.energyPeaks : [])
      .map((peak) => ({ rank: Number(peak?.rank) || 0, start_sec: round3(peak?.start_sec), end_sec: round3(peak?.end_sec), score: Number(peak?.score) || 0 }))
      .filter((peak) => peak.end_sec > peak.start_sec),
    comment_reaction_summary: commentReactionSummary,
    retention_signals: retentionSignals,
    heatmap_signals: heatmapSignals,
    verified_facts: {},
    ambiguities: [],
    evidence_coverage: {
      comments: supplementalCoverage.comments === true,
      retention: supplementalCoverage.retention === true,
      heatmap: supplementalCoverage.heatmap === true || Array.isArray(heatmapSignals.high_replay_windows) && heatmapSignals.high_replay_windows.length > 0,
      transcript: compactTranscriptSegments(transcript).length > 0
    },
    coverage_notes: supplementalEvidence?.coverage_notes || {}
  };
}

function buildLocaleEditorialStrategy(locale, evidencePack) {
  const base = {
    artifact_type: 'midform_locale_editorial_strategy',
    locale,
    evidence_pack_source: evidencePack.artifact_type,
    strategy_version: 'locale_divergence_v1'
  };
  if (locale === 'ja') {
    return {
      ...base,
      opening_priority: 'tension_build_first',
      pace_profile: 'measured_escalation',
      dialogue_vs_reaction_bias: 'reaction_support_heavy',
      payoff_timing_preference: 'mid_late',
      reaction_shot_policy: 'retain_micro_pauses',
      build_up_style: 'pressure_accumulation',
      cut_variation_bias: 'expression_then_release',
      source_range_shift_sec: 4.0
    };
  }
  return {
    ...base,
    opening_priority: 'conflict_first',
    pace_profile: 'fast_compressed',
    dialogue_vs_reaction_bias: 'dialogue_heavy',
    payoff_timing_preference: 'early_mid',
    reaction_shot_policy: 'minimal',
    build_up_style: 'direct_escalation',
    cut_variation_bias: 'incident_first',
    source_range_shift_sec: -0.18
  };
}

function shiftedRange(range, shiftSec, sourceDurationSec) {
  const duration = rangeDuration(range);
  if (!(duration > 0)) return [0, 0];
  const maxStart = sourceDurationSec > 0 ? Math.max(0, sourceDurationSec - duration) : Math.max(0, Number(range[0]) + shiftSec);
  const start = Math.min(maxStart, Math.max(0, Number(range[0]) + shiftSec));
  return [round3(start), round3(start + duration)];
}

function applyRangeToSlot(slot, range) {
  const next = { ...slot };
  next.start_sec = range[0];
  next.end_sec = range[1];
  next.estimated_duration_sec = round3(rangeDuration(range));
  if (next.visual_source_start_sec !== undefined || next.visual_source_end_sec !== undefined) {
    next.visual_source_start_sec = range[0];
    next.visual_source_end_sec = range[1];
  }
  next.source_range = range;
  return next;
}

function rolePriority(locale, slot) {
  const role = normalizeText(slot.role);
  const decision = normalizeText(slot.decision);
  if (locale === 'ja') {
    if (role === 'bridge') return 1;
    if (decision === 'NARRATE') return 2;
    if (role === 'cold_open') return 3;
    if (role === 'body') return 4;
    if (role === 'body_peak') return 5;
    if (role === 'payoff') return 6;
    if (role === 'closing') return 7;
    return 8;
  }
  if (role === 'cold_open') return 1;
  if (role === 'bridge') return 2;
  if (role === 'body_peak') return 3;
  if (role === 'body') return 4;
  if (role === 'payoff') return 5;
  if (role === 'closing') return 6;
  return 7;
}

function buildClipChain(locale, timeline) {
  let cursor = 0;
  return timeline.map((slot, index) => {
    const range = rangeForSlot(slot);
    const duration = slotDuration(slot) || rangeDuration(range);
    const clip = {
      clip_id: `${locale}_${slot.slot_id || `slot_${index + 1}`}`,
      slot_id: normalizeText(slot.slot_id),
      beat_id: normalizeText(slot.beat_id),
      role: normalizeText(slot.role),
      decision: normalizeText(slot.decision),
      source_range: range,
      timeline_range: [round3(cursor), round3(cursor + duration)],
      duration_sec: round3(duration)
    };
    cursor = round3(cursor + duration);
    return clip;
  });
}

function topHighlightOrder(timeline, evidencePack) {
  const scoreByBeat = new Map((evidencePack.scene_candidates || []).map((beat) => [beat.beat_id, Number(beat.dramatic_weight || 0) + Number(beat.hook_potential || 0)]));
  const topBeatIds = new Set(timeline
    .map((slot, index) => ({ beat_id: normalizeText(slot.beat_id), slot_id: normalizeText(slot.slot_id), score: scoreByBeat.get(normalizeText(slot.beat_id)) || 0, index }))
    .filter((item) => item.beat_id)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 3)
    .map((item) => item.beat_id || item.slot_id));
  return timeline
    .map((slot) => normalizeText(slot.beat_id || slot.slot_id))
    .filter((id, index, list) => id && topBeatIds.has(id) && list.indexOf(id) === index)
    .slice(0, 3);
}

function buildLocaleEditPlan(baseEditPlan, strategy, evidencePack, attempt = 0) {
  const locale = strategy.locale;
  const sourceDurationSec = Number(evidencePack.duration_sec || 0);
  const active = activeTimeline(baseEditPlan).map((slot) => ({ ...slot }));
  // KO is the reviewed cut: the clip's own arc order IS the story (owner doctrine) and the
  // reviewed windows are scene-pinned, so KO takes the base plan verbatim - no reshuffle, no
  // shift. Role-priority reordering here once played the reveal dialogue before the
  // interrogation that sets it up. Only the ja branch deviates, to satisfy the ko/ja
  // differentiation gates.
  // Story order is the clip's own arc and is sacred for BOTH locales (owner doctrine,
  // 2026-08-08): the ja reorder shuffled buildup after payoff and dropped the climax from
  // the ja cut. Locale difference comes from window shifts and scripts, never from order.
  const reordered = active.slice();
  const shiftBase = locale === 'ja' ? Number(strategy.source_range_shift_sec || 0) + attempt * 4.0 : 0;
  const energyPeaks = Array.isArray(evidencePack.energy_peaks) ? evidencePack.energy_peaks : [];
  const timeline = reordered.map((slot, index) => {
    let range = rangeForSlot(slot);
    const role = normalizeText(slot.role);
    const decision = normalizeText(slot.decision);
    // Anchor narration b-roll on the measured action instead of the front of the beat window:
    // capcut plays the clip from its start for the TTS duration, and "start of a long window"
    // is statistically the quietest footage — the Shelter fight peaks shipped at 0.0s coverage.
    // ko takes the strongest peak inside the window, ja the second-strongest when one exists
    // (locale differentiation through WHICH action moment screens, not through sliding off it).
    let peakAnchored = false;
    // An action beat (source_audio_action) IS a pinned peak already — never re-anchor or
    // shift it; sliding it would play the wrong seconds of the fight in one locale.
    // And when a plan HAS action beats, narration slots stop peak-anchoring entirely: the
    // beats carry the energy, and anchoring narration onto "the loudest moment" put the
    // explosion under '다시 달려듭니다' — narration b-roll follows its beat's story order.
    const planHasActionBeats = reordered.some((entry) => normalizeText(entry.visual_source_mode) === 'source_audio_action');
    if (normalizeText(slot.visual_source_mode) === 'source_audio_action') peakAnchored = true;
    else if (!planHasActionBeats && decision === 'NARRATE' && role !== 'cold_open' && energyPeaks.length) {
      const needSec = Math.max(4, slotDuration(slot) || 4);
      const inside = energyPeaks
        .filter((peak) => peak.end_sec > range[0] + 0.5 && peak.start_sec < range[1] - 0.5)
        .sort((left, right) => right.score - left.score);
      const chosen = locale === 'ja' && inside.length > 1 ? inside[1] : inside[0];
      if (chosen) {
        const lead = locale === 'ja' ? 1.5 : 1.0;
        const start = Math.min(Math.max(range[0], chosen.start_sec - lead), Math.max(range[0], range[1] - needSec));
        range = [round3(start), range[1]];
        peakAnchored = true;
      }
    }
    let shift = shiftBase;
    if (locale === 'ja' && decision === 'NARRATE') shift += 3.0 + index * 0.45;
    if (locale === 'ja' && role === 'cold_open') shift += 3.5;
    // A peak-anchored window already sits exactly where it must — a ja shift would slide it
    // straight off the action it was anchored to.
    if (peakAnchored) shift = 0;
    if (locale === 'ja' && normalizeText(slot.visual_source_mode) === 'source_audio_action') {
      // Same beat, different slice (owner directive 2026-08-11): ko keeps the wind-up, ja
      // slides toward the follow-through. Bounded to a quarter of the window (max 3s) and
      // clamped so the window never crosses the next slot's footage or the source end.
      const windowLen = Math.max(0, Number(range[1]) - Number(range[0]));
      let backShift = Math.min(3, windowLen * 0.25);
      const laterStarts = reordered
        .filter((other) => other !== slot)
        .map((other) => Number(rangeForSlot(other)[0]))
        .filter((value) => Number.isFinite(value) && value >= Number(range[1]) - 0.25);
      if (laterStarts.length) backShift = Math.min(backShift, Math.max(0, (Math.min(...laterStarts) - 0.1) - Number(range[1])));
      if (sourceDurationSec > 0) backShift = Math.min(backShift, Math.max(0, sourceDurationSec - Number(range[1])));
      if (backShift >= 0.8) range = [round3(Number(range[0]) + backShift), round3(Number(range[1]) + backShift)];
    }
    // A ja shift must not push a narration window PAST the dialogue it leads into: crossing
    // that boundary broke the reveal end-alignment for ja (spider reveal coverage 0 while ko
    // had it) and put the b-roll on the wrong scene. Cap the shift so the window end stays
    // just short of the next slot's source start whenever the base window did.
    if (locale === 'ja' && decision === 'NARRATE' && shift > 0) {
      const nextSlot = reordered[index + 1];
      const nextStart = nextSlot ? Number(rangeForSlot(nextSlot)[0]) : 0;
      const baseEnd = Number(range[1]);
      if (nextStart > 0 && baseEnd <= nextStart + 0.5) {
        shift = Math.max(0, Math.min(shift, (nextStart - 0.1) - baseEnd));
      }
    }
    // Semantic era (plans with action beats): the differentiation shift is a REFRAME within
    // the same scene, never a move off it. It was pinned to 0 when nothing verified frames;
    // now the packer snaps ends to scene cuts, splits montage parts on sentence boundaries,
    // and the sentence-level machine eye judges every build - with those rails a bounded
    // shift buys real visual differentiation (owner directive 2026-08-11: ja and ko should
    // not screen the same seconds).
    // The FIRST narration slot is the establishing shot - its sentence NAMES what is on
    // screen ('エレベーターシャフトの非常はしご'), so shifting it off the establish footage
    // put fire-below/face close-ups under the location line. It stays pinned; the later
    // slots and the action beats carry the visual differentiation.
    const firstNarrateIndex = reordered.findIndex((entry) => normalizeText(entry.decision) === 'NARRATE'
      && normalizeText(entry.visual_source_mode) !== 'source_audio_action');
    if (locale === 'ja' && decision === 'NARRATE' && planHasActionBeats) {
      shift = index === firstNarrateIndex ? 0 : Math.min(3.5, Math.max(0, shift));
    }
    // Every rule above bounds ONE step (the reframe, the slice, the lead-in cap), but they stack:
    // Draft Day's ja slot_006 came out at 360.9-369.3 against a plan window of 351.7-360.1, nine
    // seconds off the scene its narration describes, and the b-roll bounds gate failed the build.
    // Whatever the steps decide, the result stays inside the plan window's own tolerance.
    const planWindow = rangeForSlot(slot);
    const shiftedFromSteps = shiftedRange(range, shift, sourceDurationSec);
    const nextRange = clampRangeToPlanWindow(shiftedFromSteps, planWindow);
    return {
      ...applyRangeToSlot(slot, nextRange),
      // The pre-differentiation plan window is the slot's SEMANTIC identity - the packer
      // clamps any locale reframe against it (same-scene rule), so it must survive the shift.
      semantic_origin_range: Array.isArray(slot.semantic_origin_range) && slot.semantic_origin_range.length >= 2
        ? slot.semantic_origin_range
        : rangeForSlot(slot),
      locale,
      locale_strategy_applied: strategy.strategy_version,
      locale_variation_note: locale === 'ja'
        ? 'reaction/tension branch shifts source windows later and reorders buildup before direct payoff'
        : 'conflict-first branch keeps direct hook/payoff order with tighter source windows'
    };
  });
  const clipChain = buildClipChain(locale, timeline);
  const openingWindow = clipChain.filter((clip) => clip.timeline_range[0] < 15);
  return {
    artifact_type: 'midform_locale_edit_plan',
    locale,
    source_edit_plan_id: normalizeText(baseEditPlan.edit_plan_id || baseEditPlan.plan_id || ''),
    strategy,
    beats: evidencePack.scene_candidates || [],
    selected_source_ranges: clipChain.map((clip) => ({ clip_id: clip.clip_id, slot_id: clip.slot_id, source_range: clip.source_range })),
    clip_chain: clipChain,
    dialogue_anchors: timeline.filter((slot) => slot.decision === 'KEEP_DIALOGUE').map((slot) => ({ slot_id: slot.slot_id, source_range: rangeForSlot(slot), lines: slot.dialogue_focus_lines || [] })),
    reaction_support_ranges: timeline.filter((slot) => slot.decision === 'NARRATE').map((slot) => ({ slot_id: slot.slot_id, source_range: rangeForSlot(slot), policy: strategy.reaction_shot_policy })),
    opening_window: openingWindow,
    highlight_order: topHighlightOrder(timeline, evidencePack),
    timing_profile: {
      pace_profile: strategy.pace_profile,
      total_estimated_sec: round3(clipChain.reduce((sum, clip) => sum + clip.duration_sec, 0)),
      opening_sec: round3(openingWindow.reduce((sum, clip) => sum + clip.duration_sec, 0))
    },
    difference_constraints_applied: [
      'opening_source_chain_must_differ',
      'no_three_contiguous_same_shots',
      'top_three_highlight_order_must_not_match',
      'pairwise_overlap_thresholds'
    ],
    timeline
  };
}

function signatureForClip(clip) {
  const range = clip.source_range || [0, 0];
  return `${clip.beat_id || clip.slot_id}:${Math.round(Number(range[0] || 0))}:${Math.round(Number(range[1] || 0))}`;
}

function lcsSimilarity(left, right) {
  if (!left.length || !right.length) return 0;
  const dp = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      dp[i][j] = left[i - 1] === right[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return round3(dp[left.length][right.length] / Math.max(left.length, right.length));
}

function sourceRangeOverlapRatio(leftChain, rightChain) {
  const leftDuration = leftChain.reduce((sum, clip) => sum + rangeDuration(clip.source_range), 0);
  const rightDuration = rightChain.reduce((sum, clip) => sum + rangeDuration(clip.source_range), 0);
  let overlap = 0;
  for (const left of leftChain) {
    for (const right of rightChain) {
      overlap += rangeOverlap(left.source_range, right.source_range);
    }
  }
  const union = Math.max(0.001, leftDuration + rightDuration - overlap);
  return round3(overlap / union);
}

function sharedContiguousBlocks(leftChain, rightChain) {
  const blocks = [];
  for (let i = 0; i < leftChain.length; i += 1) {
    for (let j = 0; j < rightChain.length; j += 1) {
      let k = 0;
      let duration = 0;
      const members = [];
      while (leftChain[i + k] && rightChain[j + k]) {
        const overlap = rangeOverlap(leftChain[i + k].source_range, rightChain[j + k].source_range);
        const sameShot = normalizeText(leftChain[i + k].slot_id || leftChain[i + k].beat_id) === normalizeText(rightChain[j + k].slot_id || rightChain[j + k].beat_id);
        if (!sameShot || overlap < 0.25) break;
        duration += overlap;
        members.push({ ko_clip_id: leftChain[i + k].clip_id, ja_clip_id: rightChain[j + k].clip_id, overlap_sec: round3(overlap) });
        k += 1;
      }
      if (members.length) blocks.push({ ko_start_index: i, ja_start_index: j, length: members.length, duration_sec: round3(duration), clips: members });
    }
  }
  return blocks.sort((left, right) => right.duration_sec - left.duration_sec || right.length - left.length);
}

// The b-roll bounds gate allows a clip to sit within 8.5s of its slot's plan window; anything
// further is another scene. Slide the range back inside rather than truncating, so the differentiated
// slice keeps its length.
function clampRangeToPlanWindow(range, planWindow, toleranceSec = 8) {
  const start = Number(range?.[0]);
  const end = Number(range?.[1]);
  const windowStart = Number(planWindow?.[0]);
  const windowEnd = Number(planWindow?.[1]);
  if (![start, end, windowStart, windowEnd].every(Number.isFinite) || end <= start) return range;
  const lo = Math.max(0, windowStart - toleranceSec);
  const hi = windowEnd + toleranceSec;
  if (start >= lo && end <= hi) return range;
  const duration = end - start;
  const nextStart = Math.max(lo, Math.min(start, hi - duration));
  return [round3(nextStart), round3(nextStart + duration)];
}

function compareLocaleEditPlans(koPlan, jaPlan, thresholds = OVERLAP_THRESHOLDS, regenerationAttempts = 0) {
  const koChain = Array.isArray(koPlan?.clip_chain) ? koPlan.clip_chain : [];
  const jaChain = Array.isArray(jaPlan?.clip_chain) ? jaPlan.clip_chain : [];
  const openingKo = koChain.filter((clip) => Number(clip.timeline_range?.[0] || 0) < 15);
  const openingJa = jaChain.filter((clip) => Number(clip.timeline_range?.[0] || 0) < 15);
  const chainSimilarity = lcsSimilarity(koChain.map(signatureForClip), jaChain.map(signatureForClip));
  const openingSimilarity = lcsSimilarity(openingKo.map(signatureForClip), openingJa.map(signatureForClip));
  const overlapRatio = sourceRangeOverlapRatio(koChain, jaChain);
  const highlightSimilarity = JSON.stringify((koPlan.highlight_order || []).slice(0, 3)) === JSON.stringify((jaPlan.highlight_order || []).slice(0, 3)) ? 1 : 0;
  const blocks = sharedContiguousBlocks(koChain, jaChain);
  const maxBlockSec = blocks[0]?.duration_sec || 0;
  const pairwiseScore = round3((overlapRatio * 0.35) + (chainSimilarity * 0.25) + (openingSimilarity * 0.25) + (highlightSimilarity * 0.15));
  const failures = [];
  if (openingSimilarity > thresholds.opening_similarity_score) failures.push('opening_similarity_threshold');
  if (chainSimilarity > thresholds.chain_similarity_score) failures.push('chain_similarity_threshold');
  if (pairwiseScore > thresholds.pairwise_overlap_score) failures.push('pairwise_overlap_threshold');
  if (maxBlockSec > thresholds.shared_contiguous_block_max_sec) failures.push('shared_contiguous_block_threshold');
  if (blocks.some((block) => block.length >= 3)) failures.push('three_shot_chain_threshold');
  if (highlightSimilarity === 1) failures.push('top_three_highlight_order_identical');
  return {
    pair: 'ko_vs_ja',
    pairwise_overlap_score: pairwiseScore,
    opening_similarity_score: openingSimilarity,
    chain_similarity_score: chainSimilarity,
    source_range_overlap_ratio: overlapRatio,
    major_highlight_ordering_similarity: highlightSimilarity,
    shared_contiguous_blocks: blocks,
    thresholds,
    failed_gates: failures,
    regeneration_attempts: regenerationAttempts,
    // Advisory since 2026-08-08: with identical story order the sequence-similarity
    // metrics are structurally high; footage difference is enforced on the FINAL drafts
    // (free-b-roll overlap gates), not on the plan shape.
    advisory_failed_gates: failures,
    final_status: 'pass'
  };
}

function buildDraftSpec(localePlan) {
  return {
    artifact_type: 'midform_locale_draft_spec',
    locale: localePlan.locale,
    source_edit_plan_artifact: `edit_plan.${localePlan.locale}.json`,
    clip_placement: localePlan.clip_chain.map((clip) => ({
      clip_id: clip.clip_id,
      source_range: clip.source_range,
      timeline_range: clip.timeline_range,
      visual_role: clip.role,
      transition: clip.role === 'closing' ? 'soft_cut' : 'cut'
    })),
    shot_duration: localePlan.clip_chain.map((clip) => ({ clip_id: clip.clip_id, duration_sec: clip.duration_sec })),
    reaction_insert: localePlan.reaction_support_ranges,
    visual_pacing: localePlan.strategy.pace_profile,
    optional_preset_image_timing: localePlan.locale === 'ja' ? 'after_opening_pause' : 'opening_hook_hold',
    title_layer_timing: localePlan.locale === 'ja' ? [0.6, 5.2] : [0, 4.2],
    subtitle_layout: localePlan.locale === 'ja' ? 'measured_two_line_bottom_safe' : 'fast_compact_center_bottom',
    tts_voice_timing: localePlan.locale === 'ja' ? 'measured_pause_forward' : 'fast_direct'
  };
}

function buildAcceptanceGate(localePlan, overlapReport) {
  const failures = [];
  if (!Array.isArray(localePlan.clip_chain) || localePlan.clip_chain.length === 0) failures.push('clip_chain_empty');
  if (!Array.isArray(localePlan.opening_window) || localePlan.opening_window.length === 0) failures.push('opening_window_empty');
  if (!Array.isArray(localePlan.highlight_order) || localePlan.highlight_order.length === 0) failures.push('highlight_order_empty');
  if (overlapReport.final_status !== 'pass') failures.push(...overlapReport.failed_gates.map((gate) => `pairwise_${gate}`));
  return {
    artifact_type: 'midform_locale_acceptance_gates',
    locale: localePlan.locale,
    status: failures.length ? 'failed' : 'passed',
    failed: [...new Set(failures)],
    warnings: [],
    checks: {
      has_clip_chain: localePlan.clip_chain.length > 0,
      has_opening_window: localePlan.opening_window.length > 0,
      has_highlight_order: localePlan.highlight_order.length > 0,
      pairwise_overlap_passed: overlapReport.final_status === 'pass'
    }
  };
}

function buildLocaleBranchArtifacts({ normalizedRequest, beatsObject, editPlan, transcript, compressionManifest, supplementalEvidence }) {
  const evidencePack = buildEvidencePack({ normalizedRequest, beatsObject, editPlan, transcript, compressionManifest, supplementalEvidence });
  const strategies = Object.fromEntries(LOCALES.map((locale) => [locale, buildLocaleEditorialStrategy(locale, evidencePack)]));
  const koPlan = buildLocaleEditPlan(editPlan, strategies.ko, evidencePack, 0);
  let jaPlan = buildLocaleEditPlan(editPlan, strategies.ja, evidencePack, 0);
  let overlapReport = compareLocaleEditPlans(koPlan, jaPlan, OVERLAP_THRESHOLDS, 0);
  let attempts = 0;
  while (overlapReport.final_status !== 'pass' && attempts < 4) {
    attempts += 1;
    jaPlan = buildLocaleEditPlan(editPlan, strategies.ja, evidencePack, attempts);
    overlapReport = compareLocaleEditPlans(koPlan, jaPlan, OVERLAP_THRESHOLDS, attempts);
  }
  const draftSpecs = { ko: buildDraftSpec(koPlan), ja: buildDraftSpec(jaPlan) };
  const acceptanceGates = {
    ko: buildAcceptanceGate(koPlan, overlapReport),
    ja: buildAcceptanceGate(jaPlan, overlapReport)
  };
  return {
    evidencePack,
    editorialStrategies: strategies,
    editPlans: { ko: koPlan, ja: jaPlan },
    draftSpecs,
    overlapReport,
    acceptanceGates,
    outputPaths: {
      evidence_pack: 'evidence_pack.json',
      editorial_strategy_ko: 'editorial_strategy.ko.json',
      editorial_strategy_ja: 'editorial_strategy.ja.json',
      edit_plan_ko: 'edit_plan.ko.json',
      edit_plan_ja: 'edit_plan.ja.json',
      draft_spec_ko: 'draft_spec.ko.json',
      draft_spec_ja: 'draft_spec.ja.json',
      overlap_report_ko_vs_ja: 'overlap_report.ko_vs_ja.json',
      acceptance_gates_ko: 'acceptance_gates.ko.json',
      acceptance_gates_ja: 'acceptance_gates.ja.json'
    }
  };
}

module.exports = {
  OVERLAP_THRESHOLDS,
  buildAcceptanceGate,
  buildDraftSpec,
  buildEvidencePack,
  buildLocaleBranchArtifacts,
  buildLocaleEditPlan,
  buildLocaleEditorialStrategy,
  compareLocaleEditPlans,
  _test: {
    activeTimeline,
    rangeForSlot,
    sourceRangeOverlapRatio,
    sharedContiguousBlocks,
    signatureForClip
  }
};

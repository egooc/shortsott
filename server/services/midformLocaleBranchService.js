const LOCALES = ['ko', 'ja'];

const OVERLAP_THRESHOLDS = {
  pairwise_overlap_score: 0.65,
  opening_similarity_score: 0.45,
  chain_similarity_score: 0.55,
  shared_contiguous_block_max_sec: 6.0,
  clone_tolerance_sec: 0.05
};

const MAX_LOCALE_REPAIR_ATTEMPTS = 4;
const HEATMAP_ROLE_PREFERENCES = {
  ko: ['peak_core', 'payoff_tail', 'direct_lead_in', 'pre_peak', 'post_peak'],
  ja: ['lead_in', 'reaction_support', 'post_peak', 'pre_peak', 'payoff_tail']
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
    const starts = slot.dialogue_line_windows.map((win) => Number(win?.start_sec)).filter(Number.isFinite);
    const ends = slot.dialogue_line_windows.map((win) => Number(win?.end_sec)).filter(Number.isFinite);
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

function compactRange(range) {
  return Array.isArray(range) && Number(range[1]) > Number(range[0]) ? [round3(range[0]), round3(range[1])] : [0, 0];
}

function clampRange(range, minSec, maxSec) {
  const start = Math.max(minSec, Math.min(maxSec, Number(range?.[0] || 0)));
  const end = Math.max(start, Math.max(minSec, Math.min(maxSec, Number(range?.[1] || 0))));
  return end > start ? [round3(start), round3(end)] : [0, 0];
}

function normalizeHeatmapWindows(heatmapSignals = {}) {
  const windows = Array.isArray(heatmapSignals.high_replay_windows) ? heatmapSignals.high_replay_windows : [];
  return windows
    .map((window) => {
      const start = Number(window.start_sec ?? window.start ?? 0);
      const end = Number(window.end_sec ?? window.end ?? 0);
      const score = Number(window.peak_score ?? window.score ?? window.average_score ?? 0);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
      return { start_sec: round3(start), end_sec: round3(end), score: Number.isFinite(score) ? round3(score) : 0 };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.start_sec - right.start_sec);
}

function rangeHeatmapScore(range, heatmapWindows = []) {
  const duration = Math.max(0.001, rangeDuration(range));
  return round3(heatmapWindows.reduce((best, window) => {
    const overlapRatio = rangeOverlap(range, [window.start_sec, window.end_sec]) / duration;
    return Math.max(best, overlapRatio * Number(window.score || 0));
  }, 0));
}

function roleRange(start, end, minSec, maxSec) {
  return clampRange([start, end], minSec, maxSec);
}

function expandRangeWithin(range, desiredDurationSec, bounds) {
  const current = compactRange(range);
  if (rangeDuration(current) >= desiredDurationSec) return current;
  const bound = compactRange(bounds);
  if (rangeDuration(bound) <= 0) return current;
  const center = (current[0] + current[1]) / 2;
  return clampRange([center - (desiredDurationSec / 2), center + (desiredDurationSec / 2)], bound[0], bound[1]);
}

function nearestBoundaryRange(anchor, candidates, fallback, minSec, maxSec, maxDurationSec = 8) {
  if (!(maxSec > minSec)) return [0, 0];
  const valid = candidates
    .map(compactRange)
    .filter((range) => rangeDuration(range) > 0 && rangeOverlap(range, [minSec, maxSec]) > 0)
    .sort((left, right) => rangeOverlap(right, anchor) - rangeOverlap(left, anchor) || Math.abs(left[0] - anchor[0]) - Math.abs(right[0] - anchor[0]));
  const chosen = valid[0] || fallback;
  const clipped = clampRange(chosen, minSec, maxSec);
  if (rangeDuration(clipped) <= maxDurationSec) return clipped;
  const center = ((Math.max(clipped[0], anchor[0]) + Math.min(clipped[1], anchor[1])) / 2) || ((clipped[0] + clipped[1]) / 2);
  return clampRange([center - (maxDurationSec / 2), center + (maxDurationSec / 2)], clipped[0], clipped[1]);
}

function buildHeatmapRoleWindows(heatmapSignals = {}, transcriptSegments = [], sceneCandidates = []) {
  const windows = normalizeHeatmapWindows(heatmapSignals);
  const peaks = (Array.isArray(heatmapSignals.peaks) ? heatmapSignals.peaks : [])
    .map((peak) => compactRange([peak.start_sec ?? peak.start ?? 0, peak.end_sec ?? peak.end ?? 0]))
    .filter((range) => rangeDuration(range) > 0);
  const transcriptRanges = transcriptSegments.map((item) => compactRange([item.start_sec, item.end_sec])).filter((range) => rangeDuration(range) > 0);
  const sceneRanges = sceneCandidates.map((item) => compactRange([item.start_sec, item.end_sec])).filter((range) => rangeDuration(range) > 0);
  return windows.map((window, index) => {
    const full = [window.start_sec, window.end_sec];
    const duration = Math.max(0.001, rangeDuration(full));
    const bestPeak = peaks
      .filter((range) => rangeOverlap(range, full) > 0)
      .sort((left, right) => rangeOverlap(right, full) - rangeOverlap(left, full) || left[0] - right[0])[0]
      || [full[0] + (duration * 0.42), full[0] + (duration * 0.58)];
    const peakCore = expandRangeWithin(
      nearestBoundaryRange(bestPeak, [...transcriptRanges, ...sceneRanges], bestPeak, full[0], full[1], Math.min(6, Math.max(2, duration * 0.35))),
      Math.min(4, Math.max(2, duration * 0.2)),
      full
    );
    const leadIn = nearestBoundaryRange([full[0], peakCore[0]], [...sceneRanges, ...transcriptRanges], [full[0], peakCore[0]], full[0], Math.max(full[0], peakCore[0]), Math.min(8, Math.max(2, duration * 0.35)));
    const prePeak = roleRange(Math.max(full[0], peakCore[0] - Math.min(4, duration * 0.25)), peakCore[0], full[0], full[1]);
    const postPeak = nearestBoundaryRange([peakCore[1], full[1]], [...transcriptRanges, ...sceneRanges], [peakCore[1], Math.min(full[1], peakCore[1] + Math.min(6, duration * 0.3))], Math.min(full[1], peakCore[1]), full[1], Math.min(6, Math.max(2, duration * 0.3)));
    const reactionSupport = rangeDuration(postPeak) > 0 ? postPeak : roleRange(Math.max(full[0], peakCore[0] - 3), peakCore[0], full[0], full[1]);
    const payoffTail = roleRange(Math.max(full[0], full[1] - Math.min(7, duration * 0.35)), full[1], full[0], full[1]);
    return {
      heatmap_window_id: `hm_${String(index + 1).padStart(3, '0')}`,
      score: window.score,
      full_range: full,
      candidate_ranges: {
        lead_in: leadIn,
        direct_lead_in: rangeDuration(prePeak) > 0 ? prePeak : leadIn,
        pre_peak: prePeak,
        peak_core: peakCore,
        post_peak: postPeak,
        reaction_support: reactionSupport,
        payoff_tail: payoffTail
      }
    };
  });
}

function reservationOverlapScore(range, reservations = []) {
  const duration = Math.max(0.001, rangeDuration(range));
  return reservations.reduce((worst, reserved) => Math.max(worst, rangeOverlap(range, reserved.source_range || []) / duration), 0);
}

function selectHeatmapRoleRange(slotRange, locale, role, index, evidencePack, options = {}) {
  const roleWindows = Array.isArray(evidencePack.heatmap_role_windows) ? evidencePack.heatmap_role_windows : [];
  if (!roleWindows.length || rangeDuration(slotRange) <= 0) return null;
  const importantKoRole = /cold_open|body_peak|payoff/.test(role);
  if (locale === 'ko' && !importantKoRole) return null;
  const preferences = HEATMAP_ROLE_PREFERENCES[locale] || HEATMAP_ROLE_PREFERENCES.ko;
  const candidates = [];
  for (const window of roleWindows) {
    const fullOverlap = rangeOverlap(slotRange, window.full_range || []);
    const allowStrategicPull = locale === 'ko' ? importantKoRole : index <= 2;
    if (fullOverlap <= 0 && !allowStrategicPull) continue;
    for (const heatmapRole of preferences) {
      let candidate = compactRange(window.candidate_ranges?.[heatmapRole]);
      if (role === 'bridge' || role === 'body' || role === 'closing') {
        candidate = expandRangeWithin(candidate, 6, window.full_range || candidate);
      }
      if (rangeDuration(candidate) <= 0) continue;
      const pairPenalty = locale === 'ja' ? reservationOverlapScore(candidate, options.reservedSourceRanges || []) : 0;
      const fit = fullOverlap > 0 ? 1 : 0.35;
      const roleFit = (locale === 'ja' && /bridge|body|closing/.test(role)) || (locale === 'ko' && /cold_open|body_peak|payoff/.test(role)) ? 0.2 : 0;
      candidates.push({
        heatmap_window_id: window.heatmap_window_id,
        heatmap_role: heatmapRole,
        source_range: candidate,
        preference_rank: preferences.indexOf(heatmapRole),
        score: (Number(window.score || 0) * fit) + roleFit - (pairPenalty * 5),
        pair_overlap_penalty: round3(pairPenalty)
      });
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.pair_overlap_penalty - right.pair_overlap_penalty || left.preference_rank - right.preference_rank || left.source_range[0] - right.source_range[0]);
  return candidates[0] || null;
}

function buildReservedSourceRanges(localePlan) {
  return (Array.isArray(localePlan?.clip_chain) ? localePlan.clip_chain : [])
    .filter((clip) => Number(clip.heatmap_overlap_score || 0) > 0.25)
    .map((clip) => ({
      source: localePlan.locale,
      start_sec: clip.source_range?.[0] || 0,
      end_sec: clip.source_range?.[1] || 0,
      source_range: clip.source_range || [0, 0],
      heatmap_window_id: clip.heatmap_window_id || '',
      role: clip.heatmap_role || clip.role || ''
    }));
}

function diversifyHighlightOrder(order, timeline, locale, avoidOrder = []) {
  const current = order.filter(Boolean);
  if (locale !== 'ja' || !avoidOrder.length || JSON.stringify(current.slice(0, 3)) !== JSON.stringify(avoidOrder.slice(0, 3))) return current;
  const reactionFirst = timeline
    .filter((slot) => normalizeText(slot.decision) === 'NARRATE')
    .map((slot) => normalizeText(slot.beat_id || slot.slot_id))
    .find((id) => id && current.includes(id) && id !== current[0]);
  if (reactionFirst) return [reactionFirst, ...current.filter((id) => id !== reactionFirst)].slice(0, 3);
  return current.length > 1 ? [...current.slice(1), current[0]].slice(0, 3) : current;
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
  const heatmapSignals = supplementalEvidence?.heatmap_signals || { status: 'unavailable', coverage: false, source: 'youtube_public_most_replayed', peaks: [], high_replay_windows: [] };
  const heatmapWindows = normalizeHeatmapWindows(heatmapSignals);
  const commentReactionSummary = supplementalEvidence?.comment_reaction_summary || emptyReactionSummary();
  const compactTranscript = compactTranscriptSegments(transcript);
  const sceneCandidates = beats.map((beat) => {
    const range = [round3(beat.start_sec), round3(beat.end_sec)];
    return {
      beat_id: normalizeText(beat.beat_id),
      start_sec: range[0],
      end_sec: range[1],
      summary: normalizeText(beat.summary),
      dramatic_weight: Number(beat.dramatic_weight || 0),
      hook_potential: Number(beat.hook_potential || 0),
      dialogue_quality: normalizeText(beat.dialogue_quality),
      heatmap_overlap_score: rangeHeatmapScore(range, heatmapWindows)
    };
  });
  const heatmapRoleWindows = buildHeatmapRoleWindows(heatmapSignals, compactTranscript, sceneCandidates);
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
    transcript_segments: compactTranscript,
    scene_candidates: sceneCandidates,
    must_keep_dialogue_candidates: dialogueCandidates,
    must_keep_visual_candidates: visualCandidates,
    comment_reaction_summary: commentReactionSummary,
    retention_signals: retentionSignals,
    heatmap_signals: heatmapSignals,
    heatmap_priority_ranges: heatmapWindows.slice(0, 8),
    heatmap_role_windows: heatmapRoleWindows,
    verified_facts: supplementalEvidence?.verified_facts && typeof supplementalEvidence.verified_facts === 'object'
      ? supplementalEvidence.verified_facts
      : {},
    ambiguities: [],
    evidence_coverage: {
      comments: supplementalCoverage.comments === true,
      retention: supplementalCoverage.retention === true,
      heatmap: supplementalCoverage.heatmap === true || Array.isArray(heatmapSignals.high_replay_windows) && heatmapSignals.high_replay_windows.length > 0,
      transcript: compactTranscript.length > 0
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

function buildClipChain(locale, timeline, evidencePack = {}) {
  const heatmapWindows = normalizeHeatmapWindows(evidencePack.heatmap_signals || {});
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
      duration_sec: round3(duration),
      heatmap_overlap_score: rangeHeatmapScore(range, heatmapWindows),
      heatmap_window_id: normalizeText(slot.heatmap_window_id || ''),
      heatmap_role: normalizeText(slot.heatmap_role || ''),
      pair_overlap_penalty: Number(slot.pair_overlap_penalty || 0)
    };
    cursor = round3(cursor + duration);
    return clip;
  });
}

function topHighlightOrder(timeline, evidencePack, locale = 'ko', options = {}) {
  const heatmapWindows = normalizeHeatmapWindows(evidencePack.heatmap_signals || {});
  const scoreByBeat = new Map((evidencePack.scene_candidates || []).map((beat) => [beat.beat_id, Number(beat.dramatic_weight || 0) + Number(beat.hook_potential || 0) + Number(beat.heatmap_overlap_score || 0) * 4]));
  const topBeatIds = new Set(timeline
    .map((slot, index) => {
      const range = rangeForSlot(slot);
      const heatmapScore = rangeHeatmapScore(range, heatmapWindows);
      return { beat_id: normalizeText(slot.beat_id), slot_id: normalizeText(slot.slot_id), score: (scoreByBeat.get(normalizeText(slot.beat_id)) || 0) + heatmapScore * 6, index };
    })
    .filter((item) => item.beat_id)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 3)
    .map((item) => item.beat_id || item.slot_id));
  const order = timeline
    .map((slot) => normalizeText(slot.beat_id || slot.slot_id))
    .filter((id, index, list) => id && topBeatIds.has(id) && list.indexOf(id) === index)
    .slice(0, 3);
  return diversifyHighlightOrder(order, timeline, locale, options.avoidHighlightOrder || []);
}

function buildLocaleEditPlan(baseEditPlan, strategy, evidencePack, attempt = 0, options = {}) {
  const locale = strategy.locale;
  const sourceDurationSec = Number(evidencePack.duration_sec || 0);
  const active = activeTimeline(baseEditPlan).map((slot) => ({ ...slot }));
  const reordered = active
    .slice()
    .sort((left, right) => rolePriority(locale, left) - rolePriority(locale, right));
  const shiftBase = Number(strategy.source_range_shift_sec || 0) + (locale === 'ja' ? attempt * 4.0 : attempt * -0.08);
  const timeline = reordered.map((slot, index) => {
    const range = rangeForSlot(slot);
    const role = normalizeText(slot.role);
    const decision = normalizeText(slot.decision);
    let shift = shiftBase;
    if (locale === 'ja' && decision === 'NARRATE') shift += 3.0 + index * 0.45;
    if (locale === 'ja' && role === 'cold_open') shift += 3.5;
    if (locale === 'ko' && role === 'body_peak') shift -= 0.12;
    let nextRange = shiftedRange(range, shift, sourceDurationSec);
    const selectedHeatmap = selectHeatmapRoleRange(nextRange, locale, role, index + attempt, evidencePack, options);
    if (selectedHeatmap && selectedHeatmap.score > 0) nextRange = selectedHeatmap.source_range;
    return {
      ...applyRangeToSlot(slot, nextRange),
      locale,
      ...(selectedHeatmap ? {
        heatmap_window_id: selectedHeatmap.heatmap_window_id,
        heatmap_role: selectedHeatmap.heatmap_role,
        pair_overlap_penalty: selectedHeatmap.pair_overlap_penalty
      } : {}),
      locale_strategy_applied: strategy.strategy_version,
      locale_variation_note: locale === 'ja'
        ? 'reaction/tension branch shifts source windows later and reorders buildup before direct payoff'
        : 'conflict-first branch keeps direct hook/payoff order with tighter source windows'
    };
  });
  const clipChain = buildClipChain(locale, timeline, evidencePack);
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
    highlight_order: topHighlightOrder(timeline, evidencePack, locale, options),
    heatmap_priority_ranges: (evidencePack.heatmap_priority_ranges || []).slice(0, 8),
    reserved_source_ranges: options.reservedSourceRanges || [],
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
    timeline,
    repair_history: options.repairHistory || []
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

function rangesNearlyEqual(leftRange, rightRange, toleranceSec = OVERLAP_THRESHOLDS.clone_tolerance_sec) {
  return Math.abs(Number(leftRange?.[0] || 0) - Number(rightRange?.[0] || 0)) <= toleranceSec
    && Math.abs(Number(leftRange?.[1] || 0) - Number(rightRange?.[1] || 0)) <= toleranceSec;
}

function physicalTimelineCloneSignals(koChain, jaChain, thresholds = OVERLAP_THRESHOLDS) {
  const toleranceSec = Number(thresholds.clone_tolerance_sec || OVERLAP_THRESHOLDS.clone_tolerance_sec);
  const sameClipCount = koChain.length > 0 && koChain.length === jaChain.length;
  const paired = sameClipCount ? koChain.map((koClip, index) => ({ koClip, jaClip: jaChain[index] })) : [];
  const identicalSourceChain = sameClipCount && paired.every(({ koClip, jaClip }) => rangesNearlyEqual(koClip.source_range, jaClip.source_range, toleranceSec));
  const identicalTimelineTiming = sameClipCount && paired.every(({ koClip, jaClip }) => rangesNearlyEqual(koClip.timeline_range, jaClip.timeline_range, toleranceSec));
  const identicalDurations = sameClipCount && paired.every(({ koClip, jaClip }) => Math.abs(Number(koClip.duration_sec || 0) - Number(jaClip.duration_sec || 0)) <= toleranceSec);
  const identicalOpeningClip = sameClipCount && rangesNearlyEqual(koChain[0]?.source_range, jaChain[0]?.source_range, toleranceSec) && rangesNearlyEqual(koChain[0]?.timeline_range, jaChain[0]?.timeline_range, toleranceSec);
  const exactPhysicalTimelineClone = Boolean(sameClipCount && identicalSourceChain && identicalTimelineTiming && identicalDurations && identicalOpeningClip);
  return {
    same_clip_count: sameClipCount,
    identical_source_clip_chain: identicalSourceChain,
    identical_clip_ordering: identicalSourceChain,
    identical_clip_in_out_timing: identicalSourceChain && identicalTimelineTiming,
    identical_opening_frame_or_clip: identicalOpeningClip,
    identical_physical_video_timeline: exactPhysicalTimelineClone,
    exact_physical_timeline_clone: exactPhysicalTimelineClone
  };
}

function timelineContentSignature(plan) {
  return (Array.isArray(plan?.timeline) ? plan.timeline : []).map((slot) => ({
    dialogue_focus_lines: Array.isArray(slot.dialogue_focus_lines) ? slot.dialogue_focus_lines.map(normalizeText) : [],
    narration: normalizeText(slot.narration || slot.narration_text || slot.caption_text || ''),
    subtitle: normalizeText(slot.subtitle || slot.subtitle_text || ''),
    target_timerange: slot.target_timerange || null
  }));
}

function timelineContentCloneSignals(koPlan, jaPlan) {
  return {
    identical_narration_dialogue_subtitle_content: JSON.stringify(timelineContentSignature(koPlan)) === JSON.stringify(timelineContentSignature(jaPlan))
  };
}

function localeOverlapWarnings({ openingSimilarity, chainSimilarity, pairwiseScore, maxBlockSec, threeShotChain, highlightSimilarity, overlapRatio, thresholds }) {
  const warnings = [];
  if (openingSimilarity > thresholds.opening_similarity_score) warnings.push('opening_similarity_high');
  if (chainSimilarity > thresholds.chain_similarity_score) warnings.push('chain_similarity_high');
  if (pairwiseScore > thresholds.pairwise_overlap_score) warnings.push('pairwise_overlap_high');
  if (maxBlockSec > thresholds.shared_contiguous_block_max_sec) warnings.push('shared_contiguous_block_long');
  if (threeShotChain) warnings.push('three_shot_chain_reuse');
  if (highlightSimilarity === 1) warnings.push('top_three_highlight_order_identical');
  if (overlapRatio > 0.65) warnings.push('source_reuse_high');
  return [...new Set(warnings)];
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
  const threeShotChain = blocks.some((block) => block.length >= 3);
  const physicalCloneSignals = physicalTimelineCloneSignals(koChain, jaChain, thresholds);
  const contentClone = timelineContentCloneSignals(koPlan, jaPlan);
  const exactClone = physicalCloneSignals.exact_physical_timeline_clone && contentClone.identical_narration_dialogue_subtitle_content;
  const cloneSignals = {
    ...physicalCloneSignals,
    ...contentClone,
    exact_physical_timeline_clone: exactClone,
    exact_output_clone: exactClone
  };
  const failures = exactClone ? ['exact_physical_timeline_clone'] : [];
  const warnings = localeOverlapWarnings({ openingSimilarity, chainSimilarity, pairwiseScore, maxBlockSec, threeShotChain, highlightSimilarity, overlapRatio, thresholds });
  const finalStatus = failures.length ? 'failed' : (warnings.length ? 'passed_with_warnings' : 'passed');
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
    warning_gates: warnings,
    clone_signals: cloneSignals,
    regeneration_attempts: regenerationAttempts,
    final_status: finalStatus
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
  if (overlapReport.final_status === 'failed') failures.push(...overlapReport.failed_gates.map((gate) => `pairwise_${gate}`));
  return {
    artifact_type: 'midform_locale_acceptance_gates',
    locale: localePlan.locale,
    status: failures.length ? 'failed' : 'passed',
    failed: [...new Set(failures)],
    warnings: (overlapReport.warning_gates || []).map((gate) => `pairwise_${gate}`),
    checks: {
      has_clip_chain: localePlan.clip_chain.length > 0,
      has_opening_window: localePlan.opening_window.length > 0,
      has_highlight_order: localePlan.highlight_order.length > 0,
      pairwise_overlap_passed: overlapReport.final_status !== 'failed'
    }
  };
}

function buildLocaleBranchArtifacts({ normalizedRequest, beatsObject, editPlan, transcript, compressionManifest, supplementalEvidence }) {
  const evidencePack = buildEvidencePack({ normalizedRequest, beatsObject, editPlan, transcript, compressionManifest, supplementalEvidence });
  const strategies = Object.fromEntries(LOCALES.map((locale) => [locale, buildLocaleEditorialStrategy(locale, evidencePack)]));
  const koPlan = buildLocaleEditPlan(editPlan, strategies.ko, evidencePack, 0);
  const reservedSourceRanges = buildReservedSourceRanges(koPlan);
  let repairHistory = [];
  let jaPlan = buildLocaleEditPlan(editPlan, strategies.ja, evidencePack, 0, {
    reservedSourceRanges,
    avoidHighlightOrder: koPlan.highlight_order,
    repairHistory
  });
  let overlapReport = compareLocaleEditPlans(koPlan, jaPlan, OVERLAP_THRESHOLDS, 0);
  let attempts = 0;
  while (overlapReport.final_status === 'failed' && attempts < MAX_LOCALE_REPAIR_ATTEMPTS) {
    attempts += 1;
    repairHistory = [
      ...repairHistory,
      {
        attempt: attempts,
        repair_reason: overlapReport.failed_gates || [],
        target_ranges: (overlapReport.shared_contiguous_blocks || []).slice(0, 3).flatMap((block) => block.clips || []).map((clip) => ({ overlap_sec: clip.overlap_sec, ko_clip_id: clip.ko_clip_id, ja_clip_id: clip.ja_clip_id })),
        actions: [
          'replace_peak_core_with_lead_in_or_reaction_support',
          'apply_ko_reserved_source_range_penalty',
          'diversify_ja_highlight_order'
        ]
      }
    ];
    jaPlan = buildLocaleEditPlan(editPlan, strategies.ja, evidencePack, attempts, {
      reservedSourceRanges,
      avoidHighlightOrder: koPlan.highlight_order,
      repairHistory
    });
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
    physicalTimelineCloneSignals,
    timelineContentCloneSignals,
    signatureForClip
  }
};

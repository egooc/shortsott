// Cut-selection tier: ranks a candidate window/scene by three source-intrinsic
// properties that editing cannot fix afterwards --
//   (1) one complete action cycle finishing within 5s at natural speed
//       (published 3-5s clips exploded at 74.0% vs 35.7% for 6-10s in the
//       509-video labeled dataset, robust to channel stratification, outlier
//       removal, and SSIM cross-tabs; a >5s cycle can only reach 3-5s via
//       speed-up, which is itself a negative signal),
//   (2) footage not already sped up (REAL_TIME 48.4% vs SPED_UP 30.2% --
//       un-speeding time-lapsed footage is impossible),
//   (3) a fully visible person performing the action (FULL_PERSON 52.7% >
//       HANDS_ONLY 41.8% > NONE 34.3%, monotonic gradient).
// Ordering only -- NEVER a filter: a T3-only source still produces a draft,
// because the 2-hour publishing cadence must never starve for quality reasons.
// Fields absent (pre-upgrade Gemini output) simply don't count as matches, so
// old guide data degrades to T3 ordering instead of breaking.

function computeCutSelectionTier(fields = {}) {
  const cycleTime = Number(fields.cycle_time_sec);
  const matches = [
    Number.isFinite(cycleTime) && cycleTime > 0 && cycleTime <= 5,
    fields.appears_sped_up === false,
    fields.human_visibility === 'FULL_PERSON'
  ].filter(Boolean).length;
  return matches === 3 ? 'T1' : matches === 2 ? 'T2' : 'T3';
}

function cutSelectionTierRank(fields = {}) {
  return { T1: 0, T2: 1, T3: 2 }[computeCutSelectionTier(fields)];
}

module.exports = { computeCutSelectionTier, cutSelectionTierRank };

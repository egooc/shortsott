'use strict';

// What the narration_share gate will measure, computed from the edit plan and the written
// slot_fills - before a single TTS credit is spent.
//
// Why this exists. The acceptance gate reads the SHIPPED manifest, and it is right to: the
// recap budget passed in the planner twice and was undone by later passes both times. But the
// manifest only exists after TTS and draft assembly, so 26 of 48 recorded acceptance failures
// paid for the whole build to learn a number that was already determined the moment the writer
// finished. Four of them (2026-09-11..12, after the planner's 7.0/min ceiling landed) shipped at
// 10.3 to 12.6 sentences/min against a ceiling of 10.
//
// The leak is an ordering one: validateEditPlan runs on the LLM's own duration guesses, then
// recalculateNarrationDurations rewrites every NARRATE duration from the real narration text,
// and nothing re-checks the budget afterwards. A plan measured at 6.9/min before the rewrite was
// 14.4/min after it (auto_template_6cd761ad8d, 17 slots over 70.7s).
//
// Measured against 65 runs where the shipped narration still matches these fills:
//   narration rows  = sum over filled slots of max(1, sentence-split)  -> 51/65 exact,
//                     error p10=0% p50=0% p90=+10% (it over-counts, never materially under)
//   narrated seconds: chars/5.8 with a 0.8s floor -> -0.9% total bias over 807 shipped sentences
//   sentences/min at the gate's own 10 ceiling -> 9 caught, 1 missed, 1 false alarm out of 65
//   narration share  -> +-5 to 8 points, so it is reported and warned on, never thrown
//
// The 5.8 is deliberately NOT estimateKoreanNarrationSeconds (4.8 ch/s + 0.3s, which runs 27%
// long). That one SIZES slots and a long estimate there is a safety margin; here a long estimate
// dilutes the per-minute denominator and hides exactly the failure we are trying to catch.

const NARRATION_CHARS_PER_SEC_MEASURED = 5.8;
const NARRATION_MIN_SEC_MEASURED = 0.8;

function splitNarrationSentences(text) {
  return String(text || '')
    .split(/[.!?…。！？]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function measuredNarrationSeconds(text) {
  const charCount = String(text || '').replace(/\s+/g, '').length;
  if (!charCount) return 0;
  return Math.max(NARRATION_MIN_SEC_MEASURED, charCount / NARRATION_CHARS_PER_SEC_MEASURED);
}

// What the gate counts as narration is whether the row SPEAKS, not what its visual mode is.
// A source_audio_action slot with a written sentence is a narrated action beat - the adapter
// rule of 2026-09-05, and check-narration-share reads caption_kind for exactly this reason
// after Shaolin's narrated hooks were miscounted as a 21.9s dialogue run. Classifying by
// visual_source_mode hid 6 of 16 narrated slots on auto_template_6cd761ad8d and put its
// predicted density at 8.7/min when the cut shipped at 13.9.
function speaks(narrationText) {
  return !!String(narrationText || '').trim();
}

// Screen seconds are a different question from who speaks. A narrated action beat or teaser
// plays its own window whatever the sentence length, so its duration comes from the plan; a
// plain narration slot is as long as its narration.
function holdsItsOwnWindow(item) {
  return /source_audio/.test(String(item?.visual_source_mode || ''));
}

function predictNarrationBudget(editPlan, slotFills) {
  const fillsBySlot = new Map((Array.isArray(slotFills?.slot_fills) ? slotFills.slot_fills : [])
    .map((fill) => [String(fill?.slot_id || '').trim(), fill]));

  let narrationSec = 0;
  let sourceAudioSec = 0;
  let sentences = 0;
  let longestSourceRun = 0;
  let currentRun = 0;

  for (const item of Array.isArray(editPlan?.timeline) ? editPlan.timeline : []) {
    if (String(item?.decision || '') === 'DROP') continue;
    const fill = fillsBySlot.get(String(item?.slot_id || '').trim());
    const narration = String(fill?.narration || '');
    const plannedSec = Number(item?.estimated_duration_sec || 0);
    if (String(item?.decision || '') === 'KEEP_DIALOGUE' || !speaks(narration)) {
      sourceAudioSec += plannedSec;
      currentRun += plannedSec;
      longestSourceRun = Math.max(longestSourceRun, currentRun);
      continue;
    }
    currentRun = 0;
    narrationSec += holdsItsOwnWindow(item) ? plannedSec : measuredNarrationSeconds(narration);
    sentences += Math.max(1, splitNarrationSentences(narration).length);
  }

  const projectedSec = narrationSec + sourceAudioSec;
  // longest_source_audio_run_sec is REPORTED, never enforced. The plan merges adjacent
  // source-audio slots into one run where the shipped draft interleaves narration rows, so it
  // over-predicts by a median 10.3s and would have blocked 17 of 65 good drafts. The gate's
  // 10s dialogue-run rule stays a post-draft check until the plan can say where narration lands.
  return {
    projected_sec: Number(projectedSec.toFixed(2)),
    narration_sec: Number(narrationSec.toFixed(2)),
    narration_sentences: sentences,
    sentences_per_min: projectedSec > 0 ? Number((sentences / (projectedSec / 60)).toFixed(2)) : 0,
    narration_share: projectedSec > 0 ? Number((narrationSec / projectedSec).toFixed(4)) : 0,
    longest_source_audio_run_sec: Number(longestSourceRun.toFixed(2))
  };
}

module.exports = { predictNarrationBudget, measuredNarrationSeconds, splitNarrationSentences };

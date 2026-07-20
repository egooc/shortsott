const SHORTFORM_FULL_DRAFT_SKIP_MAX_DURATION_SEC = 24;

function shouldSkipFullDraftForShortSource({ durationSec = 0, sourceType = 'unknown', sourceWorkflowMode = 'unknown' } = {}) {
  const numericDurationSec = Number(durationSec || 0);
  const isLongformSource = sourceWorkflowMode === 'longform_to_shorts' || sourceType === 'longform';
  return !isLongformSource
    && numericDurationSec > 0
    && numericDurationSec < SHORTFORM_FULL_DRAFT_SKIP_MAX_DURATION_SEC;
}

module.exports = {
  SHORTFORM_FULL_DRAFT_SKIP_MAX_DURATION_SEC,
  shouldSkipFullDraftForShortSource
};

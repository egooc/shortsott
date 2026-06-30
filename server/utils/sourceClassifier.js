function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeSourceMode(value = '') {
  const mode = String(value || '').trim().toLowerCase();
  if (['shortform', 'short', 'shorts'].includes(mode)) return 'shortform';
  if (['longform', 'long'].includes(mode)) return 'longform';
  if (mode === 'auto') return 'auto';
  return 'auto';
}

function getOrientation({ width = 0, height = 0 } = {}) {
  const w = toNumber(width);
  const h = toNumber(height);
  if (w <= 0 || h <= 0) return 'unknown';
  if (Math.abs(w - h) / Math.max(w, h) < 0.08) return 'square';
  return h > w ? 'vertical' : 'horizontal';
}

function classifySourceVideo(input = {}) {
  const requestedMode = normalizeSourceMode(input.requestedMode || input.sourceMode || input.source_type || 'auto');
  const durationSec = toNumber(input.durationSec ?? input.duration_sec ?? input.duration);
  const width = toNumber(input.width);
  const height = toNumber(input.height);
  const orientation = input.orientation || getOrientation({ width, height });
  const reasons = [];

  let sourceType = 'unknown';
  let workflowMode = 'unknown';
  let confidence = 'low';

  if (durationSec > 0) {
    if (requestedMode === 'shortform') {
      sourceType = durationSec <= 120 ? 'shortform' : 'longform';
      reasons.push(`requested shortform; duration ${durationSec.toFixed(1)}s`);
    } else if (requestedMode === 'longform') {
      sourceType = durationSec >= 60 ? 'longform' : 'shortform';
      reasons.push(`requested longform; duration ${durationSec.toFixed(1)}s`);
    } else if (durationSec >= 90) {
      sourceType = 'longform';
      reasons.push(`duration ${durationSec.toFixed(1)}s is 90s or longer`);
    } else if (durationSec <= 75) {
      sourceType = 'shortform';
      reasons.push(`duration ${durationSec.toFixed(1)}s is short-form length`);
    } else {
      sourceType = orientation === 'horizontal' ? 'longform' : 'shortform';
      reasons.push(`borderline duration ${durationSec.toFixed(1)}s; orientation ${orientation}`);
    }
    confidence = requestedMode === 'auto' ? 'medium' : 'high';
  } else {
    sourceType = requestedMode === 'longform' ? 'longform' : requestedMode === 'shortform' ? 'shortform' : 'unknown';
    reasons.push('duration is unknown');
  }

  if (sourceType === 'longform') {
    workflowMode = 'longform_to_shorts';
  } else if (sourceType === 'shortform') {
    workflowMode = 'shortform_direct';
  }

  return {
    source_type: sourceType,
    source_workflow_mode: workflowMode,
    source_type_origin: input.origin || 'auto',
    source_classification: {
      duration_sec: durationSec,
      width,
      height,
      orientation,
      requested_mode: requestedMode,
      reason: reasons.join('; '),
      confidence,
      classified_at: new Date().toISOString()
    }
  };
}

module.exports = {
  classifySourceVideo,
  getOrientation,
  normalizeSourceMode
};

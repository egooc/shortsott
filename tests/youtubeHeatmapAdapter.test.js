const assert = require('node:assert/strict');
const test = require('node:test');

const { collectYouTubeHeatmap, normalizePublicHeatmap } = require('../server/services/youtubeHeatmapAdapterService');

test('public yt-dlp heatmap normalization extracts peaks and high replay windows', () => {
  const signals = normalizePublicHeatmap([
    { start_time: 0, end_time: 5, value: 0.12 },
    { start_time: 5, end_time: 10, value: 0.95 },
    { start_time: 10, end_time: 15, value: 0.93 },
    { start_time: 40, end_time: 45, value: 0.4 }
  ], { topPercent: 0.5, mergeGapSec: 0, maxWindows: 3 });

  assert.equal(signals.status, 'available');
  assert.equal(signals.coverage, true);
  assert.equal(signals.source, 'youtube_public_most_replayed');
  assert.equal(signals.raw_point_count, 4);
  assert.equal(signals.peaks[0].start_sec, 5);
  assert.deepEqual(signals.high_replay_windows[0].start_sec, 5);
  assert.deepEqual(signals.high_replay_windows[0].end_sec, 15);
});

test('public heatmap normalization reports unavailable when yt-dlp JSON has no heatmap', () => {
  const signals = normalizePublicHeatmap([], {});

  assert.equal(signals.status, 'unavailable');
  assert.equal(signals.coverage, false);
  assert.equal(signals.reason, 'public_heatmap_unavailable');
  assert.equal(signals.source, 'youtube_public_most_replayed');
});

test('provided heatmap remains supported for deterministic fixtures', async () => {
  const result = await collectYouTubeHeatmap('https://www.youtube.com/watch?v=abcdefghijk', {
    heatmap: {
      peaks: [{ start_sec: 12, end_sec: 16, score: 0.8 }],
      high_replay_windows: [{ start_sec: 12, end_sec: 20, score: 0.8 }]
    }
  });

  assert.equal(result.status, 'available');
  assert.equal(result.evidence_coverage, true);
  assert.equal(result.heatmap_signals.source, 'provided_options');
  assert.equal(result.heatmap_signals.high_replay_windows[0].end_sec, 20);
});

test('heatmap collection can be disabled without failing full-auto', async () => {
  const result = await collectYouTubeHeatmap('https://www.youtube.com/watch?v=abcdefghijk', { heatmapSource: 'disabled' });

  assert.equal(result.status, 'skipped');
  assert.equal(result.evidence_coverage, false);
  assert.equal(result.unavailable_reason, 'heatmap_disabled');
  assert.equal(result.heatmap_signals.source, 'youtube_public_most_replayed');
});

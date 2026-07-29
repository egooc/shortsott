const assert = require('node:assert/strict');
const test = require('node:test');

const { buildReactionSummary } = require('../server/services/youtubeCommentsAdapterService');
const { buildRetentionSignals } = require('../server/services/youtubeRetentionAdapterService');
const { buildTemplateBody } = require('../server/services/midformTemplateWriterService');
const {
  buildAutoTemplateMarkdown,
  buildSupplementalEvidence,
  normalizeMode
} = require('../server/services/midformFullAutoService');

test('normalizeMode defaults unsupported full-auto values to full_auto', () => {
  assert.equal(normalizeMode('template_only'), 'template_only');
  assert.equal(normalizeMode('drafts_only'), 'drafts_only');
  assert.equal(normalizeMode(''), 'full_auto');
  assert.equal(normalizeMode('unknown'), 'full_auto');
});

test('comment reaction summary combines top and recent comments', () => {
  const summary = buildReactionSummary(
    [{ text: 'That reveal scene gave me goosebumps. The reveal was perfect.' }],
    [{ text: 'Recent viewers are confused about why the line matters in this scene.' }]
  );

  assert.ok(summary.repeated_keywords.some((item) => item.keyword === 'reveal'));
  assert.ok(summary.repeated_emotions.length >= 1);
  assert.ok(summary.scene_mentions.length >= 1);
  assert.ok(summary.misunderstandings.length >= 1);
});

test('retention signals expose intro, spikes, dips, and rewatch zones', () => {
  const signals = buildRetentionSignals([
    { elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 0.8, relativeRetentionPerformance: -0.1 },
    { elapsedVideoTimeRatio: 0.42, audienceWatchRatio: 1.4, relativeRetentionPerformance: 0.3 },
    { elapsedVideoTimeRatio: 0.7, audienceWatchRatio: 0.4, relativeRetentionPerformance: -0.2 }
  ]);

  assert.equal(signals.intro.elapsedVideoTimeRatio, 0.01);
  assert.equal(signals.top_moments[0].elapsedVideoTimeRatio, 0.42);
  assert.equal(signals.spikes[0].elapsedVideoTimeRatio, 0.42);
  assert.equal(signals.dips[0].elapsedVideoTimeRatio, 0.7);
  assert.equal(signals.rewatch_zones[0].elapsedVideoTimeRatio, 0.42);
});

test('full-auto supplemental evidence records adapter coverage without blocking missing sources', () => {
  const evidence = buildSupplementalEvidence({
    sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    comments: { evidence_coverage: true, top_comments: [{ text: 'great scene' }], recent_comments: [], reaction_summary: { repeated_keywords: [{ keyword: 'scene', count: 1 }] } },
    retention: { evidence_coverage: false, unavailable_reason: 'youtube_analytics_token_missing', retention_signals: { intro: {}, top_moments: [], spikes: [], dips: [], rewatch_zones: [] } },
    heatmap: { evidence_coverage: false, unavailable_reason: 'heatmap_adapter_not_configured', heatmap_signals: { source: 'internal_adapter', peaks: [], high_replay_windows: [] } }
  });

  assert.equal(evidence.video_id, 'abcdefghijk');
  assert.equal(evidence.evidence_coverage.comments, true);
  assert.equal(evidence.evidence_coverage.retention, false);
  assert.equal(evidence.coverage_notes.retention, 'youtube_analytics_token_missing');
});

test('auto template body and markdown include production instructions without touching front matter later', () => {
  const body = buildTemplateBody('ja', {
    comment_reaction_summary: { repeated_keywords: [{ keyword: 'reveal', count: 2 }], scene_mentions: ['the reveal scene'], misunderstandings: ['why did he stop?'] },
    retention_signals: { top_moments: [{ elapsedVideoTimeRatio: 0.4, audienceWatchRatio: 1.2 }] },
    heatmap_signals: { high_replay_windows: [{ start_sec: 40, end_sec: 48, score: 0.9 }] },
    must_keep_dialogue_candidates: [{ dialogue_lines: ['Do you remember me?'] }],
    must_keep_visual_candidates: [{ scene_summary: 'Bucky reacts silently.' }]
  });
  const markdown = buildAutoTemplateMarkdown({ sourceUrl: 'https://youtu.be/abcdefghijk', targetLengthSec: 160, profile: 'production', analysisMode: 'auto', body });

  assert.match(body, /JA Auto Template Body/);
  assert.match(body, /Do you remember me\?/);
  assert.match(body, /caption-only duplicate/);
  assert.match(markdown, /source:/);
  assert.match(markdown, /target_length_sec: 160/);
  assert.match(markdown, /JA Auto Template Body/);
});

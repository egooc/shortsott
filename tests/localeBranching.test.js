const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildLocaleBranchArtifacts,
  buildLocaleEditorialStrategy,
  compareLocaleEditPlans
} = require('../server/services/midformLocaleBranchService');

function sampleInputs() {
  const normalizedRequest = {
    source: { url: 'https://www.youtube.com/watch?v=abcdefghijk' },
    output: { target_length_sec: 120 }
  };
  const beatsObject = {
    beats: [
      { beat_id: 'beat_01', start_sec: 0, end_sec: 40, summary: 'FBI starts the interrogation.', dramatic_weight: 3, hook_potential: 4, dialogue_quality: 'mid' },
      { beat_id: 'beat_02', start_sec: 40, end_sec: 100, summary: 'The mentalist unsettles the agents.', dramatic_weight: 4, hook_potential: 3, dialogue_quality: 'high' },
      { beat_id: 'beat_03', start_sec: 100, end_sec: 160, summary: 'The leader reveals the magic rule.', dramatic_weight: 5, hook_potential: 5, dialogue_quality: 'high' },
      { beat_id: 'beat_04', start_sec: 160, end_sec: 210, summary: 'The group exits with control.', dramatic_weight: 4, hook_potential: 5, dialogue_quality: 'high' }
    ]
  };
  const editPlan = {
    edit_plan_id: 'sample_plan',
    scene_type: 'dialogue_confrontation',
    editorial_pattern: 'cold_open_callback',
    duration_budget: { target_sec: 120, source_duration_sec: 220 },
    timeline: [
      {
        slot_id: 'slot_01',
        beat_id: 'beat_03',
        role: 'cold_open',
        decision: 'KEEP_DIALOGUE',
        start_sec: 120,
        end_sec: 126,
        estimated_duration_sec: 6,
        dialogue_focus_lines: ['Always be the smartest guy in the room.'],
        dialogue_line_windows: [{ matched: true, start_sec: 120, end_sec: 126, line: 'Always be the smartest guy in the room.' }]
      },
      { slot_id: 'slot_02', beat_id: 'beat_01', role: 'bridge', decision: 'NARRATE', start_sec: 4, end_sec: 28, estimated_duration_sec: 11 },
      { slot_id: 'slot_03', beat_id: 'beat_02', role: 'body', decision: 'NARRATE', start_sec: 52, end_sec: 78, estimated_duration_sec: 13 },
      {
        slot_id: 'slot_04',
        beat_id: 'beat_03',
        role: 'body_peak',
        decision: 'KEEP_DIALOGUE',
        start_sec: 130,
        end_sec: 137,
        estimated_duration_sec: 7,
        dialogue_focus_lines: ['The closer you think you are, the less you see.'],
        dialogue_line_windows: [{ matched: true, start_sec: 130, end_sec: 137, line: 'The closer you think you are, the less you see.' }]
      },
      { slot_id: 'slot_05', beat_id: 'beat_04', role: 'payoff', decision: 'NARRATE', start_sec: 170, end_sec: 195, estimated_duration_sec: 10 },
      { slot_id: 'slot_closing', beat_id: 'beat_04', role: 'closing', decision: 'NARRATE', start_sec: 195, end_sec: 205, estimated_duration_sec: 5 }
    ]
  };
  const transcript = [
    { start_sec: 120, end_sec: 126, text: 'Always be the smartest guy in the room.' },
    { start_sec: 130, end_sec: 137, text: 'The closer you think you are, the less you see.' }
  ];
  const compressionManifest = { videoId: 'abcdefghijk', sourceUrl: normalizedRequest.source.url, durationSec: 220 };
  return { normalizedRequest, beatsObject, editPlan, transcript, compressionManifest };
}

test('locale strategies encode different editorial decisions from common evidence', () => {
  const { normalizedRequest, beatsObject, editPlan, transcript, compressionManifest } = sampleInputs();
  const artifacts = buildLocaleBranchArtifacts({ normalizedRequest, beatsObject, editPlan, transcript, compressionManifest });

  assert.equal(artifacts.evidencePack.source_url, normalizedRequest.source.url);
  assert.equal(artifacts.evidencePack.must_keep_dialogue_candidates.length, 2);
  assert.equal(artifacts.editorialStrategies.ko.opening_priority, 'conflict_first');
  assert.equal(artifacts.editorialStrategies.ja.opening_priority, 'tension_build_first');
  assert.notEqual(artifacts.editorialStrategies.ko.pace_profile, artifacts.editorialStrategies.ja.pace_profile);
});

test('locale evidence pack merges full-auto supplemental reaction and coverage signals', () => {
  const inputs = sampleInputs();
  const artifacts = buildLocaleBranchArtifacts({
    ...inputs,
    supplementalEvidence: {
      comment_reaction_summary: { repeated_keywords: [{ keyword: 'reveal', count: 3 }], repeated_emotions: [], misunderstandings: ['viewer confusion'], scene_mentions: ['ending scene'], title_thumbnail_phrases: [] },
      retention_signals: { intro: { elapsedVideoTimeRatio: 0.01 }, top_moments: [{ elapsedVideoTimeRatio: 0.4 }], spikes: [], dips: [], rewatch_zones: [] },
      heatmap_signals: { source: 'youtube_public_most_replayed', coverage: true, peaks: [{ start_sec: 120, end_sec: 126, score: 0.9 }], high_replay_windows: [{ start_sec: 120, end_sec: 126, score: 0.9 }] },
      evidence_coverage: { comments: true, retention: true, heatmap: true },
      coverage_notes: { retention: '' }
    }
  });

  assert.equal(artifacts.evidencePack.comment_reaction_summary.repeated_keywords[0].keyword, 'reveal');
  assert.equal(artifacts.evidencePack.retention_signals.intro.elapsedVideoTimeRatio, 0.01);
  assert.equal(artifacts.evidencePack.heatmap_signals.high_replay_windows.length, 1);
  assert.equal(artifacts.evidencePack.heatmap_priority_ranges[0].start_sec, 120);
  assert.ok(artifacts.evidencePack.scene_candidates.find((beat) => beat.beat_id === 'beat_03').heatmap_overlap_score > 0);
  assert.deepEqual(artifacts.evidencePack.evidence_coverage, { comments: true, retention: true, heatmap: true, transcript: true });
});

test('public heatmap windows influence locale edit plan metadata and highlight priority', () => {
  const inputs = sampleInputs();
  const artifacts = buildLocaleBranchArtifacts({
    ...inputs,
    supplementalEvidence: {
      heatmap_signals: {
        source: 'youtube_public_most_replayed',
        coverage: true,
        high_replay_windows: [{ start_sec: 170, end_sec: 195, peak_score: 0.98 }],
        peaks: [{ start_sec: 180, end_sec: 184, score: 0.98 }]
      },
      evidence_coverage: { heatmap: true }
    }
  });

  const payoffClip = artifacts.editPlans.ko.clip_chain.find((clip) => clip.slot_id === 'slot_05');
  assert.ok(payoffClip.heatmap_overlap_score > 0);
  assert.equal(artifacts.editPlans.ko.heatmap_priority_ranges[0].start_sec, 170);
  assert.ok(artifacts.editPlans.ko.highlight_order.includes('beat_04'));
});

test('locale edit plans produce different opening chains and pass overlap guard', () => {
  const inputs = sampleInputs();
  const artifacts = buildLocaleBranchArtifacts(inputs);
  const koOpening = artifacts.editPlans.ko.opening_window.map((clip) => clip.slot_id);
  const jaOpening = artifacts.editPlans.ja.opening_window.map((clip) => clip.slot_id);

  assert.notDeepEqual(koOpening, jaOpening);
  assert.notDeepEqual(artifacts.editPlans.ko.highlight_order, artifacts.editPlans.ja.highlight_order);
  assert.equal(artifacts.overlapReport.final_status, 'pass');
  assert.ok(artifacts.overlapReport.opening_similarity_score <= artifacts.overlapReport.thresholds.opening_similarity_score);
  assert.equal(artifacts.acceptanceGates.ko.status, 'passed');
  assert.equal(artifacts.acceptanceGates.ja.status, 'passed');
  assert.equal(artifacts.draftSpecs.ko.subtitle_layout, 'fast_compact_center_bottom');
  assert.equal(artifacts.draftSpecs.ja.subtitle_layout, 'measured_two_line_bottom_safe');
});

test('overlap guard fails identical locale clip chains', () => {
  const inputs = sampleInputs();
  const strategy = buildLocaleEditorialStrategy('ko', { artifact_type: 'midform_locale_evidence_pack' });
  const artifacts = buildLocaleBranchArtifacts(inputs);
  const cloned = {
    ...artifacts.editPlans.ko,
    locale: 'ja',
    strategy: { ...strategy, locale: 'ja' },
    clip_chain: artifacts.editPlans.ko.clip_chain.map((clip) => ({ ...clip, clip_id: clip.clip_id.replace(/^ko_/, 'ja_') })),
    opening_window: artifacts.editPlans.ko.opening_window.map((clip) => ({ ...clip, clip_id: clip.clip_id.replace(/^ko_/, 'ja_') })),
    highlight_order: [...artifacts.editPlans.ko.highlight_order]
  };
  const report = compareLocaleEditPlans(artifacts.editPlans.ko, cloned);

  assert.equal(report.final_status, 'fail');
  assert.ok(report.failed_gates.includes('top_three_highlight_order_identical'));
  assert.ok(report.failed_gates.includes('three_shot_chain_threshold'));
  assert.ok(report.pairwise_overlap_score > report.thresholds.pairwise_overlap_score);
});

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildEditorialReviewArtifact } = require('../server/services/midformBootstrapAdapterService');
const { assertCleanViewerSubtitleText } = require('./artifactQaHelpers');

test('editorial review artifact exposes role, risk, source lines, and callback linkage', () => {
  assert.equal(typeof buildEditorialReviewArtifact, 'function');

  const editPlan = {
    scene_type: 'dialogue_confrontation',
    editorial_pattern: 'cold_open_callback',
    timeline: [{
      slot_id: 'slot_01',
      beat_id: 'B003',
      role: 'cold_open',
      decision: 'KEEP_DIALOGUE',
      editorial_role: 'hook_teaser',
      teaser_slot_id: 'slot_01',
      callback_slot_id: 'slot_04',
      callback_relation: 'same_conflict_axis',
      reused_conflict_axis: 'ad_blame',
      source_lines: ['slot_01_L01', 'slot_01_L02'],
      semantic_risk: 'medium',
      pronoun_risk: true,
      standalone_score: 0.72,
      boundary_score: 0.78,
      qc_action: { action: 'merge_adjacent_lines', reason: 'paired exchange', source: 'test' },
      dialogue_unit: {
        unit_id: 'exchange_001',
        relation_type: 'accusation_rebuttal',
        source_line_ids: ['slot_01_L01', 'slot_01_L02'],
        start_sec: 161.08,
        end_sec: 164.069
      }
    }]
  };
  const script = {
    segments: [{
      segment_id: 'slot_01_L01',
      parent_slot_id: 'slot_01',
      speaker: 'Scully',
      caption_text: '그 광고를 죽인 건 내가 아니야.',
      dialogue_original: "I didn't kill the ad.",
      source_line_id: 'slot_01_L01'
    }]
  };

  const artifact = buildEditorialReviewArtifact(editPlan, script);

  assert.equal(artifact.scene_type, 'dialogue_confrontation');
  assert.equal(artifact.editorial_pattern, 'cold_open_callback');
  assert.equal(artifact.slots.length, 1);
  assert.equal(artifact.slots[0].editorial_role, 'hook_teaser');
  assert.equal(artifact.slots[0].callback_slot_id, 'slot_04');
  assert.equal(artifact.slots[0].callback_relation, 'same_conflict_axis');
  assert.equal(artifact.slots[0].dialogue_unit.relation_type, 'accusation_rebuttal');
  assert.equal(artifact.slots[0].risk.semantic_risk, 'medium');
  assert.equal(artifact.slots[0].source_lines[0].source_line_id, 'slot_01_L01');
  assert.match(artifact.slots[0].source_lines[0].caption_text, /광고/);
});

test('editorial review-only metadata remains separate from clean viewer subtitle text', () => {
  const artifact = buildEditorialReviewArtifact({
    timeline: [{
      slot_id: 'slot_01',
      beat_id: 'B001',
      role: 'body',
      decision: 'KEEP_DIALOGUE',
      source_lines: ['slot_01_L01'],
      qc_action: { action: 'bridge_required', reason: 'context needed', source: 'test' }
    }]
  }, {
    segments: [{
      segment_id: 'slot_01_L01',
      parent_slot_id: 'slot_01',
      caption_text: '그는 끝까지 물러서지 않았습니다.',
      source_line_id: 'slot_01_L01'
    }]
  });

  assert.equal(artifact.slots[0].qc_action.action, 'bridge_required');
  assert.equal(assertCleanViewerSubtitleText('그는 끝까지 물러서지 않았습니다.'), true);
});

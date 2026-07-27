const assert = require('node:assert/strict');
const test = require('node:test');

const Ajv = require('ajv');

const { readJson } = require('./artifactQaHelpers');

function buildValidate() {
  const ajv = new Ajv({ allErrors: true });
  return ajv.compile(readJson('midform/schemas/midform_compression_edit_plan_schema.json'));
}

function baseEditPlan() {
  return {
    cold_open_selection: {
      beat_id: 'B001',
      source: 'fallback',
      fallback_used: false,
      fallback_reason: '',
      heatmap_peak_start_sec: 1,
      heatmap_peak_end_sec: 4,
      reason: 'test fixture',
      teaser_visual_mode: 'beat',
      teaser_visual_beat_id: 'B001',
      teaser_visual_start_sec: 1,
      teaser_visual_end_sec: 4
    },
    timeline: [{
      slot_id: 'slot_01',
      beat_id: 'B001',
      role: 'cold_open',
      decision: 'KEEP_DIALOGUE',
      start_sec: 1,
      end_sec: 4,
      estimated_duration_sec: 3,
      reason: 'test fixture',
      spoiler_policy: 'avoid_answer',
      repeat_policy: 'allow_callback',
      visual_source_mode: 'beat',
      visual_source_beat_id: 'B001',
      visual_source_start_sec: 1,
      visual_source_end_sec: 4,
      dialogue_focus_source: 'anchor_dialogue',
      dialogue_focus_lines: ['Why did you do it?', 'Because I had no choice.'],
      dialogue_focus_quotes: ['Why did you do it?', 'Because I had no choice.'],
      replay_of_slot_id: '',
      replay_mode: ''
    }],
    duration_budget: {
      target_sec: 90,
      estimated_total_sec: 90,
      keep_dialogue_sec: 3,
      narration_sec: 87
    },
    quality_check: {
      cold_open_has_no_answer: true,
      body_reaches_cold_open_again: true,
      timeline_roles_present: true,
      target_duration_reasonable: true
    }
  };
}

test('compression edit-plan schema remains compatible with legacy metadata shape', () => {
  const validate = buildValidate();
  const plan = baseEditPlan();

  assert.equal(validate(plan), true, JSON.stringify(validate.errors, null, 2));
});

test('compression edit-plan schema accepts generalized editorial metadata only when explicit', () => {
  const validate = buildValidate();
  const plan = baseEditPlan();
  plan.scene_type = 'dialogue_confrontation';
  plan.editorial_pattern = 'cold_open_callback';
  plan.hook_teaser = {
    enabled: true,
    source_lines: ['Why did you do it?', 'Because I had no choice.'],
    time_range: [1, 4],
    speaker: 'Speaker A',
    hook_score: 92,
    context_dependency: 'low',
    editorial_role: 'hook_teaser',
    dialogue_unit: {
      unit_id: 'exchange_001',
      relation_type: 'question_answer',
      source_line_ids: ['slot_01_L01', 'slot_01_L02'],
      start_sec: 1,
      end_sec: 4
    },
    teaser_slot_id: 'slot_01',
    callback_slot_id: 'slot_03',
    callback_relation: 'payoff_response',
    reused_conflict_axis: 'truth_vs_control'
  };
  plan.context_reset = {
    enabled: true,
    target_duration_sec: 18,
    explanation_sufficiency: 'sufficient',
    spoiler_leakage: 'none',
    callback_readiness: 'ready'
  };
  plan.callback_dialogue = {
    enabled: true,
    source_lines: ['Here is the answer.'],
    time_range: [22, 26],
    relation_to_teaser: 'payoff_response',
    callback_slot_id: 'slot_03',
    callback_relation: 'payoff_response',
    reused_conflict_axis: 'truth_vs_control'
  };
  plan.timeline[0].scene_type = 'dialogue_confrontation';
  plan.timeline[0].editorial_role = 'hook_teaser';
  plan.timeline[0].dialogue_unit = {
    unit_id: 'exchange_001',
    relation_type: 'question_answer',
    source_line_ids: ['slot_01_L01', 'slot_01_L02'],
    start_sec: 1,
    end_sec: 4
  };
  plan.timeline[0].teaser_slot_id = 'slot_01';
  plan.timeline[0].callback_slot_id = 'slot_03';
  plan.timeline[0].callback_relation = 'payoff_response';
  plan.timeline[0].reused_conflict_axis = 'truth_vs_control';
  plan.timeline[0].qc_action = {
    action: 'merge_adjacent_lines',
    reason: 'question and answer should remain together',
    source: 'dialogue_unit_controller'
  };

  assert.equal(validate(plan), true, JSON.stringify(validate.errors, null, 2));
});

test('compression edit-plan schema still rejects unrelated arbitrary fields', () => {
  const validate = buildValidate();
  const plan = baseEditPlan();
  plan.unrelated_debug_blob = { pass: true };

  assert.equal(validate(plan), false);
  assert.ok(validate.errors.some((error) => error.keyword === 'additionalProperties'));
});

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildBootstrapSlotMapAndScript } = require('../server/services/midformBootstrapAdapterService');
const { _test } = require('../server/services/midformCompressionService');

test('bootstrap preserves editorial exchange metadata while keeping line-level dialogue segments', () => {
  const editPlan = {
    scene_type: 'dialogue_confrontation',
    timeline: [{
      slot_id: 'slot_01',
      beat_id: 'B003',
      role: 'cold_open',
      decision: 'KEEP_DIALOGUE',
      editorial_role: 'hook_teaser',
      teaser_slot_id: 'slot_01',
      callback_slot_id: 'slot_04',
      callback_relation: 'same_conflict_axis',
      reused_conflict_axis: 'ad blame',
      dialogue_unit: {
        unit_id: 'exchange_001',
        relation_type: 'accusation_rebuttal',
        source_line_ids: ['slot_01_L01', 'slot_01_L02'],
        start_sec: 10,
        end_sec: 14
      },
      dialogue_line_windows: [
        { matched: true, start_sec: 10, end_sec: 11.5, line: 'You tried to kill it.' },
        { matched: true, start_sec: 11.7, end_sec: 14, line: "I didn't kill it." }
      ]
    }]
  };
  const slotFills = {
    slot_fills: [{
      slot_id: 'slot_01',
      caption_kr_dialogue: ['당신이 죽이려 했잖아.', '난 죽인 게 아니야.'],
      speakers: ['Jobs', 'Scully'],
      translation_mode: 'faithful_dialogue'
    }]
  };

  const { slotMap, script } = buildBootstrapSlotMapAndScript(editPlan, slotFills, { sourceDurationSec: 120 });
  const dialogueSegments = script.segments.filter((segment) => segment.segment_type === 'dialogue_quote');

  assert.equal(dialogueSegments.length, 2);
  assert.equal(slotMap.slots.length, 2);
  assert.ok(!Object.prototype.hasOwnProperty.call(script, 'slot_map'));
  assert.ok(dialogueSegments.every((segment) => segment.dialogue_unit.relation_type === 'accusation_rebuttal'));
  assert.ok(dialogueSegments.every((segment) => segment.editorial_role === 'hook_teaser'));
  assert.ok(dialogueSegments.every((segment) => segment.callback_slot_id === 'slot_04'));
});

test('finalizeEditPlan generates dialogue_unit metadata before bootstrap when source plan lacks it', () => {
  const transcript = [
    { start_sec: 10, end_sec: 11.5, text: 'You tried to kill it.' },
    { start_sec: 11.7, end_sec: 14, text: "I didn't kill it." }
  ];
  const beats = [{
    beat_id: 'B001',
    start_sec: 9,
    end_sec: 20,
    summary: 'A confrontation over who killed the ad.',
    key_dialogue: ['You tried to kill it.', "I didn't kill it."],
    anchor_dialogue: ['You tried to kill it.', "I didn't kill it."],
    dramatic_weight: 5,
    dialogue_quality: 'high',
    hook_potential: 5
  }];
  const editPlan = {
    dialogue_driven_scene: true,
    confrontation_scene: true,
    cold_open_selection: { beat_id: 'B001' },
    timeline: [
      { slot_id: 'slot_01', beat_id: 'B001', role: 'cold_open', decision: 'NARRATE', start_sec: 9, end_sec: 20, estimated_duration_sec: 5 },
      { slot_id: 'slot_02', beat_id: 'B001', role: 'body_peak', decision: 'NARRATE', start_sec: 9, end_sec: 20, estimated_duration_sec: 20 }
    ],
    duration_budget: { target_sec: 90 }
  };

  const finalized = _test.finalizeEditPlan(editPlan, beats, transcript, 90);
  const hook = finalized.timeline.find((slot) => slot.role === 'cold_open');
  assert.ok(hook.dialogue_unit);
  assert.equal(hook.dialogue_unit.relation_type, 'accusation_rebuttal');
  assert.deepEqual(hook.dialogue_unit.source_line_ids, ['slot_01_L01', 'slot_01_L02']);

  const slotFills = {
    slot_fills: [{
      slot_id: 'slot_01',
      caption_kr_dialogue: ['당신이 죽이려 했잖아.', '난 죽인 게 아니야.'],
      speakers: ['Jobs', 'Scully'],
      translation_mode: 'faithful_dialogue'
    }]
  };
  const { script } = buildBootstrapSlotMapAndScript(finalized, slotFills, { sourceDurationSec: 120 });
  const dialogueSegments = script.segments.filter((segment) => segment.segment_type === 'dialogue_quote');
  assert.equal(dialogueSegments.length, 2);
  assert.ok(dialogueSegments.every((segment) => segment.dialogue_unit.relation_type === 'accusation_rebuttal'));
  assert.ok(dialogueSegments.every((segment) => segment.dialogue_unit.source_line_ids.includes('slot_01_L01')));
});

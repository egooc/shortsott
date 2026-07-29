const assert = require('node:assert/strict');
const test = require('node:test');

const { buildBootstrapSlotMapAndScript } = require('../server/services/midformBootstrapAdapterService');
const { _test } = require('../server/services/midformCompressionService');
const { buildCaptionUnits } = require('../server/utils/captionUnits');

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
      caption_kr_dialogue: ['“당신이 죽이려 했잖아”라고 말합니다.', '난 죽인 게 아니야.'],
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
  assert.equal(dialogueSegments[0].caption_text, '당신이 죽이려 했잖아');
  assert.ok(dialogueSegments.every((segment) => segment.editorial_role === 'hook_teaser'));
  assert.ok(dialogueSegments.every((segment) => segment.callback_slot_id === 'slot_04'));
});

test('bootstrap pads KEEP_DIALOGUE video while preserving speech-aligned caption timing', () => {
  const editPlan = {
    scene_type: 'dialogue_confrontation',
    timeline: [{
      slot_id: 'slot_01',
      beat_id: 'B003',
      role: 'cold_open',
      decision: 'KEEP_DIALOGUE',
      editorial_role: 'hook_teaser',
      dialogue_unit: {
        unit_id: 'exchange_001',
        relation_type: 'question_answer',
        source_line_ids: ['slot_01_L01', 'slot_01_L02'],
        start_sec: 10,
        end_sec: 14
      },
      dialogue_line_windows: [
        { matched: true, start_sec: 10, end_sec: 11.5, line: 'Why did you do it?' },
        { matched: true, start_sec: 11.7, end_sec: 14, line: "I didn't do anything." }
      ]
    }]
  };
  const slotFills = {
    slot_fills: [{
      slot_id: 'slot_01',
      caption_kr_dialogue: ['왜 그런 거야?', '난 아무것도 안 했어.'],
      speakers: ['A', 'B'],
      translation_mode: 'faithful_dialogue'
    }]
  };

  const { slotMap, script } = buildBootstrapSlotMapAndScript(editPlan, slotFills, { sourceDurationSec: 120 });
  const firstSlot = slotMap.slots[0];
  const firstSegment = script.segments[0];
  const secondSegment = script.segments[1];

  assert.deepEqual(firstSegment.dialogue_speech_range_sec, [10, 11.5]);
  assert.deepEqual(firstSegment.source_scenes[0].start, '00:00:09.300');
  assert.deepEqual(firstSegment.source_scenes[0].end, '00:00:11.650');
  assert.equal(firstSegment.caption_timeline_offset_sec, 0.78);
  assert.equal(firstSegment.dialogue_timing_adjustment.caption_start_delay_sec, 0.08);
  assert.equal(firstSegment.duration_override_sec, 1.42);
  assert.equal(firstSegment.dialogue_timing_adjustment.visual_duration_sec, 2.35);
  assert.deepEqual(firstSlot.source_range, [9.3, 11.65]);
  assert.ok(firstSegment.dialogue_timing_adjustment.applied_post_roll_sec <= 0.15);
  assert.equal(secondSegment.source_scenes[0].start, '00:00:11.520');
  assert.ok(secondSegment.dialogue_timing_adjustment.applied_pre_roll_sec < 0.7);

  const captionData = buildCaptionUnits(script.segments);
  const firstCaption = captionData.captionUnits[0];
  assert.equal(firstCaption.caption_timeline_offset_sec, 0.78);
  assert.equal(firstCaption.duration_override_sec, 1.42);
  assert.deepEqual(firstCaption.dialogue_speech_range_sec, [10, 11.5]);
  assert.equal(firstCaption.caption_kind, 'dialogue');
  assert.equal(firstCaption.speaker_id, 'a');
  assert.equal(firstCaption.speaker_alias, 'A');
  assert.equal(firstCaption.source_utterance_id, 'slot_01_L01');
});

test('dialogue cleanup preserves stable speaker metadata and color keys', () => {
  const editPlan = {
    scene_type: 'dialogue_confrontation',
    timeline: [{
      slot_id: 'slot_01',
      role: 'cold_open',
      decision: 'KEEP_DIALOGUE',
      dialogue_line_windows: [
        { matched: true, start_sec: 10, end_sec: 11.5, line: 'You tried to kill it.' },
        { matched: true, start_sec: 11.7, end_sec: 14, line: "I didn't kill it." }
      ]
    }]
  };
  const slotFills = {
    slot_fills: [{
      slot_id: 'slot_01',
      caption_kr_dialogue: ['“당신이 죽이려 했잖아”라고 말합니다.', '난 죽인 게 아니야.'],
      speakers: ['Jobs', 'Sculley']
    }]
  };

  const { script } = buildBootstrapSlotMapAndScript(editPlan, slotFills, { sourceDurationSec: 120 });
  const captionData = buildCaptionUnits(script.segments);

  assert.equal(script.segments[0].caption_text, '당신이 죽이려 했잖아');
  assert.equal(script.segments[0].speaker_id, 'jobs');
  assert.equal(script.segments[0].speaker_color_key, '남주');
  assert.equal(script.segments[0].caption_color, '#00A9F7');
  assert.equal(script.segments[1].speaker_id, 'sculley');
  assert.equal(script.segments[1].speaker_color_key, '남조연');
  assert.equal(script.segments[1].caption_color, '#37FF3D');
  assert.equal(captionData.captionUnits[0].speaker_id, 'jobs');
  assert.equal(captionData.captionUnits[1].speaker_color_key, '남조연');
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

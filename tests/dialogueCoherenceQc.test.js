const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');
const { buildBootstrapSlotMapAndScript } = require('../server/services/midformBootstrapAdapterService');

test('Steve Jobs KEEP_DIALOGUE with pronoun/deictic dependency keeps micro-exchange context and review tags', () => {
  const transcript = [
    { start_sec: 485.24, end_sec: 488.27, text: "you going to end me aren't you" },
    { start_sec: 507.51, end_sec: 509.68, text: "don't manipulate him like that whatever you may think I'm always going to to protect him" }
  ];
  const beats = [
    { beat_id: 'B001', start_sec: 0, end_sec: 10, key_dialogue: ['why do people think I fired you'], anchor_dialogue: ['why do people think I fired you'], dialogue_quality: 'mid', hook_potential: 3, dramatic_weight: 3 },
    {
      beat_id: 'B006',
      start_sec: 480,
      end_sec: 515,
      key_dialogue: transcript.map((cue) => cue.text),
      anchor_dialogue: [transcript[1].text],
      dialogue_quality: 'high',
      hook_potential: 5,
      dramatic_weight: 5
    }
  ];
  const editPlan = {
    cold_open_selection: { beat_id: 'B006' },
    timeline: [
      { slot_id: 'slot_01', beat_id: 'B001', role: 'cold_open', decision: 'NARRATE', start_sec: 0, end_sec: 5, estimated_duration_sec: 4 },
      {
        slot_id: 'slot_07',
        beat_id: 'B006',
        role: 'body_peak',
        decision: 'KEEP_DIALOGUE',
        start_sec: 507.51,
        end_sec: 509.68,
        estimated_duration_sec: 2.17,
        dialogue_focus_quotes: [transcript[1].text],
        dialogue_focus_lines: [transcript[1].text]
      }
    ],
    duration_budget: { target_sec: 180 }
  };

  const finalized = _test.finalizeEditPlan(editPlan, beats, transcript, 180);
  const dialogueSlot = finalized.timeline.find((slot) => slot.slot_id === 'slot_07');
  assert.equal(dialogueSlot.mode, 'KEEP_DIALOGUE');
  assert.equal(dialogueSlot.requires_context, true);
  assert.equal(dialogueSlot.context_strategy, 'merge_exchange');
  assert.equal(dialogueSlot.pronoun_risk, true);
  assert.equal(dialogueSlot.dialogue_focus_lines[0], transcript[0].text);
  assert.equal(dialogueSlot.dialogue_focus_lines[1], transcript[1].text);
  assert.ok(dialogueSlot.source_lines.includes('slot_07_L01'));
  assert.ok(dialogueSlot.source_lines.includes('slot_07_L02'));

  const slotFills = {
    upload_text: { title_candidates: ['왜 그랬을까?', '무슨 일이었을까?', '누가 옳았을까?'], overlay_title: { top: '잡스의', bottom: '충돌' }, description: 'x', pinned_comment: 'x' },
    slot_fills: [{
      slot_id: 'slot_07',
      narration: '',
      caption_units: [],
      caption_kr: '',
      caption_kr_dialogue: ['날 끝장내려는 거군, 안 그래?', '그를 그런 식으로 이용하지 마. 난 언제나 그를 지킬 거야.'],
      speakers: ['Steve Jobs', 'Steve Jobs'],
      translation_mode: 'faithful_dialogue'
    }]
  };
  const qc = _test.buildSlotQcReport(finalized, slotFills);
  const qcSlot = qc.slots.find((slot) => slot.slot_id === 'slot_07');
  assert.equal(qcSlot.translation_mode, 'faithful_dialogue');
  assert.equal(qcSlot.recommended_fix, 'merge_exchange');
  assert.equal(qcSlot.applied_fix, 'merged_previous_line');
  assert.equal(qcSlot.qc_action.action, 'merge_adjacent_lines');
  assert.equal(qcSlot.qc_action.source, 'dialogue_slot_annotation');

  const { script } = buildBootstrapSlotMapAndScript(finalized, slotFills, { sourceDurationSec: 532.601, title: 'Steve Jobs regression' });
  const dialogueSegments = script.segments.filter((segment) => segment.segment_type === 'dialogue_quote');
  assert.equal(dialogueSegments.length, 2);
  assert.ok(dialogueSegments.every((segment) => segment.source_type === 'KEEP_DIALOGUE_BRIDGED'));
  assert.ok(dialogueSegments.every((segment) => segment.translation_mode === 'faithful_dialogue'));
});

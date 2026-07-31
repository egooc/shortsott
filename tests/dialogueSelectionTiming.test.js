const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');
const {
  readJson,
  activeSegmentsFromManifest,
  firstDialogueStartSec,
  callbackDialogueStartSec,
  maxContinuousNarrationRunSec
} = require('./artifactQaHelpers');

test('artifact helper detects the current Steve Jobs render enters KEEP_DIALOGUE too late', () => {
  const manifest = readJson('tests/fixtures/midform/drafts/late_dialogue_baseline/edit_manifest.json');
  const segments = activeSegmentsFromManifest(manifest);

  assert.ok(segments.length > 0);
  assert.ok(firstDialogueStartSec(segments) > 40);
  assert.ok(maxContinuousNarrationRunSec(segments) > 25);
});

test('dialogue-driven confrontation timing QC rejects first KEEP_DIALOGUE after 40s', () => {
  assert.equal(typeof _test.evaluateDialogueTimingQc, 'function');

  const result = _test.evaluateDialogueTimingQc([
    { slot_id: 'slot_01', decision: 'NARRATE', estimated_duration_sec: 22, role: 'cold_open' },
    { slot_id: 'slot_02', decision: 'NARRATE', estimated_duration_sec: 15, role: 'bridge' },
    { slot_id: 'slot_03', decision: 'NARRATE', estimated_duration_sec: 10, role: 'body' },
    { slot_id: 'slot_04', decision: 'KEEP_DIALOGUE', estimated_duration_sec: 6, role: 'payoff' }
  ], {
    dialogueDrivenConfrontation: true,
    totalRuntimeSec: 97.1
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.first_dialogue_start_sec, 47);
  assert.ok(result.violations.includes('first_dialogue_after_40s'));
  assert.ok(result.warnings.includes('first_dialogue_after_35s'));
});

test('cold open callback timing QC allows teaser dialogue at 0s and requires callback by 35s', () => {
  const result = _test.evaluateDialogueTimingQc([
    { slot_id: 'slot_01', decision: 'KEEP_DIALOGUE', estimated_duration_sec: 3.8, role: 'cold_open' },
    { slot_id: 'slot_02', decision: 'NARRATE', estimated_duration_sec: 16.5, role: 'bridge' },
    { slot_id: 'slot_03', decision: 'KEEP_DIALOGUE', estimated_duration_sec: 7.2, role: 'body_peak', replay_of_slot_id: 'slot_01' },
    { slot_id: 'slot_04', decision: 'NARRATE', estimated_duration_sec: 10, role: 'body' }
  ], {
    dialogueDrivenConfrontation: true,
    editorialPattern: 'cold_open_callback',
    totalRuntimeSec: 95
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.first_dialogue_start_sec, 0);
  assert.equal(result.callback_dialogue_start_sec, 20.3);
  assert.ok(!result.violations.includes('first_dialogue_after_40s'));
});

test('finalizeEditPlan builds cold_open_callback metadata with hook teaser and callback dialogue', () => {
  const transcript = [
    { start_sec: 20.0, end_sec: 22.1, text: 'why do people think I fired you' },
    { start_sec: 24.0, end_sec: 25.9, text: 'you tried to kill it' },
    { start_sec: 187.1, end_sec: 191.6, text: "I didn't kill the ad Steve I'm the only reason that made it on the air" },
    { start_sec: 198.9, end_sec: 203.4, text: 'I was the only thing protecting it' }
  ];
  const beats = [
    {
      beat_id: 'B001',
      start_sec: 1.9,
      end_sec: 61.9,
      summary: 'Steve accuses Sculley of firing him and trying to kill the 1984 ad.',
      key_dialogue: ['why do people think I fired you', 'you tried to kill it'],
      anchor_dialogue: ['why do people think I fired you', 'you tried to kill it'],
      dramatic_weight: 3,
      dialogue_quality: 'high',
      hook_potential: 4
    },
    {
      beat_id: 'B003',
      start_sec: 161.0,
      end_sec: 239.8,
      summary: 'Sculley reverses Steve\'s belief about the ad and says he protected it.',
      key_dialogue: ["I didn't kill the ad Steve I'm the only reason that made it on the air", 'I was the only thing protecting it'],
      anchor_dialogue: ["I didn't kill the ad Steve I'm the only reason that made it on the air"],
      dramatic_weight: 5,
      dialogue_quality: 'high',
      hook_potential: 5
    }
  ];
  const editPlan = {
    dialogue_driven_scene: true,
    confrontation_scene: true,
    cold_open_selection: { beat_id: 'B003' },
    timeline: [
      { slot_id: 'slot_01', beat_id: 'B003', role: 'cold_open', decision: 'NARRATE', start_sec: 161, end_sec: 239.8, estimated_duration_sec: 5 },
      { slot_id: 'slot_02', beat_id: 'B001', role: 'bridge', decision: 'NARRATE', start_sec: 1.9, end_sec: 61.9, estimated_duration_sec: 17 },
      { slot_id: 'slot_03', beat_id: 'B003', role: 'body_peak', decision: 'NARRATE', start_sec: 161, end_sec: 239.8, estimated_duration_sec: 12 }
    ],
    duration_budget: { target_sec: 90 }
  };

  const finalized = _test.finalizeEditPlan(editPlan, beats, transcript, 90);

  assert.equal(finalized.editorial_pattern, 'cold_open_callback');
  assert.equal(finalized.hook_teaser.enabled, true);
  assert.match(finalized.hook_teaser.source_lines.join(' '), /didn't kill the ad/i);
  assert.equal(finalized.context_reset.enabled, true);
  assert.equal(finalized.context_reset.explanation_sufficiency, 'sufficient');
  assert.equal(finalized.context_reset.spoiler_leakage, 'none');
  assert.equal(finalized.context_reset.callback_readiness, 'ready');
  assert.equal(finalized.callback_dialogue.enabled, true);
  assert.ok(['same_line_callback', 'same_conflict_axis'].includes(finalized.callback_dialogue.relation_to_teaser));
  assert.ok(finalized.hook_teaser.teaser_slot_id);
  assert.ok(finalized.hook_teaser.callback_slot_id);
  assert.equal(finalized.callback_dialogue.callback_relation, finalized.callback_dialogue.relation_to_teaser);
  assert.ok(finalized.callback_dialogue.reused_conflict_axis);
  assert.equal(finalized.dialogue_timing_qc.status, 'passed');
});

test('finalizeEditPlan inserts context bridge when dialogue cold open starts on first beat', () => {
  const transcript = [
    { start_sec: 7.5, end_sec: 12.4, text: 'how come you never liked me' },
    { start_sec: 14.1, end_sec: 18.5, text: 'what law is there say I got to like you' },
    { start_sec: 22.3, end_sec: 25.1, text: 'talk about liking somebody call me boy when I talk to you' },
    { start_sec: 60.0, end_sec: 62.0, text: 'you do what I say' }
  ];
  const beats = [
    {
      beat_id: 'beat_01',
      start_sec: 7.0,
      end_sec: 30.0,
      summary: 'A father and son argue over respect and affection.',
      key_dialogue: ['how come you never liked me', 'what law is there say I got to like you', 'talk about liking somebody call me boy when I talk to you'],
      anchor_dialogue: ['how come you never liked me', 'what law is there say I got to like you'],
      dramatic_weight: 5,
      dialogue_quality: 'high',
      hook_potential: 5
    },
    {
      beat_id: 'beat_02',
      start_sec: 55.0,
      end_sec: 70.0,
      summary: 'The argument hardens into authority.',
      key_dialogue: ['you do what I say'],
      anchor_dialogue: ['you do what I say'],
      dramatic_weight: 3,
      dialogue_quality: 'high',
      hook_potential: 3
    }
  ];
  const editPlan = {
    dialogue_driven_scene: true,
    confrontation_scene: true,
    cold_open_selection: { beat_id: 'beat_01' },
    timeline: [
      { slot_id: 'slot_01', beat_id: 'beat_01', role: 'cold_open', decision: 'KEEP_DIALOGUE', start_sec: 7.25, end_sec: 19.06, estimated_duration_sec: 11.81, dialogue_focus_quotes: ['how come you never liked me', 'what law is there say I got to like you'], dialogue_focus_lines: ['how come you never liked me', 'what law is there say I got to like you'] },
      { slot_id: 'slot_02', beat_id: 'beat_01', role: 'body_peak', decision: 'KEEP_DIALOGUE', start_sec: 22.0, end_sec: 25.2, estimated_duration_sec: 3.2, dialogue_focus_quotes: ['talk about liking somebody call me boy when I talk to you'], dialogue_focus_lines: ['talk about liking somebody call me boy when I talk to you'] },
      { slot_id: 'slot_03', beat_id: 'beat_02', role: 'payoff', decision: 'KEEP_DIALOGUE', start_sec: 60, end_sec: 62, estimated_duration_sec: 2, dialogue_focus_quotes: ['you do what I say'], dialogue_focus_lines: ['you do what I say'] },
      { slot_id: 'slot_closing', beat_id: 'beat_02', role: 'closing', decision: 'NARRATE', start_sec: 62, end_sec: 70, estimated_duration_sec: 8 }
    ],
    duration_budget: { target_sec: 120 }
  };

  const finalized = _test.finalizeEditPlan(editPlan, beats, transcript, 120);
  const activeRoles = finalized.timeline.filter((item) => item.decision !== 'DROP').map((item) => item.role);

  assert.ok(activeRoles.includes('bridge'));
  assert.ok(activeRoles.includes('closing'));
  assert.equal(finalized.timeline[1].role, 'bridge');
  assert.equal(finalized.timeline[1].decision, 'NARRATE');
  assert.equal(finalized.context_reset.enabled, true);
});

test('finalizeEditPlan inserts context bridge before early callback dialogue when local fallback omitted bridge role', () => {
  const transcript = [
    { start_sec: 30.95, end_sec: 32.91, text: 'please a hubing' },
    { start_sec: 32.91, end_sec: 36.559, text: 'is here to see so this must be a mistake there is no' },
    { start_sec: 79.55, end_sec: 82.109, text: 'you can they do this sir the decree is' },
    { start_sec: 82.109, end_sec: 86.4, text: 'the decree is signed by the 12 members of the table giving the Marquee the power of Em emperator' },
    { start_sec: 88.92, end_sec: 93.71, text: 'which means he is now our judge jewry' },
    { start_sec: 116.31, end_sec: 118.7, text: 'this will not be pleasant' }
  ];
  const beats = [
    {
      beat_id: 'B001',
      start_sec: 30.95,
      end_sec: 93.71,
      summary: 'The Marquis arrives with High Table authority over the Continental.',
      key_dialogue: [
        'please a hubing',
        'is here to see so this must be a mistake there is no',
        'you can they do this sir the decree is',
        'the decree is signed by the 12 members of the table giving the Marquee the power of Em emperator',
        'which means he is now our judge jewry'
      ],
      anchor_dialogue: [
        'the decree is signed by the 12 members of the table giving the Marquee the power of Em emperator',
        'which means he is now our judge jewry'
      ],
      dramatic_weight: 4,
      dialogue_quality: 'mid',
      hook_potential: 3
    },
    {
      beat_id: 'B002',
      start_sec: 116.31,
      end_sec: 170.99,
      summary: 'The Marquis makes the threat explicit.',
      key_dialogue: ['this will not be pleasant'],
      anchor_dialogue: ['this will not be pleasant'],
      dramatic_weight: 3,
      dialogue_quality: 'high',
      hook_potential: 3
    },
    {
      beat_id: 'B003',
      start_sec: 173.19,
      end_sec: 253.27,
      summary: 'The argument broadens into the rules of the table.',
      key_dialogue: ['how you do anything is how you do everything'],
      anchor_dialogue: ['how you do anything is how you do everything'],
      dramatic_weight: 3,
      dialogue_quality: 'mid',
      hook_potential: 2
    }
  ];
  const editPlan = {
    dialogue_driven_scene: false,
    confrontation_scene: false,
    cold_open_selection: { beat_id: 'B001' },
    timeline: [
      {
        slot_id: 'slot_01',
        beat_id: 'B001',
        role: 'cold_open',
        decision: 'KEEP_DIALOGUE',
        start_sec: 30.95,
        end_sec: 37.059,
        estimated_duration_sec: 6.109,
        dialogue_focus_quotes: ['please a hubing', 'is here to see so this must be a mistake there is no'],
        dialogue_focus_lines: ['please a hubing', 'is here to see so this must be a mistake there is no']
      },
      {
        slot_id: 'slot_02',
        beat_id: 'B002',
        role: 'body_peak',
        decision: 'KEEP_DIALOGUE',
        start_sec: 116.31,
        end_sec: 118.7,
        estimated_duration_sec: 2.39,
        dialogue_focus_quotes: ['this will not be pleasant'],
        dialogue_focus_lines: ['this will not be pleasant']
      },
      { slot_id: 'slot_03', beat_id: 'B003', role: 'body', decision: 'NARRATE', start_sec: 173.19, end_sec: 253.27, estimated_duration_sec: 15 }
    ],
    duration_budget: { target_sec: 150 }
  };

  const finalized = _test.finalizeEditPlan(editPlan, beats, transcript, 150);
  const active = finalized.timeline.filter((item) => item.decision !== 'DROP');
  const bridgeIndex = active.findIndex((item) => item.role === 'bridge');
  const callbackIndex = active.findIndex((item) => item.slot_id === 'slot_02');

  assert.equal(active[1].role, 'bridge');
  assert.equal(active[1].decision, 'NARRATE');
  assert.ok(bridgeIndex > 0 && bridgeIndex < callbackIndex);
  assert.equal(finalized.context_reset.enabled, true);
});

test('finalizeEditPlan trims dialogue cold open to teaser cap after readable-window expansion', () => {
  const transcript = [
    { start_sec: 120.069, end_sec: 121.67, text: "aren't angry about being fired from" },
    { start_sec: 121.67, end_sec: 132.47, text: 'valley springs for touching your students' },
    { start_sec: 135.11, end_sec: 137.51, text: "i'm not the zodiac" },
    { start_sec: 137.51, end_sec: 140.15, text: "and if i was i certainly wouldn't tell you" },
    { start_sec: 167.67, end_sec: 174.96, text: 'later payoff reaction' }
  ];
  const beats = [
    {
      beat_id: 'B004',
      start_sec: 119.07,
      end_sec: 145.8,
      summary: 'The suspect turns the accusation back with a memorable denial.',
      key_dialogue: [
        "aren't angry about being fired from",
        'valley springs for touching your students',
        "i'm not the zodiac",
        "and if i was i certainly wouldn't tell you"
      ],
      anchor_dialogue: ["i'm not the zodiac", "and if i was i certainly wouldn't tell you"],
      dramatic_weight: 5,
      dialogue_quality: 'high',
      hook_potential: 5
    },
    {
      beat_id: 'B005',
      start_sec: 167.67,
      end_sec: 174.96,
      summary: 'The room reacts to the denial.',
      key_dialogue: ['later payoff reaction'],
      anchor_dialogue: ['later payoff reaction'],
      dramatic_weight: 4,
      dialogue_quality: 'mid',
      hook_potential: 4
    }
  ];
  const editPlan = {
    editorial_pattern: 'cold_open_callback',
    cold_open_selection: { beat_id: 'B004' },
    timeline: [
      {
        slot_id: 'slot_01',
        beat_id: 'B004',
        role: 'cold_open',
        decision: 'KEEP_DIALOGUE',
        start_sec: 120.069,
        end_sec: 140.15,
        estimated_duration_sec: 20.081,
        dialogue_focus_quotes: [
          "aren't angry about being fired from",
          'valley springs for touching your students',
          "i'm not the zodiac",
          "and if i was i certainly wouldn't tell you"
        ],
        dialogue_focus_lines: [
          "aren't angry about being fired from",
          'valley springs for touching your students',
          "i'm not the zodiac",
          "and if i was i certainly wouldn't tell you"
        ]
      },
      { slot_id: 'slot_02', beat_id: 'B005', role: 'bridge', decision: 'NARRATE', start_sec: 167.67, end_sec: 174.96, estimated_duration_sec: 8 }
    ],
    duration_budget: { target_sec: 120 }
  };

  const finalized = _test.finalizeEditPlan(editPlan, beats, transcript, 120);
  const cold = finalized.timeline.find((item) => item.role === 'cold_open');

  assert.equal(cold.decision, 'KEEP_DIALOGUE');
  assert.ok(cold.estimated_duration_sec <= 16, `cold_open duration ${cold.estimated_duration_sec}s should stay teaser-short`);
  assert.deepEqual(cold.dialogue_focus_lines, ["i'm not the zodiac", "and if i was i certainly wouldn't tell you"]);
  assert.equal(cold.visual_source_start_sec, cold.start_sec);
  assert.equal(cold.visual_source_end_sec, cold.end_sec);
});

test('finalizeEditPlan aligns hook qc_action with selector support action after coherence repair', () => {
  const transcript = [
    { start_sec: 161.05, end_sec: 162.7, text: "what to do with a can of soda I didn't" },
    { start_sec: 162.9, end_sec: 164.1, text: "I didn't kill the ad Steve I'm the only reason that made it on the air" },
    { start_sec: 188.3, end_sec: 191.0, text: 'screened it the board wanted that money' },
    { start_sec: 198.9, end_sec: 203.4, text: 'I was the only thing protecting it' }
  ];
  const beats = [
    {
      beat_id: 'B001',
      start_sec: 1.9,
      end_sec: 61.9,
      summary: 'Steve accuses Sculley of firing him and trying to kill the 1984 ad.',
      key_dialogue: ['why do people think I fired you', 'you tried to kill it'],
      anchor_dialogue: ['why do people think I fired you', 'you tried to kill it'],
      dramatic_weight: 3,
      dialogue_quality: 'high',
      hook_potential: 4
    },
    {
      beat_id: 'B003',
      start_sec: 161.0,
      end_sec: 239.8,
      summary: 'Sculley reveals he protected the 1984 ad instead of killing it.',
      key_dialogue: ["I didn't kill the ad Steve I'm the only reason that made it on the air", 'I was the only thing protecting it'],
      anchor_dialogue: ["I didn't kill the ad Steve I'm the only reason that made it on the air"],
      dramatic_weight: 5,
      dialogue_quality: 'high',
      hook_potential: 5
    }
  ];
  const editPlan = {
    dialogue_driven_scene: true,
    confrontation_scene: true,
    cold_open_selection: { beat_id: 'B003' },
    timeline: [
      { slot_id: 'slot_01', beat_id: 'B003', role: 'cold_open', decision: 'NARRATE', start_sec: 161, end_sec: 239.8, estimated_duration_sec: 5 },
      { slot_id: 'slot_02', beat_id: 'B001', role: 'bridge', decision: 'NARRATE', start_sec: 1.9, end_sec: 61.9, estimated_duration_sec: 17 },
      { slot_id: 'slot_04', beat_id: 'B003', role: 'body_peak', decision: 'NARRATE', start_sec: 161, end_sec: 239.8, estimated_duration_sec: 12 }
    ],
    duration_budget: { target_sec: 90 }
  };

  const finalized = _test.finalizeEditPlan(editPlan, beats, transcript, 90);
  const hook = finalized.timeline.find((slot) => slot.role === 'cold_open');

  assert.equal(hook.dialogue_selection_scores.required_support_action, 'merge_adjacent_lines');
  assert.equal(hook.qc_action.action, 'merge_adjacent_lines');
});

test('slot fill prompt exposes editorial metadata for hook, context reset, and callback writing', () => {
  assert.equal(typeof _test.buildSlotFillEditorialGuide, 'function');

  const editPlan = {
    scene_type: 'dialogue_confrontation',
    editorial_pattern: 'cold_open_callback',
    hook_teaser: { enabled: true, teaser_slot_id: 'slot_01', callback_slot_id: 'slot_04' },
    context_reset: { enabled: true, explanation_sufficiency: 'sufficient', callback_readiness: 'ready' },
    callback_dialogue: { enabled: true, callback_slot_id: 'slot_04', callback_relation: 'same_conflict_axis' },
    timeline: [
      {
        slot_id: 'slot_01',
        role: 'cold_open',
        decision: 'KEEP_DIALOGUE',
        editorial_role: 'hook_teaser',
        scene_type: 'dialogue_confrontation',
        teaser_slot_id: 'slot_01',
        callback_slot_id: 'slot_04',
        dialogue_unit: { relation_type: 'question_answer', source_line_ids: ['slot_01_L01', 'slot_01_L02'], start_sec: 161.08, end_sec: 164.069 },
        dialogue_selection_scores: { required_support_action: 'merge_adjacent_lines' },
        qc_action: { action: 'merge_adjacent_lines' },
        callback_relation: 'same_conflict_axis',
        reused_conflict_axis: '1984_ad_blame',
        requires_context: true,
        pronoun_risk: true,
        semantic_risk: 'high'
      },
      { slot_id: 'slot_02', role: 'bridge', decision: 'NARRATE', editorial_role: 'context_reset', scene_type: 'dialogue_confrontation' },
      { slot_id: 'slot_04', role: 'body_peak', decision: 'KEEP_DIALOGUE', editorial_role: 'callback_payoff', scene_type: 'dialogue_confrontation', callback_relation: 'same_conflict_axis' }
    ]
  };

  const guide = _test.buildSlotFillEditorialGuide(editPlan);
  const prompt = require('../server/services/midformCompressionService').buildSlotFillsPrompt([], editPlan, 'Steve Jobs', '');

  assert.equal(guide.slot_rules[0].required_support_action, 'merge_adjacent_lines');
  assert.equal(guide.slot_rules[0].dialogue_unit.relation_type, 'question_answer');
  assert.equal(guide.slot_rules[2].editorial_role, 'callback_payoff');
  assert.match(prompt, /Editorial control map/);
  assert.match(prompt, /context reset/);
  assert.match(prompt, /merge_adjacent_lines/);
  assert.match(prompt, /same_conflict_axis/);
});

test('slot fill prompt and title gate reject flat declarative upload titles', () => {
  const prompt = require('../server/services/midformCompressionService').buildSlotFillsPrompt([], { timeline: [] }, 'Fences', '');

  assert.match(prompt, /question-shaped curiosity hook ending with a question mark/);
  assert.match(prompt, /가족 부양은 의무일 뿐/);
  assert.equal(_test.isCuriosityTitle('왜 아버지는 사랑이 의무가 아니라고 했을까?'), true);
  assert.equal(_test.isCuriosityTitle('가족 부양은 의무일 뿐, 사랑이 아니라는 아버지의 충격적인 진심'), false);
});

test('slot fill editorial guide preserves non-confrontation scene type without forcing callback metadata', () => {
  const guide = _test.buildSlotFillEditorialGuide({
    scene_type: 'comedy_setpiece',
    editorial_pattern: 'chronological_escalation',
    timeline: [
      { slot_id: 'slot_01', role: 'cold_open', decision: 'NARRATE', scene_type: 'comedy_setpiece' },
      { slot_id: 'slot_02', role: 'body', decision: 'NARRATE', scene_type: 'comedy_setpiece' }
    ]
  });

  assert.equal(guide.scene_type, 'comedy_setpiece');
  assert.equal(guide.editorial_pattern, 'chronological_escalation');
  assert.equal(guide.callback_dialogue, null);
  assert.ok(guide.slot_rules.every((slot) => slot.scene_type === 'comedy_setpiece'));
  assert.ok(guide.slot_rules.every((slot) => !slot.callback_relation));
});

test('validateEditPlanAgainstBeats allows hook teaser slots to carry only part of a beat anchor set', () => {
  const editPlan = {
    editorial_pattern: 'cold_open_callback',
    timeline: [{
      slot_id: 'slot_01',
      beat_id: 'B004',
      role: 'cold_open',
      decision: 'KEEP_DIALOGUE',
      editorial_role: 'hook_teaser',
      dialogue_focus_quotes: ['I did not kill the ad, Steve']
    }]
  };
  const beats = [{
    beat_id: 'B004',
    anchor_dialogue: ['I did not kill the ad, Steve', 'I was the only thing protecting it']
  }];

  assert.doesNotThrow(() => _test.validateEditPlanAgainstBeats(editPlan, beats));
});

test('finalizeEditPlan keeps hook teaser focused instead of expanding to every later anchor in the same beat', () => {
  const transcript = [
    { start_sec: 161.07, end_sec: 162.869, text: 'I did not kill the ad, Steve' },
    { start_sec: 162.869, end_sec: 164.069, text: 'I was the only reason it aired' },
    { start_sec: 194.98, end_sec: 198.659, text: 'I was the only thing protecting it' }
  ];
  const beats = [{
    beat_id: 'B004',
    start_sec: 161.07,
    end_sec: 198.399,
    summary: 'Sculley reverses the blame around the ad.',
    key_dialogue: ['I did not kill the ad, Steve', 'I was the only reason it aired', 'I was the only thing protecting it'],
    anchor_dialogue: ['I did not kill the ad, Steve', 'I was the only thing protecting it'],
    dramatic_weight: 5,
    dialogue_quality: 'high',
    hook_potential: 5
  }];
  const editPlan = {
    editorial_pattern: 'cold_open_callback',
    cold_open_selection: { beat_id: 'B004' },
    timeline: [
      {
        slot_id: 'slot_01',
        beat_id: 'B004',
        role: 'cold_open',
        decision: 'KEEP_DIALOGUE',
        editorial_role: 'hook_teaser',
        dialogue_focus_quotes: ['I did not kill the ad, Steve', 'I was the only reason it aired'],
        dialogue_focus_lines: ['I did not kill the ad, Steve', 'I was the only reason it aired'],
        start_sec: 161.07,
        end_sec: 198.399,
        estimated_duration_sec: 37.329
      }
    ],
    duration_budget: { target_sec: 90 }
  };

  const finalized = _test.finalizeEditPlan(editPlan, beats, transcript, 90);
  const cold = finalized.timeline.find((slot) => slot.slot_id === 'slot_01');

  assert.ok(cold.estimated_duration_sec <= 16);
  assert.deepEqual(cold.dialogue_focus_lines, ['I did not kill the ad, Steve', 'I was the only reason it aired']);
});

test('finalizeEditPlan restructures late payoff into cold-open teaser and callback dialogue', () => {
  const transcript = [
    { start_sec: 20.0, end_sec: 22.1, text: 'why do people think I fired you' },
    { start_sec: 24.0, end_sec: 25.9, text: 'you tried to kill it' },
    { start_sec: 187.1, end_sec: 191.6, text: "I didn't kill the ad Steve I'm the only reason that made it on the air" },
    { start_sec: 257.5, end_sec: 265.4, text: "they believe you're no longer necessary to this company" }
  ];
  const beats = [
    {
      beat_id: 'B001',
      start_sec: 1.9,
      end_sec: 61.9,
      summary: 'Steve challenges Sculley over who fired whom and accuses him of trying to kill the 1984 ad.',
      key_dialogue: ['why do people think I fired you', 'you tried to kill it'],
      anchor_dialogue: ['why do people think I fired you', 'you tried to kill it'],
      dramatic_weight: 3,
      dialogue_quality: 'high',
      hook_potential: 4
    },
    {
      beat_id: 'B003',
      start_sec: 161.0,
      end_sec: 239.8,
      summary: 'Sculley reverses Steve\'s belief about the 1984 ad.',
      key_dialogue: ["I didn't kill the ad Steve I'm the only reason that made it on the air"],
      anchor_dialogue: ["I didn't kill the ad Steve I'm the only reason that made it on the air"],
      dramatic_weight: 5,
      dialogue_quality: 'high',
      hook_potential: 5
    },
    {
      beat_id: 'B004',
      start_sec: 241.6,
      end_sec: 345.9,
      summary: 'Sculley explains the board decision.',
      key_dialogue: ["they believe you're no longer necessary to this company"],
      anchor_dialogue: ["they believe you're no longer necessary to this company"],
      dramatic_weight: 5,
      dialogue_quality: 'high',
      hook_potential: 5
    }
  ];
  const editPlan = {
    dialogue_driven_scene: true,
    confrontation_scene: true,
    cold_open_selection: { beat_id: 'B004' },
    timeline: [
      { slot_id: 'slot_01', beat_id: 'B004', role: 'cold_open', decision: 'NARRATE', start_sec: 241.6, end_sec: 345.9, estimated_duration_sec: 22 },
      { slot_id: 'slot_02', beat_id: 'B001', role: 'bridge', decision: 'NARRATE', start_sec: 1.9, end_sec: 61.9, estimated_duration_sec: 18 },
      { slot_id: 'slot_03', beat_id: 'B003', role: 'body', decision: 'NARRATE', start_sec: 161.0, end_sec: 239.8, estimated_duration_sec: 10 },
      { slot_id: 'slot_04', beat_id: 'B004', role: 'payoff', decision: 'KEEP_DIALOGUE', start_sec: 257.5, end_sec: 265.4, estimated_duration_sec: 7.9 }
    ],
    duration_budget: { target_sec: 100 }
  };

  const finalized = _test.finalizeEditPlan(editPlan, beats, transcript, 100);
  const hook = finalized.timeline.find((slot) => slot.role === 'cold_open');
  const callback = finalized.timeline.find((slot) => slot.decision === 'KEEP_DIALOGUE' && slot.slot_id !== hook.slot_id);

  assert.equal(finalized.editorial_pattern, 'cold_open_callback');
  assert.equal(hook.decision, 'KEEP_DIALOGUE');
  assert.match(hook.dialogue_focus_lines.join(' '), /kill|only reason|necessary/i);
  assert.ok(callback, 'expected a callback dialogue slot after the hook teaser');
  assert.equal(finalized.dialogue_timing_qc.first_dialogue_start_sec, 0);
  assert.notEqual(finalized.dialogue_timing_qc.callback_dialogue_start_sec, null);
});

test('finalizeEditPlan prefers coherent micro-exchange over unsupported high-hook single-line teaser', () => {
  const transcript = [
    { id: 'early_accuse', start_sec: 20.0, end_sec: 21.8, speaker: 'Steve', text: 'You tried to kill the ad.' },
    { id: 'early_rebut', start_sec: 22.1, end_sec: 25.4, speaker: 'Sculley', text: "I didn't kill the ad Steve, I saved it." },
    { id: 'late_rebut', start_sec: 187.1, end_sec: 190.0, speaker: 'Sculley', text: 'Because it was the only thing protecting it.' }
  ];
  const beats = [
    {
      beat_id: 'B001',
      start_sec: 18,
      end_sec: 40,
      summary: 'Steve accuses Sculley of trying to kill the ad, and Sculley rebuts the accusation.',
      key_dialogue: ['You tried to kill the ad.', "I didn't kill the ad Steve, I saved it."],
      anchor_dialogue: ['You tried to kill the ad.', "I didn't kill the ad Steve, I saved it."],
      dramatic_weight: 4,
      dialogue_quality: 'high',
      hook_potential: 4
    },
    {
      beat_id: 'B003',
      start_sec: 180,
      end_sec: 205,
      summary: 'Sculley gives a sharp late-context rebuttal that depends on the earlier ad argument.',
      key_dialogue: ['Because it was the only thing protecting it.'],
      anchor_dialogue: ['Because it was the only thing protecting it.'],
      dramatic_weight: 5,
      dialogue_quality: 'high',
      hook_potential: 5
    }
  ];
  const editPlan = {
    dialogue_driven_scene: true,
    confrontation_scene: true,
    cold_open_selection: { beat_id: 'B003' },
    timeline: [
      { slot_id: 'slot_01', beat_id: 'B003', role: 'cold_open', decision: 'NARRATE', start_sec: 180, end_sec: 205, estimated_duration_sec: 5 },
      { slot_id: 'slot_02', beat_id: 'B001', role: 'bridge', decision: 'NARRATE', start_sec: 18, end_sec: 40, estimated_duration_sec: 17 },
      { slot_id: 'slot_03', beat_id: 'B003', role: 'body_peak', decision: 'NARRATE', start_sec: 180, end_sec: 205, estimated_duration_sec: 10 }
    ],
    duration_budget: { target_sec: 90 }
  };

  const finalized = _test.finalizeEditPlan(editPlan, beats, transcript, 90);
  const hook = finalized.timeline.find((slot) => slot.role === 'cold_open');

  assert.equal(hook.beat_id, 'B001');
  assert.equal(hook.dialogue_focus_source, 'key_dialogue');
  assert.deepEqual(hook.dialogue_focus_lines, ['You tried to kill the ad.', "I didn't kill the ad Steve, I saved it."]);
  assert.equal(hook.dialogue_selection_scores.required_support_action, 'merge_adjacent_lines');
  assert.equal(hook.qc_action.action, 'merge_adjacent_lines');
  assert.notEqual(hook.dialogue_focus_lines.join(' '), 'Because it was the only thing protecting it.');
});

test('finalizeEditPlan does not force non-confrontation scenes into cold_open_callback', () => {
  const transcript = [
    { start_sec: 10, end_sec: 12, text: 'Look at that ridiculous hat.' },
    { start_sec: 13, end_sec: 15, text: 'It is funnier than the plan.' }
  ];
  const beats = [{
    beat_id: 'B001',
    start_sec: 5,
    end_sec: 30,
    summary: 'A visual comedy setpiece builds through physical escalation.',
    key_dialogue: ['Look at that ridiculous hat.', 'It is funnier than the plan.'],
    anchor_dialogue: ['Look at that ridiculous hat.'],
    dramatic_weight: 3,
    dialogue_quality: 'high',
    hook_potential: 5
  }];
  const editPlan = {
    scene_type: 'comedy_setpiece',
    dialogue_driven_scene: false,
    confrontation_scene: false,
    cold_open_selection: { beat_id: 'B001' },
    timeline: [
      { slot_id: 'slot_01', beat_id: 'B001', role: 'cold_open', decision: 'NARRATE', start_sec: 5, end_sec: 30, estimated_duration_sec: 8 }
    ],
    duration_budget: { target_sec: 90 }
  };

  const finalized = _test.finalizeEditPlan(editPlan, beats, transcript, 90);

  assert.notEqual(finalized.editorial_pattern, 'cold_open_callback');
  assert.equal(finalized.dialogue_timing_qc.violations.includes('missing_callback_dialogue'), false);
  assert.equal(finalized.dialogue_timing_qc.violations.includes('hook_teaser_not_in_first_5s'), false);
});

test('artifact helper can measure callback dialogue after a cold-open teaser', () => {
  const segments = [
    { segment_id: 'slot_01', segment_type: 'dialogue_quote', timeline_start_sec: 0, timeline_end_sec: 3.5 },
    { segment_id: 'slot_02', segment_type: 'recap', timeline_start_sec: 3.5, timeline_end_sec: 22 },
    { segment_id: 'slot_03', segment_type: 'dialogue_quote', timeline_start_sec: 22, timeline_end_sec: 28 }
  ];

  assert.equal(firstDialogueStartSec(segments), 0);
  assert.equal(callbackDialogueStartSec(segments), 22);
});

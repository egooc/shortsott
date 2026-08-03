const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');

const { trimTimelineToTargetRuntime } = _test;

function dialogueSlot(slotId, role, lineCount, secPerLine, weight) {
  const windows = [];
  for (let i = 0; i < lineCount; i += 1) {
    const start = 100 + slotId.length * 10 + i * (secPerLine + 0.5);
    windows.push({ matched: true, line: `${slotId} line ${i + 1}`, start_sec: start, end_sec: start + secPerLine });
  }
  return {
    slot_id: slotId,
    role,
    decision: 'KEEP_DIALOGUE',
    hook_potential: weight,
    dramatic_weight: weight,
    start_sec: windows[0].start_sec,
    end_sec: windows[windows.length - 1].end_sec,
    estimated_duration_sec: windows[windows.length - 1].end_sec - windows[0].start_sec,
    dialogue_focus_lines: windows.map((w) => w.line),
    dialogue_focus_quotes: windows.map((w) => w.line),
    dialogue_line_windows: windows
  };
}

const runtimeOf = (timeline) => timeline
  .filter((item) => item.decision !== 'DROP')
  .reduce((sum, item) => sum + Number(item.estimated_duration_sec || 0), 0);

// A plan whose slots summed to 194s survived a 180s ceiling: the trim measured runtime one way
// and duration_budget summed the raw estimates another, and every remaining slot was protected.
test('a plan of protected slots is shortened rather than left over the ceiling', () => {
  const timeline = [
    dialogueSlot('cold', 'cold_open', 2, 6, 9),
    dialogueSlot('bridgeA', 'bridge', 5, 12, 8),
    dialogueSlot('peak', 'body_peak', 5, 12, 7),
    dialogueSlot('payoffA', 'payoff', 4, 12, 6)
  ];
  assert.ok(runtimeOf(timeline) > 180, 'the fixture must start over the ceiling');

  const trimmed = trimTimelineToTargetRuntime(timeline, 180);
  assert.ok(runtimeOf(trimmed) <= 180, `still ${runtimeOf(trimmed)}s after trimming`);
  for (const item of trimmed) {
    if (item.decision !== 'KEEP_DIALOGUE') continue;
    const kept = item.dialogue_line_windows.filter((w) => w.matched === true);
    assert.ok(kept.length >= 1, `${item.slot_id} lost every line`);
    assert.equal(item.dialogue_focus_lines.length, kept.length, `${item.slot_id} captions drifted from windows`);
  }
});

test('the weakest protected slot gives up its lines first', () => {
  const timeline = [
    dialogueSlot('cold', 'cold_open', 1, 6, 9),
    dialogueSlot('strong', 'body_peak', 4, 14, 9),
    dialogueSlot('weak', 'payoff', 4, 14, 1)
  ];
  const trimmed = trimTimelineToTargetRuntime(timeline, 120);
  const linesOf = (id) => trimmed.find((i) => i.slot_id === id).dialogue_line_windows.filter((w) => w.matched === true).length;
  assert.ok(linesOf('weak') < linesOf('strong'), 'the strong slot should keep more lines than the weak one');
});

test('a plan already inside the ceiling is untouched', () => {
  const timeline = [
    dialogueSlot('cold', 'cold_open', 1, 6, 9),
    dialogueSlot('bridgeA', 'bridge', 2, 10, 8)
  ];
  const before = JSON.stringify(timeline);
  const trimmed = trimTimelineToTargetRuntime(timeline, 180);
  assert.equal(runtimeOf(trimmed), runtimeOf(timeline));
  assert.equal(JSON.stringify(timeline), before, 'the input must not be mutated');
  assert.ok(trimmed.every((item) => !item.runtime_trimmed));
});

test('droppable slots are still dropped before protected ones are shortened', () => {
  const timeline = [
    dialogueSlot('cold', 'cold_open', 1, 6, 9),
    dialogueSlot('filler', 'body', 4, 14, 1),
    dialogueSlot('peak', 'body_peak', 3, 12, 9)
  ];
  const trimmed = trimTimelineToTargetRuntime(timeline, 60);
  assert.equal(trimmed.find((i) => i.slot_id === 'filler').decision, 'DROP');
  assert.ok(runtimeOf(trimmed) <= 60);
});

// Matching whole slot spans only caught exact repeats. With twelve dialogue slots instead of
// nine, slot_001's teaser ran 166.83-171.57 while slot_006 preserved 167.03-169.728 inside it:
// the same footage was cut twice and two capcut gates rejected the plan.
test('a line contained inside an earlier slot\u0027s line is not cut twice', () => {
  const { _test: t } = require('../server/services/midformCompressionService');
  const timeline = [
    {
      slot_id: 'slot_001', role: 'cold_open', decision: 'KEEP_DIALOGUE', start_sec: 166.83, end_sec: 171.57,
      dialogue_focus_lines: ['teaser line'], dialogue_focus_quotes: ['teaser line'],
      dialogue_line_windows: [{ matched: true, line: 'teaser line', start_sec: 166.83, end_sec: 171.57 }]
    },
    {
      slot_id: 'slot_006', role: 'body', decision: 'KEEP_DIALOGUE', start_sec: 167.03, end_sec: 169.728,
      dialogue_focus_lines: ['inside it'], dialogue_focus_quotes: ['inside it'],
      dialogue_line_windows: [{ matched: true, line: 'inside it', start_sec: 167.03, end_sec: 169.728 }]
    }
  ];
  const result = t.dropDuplicateDialogueSlots(timeline);
  assert.equal(result[0].decision, 'KEEP_DIALOGUE', 'the earlier slot keeps its footage');
  assert.equal(result[1].decision, 'DROP', 'the contained one is dropped');
});

test('a slot keeps the lines that do not clash and drops only the ones that do', () => {
  const { _test: t } = require('../server/services/midformCompressionService');
  const timeline = [
    {
      slot_id: 'a', role: 'body', decision: 'KEEP_DIALOGUE', start_sec: 100, end_sec: 104,
      dialogue_focus_lines: ['x'], dialogue_focus_quotes: ['x'],
      dialogue_line_windows: [{ matched: true, line: 'x', start_sec: 100, end_sec: 104 }]
    },
    {
      slot_id: 'b', role: 'body', decision: 'KEEP_DIALOGUE', start_sec: 101, end_sec: 130,
      dialogue_focus_lines: ['clash', 'clean'], dialogue_focus_quotes: ['clash', 'clean'],
      dialogue_line_windows: [
        { matched: true, line: 'clash', start_sec: 101, end_sec: 103.5 },
        { matched: true, line: 'clean', start_sec: 126, end_sec: 130 }
      ]
    }
  ];
  const result = t.dropDuplicateDialogueSlots(timeline);
  assert.equal(result[1].decision, 'KEEP_DIALOGUE');
  const kept = result[1].dialogue_line_windows.filter((w) => w.matched === true);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].line, 'clean');
  assert.deepEqual(result[1].dialogue_focus_lines, ['clean'], 'captions must follow the windows');
});

test('a declared callback may replay its teaser', () => {
  const { _test: t } = require('../server/services/midformCompressionService');
  const timeline = [
    {
      slot_id: 'teaser', role: 'cold_open', decision: 'KEEP_DIALOGUE', start_sec: 20, end_sec: 24,
      dialogue_focus_lines: ['the line'], dialogue_focus_quotes: ['the line'],
      dialogue_line_windows: [{ matched: true, line: 'the line', start_sec: 20, end_sec: 24 }]
    },
    {
      slot_id: 'callback', role: 'payoff', decision: 'KEEP_DIALOGUE', start_sec: 20, end_sec: 24,
      replay_of_slot_id: 'teaser',
      dialogue_focus_lines: ['the line'], dialogue_focus_quotes: ['the line'],
      dialogue_line_windows: [{ matched: true, line: 'the line', start_sec: 20, end_sec: 24 }]
    }
  ];
  const result = t.dropDuplicateDialogueSlots(timeline);
  assert.equal(result[1].decision, 'KEEP_DIALOGUE', 'the replay is the point of a callback');
});

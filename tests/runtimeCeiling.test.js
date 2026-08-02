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

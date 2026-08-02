const assert = require('node:assert/strict');
const test = require('node:test');

const { buildBootstrapSlotMapAndScript } = require('../server/services/midformBootstrapAdapterService');

// The real shape, from the Senseless source: slot_02_L01 was spoken at 38.894-40.596, and an
// unselected line ran right before it at 36.99-38.68. A 0.5s pre-roll put the clip at 38.194,
// which starts in the middle of the other line's audio and trips the reserved-range gate.
function editPlan() {
  return {
    timeline: [
      {
        slot_id: 'slot_02',
        role: 'body',
        decision: 'KEEP_DIALOGUE',
        estimated_duration_sec: 2,
        dialogue_focus_lines: ['You make them yourself?'],
        dialogue_focus_quotes: ['You make them yourself?'],
        dialogue_line_windows: [{ matched: true, line: 'You make them yourself?', start_sec: 38.894, end_sec: 40.596 }]
      }
    ]
  };
}

const slotFills = () => ({ slot_fills: [{ slot_id: 'slot_02', caption_kr_dialogue: ['직접 만드세요?'] }] });

const toSec = (tc) => {
  const [h, m, s] = String(tc).split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};

function dialogueClip(script) {
  const scene = script.segments.find((s) => s.segment_type === 'dialogue_quote').source_scenes[0];
  return [toSec(scene.start), toSec(scene.end)];
}

test('pre-roll stops short of the line spoken just before it', () => {
  const { script } = buildBootstrapSlotMapAndScript(editPlan(), slotFills(), {
    sourceDurationSec: 529.561,
    speechRanges: [[36.99, 38.68], [38.894, 40.596]]
  });
  const [start] = dialogueClip(script);
  assert.ok(start >= 38.68, `clip starts at ${start}, inside the previous line's speech`);
  assert.ok(start <= 38.894, 'but it still starts before the line itself');
});

test('post-roll stops short of the line spoken just after it', () => {
  const { script } = buildBootstrapSlotMapAndScript(editPlan(), slotFills(), {
    sourceDurationSec: 529.561,
    speechRanges: [[38.894, 40.596], [40.7, 42.4]]
  });
  const [, end] = dialogueClip(script);
  assert.ok(end <= 40.7, `clip ends at ${end}, inside the next line's speech`);
  assert.ok(end >= 40.596, 'but it still covers the line itself');
});

test('with clear air around it the line keeps its full padding', () => {
  const { script } = buildBootstrapSlotMapAndScript(editPlan(), slotFills(), {
    sourceDurationSec: 529.561,
    speechRanges: [[10.0, 12.0], [38.894, 40.596], [60.0, 62.0]]
  });
  const [start, end] = dialogueClip(script);
  assert.ok(start < 38.894, 'padding is still applied');
  assert.ok(end > 40.596);
});

test('with no speech ranges the padding behaves as before', () => {
  const { script } = buildBootstrapSlotMapAndScript(editPlan(), slotFills(), { sourceDurationSec: 529.561 });
  const [start, end] = dialogueClip(script);
  assert.ok(start < 38.894 && end > 40.596);
});

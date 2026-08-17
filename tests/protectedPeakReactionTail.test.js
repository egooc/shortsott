const assert = require('node:assert/strict');
const test = require('node:test');

const { buildBootstrapSlotMapAndScript } = require('../server/services/midformBootstrapAdapterService');

// Benchmark finding (명화관, top channel in this format): the film's iconic moment plays UNCUT
// through its reaction - tension is compressed elsewhere, release plays whole. A protected_peak slot
// therefore gets the same reaction tail the cold open already had: the LAST line's visual holds to
// the slot window end instead of cutting on the last word.
const toSec = (tc) => {
  const [h, m, s] = String(tc).split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};

function planWith(extra) {
  return {
    timeline: [{
      slot_id: 'slot_09',
      role: 'payoff',
      decision: 'KEEP_DIALOGUE',
      estimated_duration_sec: 10,
      start_sec: 500,
      end_sec: 516,
      dialogue_focus_lines: ['the reveal line', 'the answer'],
      dialogue_focus_quotes: ['the reveal line', 'the answer'],
      dialogue_line_windows: [
        { matched: true, line: 'the reveal line', start_sec: 500, end_sec: 503 },
        { matched: true, line: 'the answer', start_sec: 503.5, end_sec: 506 }
      ],
      ...extra
    }]
  };
}

const fills = { slot_fills: [{ slot_id: 'slot_09', caption_kr_dialogue: ['리빌', '응답'], speakers: ['A', 'B'] }] };

const lastClipEnd = (script) => {
  const clips = script.segments
    .filter((segment) => segment.segment_type === 'dialogue_quote')
    .flatMap((segment) => (segment.source_scenes || []).map((clip) => toSec(clip.end)));
  return Math.max(...clips);
};

test('a protected_peak slot holds its last visual through the reaction', () => {
  const { script } = buildBootstrapSlotMapAndScript(planWith({ protected_peak: true }), fills, { sourceDurationSec: 600 });
  assert.ok(lastClipEnd(script) >= 515, `visual should run to the slot end, got ${lastClipEnd(script)}`);
});

test('an ordinary body slot still cuts near its last word', () => {
  const { script } = buildBootstrapSlotMapAndScript(planWith({ role: 'body' }), fills, { sourceDurationSec: 600 });
  assert.ok(lastClipEnd(script) < 510, `no reaction tail without the flag, got ${lastClipEnd(script)}`);
});

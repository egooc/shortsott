const assert = require('node:assert/strict');
const test = require('node:test');

const { _test } = require('../server/services/midformCompressionService');
const { profileSourceCase, buildSourceCaseGuidance } = _test;

// The casebook's judgement, computed: speech density and whether the most-replayed peak lands on
// speech decide the editing approach (midform/docs/source-casebook.md).
function cuesCovering(pairs) {
  return pairs.map(([s, e]) => ({ start_sec: s, end_sec: e, text: 'a spoken line here' }));
}

test('an Anger-Management-shaped source profiles short, dense, dialogue-peak', () => {
  const cues = cuesCovering([[0, 60], [61, 120], [121, 150]]);
  const heatmap = { items: [{ start_sec: 100, end_sec: 110, score: 0.9 }, { start_sec: 10, end_sec: 20, score: 0.3 }] };
  const p = profileSourceCase(cues, { duration: 163 }, heatmap);
  assert.equal(p.case_type, 'short_source+dialogue_dense+dialogue_peak');
  assert.ok(p.speech_density > 0.85);
});

test('a Breaking-Dawn-shaped source profiles sparse with an action peak', () => {
  const cues = cuesCovering([[0, 50], [60, 90]]);
  const heatmap = { items: [{ start_sec: 400, end_sec: 410, score: 0.95 }] };
  const p = profileSourceCase(cues, { duration: 529 }, heatmap);
  assert.equal(p.case_type, 'sparse_dialogue+action_peak');
  assert.equal(p.peak_is_dialogue, false);
});

test('sound-effect captions do not count as speech', () => {
  const cues = [
    { start_sec: 0, end_sec: 100, text: '[Music]' },
    { start_sec: 100, end_sec: 130, text: 'a real line' }
  ];
  const p = profileSourceCase(cues, { duration: 300 }, { items: [{ start_sec: 50, end_sec: 55, score: 1 }] });
  assert.ok(p.speech_density < 0.35, `music must not count, got ${p.speech_density}`);
  assert.equal(p.peak_is_dialogue, false, 'a peak over music is not a dialogue peak');
});

test('guidance names the case and matches its rules', () => {
  const dense = buildSourceCaseGuidance({ case_type: 'short_source+dialogue_dense+dialogue_peak', duration_sec: 163, speech_density: 0.9, peak_is_dialogue: true }).join(' ');
  assert.match(dense, /Chain preserved dialogue back to back/);
  assert.match(dense, /captioned hook/);
  assert.match(dense, /completeness beats length/i);
  const sparse = buildSourceCaseGuidance({ case_type: 'sparse_dialogue+action_peak', duration_sec: 529, speech_density: 0.2, peak_is_dialogue: false }).join(' ');
  assert.match(sparse, /speech-forward structure is impossible/);
  assert.match(sparse, /uncaptioned source-audio teaser/);
  assert.deepEqual(buildSourceCaseGuidance(null), []);
});

// Source channels end their clips with ~30s of self-promotion (user directive: never cut from
// it; reuse the hook if narration runs out of footage).
const { detectPromoTail } = require('../server/services/midformCompressionService');

test('an outro of music and subscribe copy is detected as a promo tail', () => {
  const cues = [
    { start_sec: 5, end_sec: 128, text: 'real movie dialogue happening here' },
    { start_sec: 133, end_sec: 140, text: '[Music]' },
    { start_sec: 140, end_sec: 155, text: 'subscribe to our channel for the best movie clips' }
  ];
  const tail = detectPromoTail(cues, 163);
  assert.ok(tail.promo_tail_sec >= 30, `expected a ~33s tail, got ${tail.promo_tail_sec}`);
  assert.ok(tail.usable_end_sec <= 130.5);
});

test('a clip that ends on real dialogue has no promo tail', () => {
  const cues = [{ start_sec: 5, end_sec: 160, text: 'dialogue to the very end' }];
  const tail = detectPromoTail(cues, 163);
  assert.equal(tail.promo_tail_sec, 0);
  assert.equal(tail.usable_end_sec, 163);
});

test('narration falling inside the promo tail replays the hook instead', () => {
  const { buildBootstrapSlotMapAndScript } = require('../server/services/midformBootstrapAdapterService');
  const editPlan = {
    timeline: [
      {
        slot_id: 'slot_01', role: 'cold_open', decision: 'KEEP_DIALOGUE', estimated_duration_sec: 3,
        dialogue_focus_lines: ['hook line'], dialogue_focus_quotes: ['hook line'],
        dialogue_line_windows: [{ matched: true, line: 'hook line', start_sec: 40.0, end_sec: 43.0 }]
      },
      { slot_id: 'slot_closing', role: 'closing', decision: 'NARRATE', start_sec: 140.0, end_sec: 160.0, estimated_duration_sec: 8 }
    ]
  };
  const fills = { slot_fills: [
    { slot_id: 'slot_01', caption_kr_dialogue: ['훅'] },
    { slot_id: 'slot_closing', narration: '마무리 나레이션입니다.' }
  ] };
  const { script } = buildBootstrapSlotMapAndScript(editPlan, fills, {
    sourceDurationSec: 163, usableEndSec: 130.5
  });
  const closing = script.segments.find((seg) => String(seg.segment_id || '').includes('slot_closing'));
  const clip = (closing.source_scenes || [])[0];
  assert.ok(clip, 'the closing still gets footage');
  const toSec = (tc) => { const [h, m, s] = String(tc).split(':'); return Number(h) * 3600 + Number(m) * 60 + Number(s); };
  assert.ok(toSec(clip.end) <= 130.5 + 0.5, `footage must stay out of the promo tail, got ${clip.end}`);
  assert.ok(Math.abs(toSec(clip.start) - 40.0) < 2, 'and it replays the hook moment');
});

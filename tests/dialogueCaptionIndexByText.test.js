const assert = require('node:assert/strict');
const test = require('node:test');

const { buildBootstrapSlotMapAndScript } = require('../server/services/midformBootstrapAdapterService');

// The Housemaid night cut lost slot_06 and slot_07 whole - Nina's gaslighting about the tickets and
// Andrew stepping in, the causal middle of the scene. The plan's first line was a truncated caption
// chunk that matched nothing, the surviving second line read caption_kr_dialogue[1] of a slot with
// one authored caption, came out captionless, and a captionless dialogue segment never reaches the
// timeline. Captions are authored per focus LINE, so they have to be found by text.
function planWithMismatchedLists() {
  return {
    timeline: [{
      slot_id: 'slot_06',
      role: 'body',
      decision: 'KEEP_DIALOGUE',
      estimated_duration_sec: 3,
      // One authored line (which failed to match) plus the line the exchange restoration added.
      dialogue_focus_lines: [
        '>> But why would I have you book tickets for the day that I\'m driving Cece to',
        "I don't care. It was your mistake, you're going to cover it."
      ],
      dialogue_focus_quotes: ['>> But why would I have you book tickets for the day that I\'m driving Cece to'],
      dialogue_line_windows: [
        { matched: false, line: '>> But why would I have you book tickets for the day that I\'m driving Cece to', start_sec: null, end_sec: null },
        { matched: true, line: "I don't care. It was your mistake, you're going to cover it.", start_sec: 273.88, end_sec: 276.8 }
      ]
    }]
  };
}

test('a kept line finds its caption by text even when an unmatched line shifts the index', () => {
  const fills = {
    slot_fills: [{
      slot_id: 'slot_06',
      caption_kr_dialogue: [
        '하지만 내가 씨씨를 데려다주는 날에 왜 네가 표를 예약하게 하겠어?',
        '난 상관없어. 네 실수니까 네가 감당해.'
      ],
      speakers: ['니나', '니나']
    }]
  };
  const { script, uncaptionedDialogueLines } = buildBootstrapSlotMapAndScript(planWithMismatchedLists(), fills, { sourceDurationSec: 600 });
  const dialogue = script.segments.filter((segment) => segment.segment_type === 'dialogue_quote');
  assert.equal(dialogue.length, 1, 'only the matched line is cut');
  assert.ok(String(dialogue[0].narration || dialogue[0].caption_text || '').includes('네 실수'), 'and it carries ITS OWN caption');
  assert.deepEqual(uncaptionedDialogueLines, []);
});

test('a kept line with no authored caption at all is reported, not silently dropped', () => {
  const fills = {
    slot_fills: [{
      slot_id: 'slot_06',
      caption_kr_dialogue: ['하지만 내가 씨씨를 데려다주는 날에 왜 네가 표를 예약하게 하겠어?'],
      speakers: ['니나']
    }]
  };
  const { uncaptionedDialogueLines } = buildBootstrapSlotMapAndScript(planWithMismatchedLists(), fills, { sourceDurationSec: 600 });
  assert.equal(uncaptionedDialogueLines.length, 1);
  assert.equal(uncaptionedDialogueLines[0].segment_id, 'slot_06_L02');
});

test('aligned lists keep reading their own index', () => {
  const plan = {
    timeline: [{
      slot_id: 'slot_01',
      role: 'body',
      decision: 'KEEP_DIALOGUE',
      estimated_duration_sec: 5,
      dialogue_focus_lines: ['first line here', 'second line here'],
      dialogue_focus_quotes: ['first line here', 'second line here'],
      dialogue_line_windows: [
        { matched: true, line: 'first line here', start_sec: 100, end_sec: 102 },
        { matched: true, line: 'second line here', start_sec: 103, end_sec: 105 }
      ]
    }]
  };
  const fills = { slot_fills: [{ slot_id: 'slot_01', caption_kr_dialogue: ['첫 번째 줄', '두 번째 줄'], speakers: ['A', 'B'] }] };
  const { script } = buildBootstrapSlotMapAndScript(plan, fills, { sourceDurationSec: 600 });
  const texts = script.segments
    .filter((segment) => segment.segment_type === 'dialogue_quote')
    .map((segment) => String(segment.narration || segment.caption_text || ''));
  assert.ok(texts.join(' ').includes('첫 번째'), 'first caption stays on the first line');
  assert.ok(texts.join(' ').includes('두 번째'), 'second caption stays on the second line');
});

// Upstream half of the same failure: the plan listed one focus line while the resolver produced two
// windows, so the found line was never shown to the caption writer at all. The two lists have to
// describe the same set of lines before the fills are authored.
test('a window whose line is missing from the focus list is added to it', () => {
  const { _test } = require('../server/services/midformCompressionService');
  const out = _test.alignFocusLinesToWindows([{
    slot_id: 'slot_06',
    decision: 'KEEP_DIALOGUE',
    dialogue_focus_lines: ['>> But why would I have you book tickets for the day that I am driving Cece to'],
    dialogue_focus_quotes: ['>> But why would I have you book tickets for the day that I am driving Cece to'],
    dialogue_line_windows: [
      { matched: false, line: '>> But why would I have you book tickets for the day that I am driving Cece to' },
      { matched: true, start_sec: 273.88, end_sec: 276.8, line: "I don't care. It was your mistake, you're going to cover it." }
    ]
  }]);
  assert.equal(out[0].dialogue_focus_lines.length, 2);
  assert.ok(out[0].dialogue_focus_lines[1].includes('your mistake'));
});

test('a window that is a display chunk of a line already listed adds nothing', () => {
  const { _test } = require('../server/services/midformCompressionService');
  const out = _test.alignFocusLinesToWindows([{
    slot_id: 'slot_01',
    decision: 'KEEP_DIALOGUE',
    dialogue_focus_lines: ['I know exactly what you did last night.'],
    dialogue_focus_quotes: ['I know exactly what you did last night.'],
    dialogue_line_windows: [{ matched: true, start_sec: 10, end_sec: 12, line: 'what you did last night' }]
  }]);
  assert.equal(out[0].dialogue_focus_lines.length, 1);
});

// The caption writer must not be shown a line that never plays: it spends a caption on it, comes back
// one caption short, and reconcileDialogueCaptionCounts then keeps the FIRST lines - the unplayable
// one - and throws away the line that was actually cut.
test('an unplayable line is not offered to the caption writer', () => {
  const { _test } = require('../server/services/midformCompressionService');
  const out = _test.dropUnplayableFocusLines([{
    slot_id: 'slot_06',
    decision: 'KEEP_DIALOGUE',
    dialogue_focus_lines: ['>> But why would I have you book tickets for the day', 'I do not care. It was your mistake.'],
    dialogue_focus_quotes: ['>> But why would I have you book tickets for the day', 'I do not care. It was your mistake.'],
    dialogue_line_windows: [
      { matched: false, line: '>> But why would I have you book tickets for the day' },
      { matched: true, start_sec: 273.88, end_sec: 276.8, line: 'I do not care. It was your mistake.' }
    ]
  }]);
  assert.deepEqual(out[0].dialogue_focus_lines, ['I do not care. It was your mistake.']);
});

test('a slot where nothing matched keeps its lines rather than emptying', () => {
  const { _test } = require('../server/services/midformCompressionService');
  const out = _test.dropUnplayableFocusLines([{
    slot_id: 'slot_09',
    decision: 'KEEP_DIALOGUE',
    dialogue_focus_lines: ['nothing matched here'],
    dialogue_focus_quotes: ['nothing matched here'],
    dialogue_line_windows: [{ matched: false, line: 'nothing matched here' }]
  }]);
  assert.equal(out[0].dialogue_focus_lines.length, 1);
});

// caption_source_lines records the line each caption was written for. After a refresh or a runtime
// shave, position N in the caption array stops meaning line N - Housemaid night's slot_07 shipped every
// caption one line off, so Andrew's answer carried Nina's objection.
test('a caption is found by the line it was written for, not by position', () => {
  const plan = {
    timeline: [{
      slot_id: 'slot_07',
      role: 'body',
      decision: 'KEEP_DIALOGUE',
      estimated_duration_sec: 6,
      // The plan lost one line since the captions were written.
      dialogue_focus_lines: ['Milly booked tickets for a weekend.', '>> I do not think that is a thing.', 'You do not have to pay for anything.'],
      dialogue_focus_quotes: ['Milly booked tickets for a weekend.'],
      dialogue_line_windows: [
        { matched: true, line: 'Milly booked tickets for a weekend.', start_sec: 293.51, end_sec: 298.6 },
        { matched: true, line: '>> I do not think that is a thing.', start_sec: 304.32, end_sec: 305.6 },
        { matched: true, line: 'You do not have to pay for anything.', start_sec: 305.6, end_sec: 310.24 }
      ]
    }]
  };
  const fills = {
    slot_fills: [{
      slot_id: 'slot_07',
      caption_kr_dialogue: ['밀리가 표를 예매했어요.', '카드사에 전화하면 돼.', '그게 될 리가 없잖아요.', '아무것도 낼 필요 없어요.'],
      caption_source_lines: [
        'Milly booked tickets for a weekend.',
        '>> No, she does not. We will call the credit card company.',
        '>> I do not think that is a thing.',
        'You do not have to pay for anything.'
      ],
      speakers: ['니나', '앤드류', '니나', '앤드류']
    }]
  };
  const { script, uncaptionedDialogueLines } = buildBootstrapSlotMapAndScript(plan, fills, { sourceDurationSec: 600 });
  const texts = script.segments
    .filter((segment) => segment.segment_type === 'dialogue_quote')
    .sort((left, right) => (left.timeline_start_sec ?? 0) - (right.timeline_start_sec ?? 0))
    .map((segment) => String(segment.narration || segment.caption_text || ''));
  assert.deepEqual(uncaptionedDialogueLines, []);
  assert.ok(texts[1].includes('될 리가 없'), `second line keeps its own caption, got ${texts[1]}`);
  assert.ok(texts[2].includes('낼 필요 없'), `third line keeps its own caption, got ${texts[2]}`);
});

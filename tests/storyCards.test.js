const assert = require('node:assert/strict');
const test = require('node:test');

const { buildBootstrapSlotMapAndScript } = require('../server/services/midformBootstrapAdapterService');
const { _test: localeTest } = require('../server/services/midformLocaleDraftService');

// Benchmark B-form (명화관): on-screen cards over the clip's original audio - the two-card situation
// hook and the single time-jump card. No TTS, no captions; the card IS the text.

test('a card-only NARRATE seam renders as a scene hook carrying its card', () => {
  const plan = {
    timeline: [{
      slot_id: 'slot_05',
      role: 'body',
      decision: 'NARRATE',
      estimated_duration_sec: 2.5,
      start_sec: 540.0,
      end_sec: 543.0
    }]
  };
  const fills = { slot_fills: [{ slot_id: 'slot_05', narration: '', cards: ['공연이 끝난 밤'] }] };
  const { script } = buildBootstrapSlotMapAndScript(plan, fills, { sourceDurationSec: 600 });
  const segment = script.segments.find((entry) => entry.segment_id === 'slot_05');
  assert.equal(segment.segment_type, 'scene_hook', 'no TTS: the card seam plays original audio');
  assert.equal(segment.tts_enabled, false);
  assert.ok(Array.isArray(segment.story_cards) && segment.story_cards.length === 1, 'one card attached');
  assert.equal(segment.story_cards[0].text, '공연이 끝난 밤');
  assert.ok(segment.story_cards[0].duration_sec >= 1.2, 'readable duration');
});

test('a scene-hook cold open spreads two situation cards across the teaser', () => {
  const plan = {
    timeline: [{
      slot_id: 'slot_001',
      role: 'cold_open',
      decision: 'NARRATE',
      visual_source_mode: 'source_audio_teaser',
      visual_source_start_sec: 100,
      visual_source_end_sec: 108,
      estimated_duration_sec: 8,
      start_sec: 100,
      end_sec: 108
    }]
  };
  const fills = { slot_fills: [{ slot_id: 'slot_001', narration: '', cards: ['화장실이 급해 마트에 들렀는데', '도망가버린 남친'] }] };
  const { script } = buildBootstrapSlotMapAndScript(plan, fills, { sourceDurationSec: 600 });
  const segment = script.segments.find((entry) => entry.segment_id === 'slot_001');
  assert.equal(segment.segment_type, 'scene_hook');
  assert.equal(segment.story_cards.length, 2);
  const [first, second] = segment.story_cards;
  assert.ok(second.offset_sec >= first.offset_sec + first.duration_sec, 'cards are sequential, not stacked');
  assert.ok(second.offset_sec + second.duration_sec <= 8.1, 'cards stay inside the teaser');
});

test('a NARRATE slot with narration ignores any stray cards', () => {
  const plan = {
    timeline: [{ slot_id: 'slot_02', role: 'bridge', decision: 'NARRATE', estimated_duration_sec: 5, start_sec: 10, end_sec: 20 }]
  };
  const fills = { slot_fills: [{ slot_id: 'slot_02', narration: '전제 한 줄.', caption_kr: '전제 한 줄.', cards: ['며칠후'] }] };
  const { script } = buildBootstrapSlotMapAndScript(plan, fills, { sourceDurationSec: 600 });
  const segment = script.segments.find((entry) => entry.segment_id === 'slot_02');
  assert.equal(segment.segment_type, 'recap', 'narration wins; the slot stays a narrated seam');
  assert.equal(segment.tts_enabled, true);
});

test('the Japanese script swaps card text positionally', () => {
  const base = {
    segments: [{
      segment_id: 'slot_05',
      segment_type: 'scene_hook',
      tts_enabled: false,
      caption_text: '',
      story_cards: [{ text: '공연이 끝난 밤', offset_sec: 0.2, duration_sec: 2.0 }]
    }]
  };
  const ja = localeTest.buildJapaneseScript(base, { slot_fills: [{ slot_id: 'slot_05', cards: ['公演が終わった夜'] }] });
  assert.equal(ja.segments[0].story_cards[0].text, '公演が終わった夜');
  assert.equal(ja.segments[0].story_cards[0].offset_sec, 0.2, 'timing untouched');
});

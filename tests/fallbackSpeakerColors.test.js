const assert = require('node:assert/strict');
const test = require('node:test');

const { assignFallbackSpeakerColorKeys, resolveCaptionColor, readCaptionColorConfig } = require('../server/utils/captionColorConfig');
const { buildBootstrapSlotMapAndScript } = require('../server/services/midformBootstrapAdapterService');

const config = readCaptionColorConfig();
const paletteSize = Object.keys(config.fallback_roles || {}).length;

// Each alias used to be hashed independently, which says nothing about whether two speakers in
// the same scene differ: "대릴" and "여자" both hashed to 기타1 and the exchange played out in
// a single colour, so the viewer could not tell who was speaking.
test('two unknown speakers never share a fallback colour', () => {
  const assignment = assignFallbackSpeakerColorKeys(['대릴', '여자']);
  assert.equal(assignment.size, 2);
  assert.notEqual(assignment.get('대릴'), assignment.get('여자'));
});

test('the palette is used in order and repeats only once exhausted', () => {
  const aliases = Array.from({ length: paletteSize + 1 }, (_, i) => `unknown_${i}`);
  const assignment = assignFallbackSpeakerColorKeys(aliases);
  const keys = aliases.map((alias) => assignment.get(alias));
  assert.equal(new Set(keys.slice(0, paletteSize)).size, paletteSize, 'the whole palette should be used first');
  assert.equal(keys[paletteSize], keys[0], 'only then does it wrap');
});

test('a speaker the config names keeps its own colour', () => {
  const named = Object.keys(config.roles || {})[0];
  const assignment = assignFallbackSpeakerColorKeys([named, '모르는사람']);
  assert.ok(!assignment.has(named), 'a named role should not draw from the fallback palette');
  assert.ok(assignment.has('모르는사람'));
});

test('assignment is stable for the same order of appearance', () => {
  const first = assignFallbackSpeakerColorKeys(['가', '나', '다']);
  const second = assignFallbackSpeakerColorKeys(['가', '나', '다']);
  assert.deepEqual([...first.entries()], [...second.entries()]);
});

test('an exchange between two unknown speakers renders in two colours', () => {
  const editPlan = {
    timeline: [{
      slot_id: 'slot_02',
      role: 'body',
      decision: 'KEEP_DIALOGUE',
      estimated_duration_sec: 6,
      dialogue_focus_lines: ['one', 'two'],
      dialogue_focus_quotes: ['one', 'two'],
      dialogue_line_windows: [
        { matched: true, line: 'one', start_sec: 40.0, end_sec: 42.0 },
        { matched: true, line: 'two', start_sec: 43.0, end_sec: 45.0 }
      ]
    }]
  };
  const slotFills = { slot_fills: [{ slot_id: 'slot_02', speakers: ['여자', '대릴'], caption_kr_dialogue: ['첫 줄', '둘째 줄'] }] };
  const { script } = buildBootstrapSlotMapAndScript(editPlan, slotFills, { sourceDurationSec: 529.561 });

  const dialogue = script.segments.filter((s) => s.segment_type === 'dialogue_quote');
  assert.equal(dialogue.length, 2);
  const colors = new Set(dialogue.map((s) => String(s.caption_color || '').toLowerCase()));
  assert.equal(colors.size, 2, `both speakers rendered in ${[...colors]}`);
  assert.ok([...colors].every((c) => c.startsWith('#')), 'every speaker still gets a real colour');
});

test('a resolved fallback key maps to a real colour', () => {
  const assignment = assignFallbackSpeakerColorKeys(['모르는사람']);
  const color = resolveCaptionColor({ speakerAlias: '모르는사람', speakerColorKey: assignment.get('모르는사람') });
  assert.ok(color.startsWith('#'), `expected a hex colour, got ${color}`);
});

// Six speakers against a four-colour palette wrapped around: Darryl and Mr. Tyson both took 기타2
// and they share two scenes, so the exchange played out in one colour again.
test('speakers who share a scene get different colours even when the palette wraps', () => {
  const groups = [
    ['Lorraine', 'Darryl'],
    ['Janice', 'Friend'],
    ["Janice's Mother", 'Darryl', 'Mr. Tyson'],
    ['Mr. Tyson', 'Janice', 'Darryl']
  ];
  const assignment = assignFallbackSpeakerColorKeys(groups);
  for (const group of groups) {
    const keys = [...new Set(group)].map((alias) => assignment.get(alias));
    assert.equal(new Set(keys).size, keys.length, `${group.join(' / ')} collapsed onto ${keys}`);
  }
});

test('a colour may still repeat between scenes that never meet', () => {
  const groups = [['A', 'B'], ['C', 'D'], ['E', 'F']];
  const assignment = assignFallbackSpeakerColorKeys(groups);
  const used = new Set(['A', 'B', 'C', 'D', 'E', 'F'].map((a) => assignment.get(a)));
  assert.ok(used.size <= paletteSize, 'reuse across scenes is fine');
  for (const group of groups) {
    assert.notEqual(assignment.get(group[0]), assignment.get(group[1]));
  }
});

test('a flat list of aliases is still accepted', () => {
  const assignment = assignFallbackSpeakerColorKeys(['대릴', '여자']);
  assert.notEqual(assignment.get('대릴'), assignment.get('여자'));
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildLocaleDraftInput,
  compareDialogueParentCompositions,
  generateLocaleDraftArtifacts,
  normalizeDraftSpecSourceRanges,
  placementBySlot,
  replanJaDraftSpecForFinalOverlap,
  secondsToTimecode,
  _test
} = require('../server/services/midformLocaleDraftService');

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function secondsFromTimecode(value) {
  const parts = String(value || '').split(':').map(Number);
  if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  if (parts.length === 2) return (parts[0] * 60) + parts[1];
  return Number(value || 0);
}

function videoSegmentFromSourceScene(segment, index) {
  const scene = segment.source_scenes?.[0] || {};
  const startSec = secondsFromTimecode(scene.start);
  const endSec = secondsFromTimecode(scene.end);
  const targetStartSec = index * 4;
  const durationSec = Math.max(0.001, endSec - startSec);
  return {
    id: segment.locale_clip_id || segment.segment_id,
    material_id: 'source-video-material',
    source_timerange: { start: Math.round(startSec * 1_000_000), duration: Math.round(durationSec * 1_000_000) },
    target_timerange: { start: Math.round(targetStartSec * 1_000_000), duration: Math.round(durationSec * 1_000_000) }
  };
}

test('secondsToTimecode formats locale source ranges for CapCut source_scenes', () => {
  assert.equal(secondsToTimecode(4.2), '00:04.200');
  assert.equal(secondsToTimecode(65.125), '01:05.125');
  assert.equal(secondsToTimecode(3661.5), '01:01:01.500');
});

test('placementBySlot maps locale clip ids back to base slot ids', () => {
  const map = placementBySlot({
    clip_placement: [
      { clip_id: 'ko_slot_01', source_range: [10, 14] },
      { clip_id: 'ko_slot_02_L01', source_range: [30, 32] }
    ]
  });

  assert.deepEqual(map.get('slot_01').source_range, [10, 14]);
  assert.deepEqual(map.get('slot_02_L01').source_range, [30, 32]);
});

test('buildLocaleDraftInput rewrites video source_scenes from draft_spec without changing caption units', () => {
  const baseDraftInput = {
    segments: [
      {
        segment_id: 'slot_01_L01',
        parent_slot_id: 'slot_01',
        caption_text: '첫 대사',
        combined_segment_ids: ['slot_legacy_a'],
        speaker_id: 'jobs',
        speaker_alias: 'Jobs',
        speaker_color_key: '남주',
        caption_kind: 'dialogue',
        source_utterance_id: 'utt_001',
        source_scenes: [{ start: '00:01.000', end: '00:03.000' }],
        story_anchor: { source_range_hint: [1, 1] }
      },
      {
        segment_id: 'slot_02',
        caption_text: '나레이션',
        source_scenes: [{ start: '00:10.000', end: '00:20.000' }],
        story_anchor: { source_range_hint: [10, 10] }
      }
    ],
    captionUnits: [{ caption_id: 'cap_001', segment_id: 'slot_01_L01', segment_type: 'dialogue_quote', text: '첫 대사', combined_segment_ids: ['slot_legacy_a'] }],
    ttsFiles: [],
    resolution: { width: 1080, height: 1920 },
    fps: 30
  };
  const draftSpec = {
    locale: 'ja',
    clip_placement: [
      { clip_id: 'ja_slot_01', source_range: [40, 44], visual_role: 'cold_open' },
      { clip_id: 'ja_slot_02', source_range: [80, 90], visual_role: 'bridge' }
    ]
  };

  const localeInput = buildLocaleDraftInput(baseDraftInput, draftSpec, 'ja');

  assert.equal(localeInput.locale, 'ja');
  assert.equal(localeInput.draftName, 'draft_ja');
  assert.equal(localeInput.draft_output_mode, 'folder_only');
  assert.equal(localeInput.package_zip, false);
  assert.equal(localeInput.captionUnits.length, baseDraftInput.captionUnits.length);
  assert.equal(localeInput.captionUnits[0].text, baseDraftInput.captionUnits[0].text);
  assert.equal(localeInput.segments[0].source_scenes[0].start, '00:40.000');
  assert.equal(localeInput.segments[0].source_scenes[0].end, '00:44.000');
  assert.equal(localeInput.segments[0].source_clips[0].start, '00:40.000');
  assert.equal(localeInput.segments[0].source_clips[0].source, 'locale_draft_spec');
  assert.deepEqual(localeInput.segments[0].story_anchor.source_range_hint, [40, 44]);
  assert.equal(localeInput.segments[0].speaker_id, 'jobs');
  assert.equal(localeInput.captionUnits[0].speaker_id, 'jobs');
  assert.equal(localeInput.captionUnits[0].speaker_color_key, '남주');
  assert.equal(localeInput.captionUnits[0].caption_color, '#00A9F7');
  assert.equal(localeInput.captionUnits[0].source_utterance_id, 'utt_001');
  assert.deepEqual(localeInput.segments[0].combined_segment_ids, []);
  assert.deepEqual(localeInput.captionUnits[0].combined_segment_ids, []);
  assert.equal(localeInput.segments[1].source_scenes[0].start, '01:20.000');
  assert.equal(localeInput.segments[1].source_scenes[0].end, '01:30.000');
  assert.equal(localeInput.segments[1].source_clips[0].end, '01:30.000');
  assert.equal(localeInput.segments[1].narration_background, true);
  assert.equal(localeInput.segments[1].source_audio_ducking, 0);
  assert.equal(localeInput.segments[0].locale_source_override, true);
});

test('buildLocaleDraftInput splits parent slot locale source across child physical segments', () => {
  const baseDraftInput = {
    segments: [
      { segment_id: 'slot_01_L01', parent_slot_id: 'slot_01', segment_type: 'dialogue_quote', caption_text: '첫 대사' },
      { segment_id: 'slot_01_L02', parent_slot_id: 'slot_01', segment_type: 'dialogue_quote', caption_text: '둘째 대사' },
      { segment_id: 'slot_01_L03', parent_slot_id: 'slot_01', segment_type: 'dialogue_quote', caption_text: '셋째 대사' }
    ],
    captionUnits: []
  };
  const draftSpec = {
    locale: 'ko',
    clip_placement: [{ clip_id: 'ko_slot_01', source_range: [120, 129], visual_role: 'body_peak' }]
  };

  const localeInput = buildLocaleDraftInput(baseDraftInput, draftSpec, 'ko');
  const ranges = localeInput.segments.map((segment) => [secondsFromTimecode(segment.source_scenes[0].start), secondsFromTimecode(segment.source_scenes[0].end)]);

  assert.equal(localeInput.segments[0].source_clips[0].source, 'locale_draft_spec');
  assert.equal(localeInput.segments[0].locale_source_subrange_count, 3);
  assert.ok(ranges[0][1] <= ranges[1][0]);
  assert.ok(ranges[1][1] <= ranges[2][0]);
  assert.ok(ranges[0][0] >= 120);
  assert.ok(ranges[2][1] <= 129);
});

test('buildLocaleDraftInput preserves dialogue child duration when splitting parent source', () => {
  const baseDraftInput = {
    segments: [
      { segment_id: 'slot_04_L01', parent_slot_id: 'slot_04', segment_type: 'dialogue_quote', duration_override_sec: 3.975, caption_text: '첫 대사' },
      { segment_id: 'slot_04_L02', parent_slot_id: 'slot_04', segment_type: 'dialogue_quote', duration_override_sec: 3.975, caption_text: '둘째 대사' }
    ],
    captionUnits: []
  };
  const draftSpec = {
    locale: 'ko',
    clip_placement: [{ clip_id: 'ko_slot_04', source_range: [40, 48], visual_role: 'dialogue_anchor' }]
  };

  const localeInput = buildLocaleDraftInput(baseDraftInput, draftSpec, 'ko');
  const ranges = localeInput.segments.map((segment) => [secondsFromTimecode(segment.source_scenes[0].start), secondsFromTimecode(segment.source_scenes[0].end)]);

  assert.equal(Number((ranges[0][1] - ranges[0][0]).toFixed(3)), 3.975);
  assert.equal(Number((ranges[1][1] - ranges[1][0]).toFixed(3)), 3.975);
  assert.equal(ranges[0][1], ranges[1][0]);
});

test('dialogue-heavy parent atomization marks utterance boundaries, speakers, required and optional atoms', () => {
  const atoms = _test.buildDialogueParentAtomMap([
    { segment_id: 'slot_03_L01', parent_slot_id: 'slot_03', segment_type: 'dialogue_quote', utt_id: 'utt_1', speaker_id: 'jobs', speaker_alias: 'Jobs', speaker_color_key: '남주', caption_color: '#00A9F7', duration_override_sec: 2, source_scenes: [{ start: '00:10.000', end: '00:12.000' }] },
    { segment_id: 'slot_03_L02', parent_slot_id: 'slot_03', segment_type: 'dialogue_quote', utt_id: 'utt_2', speaker_id: 'sculley', speaker_alias: 'Sculley', speaker_color_key: '남조연', caption_color: '#37FF3D', duration_override_sec: 1, source_scenes: [{ start: '00:12.500', end: '00:13.500' }] },
    { segment_id: 'slot_03_L03', parent_slot_id: 'slot_03', segment_type: 'dialogue_quote', utt_id: 'utt_3', speaker_id: 'jobs', speaker_alias: 'Jobs', speaker_color_key: '남주', caption_color: '#00A9F7', duration_override_sec: 3, source_scenes: [{ start: '00:14.000', end: '00:17.000' }] }
  ]).get('slot_03');

  assert.equal(atoms.length, 3);
  assert.deepEqual(atoms.map((atom) => atom.utterance_ids[0]), ['utt_1', 'utt_2', 'utt_3']);
  assert.deepEqual(atoms.map((atom) => atom.speaker_id), ['jobs', 'sculley', 'jobs']);
  assert.deepEqual(atoms.map((atom) => atom.speaker_alias), ['Jobs', 'Sculley', 'Jobs']);
  assert.deepEqual(atoms.map((atom) => atom.speaker_color_key), ['남주', '남조연', '남주']);
  assert.deepEqual(atoms.map((atom) => atom.caption_color), ['#00A9F7', '#37FF3D', '#00A9F7']);
  assert.deepEqual(atoms.map((atom) => atom.caption_kind), ['dialogue', 'dialogue', 'dialogue']);
  assert.deepEqual(atoms.map((atom) => atom.is_required), [true, false, true]);
  assert.equal(atoms[1].dependencies[0].hard, true);
});

test('buildLocaleDraftInput recomposes JA dialogue parent by pruning optional atom while preserving required order', () => {
  const baseDraftInput = {
    segments: [
      { segment_id: 'slot_03_L01', parent_slot_id: 'slot_03', segment_type: 'dialogue_quote', duration_override_sec: 2, speaker_id: 'teddy', speaker_alias: 'Teddy', source_utterance_id: 'utt_teddy_1', source_scenes: [{ start: '00:10.000', end: '00:12.000' }] },
      { segment_id: 'slot_03_L02', parent_slot_id: 'slot_03', segment_type: 'dialogue_quote', duration_override_sec: 1, speaker_id: 'middle', speaker_alias: 'Middle', source_utterance_id: 'utt_middle', source_scenes: [{ start: '00:12.500', end: '00:13.500' }] },
      { segment_id: 'slot_03_L03', parent_slot_id: 'slot_03', segment_type: 'dialogue_quote', duration_override_sec: 3, speaker_id: 'chuck', speaker_alias: 'Chuck', source_utterance_id: 'utt_chuck_1', source_scenes: [{ start: '00:14.000', end: '00:17.000' }] }
    ],
    captionUnits: [
      { caption_id: 'cap_1', segment_id: 'slot_03_L01', segment_type: 'dialogue_quote', text: 'required one', speaker_id: 'teddy', speaker_alias: 'Teddy', source_utterance_id: 'utt_teddy_1' },
      { caption_id: 'cap_2', segment_id: 'slot_03_L02', segment_type: 'dialogue_quote', text: 'optional', speaker_id: 'middle', speaker_alias: 'Middle', source_utterance_id: 'utt_middle' },
      { caption_id: 'cap_3', segment_id: 'slot_03_L03', segment_type: 'dialogue_quote', text: 'required two', speaker_id: 'chuck', speaker_alias: 'Chuck', source_utterance_id: 'utt_chuck_1' }
    ]
  };
  const draftSpec = { locale: 'ja', clip_placement: [{ clip_id: 'ja_slot_03', source_range: [80, 90], visual_role: 'body' }] };

  const localeInput = buildLocaleDraftInput(baseDraftInput, draftSpec, 'ja');

  assert.deepEqual(localeInput.segments.map((segment) => segment.segment_id), ['slot_03_L01', 'slot_03_L03']);
  assert.deepEqual(localeInput.captionUnits.map((unit) => unit.segment_id), ['slot_03_L01', 'slot_03_L03']);
  assert.equal(localeInput.segments[0].source_scenes[0].start, '00:10.000');
  assert.equal(localeInput.segments[1].source_scenes[0].start, '00:14.000');
  assert.equal(localeInput.segments[0].dialogue_parent_recomposition.strategy, 'reaction_led_optional_dialogue_pruned');
  assert.deepEqual(localeInput.segments.map((segment) => segment.dialogue_parent_atom.is_required), [true, true]);
  assert.deepEqual(localeInput.segments.map((segment) => segment.source_utterance_id), ['utt_teddy_1', 'utt_chuck_1']);
  assert.deepEqual(localeInput.captionUnits.map((unit) => unit.source_utterance_id), ['utt_teddy_1', 'utt_chuck_1']);
  assert.ok(localeInput.captionUnits.every((unit) => unit.speaker_color_key && unit.caption_color));
  assert.notEqual(localeInput.captionUnits[0].caption_color, localeInput.captionUnits[1].caption_color);
});

test('single-child dialogue parent keeps metadata and padded visual clip range', () => {
  const baseDraftInput = {
    segments: [
      { segment_id: 'slot_09_L01', parent_slot_id: 'slot_09', segment_type: 'dialogue_quote', duration_override_sec: 1.8, speaker_id: 'lee', speaker_alias: '리', source_utterance_id: 'utt_lee_1', caption_kind: 'dialogue', source_scenes: [{ start: '00:30.200', end: '00:33.900' }] }
    ],
    captionUnits: [
      { caption_id: 'cap_lee_1', segment_id: 'slot_09_L01', segment_type: 'dialogue_quote', text: '같은 말', speaker_id: 'lee', speaker_alias: '리', source_utterance_id: 'utt_lee_1' }
    ]
  };
  const draftSpec = { locale: 'ko', clip_placement: [{ clip_id: 'ko_slot_09', source_range: [30.2, 33.9], visual_role: 'dialogue_anchor' }] };

  const localeInput = buildLocaleDraftInput(baseDraftInput, draftSpec, 'ko');
  const segment = localeInput.segments[0];
  const unit = localeInput.captionUnits[0];

  assert.equal(segment.dialogue_parent_atom.source_utterance_id, 'utt_lee_1');
  assert.equal(segment.dialogue_parent_atom.speaker_id, 'lee');
  assert.equal(segment.source_scenes[0].start, '00:30.200');
  assert.equal(segment.source_scenes[0].end, '00:32.000');
  assert.equal(unit.speaker_id, 'lee');
  assert.equal(unit.source_utterance_id, 'utt_lee_1');
  assert.ok(unit.speaker_color_key);
  assert.ok(unit.caption_color);
});

test('buildLocaleDraftInput moves narration locale range away from protected dialogue atoms', () => {
  const baseDraftInput = {
    sourceDurationSec: 140,
    segments: [
      { segment_id: 'slot_01_L01', parent_slot_id: 'slot_01', segment_type: 'dialogue_quote', duration_override_sec: 8, source_scenes: [{ start: '01:40.000', end: '01:48.000' }] },
      { segment_id: 'slot_06', segment_type: 'recap', caption_text: '나레이션' }
    ],
    captionUnits: []
  };
  const draftSpec = {
    locale: 'ja',
    clip_placement: [
      { clip_id: 'ja_slot_01', source_range: [100, 108], visual_role: 'dialogue_anchor' },
      { clip_id: 'ja_slot_06', source_range: [101, 109], visual_role: 'payoff' }
    ]
  };

  const localeInput = buildLocaleDraftInput(baseDraftInput, draftSpec, 'ja');
  const narration = localeInput.segments.find((segment) => segment.segment_id === 'slot_06');

  assert.equal(narration.dialogue_protected_range_avoidance, true);
  assert.equal(narration.source_scenes[0].start, '01:48.300');
  assert.equal(narration.source_scenes[0].end, '01:56.300');
});

test('buildLocaleDraftInput protects KO rendered parent dialogue ranges from narration overlap', () => {
  const baseDraftInput = {
    sourceDurationSec: 180,
    segments: [
      { segment_id: 'slot_02', segment_type: 'recap', caption_text: '나레이션' },
      { segment_id: 'slot_03_L01', parent_slot_id: 'slot_03', segment_type: 'dialogue_quote', duration_override_sec: 7, source_scenes: [{ start: '00:20.000', end: '00:27.000' }] },
      { segment_id: 'slot_03_L02', parent_slot_id: 'slot_03', segment_type: 'dialogue_quote', duration_override_sec: 3, source_scenes: [{ start: '00:28.000', end: '00:31.000' }] }
    ],
    captionUnits: []
  };
  const draftSpec = {
    locale: 'ko',
    clip_placement: [
      { clip_id: 'ko_slot_02', source_range: [102, 110], visual_role: 'bridge' },
      { clip_id: 'ko_slot_03', source_range: [108, 120], visual_role: 'body' }
    ]
  };

  const localeInput = buildLocaleDraftInput(baseDraftInput, draftSpec, 'ko');
  const narration = localeInput.segments.find((segment) => segment.segment_id === 'slot_02');

  assert.equal(narration.dialogue_protected_range_avoidance, true);
  assert.equal(narration.source_scenes[0].start, '01:58.300');
  assert.equal(narration.source_scenes[0].end, '02:06.300');
});

test('buildLocaleDraftInput avoids collisions between multiple protected narration ranges', () => {
  const baseDraftInput = {
    sourceDurationSec: 180,
    segments: [
      { segment_id: 'slot_02', segment_type: 'recap', caption_text: '첫 나레이션' },
      { segment_id: 'slot_03_L01', parent_slot_id: 'slot_03', segment_type: 'dialogue_quote', duration_override_sec: 7, source_scenes: [{ start: '00:20.000', end: '00:27.000' }] },
      { segment_id: 'slot_03_L02', parent_slot_id: 'slot_03', segment_type: 'dialogue_quote', duration_override_sec: 12, source_scenes: [{ start: '00:32.000', end: '00:44.000' }] },
      { segment_id: 'slot_06', segment_type: 'recap', caption_text: '두 번째 나레이션' }
    ],
    captionUnits: []
  };
  const draftSpec = {
    locale: 'ja',
    clip_placement: [
      { clip_id: 'ja_slot_02', source_range: [19, 27], visual_role: 'bridge' },
      { clip_id: 'ja_slot_03', source_range: [60, 80], visual_role: 'body' },
      { clip_id: 'ja_slot_06', source_range: [38, 46], visual_role: 'payoff' }
    ]
  };

  const localeInput = buildLocaleDraftInput(baseDraftInput, draftSpec, 'ja');
  const first = localeInput.segments.find((segment) => segment.segment_id === 'slot_02');
  const second = localeInput.segments.find((segment) => segment.segment_id === 'slot_06');

  assert.equal(first.source_scenes[0].start, '00:44.300');
  assert.equal(first.source_scenes[0].end, '00:52.300');
  assert.equal(second.source_scenes[0].start, '00:52.600');
  assert.equal(second.source_scenes[0].end, '01:00.600');
});

test('dialogue parent overlap gate allows one shared required atom but fails repeated required chain', () => {
  const koInput = {
    segments: [
      { dialogue_parent_atom: { slot_id: 'slot_03', atomic_id: 'a1', duration_sec: 2, is_required: true } },
      { dialogue_parent_atom: { slot_id: 'slot_03', atomic_id: 'a2', duration_sec: 2, is_required: false } },
      { dialogue_parent_atom: { slot_id: 'slot_03', atomic_id: 'a3', duration_sec: 3, is_required: true } }
    ]
  };
  const jaSingleShared = { segments: [{ dialogue_parent_atom: { slot_id: 'slot_03', atomic_id: 'a1', duration_sec: 2, is_required: true } }] };
  const jaRepeatedShared = { segments: [
    { dialogue_parent_atom: { slot_id: 'slot_03', atomic_id: 'a1', duration_sec: 2, is_required: true } },
    { dialogue_parent_atom: { slot_id: 'slot_03', atomic_id: 'a3', duration_sec: 3, is_required: true } }
  ] };

  assert.equal(compareDialogueParentCompositions(koInput, jaSingleShared).status, 'pass');
  assert.equal(compareDialogueParentCompositions(koInput, jaRepeatedShared).reports[0].identical_required_anchor_chain, false);
});

test('buildLocaleDraftInput applies numeric draft spec clips by stable slot order', () => {
  const baseDraftInput = {
    segments: [
      { segment_id: 'slot_01_L01', parent_slot_id: 'slot_01', segment_type: 'dialogue_quote', caption_text: '첫 대사' },
      { segment_id: 'slot_01_L02', parent_slot_id: 'slot_01', segment_type: 'dialogue_quote', caption_text: '둘째 대사' },
      { segment_id: 'slot_02', caption_text: '두 번째 장면' },
      { segment_id: 'slot_03', caption_text: '세 번째 장면' }
    ],
    captionUnits: [
      { caption_id: 'cap_01', segment_id: 'slot_01_L01', text: '첫 대사' },
      { caption_id: 'cap_02', segment_id: 'slot_02', text: '두 번째 장면' }
    ]
  };
  const draftSpec = {
    locale: 'ja',
    clip_placement: [
      { clip_id: 'ja_2', source_range: [160, 166], visual_role: 'lead_in' },
      { clip_id: 'ja_5', source_range: [170, 176], visual_role: 'reaction_support' },
      { clip_id: 'ja_1', source_range: [180, 186], visual_role: 'post_peak' }
    ]
  };

  const localeInput = buildLocaleDraftInput(baseDraftInput, draftSpec, 'ja');
  const byId = new Map(localeInput.segments.map((segment) => [segment.segment_id, segment]));

  assert.equal(byId.get('slot_01_L01').source_scenes[0].start, '02:40.000');
  assert.equal(byId.get('slot_01_L02').source_scenes[0].end, '02:46.000');
  assert.equal(byId.get('slot_02').source_scenes[0].start, '02:50.000');
  assert.equal(byId.get('slot_03').source_scenes[0].start, '03:00.000');
  assert.equal(localeInput.segments.every((segment) => segment.locale_source_override), true);
  assert.equal(localeInput.captionUnits.every((unit) => unit.locale_source_override), true);
});

test('buildLocaleDraftInput reorders physical segment chain from draft_spec placement order', () => {
  const baseDraftInput = {
    segments: [
      { segment_id: 'slot_01', caption_text: '첫 번째', source_scenes: [{ start: '00:01.000', end: '00:03.000' }] },
      { segment_id: 'slot_02', caption_text: '두 번째', source_scenes: [{ start: '00:05.000', end: '00:07.000' }] },
      { segment_id: 'slot_03', caption_text: '세 번째', source_scenes: [{ start: '00:09.000', end: '00:11.000' }] }
    ],
    captionUnits: [
      { caption_id: 'cap_01', segment_id: 'slot_01', text: '첫 번째' },
      { caption_id: 'cap_02', segment_id: 'slot_02', text: '두 번째' },
      { caption_id: 'cap_03', segment_id: 'slot_03', text: '세 번째' }
    ]
  };
  const draftSpec = {
    locale: 'ja',
    clip_placement: [
      { clip_id: 'ja_slot_03', source_range: [90, 92], visual_role: 'cold_open' },
      { clip_id: 'ja_slot_01', source_range: [10, 12], visual_role: 'bridge' },
      { clip_id: 'ja_slot_02', source_range: [40, 42], visual_role: 'payoff' }
    ]
  };

  const localeInput = buildLocaleDraftInput(baseDraftInput, draftSpec, 'ja');

  assert.deepEqual(localeInput.segments.map((segment) => segment.segment_id), ['slot_03', 'slot_01', 'slot_02']);
  assert.deepEqual(localeInput.captionUnits.map((unit) => unit.segment_id), ['slot_03', 'slot_01', 'slot_02']);
  assert.deepEqual(localeInput.segments[0].story_anchor.source_range_hint, [90, 92]);
});

test('generateLocaleDraftArtifacts creates separate folder-only KO/JA draft artifacts and final overlap report', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'midform-locale-drafts-'));
  const baseDraftInputPath = path.join(workspaceDir, 'draft_input.json');
  writeJson(baseDraftInputPath, {
    segments: [
      { segment_id: 'slot_01', caption_text: '첫 장면', source_scenes: [{ start: '00:01.000', end: '00:05.000' }] },
      { segment_id: 'slot_02', caption_text: '두 번째 장면', source_scenes: [{ start: '00:08.000', end: '00:12.000' }] },
      { segment_id: 'slot_03', caption_text: '세 번째 장면', source_scenes: [{ start: '00:14.000', end: '00:18.000' }] }
    ],
    captionUnits: [],
    ttsFiles: [],
    sourceDurationSec: 180
  });
  writeJson(path.join(workspaceDir, 'draft_spec.ko.json'), {
    locale: 'ko',
    clip_placement: [
      { clip_id: 'ko_slot_01', source_range: [10, 14], visual_role: 'cold_open' },
      { clip_id: 'ko_slot_02', source_range: [20, 24], visual_role: 'body' },
      { clip_id: 'ko_slot_03', source_range: [30, 34], visual_role: 'payoff' }
    ]
  });
  writeJson(path.join(workspaceDir, 'draft_spec.ja.json'), {
    locale: 'ja',
    clip_placement: [
      { clip_id: 'ja_slot_01', source_range: [60, 64], visual_role: 'bridge' },
      { clip_id: 'ja_slot_02', source_range: [80, 84], visual_role: 'cold_open' },
      { clip_id: 'ja_slot_03', source_range: [100, 104], visual_role: 'payoff' }
    ]
  });

  const rendered = [];
  const result = await generateLocaleDraftArtifacts({
    workspaceDir,
    baseDraftInputPath,
    draftGenerator: async (locale, localeDraftInput, draftWorkspaceDir) => {
      rendered.push({ locale, input: localeDraftInput });
      const draftFolder = path.join(draftWorkspaceDir, `draft_${locale}`);
      fs.mkdirSync(draftFolder, { recursive: true });
      const draftContent = {
        tracks: [{
          type: 'video',
          name: 'source_video',
          segments: localeDraftInput.segments.map(videoSegmentFromSourceScene)
        }]
      };
      const sourceDraftContentPath = path.join(draftFolder, 'draft_content.json');
      const workspaceDraftContentPath = path.join(draftWorkspaceDir, `draft_content.${locale}.json`);
      writeJson(sourceDraftContentPath, draftContent);
      writeJson(workspaceDraftContentPath, draftContent);
      return {
        locale,
        result: { draftPath: draftFolder, draftOutputMode: 'folder_only', packageZip: false, zipPath: '' },
        draft_folder_path: draftFolder,
        draft_content_path: workspaceDraftContentPath,
        source_draft_content_path: sourceDraftContentPath,
        replan_attempt: localeDraftInput.finalDraftReplanAttempt || 0
      };
    }
  });

  assert.deepEqual(rendered.map((item) => item.locale), ['ko', 'ja']);
  assert.equal(fs.existsSync(path.join(workspaceDir, 'draft_input.ko.json')), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, 'draft_input.ja.json')), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, 'draft_content.ko.json')), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, 'draft_content.ja.json')), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, 'draft_ko')), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, 'draft_ja')), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, 'overlap_report_final_draft.ko_vs_ja.json')), true);
  assert.equal(result.finalOverlapReport.final_status, 'pass');
  assert.equal(result.finalOverlapReport.source_range_overlap_ratio, 0);
  assert.equal(result.finalOverlapReport.top_highlight_cluster_ordering.identical, false);
  assert.equal(Object.keys(result.outputPaths).some((key) => key.includes('zip')), false);
  assert.match(result.outputPaths.draft_folder_ko, /draft_ko$/);
  assert.match(result.outputPaths.draft_folder_ja, /draft_ja$/);
});

test('replanJaDraftSpecForFinalOverlap changes JA video source ranges instead of caption-only retrying', () => {
  const draftSpec = {
    locale: 'ja',
    clip_placement: [
      { clip_id: 'ja_slot_01', source_range: [10, 14], visual_role: 'cold_open' },
      { clip_id: 'ja_slot_02', source_range: [20, 24], visual_role: 'body' },
      { clip_id: 'ja_slot_03', source_range: [30, 34], visual_role: 'payoff' }
    ]
  };

  const replanned = replanJaDraftSpecForFinalOverlap(draftSpec, {
    failed_gates: ['three_shot_identical_chain'],
    shared_contiguous_blocks: [{ ja_start_index: 0, length: 3, clips: [] }]
  }, 1, { sourceDurationSec: 180 });

  assert.notDeepEqual(replanned.clip_placement.map((clip) => clip.source_range), draftSpec.clip_placement.map((clip) => clip.source_range));
  assert.equal(replanned.final_draft_replan.strategy, 'ja_video_chain_reselection');
  assert.equal(replanned.clip_placement.every((clip) => clip.final_draft_replan_attempt === 1), true);

  const secondAttempt = replanJaDraftSpecForFinalOverlap(replanned, {
    failed_gates: ['shared_contiguous_block_threshold'],
    shared_contiguous_blocks: [{ ja_start_index: 0, length: 3, clips: [] }]
  }, 2, { sourceDurationSec: 180 });
  assert.ok(secondAttempt.clip_placement[0].source_range[0] < replanned.clip_placement[0].source_range[0]);

  const lateAttempt = replanJaDraftSpecForFinalOverlap({
    locale: 'ja',
    clip_placement: [
      { clip_id: 'ja_slot_1', source_range: [80, 92], visual_role: 'cold_open' },
      { clip_id: 'ja_slot_3', source_range: [92, 114], visual_role: 'body_peak' },
      { clip_id: 'ja_slot_4', source_range: [140, 160], visual_role: 'payoff' }
    ]
  }, {
    failed_gates: ['shared_contiguous_block_threshold'],
    shared_contiguous_blocks: [{ ja_start_index: 2, length: 1, clips: [{ ja_clip_id: 'ja_slot_4' }] }]
  }, 3, { sourceDurationSec: 160 });
  assert.equal(lateAttempt.clip_placement[1].clip_id, 'ja_slot_4');
  assert.ok(lateAttempt.clip_placement[1].source_range[0] < 60);

  const targetedAttempt = replanJaDraftSpecForFinalOverlap({
    locale: 'ja',
    clip_placement: [
      { clip_id: 'ja_slot_1', source_range: [40, 52], visual_role: 'cold_open' },
      { clip_id: 'ja_slot_4', source_range: [130, 150], visual_role: 'payoff' },
      { clip_id: 'ja_slot_3', source_range: [82, 104], visual_role: 'body_peak' }
    ]
  }, {
    failed_gates: ['shared_contiguous_block_threshold'],
    top_highlight_cluster_ordering: {
      ko: [{ source_range: [90, 102] }],
      ja: [{ source_range: [91, 103] }]
    },
    shared_contiguous_blocks: [{ ja_start_index: 2, length: 1, clips: [] }]
  }, 3, { sourceDurationSec: 160 });
  assert.equal(targetedAttempt.clip_placement[1].clip_id, 'ja_slot_3');
});

test('normalizeDraftSpecSourceRanges removes intra-locale source overlaps before physical render', () => {
  const normalized = normalizeDraftSpecSourceRanges({
    locale: 'ja',
    clip_placement: [
      { clip_id: 'ja_slot_01', source_range: [10, 14], visual_role: 'cold_open' },
      { clip_id: 'ja_slot_02', source_range: [12, 16], visual_role: 'dialogue_anchor' },
      { clip_id: 'ja_slot_03', source_range: [17, 20], visual_role: 'payoff' }
    ]
  }, { sourceDurationSec: 120 });

  assert.deepEqual(normalized.clip_placement[0].source_range, [10, 14]);
  assert.ok(normalized.clip_placement[1].source_range[0] > normalized.clip_placement[0].source_range[1]);
  assert.equal(normalized.clip_placement[1].source_range_normalized_for_physical_draft, true);
  assert.equal(normalized.shot_duration.length, 3);
});

test('normalizeDraftSpecSourceRanges preserves monotonic order near source tail', () => {
  const normalized = normalizeDraftSpecSourceRanges({
    locale: 'ja',
    clip_placement: [
      { clip_id: 'ja_slot_08', source_range: [120.72, 124.3], visual_role: 'payoff' },
      { clip_id: 'ja_slot_09', source_range: [122.04, 140.04], visual_role: 'payoff' }
    ]
  }, { sourceDurationSec: 125 });

  assert.ok(normalized.clip_placement[1].source_range[0] > normalized.clip_placement[0].source_range[1]);
  assert.ok(normalized.clip_placement[1].source_range[1] <= 125);
  assert.equal(normalized.clip_placement[1].source_range_normalized_for_physical_draft, true);
});

test('normalizeDraftSpecSourceRanges caps long source windows for physical edit clips', () => {
  const normalized = normalizeDraftSpecSourceRanges({
    locale: 'ja',
    clip_placement: [
      { clip_id: 'ja_slot_01', source_range: [10, 70], visual_role: 'bridge' },
      { clip_id: 'ja_slot_02', source_range: [71, 90], visual_role: 'payoff' }
    ]
  }, { sourceDurationSec: 140 });

  assert.ok(normalized.clip_placement[0].source_range[1] - normalized.clip_placement[0].source_range[0] <= 8);
  assert.ok(normalized.clip_placement[1].source_range[0] > normalized.clip_placement[0].source_range[1]);
});

test('normalizeDraftSpecSourceRanges keeps parent dialogue windows long enough for children', () => {
  const normalized = normalizeDraftSpecSourceRanges({
    locale: 'ko',
    clip_placement: [
      { clip_id: 'ko_slot_03', source_range: [100, 140], visual_role: 'dialogue_anchor' },
      { clip_id: 'ko_slot_04', source_range: [141, 170], visual_role: 'dialogue_anchor' }
    ]
  }, {
    sourceDurationSec: 180,
    segments: [
      { segment_id: 'slot_03_L01', parent_slot_id: 'slot_03', segment_type: 'dialogue_quote', duration_override_sec: 7.059 },
      { segment_id: 'slot_03_L02', parent_slot_id: 'slot_03', segment_type: 'dialogue_quote', duration_override_sec: 2.099 },
      { segment_id: 'slot_03_L03', parent_slot_id: 'slot_03', segment_type: 'dialogue_quote', duration_override_sec: 11.92 },
      { segment_id: 'slot_04_L01', parent_slot_id: 'slot_04', segment_type: 'dialogue_quote', duration_override_sec: 8.34 },
      { segment_id: 'slot_04_L02', parent_slot_id: 'slot_04', segment_type: 'dialogue_quote', duration_override_sec: 11.92 }
    ]
  });

  assert.equal(Number((normalized.clip_placement[0].source_range[1] - normalized.clip_placement[0].source_range[0]).toFixed(3)), 21.078);
  assert.equal(Number((normalized.clip_placement[1].source_range[1] - normalized.clip_placement[1].source_range[0]).toFixed(3)), 20.26);
  assert.ok(normalized.clip_placement[1].source_range[0] > normalized.clip_placement[0].source_range[1]);
});

const assert = require('node:assert/strict');
const test = require('node:test');

const { readJson, colorEvidenceBySpeaker, validateSpeakerColorMetadata } = require('./artifactQaHelpers');
const { evaluateEditorialAcceptance } = require('../server/services/midformEditorialAcceptanceService');
const { buildSpeakerMetadata, resolveCaptionColor } = require('../server/utils/captionColorConfig');

test('caption color config maps Jobs and Sculley to distinct visible colors', () => {
  const config = readJson('midform/config/caption_colors.json');
  const speakers = config.speakers || {};
  const roles = config.roles || {};

  const resolveColor = (speaker) => {
    const mapped = speakers[speaker];
    if (typeof mapped === 'string' && mapped.startsWith('#')) return mapped;
    if (typeof mapped === 'string' && roles[mapped]) return roles[mapped];
    return roles[speaker] || '';
  };

  const jobsColor = resolveColor('Jobs');
  const sculleyColor = resolveColor('Sculley');

  assert.match(jobsColor, /^#[0-9A-Fa-f]{6}$/);
  assert.match(sculleyColor, /^#[0-9A-Fa-f]{6}$/);
  assert.notEqual(jobsColor.toLowerCase(), sculleyColor.toLowerCase());
});

test('caption color config resolves English and Korean Jobs/Scully aliases consistently', () => {
  const config = readJson('midform/config/caption_colors.json');
  const speakers = config.speakers || {};
  const roles = config.roles || {};
  const resolveColor = (speaker) => {
    const mapped = speakers[speaker];
    if (typeof mapped === 'string' && mapped.startsWith('#')) return mapped;
    if (typeof mapped === 'string' && roles[mapped]) return roles[mapped];
    return roles[speaker] || '';
  };

  for (const alias of ['Jobs', 'Steve', 'Steve Jobs', '잡스', '스티브 잡스']) {
    assert.equal(resolveColor(alias), '#00A9F7', alias);
  }
  for (const alias of ['Sculley', 'Scully', 'John Sculley', 'John Scully', '스컬리', '존 스컬리']) {
    assert.equal(resolveColor(alias), '#37FF3D', alias);
  }
});

test('caption color config resolves Korean family-role aliases for dialogue-heavy movie scenes', () => {
  const config = readJson('midform/config/caption_colors.json');
  const speakers = config.speakers || {};
  const roles = config.roles || {};
  const resolveColor = (speaker) => {
    const mapped = speakers[speaker];
    if (typeof mapped === 'string' && mapped.startsWith('#')) return mapped;
    if (typeof mapped === 'string' && roles[mapped]) return roles[mapped];
    return roles[speaker] || '';
  };

  assert.equal(resolveColor('아버지'), '#00A9F7');
  assert.equal(resolveColor('아빠'), '#00A9F7');
  assert.equal(resolveColor('아들'), '#37FF3D');
  assert.notEqual(resolveColor('아버지'), resolveColor('아들'));
});

test('unknown speaker color behavior is stable and does not affect known speakers', () => {
  const config = readJson('midform/config/caption_colors.json');
  const speakers = config.speakers || {};
  const roles = config.roles || {};
  const resolveColor = (speaker) => {
    const mapped = speakers[speaker];
    if (typeof mapped === 'string' && mapped.startsWith('#')) return mapped;
    if (typeof mapped === 'string' && roles[mapped]) return roles[mapped];
    return roles[speaker] || '';
  };

  assert.equal(resolveColor('Jobs'), '#00A9F7');
  assert.equal(resolveColor('Scully'), '#37FF3D');
  const unknown = buildSpeakerMetadata({ speaker: 'Unknown Speaker', speaker_id: 'unknown_speaker', segment_type: 'dialogue_quote', utt_id: 'utt_unknown' }, {}, config);
  const unknownAgain = buildSpeakerMetadata({ speaker: 'Unknown Speaker', speaker_id: 'unknown_speaker', segment_type: 'dialogue_quote', utt_id: 'utt_unknown_2' }, {}, config);
  assert.ok(unknown.speaker_color_key);
  assert.equal(unknown.speaker_color_key, unknownAgain.speaker_color_key);
  assert.match(resolveCaptionColor({ speakerAlias: unknown.speaker_alias, speakerColorKey: unknown.speaker_color_key }, config), /^#[0-9A-Fa-f]{6}$/);
});

test('fresh unregistered Zodiac/Shutter-style speakers get deterministic non-collapsed colors across locales', () => {
  const config = readJson('midform/config/caption_colors.json');
  const teddyKo = buildSpeakerMetadata({ speaker: 'Teddy', speaker_id: 'teddy', segment_type: 'dialogue_quote', utt_id: 'utt_001' }, {}, config);
  const teddyJa = buildSpeakerMetadata({ speaker: 'テディ', speaker_id: 'teddy', segment_type: 'dialogue_quote', utt_id: 'utt_ja_001' }, {}, config);
  const chuck = buildSpeakerMetadata({ speaker: 'Chuck', speaker_id: 'chuck', segment_type: 'dialogue_quote', utt_id: 'utt_002' }, {}, config);
  const lee = buildSpeakerMetadata({ speaker: '리', speaker_id: 'lee', segment_type: 'dialogue_quote', utt_id: 'utt_003' }, {}, config);

  assert.equal(teddyKo.speaker_color_key, teddyJa.speaker_color_key);
  assert.notEqual(teddyKo.speaker_color_key, chuck.speaker_color_key);
  assert.notEqual(chuck.speaker_color_key, lee.speaker_color_key);
  assert.notEqual(resolveCaptionColor({ speakerColorKey: teddyKo.speaker_color_key }, config), resolveCaptionColor({ speakerColorKey: chuck.speaker_color_key }, config));
  assert.match(resolveCaptionColor({ speakerColorKey: lee.speaker_color_key }, config), /^#[0-9A-Fa-f]{6}$/);
});

test('speaker color artifact helper requires dialogue color evidence, not just speaker names', () => {
  const manifest = {
    segments: [
      { segment_id: 'slot_early_jobs', segment_type: 'dialogue_quote', speaker: 'Jobs', caption_color: '#00A9F7', timeline_start_sec: 20, timeline_end_sec: 23, narration: '왜 사람들이 당신이 날 해고했다고 믿죠?' },
      { segment_id: 'slot_early_sculley', segment_type: 'dialogue_quote', speaker: 'Sculley', caption_color: '#FFC137', timeline_start_sec: 23, timeline_end_sec: 27, narration: '광고는 내가 살린 겁니다.' },
      { segment_id: 'slot_narrate', segment_type: 'recap', speaker: '', caption_color: '', timeline_start_sec: 27, timeline_end_sec: 33, narration: '두 사람의 기억은 완전히 달랐습니다.' }
    ]
  };

  assert.deepEqual(colorEvidenceBySpeaker(manifest), {
    Jobs: ['#00A9F7'],
    Sculley: ['#FFC137']
  });
});

test('speaker color metadata gate rejects missing and collapsed dialogue colors', () => {
  const manifest = {
    segments: [
      { segment_id: 'scene_01_L01', segment_type: 'dialogue_quote', speaker_id: 'jobs', speaker_alias: 'Jobs', speaker_color_key: '남주', source_utterance_id: 'utt_001', caption_color: '#00A9F7', timeline_start_sec: 0, timeline_end_sec: 2, narration: '왜 그랬어?' },
      { segment_id: 'scene_01_L02', segment_type: 'dialogue_quote', speaker_id: 'sculley', speaker_alias: 'Sculley', speaker_color_key: '남조연', source_utterance_id: 'utt_002', caption_color: '#00A9F7', timeline_start_sec: 2, timeline_end_sec: 4, narration: '아니야.' },
      { segment_id: 'scene_02_L01', segment_type: 'dialogue_quote', speaker_id: '', speaker_alias: '', speaker_color_key: '', source_utterance_id: '', caption_color: '', timeline_start_sec: 5, timeline_end_sec: 6, narration: '누구지?' }
    ]
  };

  const validation = validateSpeakerColorMetadata(manifest);
  const gates = evaluateEditorialAcceptance({
    segments: manifest.segments,
    speaker_color_validation: validation,
    material_validation: { checked: 1, passed: 1, failed: [] }
  });

  assert.equal(validation.status, 'failed');
  assert.ok(validation.failed.includes('dialogue_speaker_metadata_present'));
  assert.ok(validation.failed.includes('distinct_speakers_not_collapsed'));
  assert.ok(gates.failed.includes('dialogue_speaker_metadata_present'));
  assert.ok(gates.failed.includes('distinct_speakers_not_collapsed'));
});

test('speaker color metadata gate passes separated narration and dialogue colors', () => {
  const manifest = {
    segments: [
      { segment_id: 'scene_01_L01', segment_type: 'dialogue_quote', speaker_id: 'jobs', speaker_alias: 'Jobs', speaker_color_key: '남주', source_utterance_id: 'utt_001', caption_color: '#00A9F7', timeline_start_sec: 0, timeline_end_sec: 2, narration: '왜 그랬어?' },
      { segment_id: 'scene_01_L02', segment_type: 'dialogue_quote', speaker_id: 'sculley', speaker_alias: 'Sculley', speaker_color_key: '남조연', source_utterance_id: 'utt_002', caption_color: '#37FF3D', timeline_start_sec: 2, timeline_end_sec: 4, narration: '아니야.' },
      { segment_id: 'narration_01', segment_type: 'recap', caption_color: '', timeline_start_sec: 4, timeline_end_sec: 7, narration: '두 사람은 충돌했습니다.' }
    ]
  };

  const validation = validateSpeakerColorMetadata(manifest);

  assert.equal(validation.status, 'passed');
  assert.deepEqual(validation.failed, []);
});

test('current Steve Jobs render has speaker metadata but no speaker color evidence', () => {
  const manifest = readJson('tests/fixtures/midform/drafts/late_dialogue_baseline/edit_manifest.json');
  const evidence = colorEvidenceBySpeaker(manifest);

  assert.deepEqual(evidence.Jobs || [], []);
  assert.deepEqual(evidence.Sculley || [], []);
});

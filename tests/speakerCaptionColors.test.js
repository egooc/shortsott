const assert = require('node:assert/strict');
const test = require('node:test');

const { readJson, colorEvidenceBySpeaker } = require('./artifactQaHelpers');

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

  assert.equal(resolveColor('Unknown Speaker'), '');
  assert.equal(resolveColor('Jobs'), '#00A9F7');
  assert.equal(resolveColor('Scully'), '#37FF3D');
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

test('current Steve Jobs render has speaker metadata but no speaker color evidence', () => {
  const manifest = readJson('server/output/drafts/pipeline_1785135546/edit_manifest.json');
  const evidence = colorEvidenceBySpeaker(manifest);

  assert.deepEqual(evidence.Jobs || [], []);
  assert.deepEqual(evidence.Sculley || [], []);
});

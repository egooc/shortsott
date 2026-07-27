const assert = require('node:assert/strict');
const test = require('node:test');

const { evaluateEditorialAcceptance, _test } = require('../server/services/midformEditorialAcceptanceService');

test('editorial acceptance rejects rebuttal-only confrontation opener and missing callback', () => {
  const result = evaluateEditorialAcceptance({
    scene_type: 'dialogue_confrontation',
    editorial_pattern: 'cold_open_callback',
    segments: [
      { segment_id: 's1', segment_type: 'dialogue_quote', caption_text: '아니, 내가 한 게 아니야.', timeline_start_sec: 0, timeline_end_sec: 3 },
      { segment_id: 's2', segment_type: 'recap', narration: '한참 설명이 이어집니다.', timeline_start_sec: 3, timeline_end_sec: 45 }
    ],
    caption_units: [{ caption_id: 'c1', segment_id: 's1', text: '아니, 내가 한 게 아니야.' }],
    material_validation: { checked: 1, passed: 1, failed: [] }
  });

  assert.equal(result.status, 'failed');
  assert.ok(result.failed.includes('rebuttal_only_opener'));
  assert.ok(result.failed.includes('callback_strength'));
});

test('editorial acceptance passes a clear cold-open callback confrontation with color proof', () => {
  const result = evaluateEditorialAcceptance({
    scene_type: 'dialogue_confrontation',
    editorial_pattern: 'cold_open_callback',
    segments: [
      { segment_id: 'slot_01_L01', parent_slot_id: 'slot_01', segment_type: 'dialogue_quote', caption_text: '잡스가 믿던 해고의 진실이 뒤집힙니다.', timeline_start_sec: 0, timeline_end_sec: 3 },
      { segment_id: 'slot_02', segment_type: 'recap', narration: '발표 직전, 두 사람은 광고와 해고 책임을 두고 맞붙습니다.', timeline_start_sec: 3, timeline_end_sec: 20 },
      { segment_id: 'slot_04_L01', parent_slot_id: 'slot_04', segment_type: 'dialogue_quote', caption_text: '그 광고를 지킨 건 나였어.', timeline_start_sec: 22, timeline_end_sec: 25 }
    ],
    caption_units: [
      { caption_id: 'c1', segment_id: 'slot_01_L01', text: '잡스가 믿던 해고의 진실이' },
      { caption_id: 'c2', segment_id: 'slot_04_L01', text: '그 광고를 지킨 건 나였어.' }
    ],
    material_validation: { checked: 2, passed: 2, failed: [] }
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(result.failed, []);
});

test('editorial acceptance warns on subtitle density instead of hiding readability risk', () => {
  const issues = _test.captionReadabilityIssues([
    { caption_id: 'long', segment_id: 's1', text: '이 자막은 한 줄에서 보기에는 너무 길고 밀도가 높습니다' },
    { caption_id: 'a', segment_id: 'dense', text: '하나' },
    { caption_id: 'b', segment_id: 'dense', text: '둘' },
    { caption_id: 'c', segment_id: 'dense', text: '셋' },
    { caption_id: 'd', segment_id: 'dense', text: '넷' },
    { caption_id: 'e', segment_id: 'dense', text: '다섯' },
    { caption_id: 'f', segment_id: 'dense', text: '여섯' },
    { caption_id: 'g', segment_id: 'dense', text: '일곱' }
  ], { maxChars: 12, maxUnitsPerSegment: 6 });

  assert.ok(issues.some((issue) => issue.type === 'overlong_caption'));
  assert.ok(issues.some((issue) => issue.type === 'dense_segment'));
});

test('editorial acceptance flags rendered color mismatch when proof fails', () => {
  const result = evaluateEditorialAcceptance({
    scene_type: 'comedic_setpiece',
    editorial_pattern: 'chronological_escalation',
    segments: [
      { segment_id: 's1', segment_type: 'dialogue_quote', caption_text: '벨라를 여기서 빼내.', timeline_start_sec: 0, timeline_end_sec: 2 }
    ],
    caption_units: [{ caption_id: 'c1', segment_id: 's1', text: '벨라를 여기서 빼내.' }],
    material_validation: { checked: 1, passed: 0, failed: [{ caption_id: 'c1' }] }
  });

  assert.equal(result.status, 'failed');
  assert.ok(result.failed.includes('rendered_speaker_color_match'));
});

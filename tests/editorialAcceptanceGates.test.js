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

test('editorial acceptance treats investigation framing as first-30 conflict clarity', () => {
  const result = evaluateEditorialAcceptance({
    scene_type: 'dialogue_confrontation',
    editorial_pattern: 'cold_open_callback',
    segments: [
      { segment_id: 'slot_01_L01', parent_slot_id: 'slot_01', segment_type: 'dialogue_quote', caption_text: '전 조디악이 아닙니다.', speaker: '아서 리 앨런', timeline_start_sec: 0.53, timeline_end_sec: 3.1 },
      { segment_id: 'slot_01_L02', parent_slot_id: 'slot_01', segment_type: 'dialogue_quote', caption_text: '만약 제가 조디악이라도, 당신들한테 말하진 않겠죠.', speaker: '아서 리 앨런', timeline_start_sec: 3.18, timeline_end_sec: 5.74 },
      { segment_id: 'slot_02', segment_type: 'recap', narration: "연쇄살인마 '조디악'의 유력 용의자, 아서 리 앨런.", timeline_start_sec: 5.89, timeline_end_sec: 9.834 },
      { segment_id: 'slot_02', segment_type: 'recap', narration: '형사들이 그의 알리바이를 추궁하기 시작합니다.', timeline_start_sec: 9.834, timeline_end_sec: 13.204 },
      { segment_id: 'slot_03_L01', parent_slot_id: 'slot_03', segment_type: 'dialogue_quote', caption_text: '제 차에 있던 피 묻은 칼들은 닭의 피였습니다.', speaker: '아서 리 앨런', timeline_start_sec: 20.367, timeline_end_sec: 27.747 }
    ],
    caption_units: [
      { caption_id: 'c1', segment_id: 'slot_01_L01', text: '전 조디악이 아닙니다.' },
      { caption_id: 'c2', segment_id: 'slot_03_L01', text: '제 차에 있던 피 묻은 칼들은 닭의 피였습니다.' }
    ],
    material_validation: { checked: 2, passed: 2, failed: [] }
  });

  assert.equal(result.results.find((item) => item.id === 'first_30_conflict_clarity').status, 'pass');
  assert.deepEqual(result.failed, []);
});

test('editorial acceptance still rejects a first 30 seconds without concrete conflict', () => {
  const result = evaluateEditorialAcceptance({
    scene_type: 'dialogue_confrontation',
    editorial_pattern: 'cold_open_callback',
    segments: [
      { segment_id: 'slot_01_L01', parent_slot_id: 'slot_01', segment_type: 'dialogue_quote', caption_text: '오늘은 여기서 시작합니다.', timeline_start_sec: 0, timeline_end_sec: 3 },
      { segment_id: 'slot_02', segment_type: 'recap', narration: '두 사람은 방 안에서 차분히 대화를 이어갑니다.', timeline_start_sec: 3, timeline_end_sec: 18 },
      { segment_id: 'slot_03_L01', parent_slot_id: 'slot_03', segment_type: 'dialogue_quote', caption_text: '이야기를 계속해 보죠.', timeline_start_sec: 20, timeline_end_sec: 23 }
    ],
    caption_units: [
      { caption_id: 'c1', segment_id: 'slot_01_L01', text: '오늘은 여기서 시작합니다.' },
      { caption_id: 'c2', segment_id: 'slot_03_L01', text: '이야기를 계속해 보죠.' }
    ],
    material_validation: { checked: 2, passed: 2, failed: [] }
  });

  assert.equal(result.results.find((item) => item.id === 'first_30_conflict_clarity').status, 'fail');
  assert.ok(result.failed.includes('first_30_conflict_clarity'));
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

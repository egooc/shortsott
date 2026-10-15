// tag-share 회귀 — 10-15 실측 스냅숏으로 셈만 본다(네트워크 없음).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tally, tagsOf } = require('../scripts/tag-share');

const items = (dir, name) => require(path.join(__dirname, 'fixtures', dir, `${name}_20261015.json`)).items;

// ── 잡아야 할 것 ──
test('대장간 장인: 꼬리표 16편·16채널, 한국어 제목+꼬리표 30%대', () => {
  const r = tally(items('tag_share', 'blacksmith_ko'));
  assert.equal(r.mass, 16);
  assert.equal(r.mass_channels, 16);
  assert.ok(r.local_mass_share >= 0.3 && r.local_mass_share < 0.35);
});

test('대장간 장인: «#process #worker» 쌍이 3채널+ 공통 쌍 1위', () => {
  const r = tally(items('tag_share', 'blacksmith_ko'));
  assert.equal(r.shared_pairs[0].pair, '#process #worker');
  assert.equal(r.shared_pairs[0].channels, 16);
});

test('--tags 를 바꾸면 다른 양산 틀도 센다 (#blacksmith → 7편, 쌍 통계의 5는 #process 와 같이 단 편만)', () => {
  const r = tally(items('tag_share', 'blacksmith_ko'), { tags: ['blacksmith'] });
  assert.equal(r.mass, 7);
});

// ── 잡으면 안 되는 것 ──
test('공장 제조 과정: 꼬리표 소수(10% 미만), 조회 점유 1% 미만', () => {
  const r = tally(items('tag_share', 'factory_process_ko'));
  assert.ok(r.mass_share < 0.1);
  assert.ok(r.mass_view_share < 0.01);
});

test('드라마 검색(열혈사제)은 꼬리표 0', () => {
  const r = tally(items('dup_check', 'fiery_priest_nun_ko'));
  assert.equal(r.mass, 0);
  assert.equal(r.shared_pairs.length, 0);
});

test('#shorts·#Shorts 는 꼬리표가 아니고, 제목 본문의 worker 낱말도 안 센다', () => {
  const r = tally([
    { id: 'a', title: '공장 worker 의 하루 #Shorts', view_count: 1000, channel_id: '@a' },
    { id: 'b', title: 'process 설명 #shorts #fyp', view_count: 1000, channel_id: '@b' },
  ]);
  assert.equal(r.mass, 0);
  assert.deepEqual(tagsOf('제목 #Shorts #Worker…'), ['worker']);
});

test('ja 레인은 일본어 제목+꼬리표로 센다', () => {
  const r = tally([{ id: 'c', title: '鍛冶屋の技 #worker #process', view_count: 5, channel_id: '@c' }], { lane: 'ja' });
  assert.equal(r.local_mass, 1);
});

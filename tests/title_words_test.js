// scripts/title_words.js 자기 테스트 — 반복 낱말·표 꼴(API 0)
const assert = require('assert');
const { repeated, md } = require('../scripts/title_words');

const r = repeated(['조희대 탄핵 민주당은 왜', '조희대 탄핵 찬성 여론', '국감 조희대 법카 #shorts']);
assert.deepStrictEqual(r.slice(0, 2), [['조희대', 3], ['탄핵', 2]]);
const m = md({ keyword: '조희대 탄핵', days: 30, at: '2026-10-21T00:00:00Z', ours: '조희대 탄핵, 민주당은 왜 망설이나', repeated: r,
  rows: [{ title: '조희대 탄핵 | 찬성', views: 12345, channel: 'A', published: '2026-10-19T00:00:00Z' }] });
assert.ok(m.includes('| 1 | 조희대 탄핵 / 찬성 | 12,345 | A | 2026-10-19 |') && m.includes('앞 10자 «조희대 탄핵, 민주»'), m);
console.log('OK');

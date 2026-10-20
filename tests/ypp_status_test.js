// scripts/ypp_status.js 자기 테스트 — 한 줄 꼴만(API 0)
const assert = require('assert');
const { formatLine } = require('../scripts/ypp_status');

const line = formatLine({ rows: [
  { name: '쟁점브리핑', subs: 250, long_hours_365: 1200, shorts_views_90: 500000 },
  { name: '최애모먼트', subs: null, long_hours_365: 0, shorts_views_90: 0 },
  { name: '国会ノート', error: '멈춤 429' },
] });
assert.ok(line.startsWith('YPP — 쟁점브리핑 구독 250(25%) · 롱폼 365일 1,200h(30%) · 쇼츠 90일 500,000회(5%)'), line);
assert.ok(line.includes('최애모먼트 구독 비공개(?)') && line.includes('国会ノート ⚠멈춤 429'), line);
console.log('OK');

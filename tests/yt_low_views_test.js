// yt-low-views.js judge() 자기 테스트(API 0원) — 0회 쇼츠 6시간 즉시 비공개(guideline_zero_feed, 10-18 소유주)와 기존 24h 기준.
//   node tests/yt_low_views_test.js
const assert = require('assert');
const { judge, seconds } = require('../scripts/yt-low-views.js');

const now = Date.parse('2026-10-18T12:00:00Z');
const v = (hAgo, views, dur = 'PT45S', priv = 'public') => ({
  status: { privacyStatus: priv }, snippet: { publishedAt: new Date(now - hAgo * 36e5).toISOString() },
  statistics: { viewCount: String(views) }, contentDetails: { duration: dur } });
const o = { min: 100, hours: 24, zeroHours: 6 };

assert.strictEqual(seconds('PT2M30S'), 150);
assert.strictEqual(seconds('PT1H2M'), 3720);
assert.strictEqual(judge(v(7, 0), now, o), 'guideline_zero_feed');        // 6h 지난 0회 쇼츠 → 즉시
assert.strictEqual(judge(v(5, 0), now, o), null);                         // 6h 전엔 기다린다
assert.strictEqual(judge(v(7, 1), now, o), null);                         // 1회라도 있으면 24h 기준
assert.strictEqual(judge(v(25, 50), now, o), 'low_views');                // 기존 규칙 그대로
assert.strictEqual(judge(v(25, 0, 'PT20M'), now, o), 'low_views');        // 롱폼 0회는 가이드 규칙 아님(24h 기준)
assert.strictEqual(judge(v(7, 0, 'PT20M'), now, o), null);
assert.strictEqual(judge(v(30, 0, 'PT45S', 'private'), now, o), null);    // 이미 비공개·예약 대기는 안 건드림
console.log('OK');

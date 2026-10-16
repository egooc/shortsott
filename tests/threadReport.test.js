const test = require('node:test');
const assert = require('node:assert');
const { analyse, titleShape, jaAttrs } = require('../scripts/thread_report');

const NOW = Date.parse('2026-10-16T12:00:00+09:00');
const vid = (id, views, daysAgo, title, desc = '', dur = 'PT40S') => ({
  id, snippet: { title, description: desc, publishedAt: new Date(NOW - daysAgo * 864e5).toISOString() },
  status: { privacyStatus: 'public' }, statistics: { viewCount: String(views) }, contentDetails: { duration: dur },
});

test('ja: 近衛十四郎 浪人물이 터진 편의 공통 속성으로 잡힌다', () => {
  const kon = 'この作品は近衛十四郎さん・品川隆二さんほかが出演しています。';
  const items = [
    vid('a1', 90000, 5, '浪人の一言', kon), vid('a2', 70000, 6, '姫を背負った浪人', kon), vid('a3', 60000, 7, '浪人と姫', kon),
    vid('b1', 1000, 5, '町の話'), vid('b2', 1200, 6, '町の話二'), vid('b3', 900, 7, '町の話三'), vid('b4', 1100, 8, '町の話四'),
    vid('n1', 500000, 1, '新しい浪人', kon), // 72시간 안 — 집계에서 빠진다
    vid('a1', 90000, 5, '浪人の一言', kon), // 중복 — 한 번만 센다
  ];
  const ctx = { rinbox: new Map(), ledgerIds: new Set(), ledgerByYt: new Map(), jaIds: new Set(['a1', 'a2', 'a3', 'b1', 'b2', 'b3', 'b4', 'n1']) };
  const r = analyse('ja', items, ctx, { now: NOW, minAgeH: 72, x: 3 });
  assert.strictEqual(r.pool, 7);
  assert.deepStrictEqual(r.hot.map((h) => h.id).sort(), ['a1', 'a2', 'a3']);
  const top = r.lifts.find((t) => t.k === '주연');
  assert.ok(top && top.v === '近衛十四郎' && top.hot === 3);
});

test('ja: 린박스 업로드 기록에 없는 옛 영상은 집계하지 않는다', () => {
  const items = [vid('x1', 1e6, 30, 'cricket'), vid('a1', 100, 5, '浪人'), vid('a2', 120, 5, '浪人二'), vid('a3', 110, 5, '浪人三')];
  const ctx = { rinbox: new Map(), ledgerIds: new Set(), ledgerByYt: new Map(), jaIds: new Set(['a1', 'a2', 'a3']) };
  const r = analyse('ja', items, ctx, { now: NOW, minAgeH: 72, x: 3 });
  assert.strictEqual(r.pool, 3);
  assert.strictEqual(r.hot.length, 0);
});

test('제목 틀·출연 추출', () => {
  assert.ok(titleShape('「本当にダサい」高市総理?').includes('발언 인용「」'));
  assert.ok(titleShape('浪人の一言').includes('제목 ≤12자'));
  const v = vid('z', 1, 5, 't', '制作：東映\n出演：北大路欣也（辰造）・大原麗子');
  assert.strictEqual(jaAttrs(v, { rinbox: new Map() })['주연'], '北大路欣也');
});

test('N100: 장부 행으로 편수·렌더를 세고, 공개 통계가 없으면 조회 없음 · 쓸모연구소는 뺀다', () => {
  const { analyseN100 } = require('../scripts/thread_report');
  const row = (id, lane, yt, ch, day) => ({ lane, id, youtube_id: yt, render_secs: 300, rejected: 0, note: `채널=${ch}`, finished_at: `2026-10-${day}T01:00:00+09:00` });
  const rows = [row('o1', 'n100_ko_event', 'y1', '야생일지', 10), row('o2', 'n100_ko_event', 'y2', '야생일지', 10),
    row('o3', 'n100_ko_event', 'y3', '야생일지', 11), row('o4', 'n100_ko_event', 'y4', '야생일지', 11),
    row('o5', 'n100_ko_mon2_old', 'y5', '쓸모연구소', 11), row('o6', 'n100_ko_robot', null, '로보토리', 12)];
  const pub = NOW - 5 * 864e5;
  const stats = new Map([['y1', { views: 1000, title: 'a', pub }], ['y2', { views: 1100, title: 'b', pub }],
    ['y3', { views: 900, title: 'c', pub }], ['y4', { views: 9000, title: 'd', pub }]]);
  const r = analyseN100(rows, stats, { now: NOW, minAgeH: 72, x: 3 });
  assert.deepStrictEqual(r.map((l) => l.lane), ['n100_ko_event', 'n100_ko_robot']);
  const ev = r[0];
  assert.strictEqual(ev.made, 4); assert.strictEqual(ev.perDay, 2); assert.strictEqual(ev.pool, 4);
  assert.deepStrictEqual(ev.hot.map((h) => h.id), ['y4']);
  assert.strictEqual(r[1].withViews, 0); // 조회 없음
});

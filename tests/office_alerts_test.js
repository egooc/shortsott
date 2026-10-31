// 오피스 기기 경고: node tests/office_alerts_test.js
const assert = require('assert');
const { makeAlerts } = require('../office/server/alerts');
const MIN = 60e3;
function setup() {
  let t = Date.parse('2026-10-31T09:00:00Z');
  const sent = [];
  const a = makeAlerts({ notify: (x) => sent.push(x), now: () => t });
  const dev = (state, online = true) => [['main-pc', { ws: online ? { readyState: 1 } : null, state }]];
  return { a, sent, dev, step: (ms) => { t += ms; } };
}
const claude = (title) => ({ title, agent: 'claude', cc_status: 'idle' });

{ // 재부팅: 부팅 시각이 바뀌면 바로, 흔들림 2분 안쪽과 옛 연결기(값 없음)는 조용히
  const { a, sent } = setup();
  a.onState('main-pc', { boot_at: '2026-10-31T08:40:00Z' }, { boot_at: '2026-10-31T08:40:30Z' });
  a.onState('main-pc', {}, { boot_at: '2026-10-31T08:40:00Z' });
  assert.strictEqual(sent.length, 0);
  a.onState('main-pc', { boot_at: '2026-10-30T08:40:00Z' }, { boot_at: '2026-10-31T08:40:00Z' });
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].body, /17:40/);
}
{ // Orca: 2분 뒤 한 번만, 돌아오면 다시 잰다
  const { a, sent, dev, step } = setup();
  const off = { orca_ok: false, sessions: [] }, on = { orca_ok: true, sessions: [] };
  a.tick(dev(off)); step(MIN); a.tick(dev(off));
  assert.strictEqual(sent.length, 0);
  step(MIN); a.tick(dev(off)); step(5 * MIN); a.tick(dev(off));
  assert.strictEqual(sent.filter((x) => x.title === 'Orca 꺼짐').length, 1);
  a.tick(dev(on)); a.tick(dev(off)); step(2 * MIN); a.tick(dev(off));
  assert.strictEqual(sent.filter((x) => x.title === 'Orca 꺼짐').length, 2);
}
{ // Orca 없는 VPS·끊긴 기기는 Orca 경고를 안 낸다
  const { a, sent, step } = setup();
  const vps = [['vps', { ws: { readyState: 1 }, state: { orca_ok: false, sessions: [] } }]];
  a.tick(vps); step(10 * MIN); a.tick(vps);
  const gone = [['main-pc', { ws: null, state: { orca_ok: false, sessions: [] } }]];
  a.tick(gone); step(10 * MIN); a.tick(gone);
  assert.strictEqual(sent.length, 0);
}
{ // 세션: 오래 있던 것만, 5분 뒤 묶어서 한 번
  const { a, sent, dev, step } = setup();
  const st = (ss) => ({ orca_ok: true, sessions: ss });
  a.onState('main-pc', null, st([claude('✳ 오래된 세션'), claude('둘째')]));
  step(31 * MIN);
  a.onState('main-pc', null, st([claude('오래된 세션'), claude('둘째'), claude('방금 생김')]));
  a.tick(dev(st([]))); step(4 * MIN); a.tick(dev(st([])));
  assert.strictEqual(sent.length, 0);
  step(MIN + 1); a.tick(dev(st([]))); step(MIN); a.tick(dev(st([])));
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].title, '세션 2개 사라짐');
  assert.match(sent[0].body, /오래된 세션/);
  assert.doesNotMatch(sent[0].body, /방금 생김/);
}
{ // 재부팅: Orca 꺼진 동안과 돌아온 뒤 5분은 재지 않고, 그 뒤에도 안 돌아오면 알린다
  const { a, sent, dev, step } = setup();
  const up = (ss) => ({ orca_ok: true, sessions: ss });
  a.onState('main-pc', null, up([claude('A')])); step(31 * MIN); a.onState('main-pc', null, up([claude('A')]));
  a.tick(dev({ orca_ok: false, sessions: [] })); step(60 * MIN); a.tick(dev({ orca_ok: false, sessions: [] }));
  assert.ok(sent.every((x) => x.title === 'Orca 꺼짐'));
  a.tick(dev(up([]))); step(4 * MIN); a.tick(dev(up([])));
  assert.ok(!sent.some((x) => /사라짐/.test(x.title)));
  step(2 * MIN); a.tick(dev(up([])));
  assert.ok(sent.some((x) => /세션 1개 사라짐/.test(x.title)));
}
{ // 오피스에서 닫은 세션은 알리지 않는다
  const { a, sent, dev, step } = setup();
  const up = (ss) => ({ orca_ok: true, sessions: ss });
  a.onState('main-pc', null, up([claude('A')])); step(31 * MIN); a.onState('main-pc', null, up([claude('A')]));
  a.forget('main-pc', 'A');
  step(10 * MIN); a.tick(dev(up([])));
  assert.strictEqual(sent.length, 0);
}
console.log('office_alerts_test OK');

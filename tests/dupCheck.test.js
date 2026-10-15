// dup-check 회귀 — 네트워크 없이 10-15 실측 스냅숏(tests/fixtures/dup_check)으로 판정만 본다.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { judge, overlap } = require('../scripts/dup-check');

const FIX = path.join(__dirname, 'fixtures', 'dup_check');
const items = (name) => require(path.join(FIX, `${name}_20261015.json`)).items;
// 우리 편 목록을 고정해 둔다 — own_channels.json 이 바뀌어도 회귀가 흔들리지 않게.
const own = { names: new Set(['沼落ちシネマ', '지구관측소']), handles: new Set(['@numaochicinema', '@지구관측소']) };

// ── 통과해야 할 것 ──
test('花山大吉: 일본 쇼츠에 10만+ 없음 → PASS (C 10-15 «0건» 재현)', () => {
  const r = judge('花山大吉', items('hanayama_daikichi_ja'), { own });
  assert.equal(r.verdict, 'PASS');
  assert.ok(r.max_other < 100000);
});

test('제목 통째 후보가 남의 제목과 안 겹치면 PASS (조회수만 높아선 안 걸림)', () => {
  const r = judge('타짜 수녀님이 신부에게 건넨 마지막 한마디', items('fiery_priest_nun_ko'), { own });
  assert.equal(r.verdict, 'PASS');
  assert.ok(r.max_other >= 100000, '결과에 10만+ 편은 있다 — 겹침이 낮아서 통과해야 한다');
});

test('10만+ 겹침이 우리 편뿐이면 PASS, 자기 잠식으로만 센다', () => {
  const r = judge('将軍が自ら町へ出る', [
    { id: 'a', title: '将軍が自ら町へ出ると言う', view_count: 360000, channel_id: '@numaochicinema', channel: '沼落ちシネマ' },
    { id: 'b', title: '関係ない動画', view_count: 900000, channel_id: '@x', channel: 'x' },
  ], { own });
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.own_hits.length, 1);
});

test('문턱 바로 아래(99,999회)는 PASS', () => {
  const r = judge('열혈사제 수녀', [{ id: 'c', title: '열혈사제 수녀 반전', view_count: 99999, channel_id: '@x' }], { own });
  assert.equal(r.verdict, 'PASS');
});

// ── 걸려야 할 것 ──
test('暴れん坊将軍: 남의 10만+ 다수 → WARN, 상위 10에 우리 편 3개 (C 10-15 재현)', () => {
  const r = judge('暴れん坊将軍', items('abarenbou_shogun_ja'), { own });
  assert.equal(r.verdict, 'WARN');
  assert.equal(r.own_top10, 3);
  assert.ok(r.hits.every((h) => h.handle !== '@numaochicinema'));
});

test('열혈사제 수녀 타짜: 빽드 86만·SBS Catch 19만 → WARN (해시태그 작품명도 겹침으로 친다)', () => {
  const r = judge('열혈사제 수녀 타짜', items('fiery_priest_nun_ko'), { own });
  assert.equal(r.verdict, 'WARN');
  assert.deepEqual(r.hits.map((h) => h.handle), ['@BBACKD', '@SBSCatch']);
});

test('남의 같은 제목 15만 → WARN, 문턱 정확히 10만도 WARN', () => {
  for (const views of [150000, 100000]) {
    const r = judge('흑백요리사 셰프의 반전', [{ id: 'd', title: '흑백요리사 셰프의 반전 #shorts', view_count: views, channel_id: '@other' }], { own });
    assert.equal(r.verdict, 'WARN', `${views}회`);
  }
});

test('겹침: #shorts 는 무시하고 한·일 글자 2-gram 으로 잰다', () => {
  assert.equal(overlap('暴れん坊将軍', '#暴れん坊将軍 鶴姫の決心'), 1);
  assert.equal(overlap('shorts', 'anything #shorts'), 0);
  assert.ok(overlap('열혈사제 수녀', '수녀님의 반전 #열혈사제') >= 0.8);
});

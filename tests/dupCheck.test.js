// dup-check 회귀 — 네트워크 없이 10-15 실측 스냅숏(tests/fixtures/dup_check)으로 판정만 본다.
//   수정 1판(10-15 밤): 주 신호 = 키워드가 남의 제목 «본문»에 통째로 + 10만+. 겹침 점수는 참고 열.
//   사례 출처: C 린박스(暴れん坊将軍 게임 밈·浪人生·桃太郎侍), A 롱투숏(Mark Wiens), 쇼핑(무타공 청소도구 걸이).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { judge, overlap, isTitleMode, previous, changeLine, logLine } = require('../scripts/dup-check');

const FIX = path.join(__dirname, 'fixtures', 'dup_check');
const items = (name) => require(path.join(FIX, `${name}_20261015.json`)).items;
// 우리 편 목록을 고정해 둔다 — own_channels.json 이 바뀌어도 회귀가 흔들리지 않게.
const own = { names: new Set(['沼落ちシネマ', '지구관측소']), handles: new Set(['@numaochicinema', '@지구관측소']) };
const handles = (vs) => vs.map((v) => v.handle);

// ── 통과(PASS·NOTE)해야 할 것 ──
test('花山大吉: 10만+ 없음 → PASS (C 10-15 «0건» 재현)', () => {
  const r = judge('花山大吉', items('hanayama_daikichi_ja'), { own });
  assert.equal(r.verdict, 'PASS');
});

test('桃太郎侍(1년): 10만+ 없음 → PASS 유지 (C)', () => {
  assert.equal(judge('桃太郎侍', items('momotaro_zamurai_ja_year'), { own }).verdict, 'PASS');
});

test('浪人の一言: 수험 «浪人生» 726만은 키워드가 통째로 없음 → NOTE, 우리 편 37만은 자기 잠식 (C)', () => {
  const r = judge('浪人の一言', items('ronin_hitokoto_ja_year'), { own });
  assert.equal(r.verdict, 'NOTE');
  assert.ok(handles(r.notes).includes('@Stardy'));
  assert.ok(r.own_hits.some((v) => v.views === 370000));
});

test('Mark Wiens Philippines bakery: 긴 검색어는 제목 모드 → 다른 유튜버 빵집 14만은 NOTE (A)', () => {
  const r = judge('Mark Wiens Philippines bakery', items('mark_wiens_bakery_ko_year'), { own });
  assert.equal(r.title_mode, true);
  assert.equal(r.verdict, 'NOTE');
  assert.equal(r.hits.length, 0);
});

test('완성 제목 후보도 제목 모드 → WARN 을 내지 않는다', () => {
  const r = judge('타짜 수녀님이 신부에게 건넨 마지막 한마디', items('fiery_priest_nun_ko'), { own });
  assert.equal(r.title_mode, true);
  assert.notEqual(r.verdict, 'WARN');
});

test('10만+ 겹침이 우리 편뿐이면 PASS, 자기 잠식으로만 센다', () => {
  const r = judge('将軍', [
    { id: 'a', title: '将軍が自ら町へ出ると言う', view_count: 360000, channel_id: '@numaochicinema', channel: '沼落ちシネマ' },
  ], { own });
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.own_hits.length, 1);
});

test('무타공 청소도구 걸이 --info: 판정 없이 10만+ 남의 편 수와 최고 145만을 보여 준다 (쇼핑)', () => {
  const r = judge('무타공 청소도구 걸이', items('mutagong_holder_ko_year'), { own, info: true });
  assert.equal(r.verdict, 'INFO');
  assert.equal(r.big_others, 5);
  assert.equal(r.notes[0].views, 1450000);
});

// ── 걸려야(WARN) 할 것 ──
test('暴れん坊将軍(1년): 제목 본문에 든 남의 10만+ → WARN, 게임 밈 sorane_daa(태그만)는 참고로 (C)', () => {
  const r = judge('暴れん坊将軍', items('abarenbou_shogun_ja_year'), { own });
  assert.equal(r.verdict, 'WARN');
  assert.ok(!handles(r.hits).includes('@sorane_daa'));
  assert.ok(r.notes.some((v) => v.handle === '@sorane_daa' && v.anchor === 'tag'));
});

test('暴れん坊将軍(1개월): 상위10 우리 편 3 (C 10-15 손 검사 재현)', () => {
  const r = judge('暴れん坊将軍', items('abarenbou_shogun_ja'), { own });
  assert.equal(r.own_top10, 3);
});

test('--key "Mark Wiens": 인물명이 제목에 든 남의 16만·12만 → WARN', () => {
  const r = judge('Mark Wiens Philippines bakery', items('mark_wiens_bakery_ko_year'), { own, keys: ['Mark Wiens'] });
  assert.equal(r.verdict, 'WARN');
  assert.deepEqual(handles(r.hits), ['@LavventuraPhilippines', '@aprildawnmartinez7460']);
});

test('열혈사제: 작품명이 태그에만 → 기본 NOTE, --tag-anchor 면 WARN (빽드 86만·SBS Catch 19만)', () => {
  assert.equal(judge('열혈사제', items('fiery_priest_nun_ko'), { own }).verdict, 'NOTE');
  const r = judge('열혈사제', items('fiery_priest_nun_ko'), { own, tagAnchor: true });
  assert.equal(r.verdict, 'WARN');
  assert.deepEqual(handles(r.hits), ['@BBACKD', '@SBSCatch']);
});

test('문턱 정확히 10만은 WARN, 99,999는 PASS', () => {
  const one = (views) => judge('흑백요리사', [{ id: 'd', title: '흑백요리사 셰프의 반전 #shorts', view_count: views, channel_id: '@other' }], { own }).verdict;
  assert.equal(one(100000), 'WARN');
  assert.equal(one(99999), 'PASS');
});

// ── 보조 ──
test('제목 모드 경계: 2덩이·12자까지는 키워드, 3덩이 또는 13자부터 제목', () => {
  assert.equal(isTitleMode('Mark Wiens'), false);
  assert.equal(isTitleMode('浪人の一言'), false);
  assert.equal(isTitleMode('무타공 청소도구 걸이'), true);
});

test('날짜별 변동: 지난 날 기록과 우리 편 상위10·WARN 편 수를 비교한다 (C ③)', () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dupcheck-')), 'log.jsonl');
  const old = judge('暴れん坊将軍', items('abarenbou_shogun_ja'), { own });
  const line = logLine(old, { lane: 'ja', period: 'month' });
  line.at = '2026-10-14T09:00:00';
  fs.writeFileSync(log, JSON.stringify(line) + '\n', 'utf8');
  const now = judge('暴れん坊将軍', items('abarenbou_shogun_ja_year'), { own });
  const prev = previous(log, 'ja', '暴れん坊将軍', '2026-10-15');
  assert.match(changeLine(prev, now), /2026-10-14: 우리 편 상위10 3 → 1/);
  assert.equal(previous(log, 'ja', '暴れん坊将軍', '2026-10-14'), null, '같은 날 기록은 비교 대상이 아니다');
});

test('겹침(참고 열): #shorts 는 무시하고 한·일 글자 2-gram 으로 잰다', () => {
  assert.equal(overlap('暴れん坊将軍', '#暴れん坊将軍 鶴姫の決心'), 1);
  assert.equal(overlap('shorts', 'anything #shorts'), 0);
});

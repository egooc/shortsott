// scripts/comment_mine.js --channel-types 자기 테스트 — 집계·순간 검증·자막 파싱(API 0, GPT 0)
const assert = require('assert');
const cm = require(process.env.CM_PATH || '../scripts/comment_mine');

assert.deepStrictEqual(cm.commentTs('0:32 여기서 웃음 ㅋㅋ 1:05도'), [32, 65]);
assert.deepStrictEqual(cm.commentTs('10:00시에 봤음 2026:12'), [600]);
const vtt = 'WEBVTT\nKind: captions\n\n00:00:01.000 --> 00:00:03.000\n<c>문어가</c> 다가옵니다\n\n00:00:03.000 --> 00:00:05.000\n문어가 다가옵니다\n\n00:00:12.500 --> 00:00:14.000\n카메라를 밀어요\n';
assert.deepStrictEqual(cm.parseVtt(vtt), [{ t: 1, text: '문어가 다가옵니다' }, { t: 12, text: '카메라를 밀어요' }]);

const c = (id, text, likes) => ({ id, text, likes, replies: 0 });
const vids = [
  { id: 'AAAAAAAAAAA', title: '카메라가 코앞인데 밀고 온 문어', dur: 40, views: 61965, subs: [{ t: 12, text: '카메라를 밀어요' }],
    picked: [c('a1', '한국 바다였으면 벌써 회 떠졌다', 900), c('a2', '귀여워 미치겠다', 300), c('a3', '0:12 여기 표정 봐', 50), c('a4', '구독', 0)] },
  { id: 'BBBBBBBBBBB', title: '220kg 실버백이 코앞인데 안 친 이유', dur: 45, views: 14741, subs: null,
    picked: [c('b1', '사람은 상대도 안 됨', 500), c('b2', '한국 산에 있었으면 다 잡아먹힘', 400), c('b3', '귀엽네', 20)] },
];
const ans = {
  types: [{ name: '한국이었으면 잡아먹힘', trigger: '포식자가 코앞' }, { name: '귀엽다', call: '피함' }, { name: '상대도 안 됨' }, { name: '빈 유형' }],
  assign: { 'v1.1': 1, 'v1.2': 2, 'v1.3': 2, 'v1.4': 0, 'v2.1': 3, 'v2.2': 1, 'v2.3': 2, 'v9.9': 1 },
  moments: [{ type: 1, video: 'v1', at_sec: 12, what: '카메라 밀기', basis: '자막' },
    { type: 1, video: 'v2', at_sec: 30, what: '지어낸 초', basis: '자막' },          // v2 는 자막 없음 → 초 지움
    { type: 2, video: 'v1', at_sec: 12.5, what: '표정', basis: '댓글 타임스탬프' },  // 댓글 0:12 ±2 → 인정
    { type: 3, video: 'v2', at_sec: 99, what: '길이 밖', basis: '댓글 타임스탬프' }],
};
const r = cm.tallyTypes({ name: '야생일지' }, vids, ans);
assert.strictEqual(r.total, 7);
assert.deepStrictEqual(r.types.map((t) => [t.name, t.count, t.pct]), [['귀엽다', 3, 42.9], ['한국이었으면 잡아먹힘', 2, 28.6], ['상대도 안 됨', 1, 14.3], ['빈 유형', 0, 0]]);
assert.deepStrictEqual(r.top3, ['한국이었으면 잡아먹힘', '상대도 안 됨']);   // «피함»·댓글 0 유형은 관문 상위 3에서 뺀다
assert.deepStrictEqual(r.other, { count: 1, pct: 14.3 });
const korea = r.types.find((t) => t.name === '한국이었으면 잡아먹힘');
assert.deepStrictEqual(korea.examples.map((e) => [e.text, e.likes, e.video]), [['한국 바다였으면 벌써 회 떠졌다', 900, 'AAAAAAAAAAA'], ['한국 산에 있었으면 다 잡아먹힘', 400, 'BBBBBBBBBBB']]);
assert.deepStrictEqual(korea.moments.map((m) => m.at_sec), [12, null]);
assert.strictEqual(r.types.find((t) => t.name === '귀엽다').moments[0].at_sec, 12.5);
assert.strictEqual(r.types.find((t) => t.name === '상대도 안 됨').moments[0].at_sec, null);
const md = cm.typesMd({ ...r, key: 'ko_event', channel: '야생일지', at: '2026-10-23T00:00:00Z', videos: vids });
assert.ok(md.includes('| 1 | 귀엽다 | 42.9% | 3 | 370 | 피함 |') && md.includes('«한국 바다였으면 벌써 회 떠졌다» ♥900') && md.includes('0:12(12초)'), md);
assert.ok(cm.typesPrompt({ name: '야생일지' }, vids).includes('v2.2 [♥400 · 답0] 한국 산에'));
assert.strictEqual(cm.pickComments([c('x', 'a', 1), c('y', '1:00 b', 0)], 1).length, 2);   // 타임스탬프 댓글은 좋아요 밖이어도 보낸다
console.log('OK');
